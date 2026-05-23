import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint, polygon as turfPolygon } from '@turf/helpers';

export type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: number[][][];
};

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters between two (lat, lng) points (haversine). */
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Returns true if (lng, lat) lies inside the polygon (or on the boundary). */
export function isPointInPolygon(
  lngLat: [number, number],
  polygon: GeoJsonPolygon,
): boolean {
  const [lng, lat] = lngLat;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new TypeError(`isPointInPolygon: invalid coordinates ${lngLat}`);
  }
  return booleanPointInPolygon(turfPoint([lng, lat]), turfPolygon(polygon.coordinates));
}

/**
 * Throws if `input` is not a valid GeoJSON Polygon.
 * Returns a typed, narrowed value on success.
 */
export function validateGeoJsonPolygon(input: unknown): GeoJsonPolygon {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Polygon must be an object');
  }
  const obj = input as Record<string, unknown>;
  if (obj.type !== 'Polygon') {
    throw new TypeError(`Polygon.type must be "Polygon", got ${String(obj.type)}`);
  }
  if (!Array.isArray(obj.coordinates) || obj.coordinates.length === 0) {
    throw new TypeError('Polygon.coordinates must be a non-empty array of rings');
  }
  for (const ring of obj.coordinates as unknown[]) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new TypeError('Polygon ring must have at least 4 positions (closed)');
    }
    const first = ring[0] as unknown[];
    const last = ring[ring.length - 1] as unknown[];
    if (
      !Array.isArray(first) ||
      !Array.isArray(last) ||
      first.length < 2 ||
      last.length < 2 ||
      first[0] !== last[0] ||
      first[1] !== last[1]
    ) {
      throw new TypeError('Polygon ring must be closed (first == last position)');
    }
    for (const pos of ring as unknown[]) {
      if (
        !Array.isArray(pos) ||
        pos.length < 2 ||
        !Number.isFinite(pos[0]) ||
        !Number.isFinite(pos[1])
      ) {
        throw new TypeError('Polygon positions must be [lng, lat] numbers');
      }
      const [lng, lat] = pos as number[];
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new RangeError(`Polygon position out of WGS84 range: [${lng}, ${lat}]`);
      }
    }
  }
  return { type: 'Polygon', coordinates: obj.coordinates as number[][][] };
}
