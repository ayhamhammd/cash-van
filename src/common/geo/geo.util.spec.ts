import {
  haversineMeters,
  isPointInPolygon,
  validateGeoJsonPolygon,
  GeoJsonPolygon,
} from './geo.util';

// Square around (0,0): (-1,-1) to (1,1)
const unitSquare: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ],
  ],
};

describe('geo.util', () => {
  describe('isPointInPolygon', () => {
    it('detects inside', () => {
      expect(isPointInPolygon([0, 0], unitSquare)).toBe(true);
      expect(isPointInPolygon([0.5, 0.5], unitSquare)).toBe(true);
    });

    it('detects outside', () => {
      expect(isPointInPolygon([2, 2], unitSquare)).toBe(false);
      expect(isPointInPolygon([-2, 0], unitSquare)).toBe(false);
    });

    it('throws on non-finite coordinates', () => {
      expect(() => isPointInPolygon([NaN, 0], unitSquare)).toThrow(TypeError);
    });
  });

  describe('haversineMeters', () => {
    it('is ~0 for identical points', () => {
      expect(haversineMeters(31.95, 35.91, 31.95, 35.91)).toBeCloseTo(0, 5);
    });

    it('approximates a known distance (~111km per degree latitude)', () => {
      const d = haversineMeters(31.0, 35.0, 32.0, 35.0);
      expect(d).toBeGreaterThan(110_000);
      expect(d).toBeLessThan(112_000);
    });

    it('is symmetric', () => {
      const a = haversineMeters(31.95, 35.91, 32.05, 36.01);
      const b = haversineMeters(32.05, 36.01, 31.95, 35.91);
      expect(a).toBeCloseTo(b, 6);
    });
  });

  describe('validateGeoJsonPolygon', () => {
    it('accepts a valid polygon', () => {
      const result = validateGeoJsonPolygon(unitSquare);
      expect(result.type).toBe('Polygon');
    });

    it('rejects wrong type', () => {
      expect(() =>
        validateGeoJsonPolygon({ type: 'Point', coordinates: [0, 0] }),
      ).toThrow(/type/);
    });

    it('rejects unclosed ring', () => {
      expect(() =>
        validateGeoJsonPolygon({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        }),
      ).toThrow(/closed/);
    });

    it('rejects coordinates outside WGS84 range', () => {
      expect(() =>
        validateGeoJsonPolygon({
          type: 'Polygon',
          coordinates: [
            [
              [200, 0],
              [201, 0],
              [201, 1],
              [200, 1],
              [200, 0],
            ],
          ],
        }),
      ).toThrow(/WGS84/);
    });
  });
});
