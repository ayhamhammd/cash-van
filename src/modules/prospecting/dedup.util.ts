/**
 * De-duplication helpers for the lead finder — pure functions so the matching
 * rules can be unit-tested without a database or Google.
 */

/** Metres. Two shopfronts closer than this are treated as the same business. */
export const DISTANCE_MATCH_M = 75;

/**
 * Reduce a phone to comparable digits: strips spaces/dashes/parens, drops the
 * Jordan country code (+962 / 00962) and any leading zero, so
 * "+962 79 000 0000", "0790000000" and "790000000" all compare equal.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00962')) d = d.slice(5);
  else if (d.startsWith('962')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  return d || null;
}

/**
 * Normalize an Arabic/Latin business name for comparison: strips tatweel and
 * diacritics, unifies alef/ya/ta-marbuta variants, drops punctuation and
 * collapses whitespace. "مَحَلّ الأمل" and "محل الامل" compare equal.
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[ـ]/g, '') // tatweel
    .replace(/[ً-ْ]/g, '') // harakat
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Great-circle distance in metres. */
export function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface DedupCustomer {
  id: string;
  phone?: string | null;
  nameAr?: string | null;
  customerName?: string | null;
  latitude?: string | null;
  longitude?: string | null;
}

export interface DedupCandidate {
  name: string;
  phone: string | null;
  lat: number | null;
  lng: number | null;
}

export interface DedupHit {
  customerId: string;
  reason: 'PHONE' | 'DISTANCE' | 'NAME';
}

/**
 * Decide whether a candidate is an existing customer. Checked in confidence
 * order — phone (exact identity), then distance (same shopfront), then
 * normalized name (weakest, so it is reported but meant for human review).
 */
export function matchExistingCustomer(
  candidate: DedupCandidate,
  customers: DedupCustomer[],
): DedupHit | null {
  const phone = normalizePhone(candidate.phone);
  if (phone) {
    for (const c of customers) {
      if (normalizePhone(c.phone) === phone) {
        return { customerId: c.id, reason: 'PHONE' };
      }
    }
  }

  if (candidate.lat != null && candidate.lng != null) {
    for (const c of customers) {
      const lat = c.latitude != null ? Number(c.latitude) : NaN;
      const lng = c.longitude != null ? Number(c.longitude) : NaN;
      if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
      if (
        haversineM(candidate.lat, candidate.lng, lat, lng) <= DISTANCE_MATCH_M
      ) {
        return { customerId: c.id, reason: 'DISTANCE' };
      }
    }
  }

  const name = normalizeName(candidate.name);
  // Guard against absurdly short names ("محل") matching half the database.
  if (name.length >= 6) {
    for (const c of customers) {
      const cn = normalizeName(c.nameAr ?? c.customerName);
      if (cn.length >= 6 && cn === name) {
        return { customerId: c.id, reason: 'NAME' };
      }
    }
  }

  return null;
}
