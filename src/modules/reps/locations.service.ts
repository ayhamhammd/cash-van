import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Rep } from './entities/rep.entity';
import { RepLocationEvent } from './entities/rep-location-event.entity';
import { RepStatusService } from './rep-status.service';
import { RecordLocationDto, BulkRecordLocationDto } from './dto/record-location.dto';
import { ListLocationsQuery } from './dto/list-locations.query';

export type LiveStatus = 'online' | 'idle' | 'offline';

export interface LatestRepLocation {
  repId: string;
  nameAr: string;
  nameEn: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: Date;
  status: LiveStatus;
}

/** One GPS ping in a trail (matches RepLocationEvent's public fields). */
export interface TrailPoint {
  repId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: Date;
}

/** A customer visit row for the tracking map / per-customer history. */
export interface VisitRow {
  customerId: string;
  customerNumber: string | null;
  customerName: string | null;
  visitedAt: Date;
  hadSale: boolean;
  note: string | null;
  lat: number | null;
  lng: number | null;
}

/** A per-day / per-month tracking summary bucket. */
export interface TrackingBucket {
  date: string; // YYYY-MM-DD (bucket start)
  points: number;
  distanceKm: number;
  firstAt: Date | null;
  lastAt: Date | null;
  activeMinutes: number;
  customersVisited: number;
  sales: number;
}

@Injectable()
export class LocationsService {
  constructor(
    @InjectRepository(RepLocationEvent)
    private readonly events: Repository<RepLocationEvent>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    private readonly bus: EventEmitter2,
    private readonly repStatus: RepStatusService,
  ) {}

  async record(repId: string, dto: RecordLocationDto): Promise<RepLocationEvent> {
    await this.assertRepExists(repId);
    const saved = await this.events.save(
      this.events.create({
        repId,
        lat: dto.lat,
        lng: dto.lng,
        accuracyM: dto.accuracyM ?? null,
        recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
      }),
    );
    this.bus.emit('rep.location', {
      repId,
      lat: saved.lat,
      lng: saved.lng,
      recordedAt: saved.recordedAt,
    });
    await this.repStatus.touch(repId);
    return saved;
  }

  async recordBulk(
    repId: string,
    dto: BulkRecordLocationDto,
  ): Promise<{ accepted: number }> {
    await this.assertRepExists(repId);
    const rows = dto.points.map((p) =>
      this.events.create({
        repId,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM ?? null,
        recordedAt: p.recordedAt ? new Date(p.recordedAt) : new Date(),
      }),
    );
    await this.events.save(rows, { chunk: 100 });

    // Emit just the latest point — older points are historical, not "live."
    const latest = rows.reduce((acc, r) =>
      acc.recordedAt > r.recordedAt ? acc : r,
    );
    this.bus.emit('rep.location', {
      repId,
      lat: latest.lat,
      lng: latest.lng,
      recordedAt: latest.recordedAt,
    });
    await this.repStatus.touch(repId);
    return { accepted: rows.length };
  }

  async list(repId: string, q: ListLocationsQuery): Promise<TrailPoint[]> {
    await this.assertRepExists(repId);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600_000);

    // Downsample server-side for wide ranges (a month can be tens of thousands of
    // pings) — keep an even sample plus the first + last so the polyline still fits
    // bounds correctly. Distance/summary are computed on the FULL rows elsewhere.
    if (q.maxPoints) {
      return (await this.events.query(
        `
        SELECT rep_id AS "repId", lat, lng, accuracy_m AS "accuracyM", recorded_at AS "recordedAt"
        FROM (
          SELECT rep_id, lat, lng, accuracy_m, recorded_at,
                 row_number() OVER (ORDER BY recorded_at) AS rn,
                 count(*)     OVER () AS total
          FROM rep_location_events
          WHERE rep_id = $1 AND recorded_at BETWEEN $2 AND $3
        ) t
        WHERE total <= $4
           OR rn = 1 OR rn = total
           OR (rn % (ceil(total::numeric / $4)::int)) = 0
        ORDER BY recorded_at ASC
        `,
        [repId, from, to, q.maxPoints],
      )) as TrailPoint[];
    }

    const rows = await this.events.find({
      where: { repId, recordedAt: Between(from, to) },
      order: { recordedAt: 'ASC' },
      take: q.limit ?? 1000,
    });
    return rows.map((r) => ({
      repId: r.repId,
      lat: r.lat,
      lng: r.lng,
      accuracyM: r.accuracyM ?? null,
      recordedAt: r.recordedAt,
    }));
  }

  /** A rep's customer visits within a range (visit markers for the tracking map). */
  async visitsForRep(repId: string, fromIso?: string, toIso?: string): Promise<VisitRow[]> {
    await this.assertRepExists(repId);
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 3600_000);
    return (await this.events.query(
      `
      SELECT cv.customer_id            AS "customerId",
             c.customer_number         AS "customerNumber",
             c.customer_name           AS "customerName",
             cv.visited_at             AS "visitedAt",
             cv.had_sale               AS "hadSale",
             cv.visit_note             AS "note",
             cv.lat, cv.lng
      FROM customer_visits cv
      LEFT JOIN customers c ON c.id = cv.customer_id
      WHERE cv.rep_id = $1 AND cv.visited_at BETWEEN $2 AND $3
      ORDER BY cv.visited_at ASC
      `,
      [repId, from, to],
    )) as VisitRow[];
  }

  /**
   * Per-day / per-month tracking summary: distance (haversine between consecutive
   * pings WITHIN the bucket), active span, points, customers visited + sales.
   * Distance is computed on the full ping set (not the downsampled trail).
   */
  async trackingSummary(
    repId: string,
    fromIso?: string,
    toIso?: string,
    bucket: 'day' | 'month' = 'day',
  ): Promise<TrackingBucket[]> {
    await this.assertRepExists(repId);
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 3600_000);
    const rows = (await this.events.query(
      `
      WITH seg AS (
        SELECT date_trunc($4, recorded_at) AS bucket, recorded_at,
          CASE WHEN LAG(lat) OVER w IS NULL THEN 0 ELSE
            6371 * 2 * asin(sqrt(
              power(sin(radians(lat - LAG(lat) OVER w) / 2), 2) +
              cos(radians(LAG(lat) OVER w)) * cos(radians(lat)) *
              power(sin(radians(lng - LAG(lng) OVER w) / 2), 2)
            )) END AS seg_km
        FROM rep_location_events
        WHERE rep_id = $1 AND recorded_at BETWEEN $2 AND $3
        WINDOW w AS (PARTITION BY date_trunc($4, recorded_at) ORDER BY recorded_at)
      ),
      loc AS (
        SELECT bucket, count(*) AS points, min(recorded_at) AS first_at,
               max(recorded_at) AS last_at, sum(seg_km) AS distance_km
        FROM seg GROUP BY bucket
      ),
      vis AS (
        SELECT date_trunc($4, visited_at) AS bucket,
               count(DISTINCT customer_id) AS customers,
               count(*) FILTER (WHERE had_sale) AS sales
        FROM customer_visits
        WHERE rep_id = $1 AND visited_at BETWEEN $2 AND $3
        GROUP BY 1
      )
      SELECT to_char(coalesce(loc.bucket, vis.bucket), 'YYYY-MM-DD') AS date,
             coalesce(loc.points, 0)::int              AS points,
             round(coalesce(loc.distance_km, 0)::numeric, 2)::float8 AS "distanceKm",
             loc.first_at                              AS "firstAt",
             loc.last_at                               AS "lastAt",
             round(coalesce(extract(epoch FROM (loc.last_at - loc.first_at)) / 60, 0)::numeric, 0)::int AS "activeMinutes",
             coalesce(vis.customers, 0)::int           AS "customersVisited",
             coalesce(vis.sales, 0)::int               AS sales
      FROM loc FULL OUTER JOIN vis ON loc.bucket = vis.bucket
      ORDER BY 1
      `,
      [repId, from, to, bucket],
    )) as TrackingBucket[];
    return rows;
  }

  /**
   * Latest ping per active rep. Used by the dashboard's Live Map.
   *
   * Uses Postgres DISTINCT ON for efficiency on the partitioned table.
   */
  async latestPerRep(): Promise<LatestRepLocation[]> {
    // Get distinct latest event per rep within the last 24h (live map window).
    // Raw query because TypeORM's QueryBuilder reorders SELECT columns, which
    // breaks `DISTINCT ON (...)`'s requirement that it be the first expression.
    const horizon = new Date(Date.now() - 24 * 3600_000);
    const rows = (await this.events.query(
      `
      SELECT DISTINCT ON (rep_id)
             rep_id, lat, lng, accuracy_m, recorded_at
      FROM rep_location_events
      WHERE recorded_at >= $1
      ORDER BY rep_id, recorded_at DESC
      `,
      [horizon],
    )) as Array<{
      rep_id: string;
      lat: number;
      lng: number;
      accuracy_m: number | null;
      recorded_at: Date;
    }>;

    if (rows.length === 0) return [];

    const reps = await this.reps.find({
      where: { id: In(rows.map((r) => r.rep_id)) },
    });
    const repIndex = new Map(reps.map((r) => [r.id, r]));
    const now = Date.now();

    return rows.flatMap((row) => {
      const rep = repIndex.get(row.rep_id);
      if (!rep || !rep.isActive) return [];
      const ageMs = now - new Date(row.recorded_at).getTime();
      const status: LiveStatus =
        ageMs <= 5 * 60_000 ? 'online' : ageMs <= 30 * 60_000 ? 'idle' : 'offline';
      return [
        {
          repId: row.rep_id,
          nameAr: rep.nameAr,
          nameEn: rep.nameEn ?? null,
          lat: Number(row.lat),
          lng: Number(row.lng),
          accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
          recordedAt: new Date(row.recorded_at),
          status,
        },
      ];
    });
  }

  async toGeoJsonLineString(repId: string, q: ListLocationsQuery): Promise<{
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: { type: 'LineString'; coordinates: number[][] };
      properties: { repId: string; from: string; to: string; pointCount: number };
    }>;
  }> {
    const points = await this.list(repId, q);
    const coords = points.map((p) => [Number(p.lng), Number(p.lat)]);
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {
            repId,
            from: points[0]?.recordedAt.toISOString() ?? '',
            to: points[points.length - 1]?.recordedAt.toISOString() ?? '',
            pointCount: points.length,
          },
        },
      ],
    };
  }

  private async assertRepExists(repId: string): Promise<void> {
    const exists = await this.reps.exist({ where: { id: repId } });
    if (!exists) throw new NotFoundException(`Rep ${repId} not found`);
  }
}
