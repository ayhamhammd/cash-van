import {
  haversineM,
  matchExistingCustomer,
  normalizeName,
  normalizePhone,
  type DedupCustomer,
} from './dedup.util';

describe('prospecting de-dup', () => {
  describe('normalizePhone', () => {
    it('treats every Jordanian format of the same number as equal', () => {
      const forms = [
        '0790000000',
        '+962 79 000 0000',
        '00962790000000',
        '962-79-000-0000',
        '790000000',
      ];
      const normalized = forms.map(normalizePhone);
      expect(new Set(normalized).size).toBe(1);
      expect(normalized[0]).toBe('790000000');
    });

    it('returns null for empty/garbage input', () => {
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone('')).toBeNull();
      expect(normalizePhone('---')).toBeNull();
    });

    it('keeps genuinely different numbers different', () => {
      expect(normalizePhone('0790000000')).not.toBe(normalizePhone('0791111111'));
    });
  });

  describe('normalizeName', () => {
    it('ignores diacritics, alef/ya/ta-marbuta variants and punctuation', () => {
      expect(normalizeName('مَحَلّ الأمل')).toBe(normalizeName('محل الامل'));
      expect(normalizeName('بقالة العمري')).toBe(normalizeName('بقاله العمري'));
      expect(normalizeName('سوبر ماركت - النور!')).toBe(
        normalizeName('سوبر ماركت النور'),
      );
    });
  });

  describe('haversineM', () => {
    it('measures a short distance about right', () => {
      // ~111m apart in latitude (0.001°).
      const d = haversineM(31.95, 35.93, 31.951, 35.93);
      expect(d).toBeGreaterThan(100);
      expect(d).toBeLessThan(120);
    });
  });

  describe('matchExistingCustomer', () => {
    const customers: DedupCustomer[] = [
      {
        id: 'c-phone',
        phone: '0790000000',
        nameAr: 'زبون الهاتف',
        latitude: null,
        longitude: null,
      },
      {
        id: 'c-geo',
        phone: null,
        nameAr: 'زبون الموقع',
        latitude: '31.950000',
        longitude: '35.930000',
      },
      {
        id: 'c-name',
        phone: null,
        nameAr: 'سوبر ماركت النور',
        latitude: null,
        longitude: null,
      },
    ];

    it('matches on phone even when the format differs', () => {
      const hit = matchExistingCustomer(
        { name: 'اسم مختلف تماما', phone: '+962 79 000 0000', lat: null, lng: null },
        customers,
      );
      expect(hit).toEqual({ customerId: 'c-phone', reason: 'PHONE' });
    });

    it('matches a shopfront within 75 m', () => {
      const hit = matchExistingCustomer(
        { name: 'اسم اخر', phone: null, lat: 31.9503, lng: 35.93 },
        customers,
      );
      expect(hit).toEqual({ customerId: 'c-geo', reason: 'DISTANCE' });
    });

    it('does NOT match a business further than 75 m away', () => {
      // ~330m north — a different shop on the same street.
      const hit = matchExistingCustomer(
        { name: 'اسم اخر', phone: null, lat: 31.953, lng: 35.93 },
        customers,
      );
      expect(hit).toBeNull();
    });

    it('matches on normalized name as the last resort', () => {
      const hit = matchExistingCustomer(
        { name: 'سوبر ماركت النور', phone: null, lat: null, lng: null },
        customers,
      );
      expect(hit).toEqual({ customerId: 'c-name', reason: 'NAME' });
    });

    it('prefers phone over distance when both would match', () => {
      const hit = matchExistingCustomer(
        { name: 'x', phone: '0790000000', lat: 31.95, lng: 35.93 },
        customers,
      );
      expect(hit?.reason).toBe('PHONE');
    });

    it('does not match very short names (guards against mass false positives)', () => {
      const shortNamed: DedupCustomer[] = [{ id: 'c', nameAr: 'محل' }];
      expect(
        matchExistingCustomer(
          { name: 'محل', phone: null, lat: null, lng: null },
          shortNamed,
        ),
      ).toBeNull();
    });

    it('returns null for a genuinely new business', () => {
      const hit = matchExistingCustomer(
        { name: 'بقالة جديدة تماما', phone: '0799999999', lat: 32.5, lng: 36.5 },
        customers,
      );
      expect(hit).toBeNull();
    });
  });
});
