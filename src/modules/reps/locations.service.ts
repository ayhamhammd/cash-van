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

  async list(repId: string, q: ListLocationsQuery): Promise<RepLocationEvent[]> {
    await this.assertRepExists(repId);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600_000);
    return this.events.find({
      where: { repId, recordedAt: Between(from, to) },
      order: { recordedAt: 'ASC' },
      take: q.limit ?? 1000,
    });
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
