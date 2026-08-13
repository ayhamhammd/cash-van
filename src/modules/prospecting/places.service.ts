import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { haversineM } from './dedup.util';

/** A business as returned by Google Places, normalized to what we store. */
export interface PlaceResult {
  placeId: string;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  phone: string | null;
  category: string | null;
  rating: number | null;
}

/** A geocoded location the search point can be moved to. */
export interface PlaceLocation {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
}

const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';

/** Metres per degree of latitude — near enough anywhere for a search box. */
const M_PER_DEG_LAT = 111_320;

/**
 * Smallest lat/lng rectangle containing the circle, for the Text Search
 * endpoint, which will not take a circle. Deliberately the *outer* box, so it
 * never clips a real result — the caller trims the corners by exact distance.
 */
function boundingBox(
  lat: number,
  lng: number,
  radiusM: number,
): {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
} {
  const dLat = radiusM / M_PER_DEG_LAT;
  // Degrees of longitude shrink towards the poles. The cosine is floored so a
  // near-polar point widens the box instead of dividing by ~0.
  const shrink = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const dLng = radiusM / (M_PER_DEG_LAT * shrink);
  return {
    low: {
      latitude: Math.max(lat - dLat, -90),
      longitude: Math.max(lng - dLng, -180),
    },
    high: {
      latitude: Math.min(lat + dLat, 90),
      longitude: Math.min(lng + dLng, 180),
    },
  };
}

/**
 * Google Places (New) client. Runs SERVER-SIDE only — the API key must never
 * reach the browser, where it could be lifted and billed against.
 *
 * Cost control: the field mask requests only the fields we persist, and the
 * phone number needs a second per-place Details call (contact fields are not
 * returned by Nearby Search), so Details is issued only for places we actually
 * keep. Both SKUs have monthly free allowances that this volume stays inside.
 */
@Injectable()
export class PlacesService {
  private readonly log = new Logger(PlacesService.name);

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return !!this.config.get<string>('places.apiKey');
  }

  private key(): string {
    const k = this.config.get<string>('places.apiKey');
    if (!k) {
      throw new ServiceUnavailableException(
        'Google Places is not configured — set GOOGLE_PLACES_API_KEY',
      );
    }
    return k;
  }

  /**
   * Businesses of `types` within `radiusM` of a point. `maxResults` is capped
   * at 20 by the API itself.
   */
  async searchNearby(
    lat: number,
    lng: number,
    radiusM: number,
    types: string[],
  ): Promise<PlaceResult[]> {
    const res = await fetch(NEARBY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key(),
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.primaryType',
          'places.rating',
        ].join(','),
      },
      body: JSON.stringify({
        includedTypes: types,
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: radiusM,
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.log.error(`Places searchNearby ${res.status}: ${body.slice(0, 400)}`);
      throw new ServiceUnavailableException('Google Places search failed');
    }

    const json = (await res.json()) as {
      places?: {
        id: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        primaryType?: string;
        rating?: number;
      }[];
    };

    return (json.places ?? []).map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? '—',
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      address: p.formattedAddress ?? null,
      phone: null,
      category: p.primaryType ?? null,
      rating: p.rating ?? null,
    }));
  }

  /**
   * Businesses matching a free-text term within `radiusM` of a point.
   *
   * The category allow-list can only ever cover the trades Google has a type
   * for, so this is the escape hatch: the rep types what the place is called
   * ("ماركت", a chain name) and Places matches it against the business name and
   * description. Same field mask as `searchNearby` so both feed one pipeline.
   *
   * Text Search takes a *rectangle* for `locationRestriction` (a circle is a
   * 400 — only Nearby Search accepts one), so the circle is sent as its
   * bounding box and the corners are then trimmed off by exact distance here.
   * `locationRestriction` rather than `locationBias` on purpose: a bias is a
   * suggestion, and a keyword search must not quietly return leads outside the
   * radius the rep chose.
   */
  async searchTextNearby(
    query: string,
    lat: number,
    lng: number,
    radiusM: number,
    maxResults = 20,
  ): Promise<PlaceResult[]> {
    const res = await fetch(TEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key(),
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.primaryType',
          'places.rating',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: maxResults,
        locationRestriction: { rectangle: boundingBox(lat, lng, radiusM) },
        languageCode: 'ar',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.log.error(
        `Places searchTextNearby ${res.status}: ${body.slice(0, 400)}`,
      );
      throw new ServiceUnavailableException('Google Places search failed');
    }

    const json = (await res.json()) as {
      places?: {
        id: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        primaryType?: string;
        rating?: number;
      }[];
    };

    return (json.places ?? [])
      .map((p) => ({
        placeId: p.id,
        name: p.displayName?.text ?? '—',
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        address: p.formattedAddress ?? null,
        phone: null,
        category: p.primaryType ?? null,
        rating: p.rating ?? null,
      }))
      // Trim the box back to the circle the rep actually drew. A place with no
      // coordinates is kept: it can't be proven outside, and dropping it would
      // silently lose a lead the term did match.
      .filter(
        (p) =>
          p.lat == null ||
          p.lng == null ||
          haversineM(lat, lng, p.lat, p.lng) <= radiusM,
      );
  }

  /**
   * Free-text place lookup — "خلدا", "Sweifieh", "Irbid city centre" — used to
   * move the lead-finder's search point without hunting on the map.
   *
   * Runs server-side for the same reason the rest of this class does: it keeps
   * the Places key off the browser, where the dashboard's Maps key is a
   * separate, referrer-restricted credential that Places would reject anyway.
   *
   * `regionCode` biases results to the country the business operates in, so
   * "Sweifieh" resolves to the Amman district rather than a namesake abroad.
   */
  async searchText(query: string, limit = 6): Promise<PlaceLocation[]> {
    const res = await fetch(TEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key(),
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: limit,
        regionCode: this.config.get<string>('places.regionCode') || undefined,
        languageCode: 'ar',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.log.error(`Places searchText ${res.status}: ${body.slice(0, 400)}`);
      throw new ServiceUnavailableException('Place lookup failed');
    }

    const json = (await res.json()) as {
      places?: {
        id: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      }[];
    };

    // A result without coordinates can't move the map, so it's dropped rather
    // than shown as an option that does nothing when clicked.
    return (json.places ?? [])
      .filter((p) => p.location?.latitude != null && p.location?.longitude != null)
      .map((p) => ({
        placeId: p.id,
        name: p.displayName?.text ?? p.formattedAddress ?? '—',
        address: p.formattedAddress ?? null,
        lat: p.location!.latitude!,
        lng: p.location!.longitude!,
      }));
  }

  /**
   * Phone number for one place. Returns null rather than throwing: a missing
   * phone is normal (small shops often have none) and must not fail the whole
   * search.
   */
  async fetchPhone(placeId: string): Promise<string | null> {
    try {
      const res = await fetch(`${DETAILS_URL}/${placeId}`, {
        headers: {
          'X-Goog-Api-Key': this.key(),
          'X-Goog-FieldMask': 'nationalPhoneNumber,internationalPhoneNumber',
        },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        nationalPhoneNumber?: string;
        internationalPhoneNumber?: string;
      };
      return json.nationalPhoneNumber ?? json.internationalPhoneNumber ?? null;
    } catch (e) {
      this.log.warn(`Places details failed for ${placeId}: ${String(e)}`);
      return null;
    }
  }
}
