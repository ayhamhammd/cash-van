import type { ProspectStatus } from './entities/prospect.entity';

/** Pipeline order, also used for DTO validation. */
export const PROSPECT_STATUSES = [
  'NEW',
  'QUOTED',
  'CONTACTED',
  'CONVERTED',
  'REJECTED',
] as const satisfies readonly ProspectStatus[];

/**
 * Google Places types offered in the UI. Restricted to an allow-list so an
 * arbitrary string can't be forwarded to the paid Places API — and because
 * `searchNearby` rejects the *whole* request when one type is unknown, an
 * unvetted string would fail the search outright rather than just narrow it.
 *
 * Kept flat (that is what the API takes); the comments only group it for
 * reading. Every entry here is a Places API (New) "Table A" type. When adding
 * one, add its `prospecting.cat.<type>` label to the dashboard dictionary too —
 * the picker falls back to a humanized key, which reads poorly in Arabic.
 */
export const PROSPECT_CATEGORIES = [
  // Retail — the core of a distributor's route
  'supermarket',
  'grocery_store',
  'convenience_store',
  'food_store',
  'asian_grocery_store',
  'butcher_shop',
  'wholesaler',
  'warehouse_store',
  'market',
  'shopping_mall',
  'department_store',
  'discount_store',
  'liquor_store',
  'store',
  'gift_shop',
  'pet_store',
  'florist',
  'book_store',
  'clothing_store',
  'shoe_store',
  'jewelry_store',
  'electronics_store',
  'cell_phone_store',
  'hardware_store',
  'home_goods_store',
  'home_improvement_store',
  'furniture_store',
  'sporting_goods_store',
  'bicycle_store',
  'auto_parts_store',

  // Food & drink — HORECA
  'restaurant',
  'cafe',
  'coffee_shop',
  'bakery',
  'confectionery',
  'candy_store',
  'chocolate_shop',
  'dessert_shop',
  'donut_shop',
  'ice_cream_shop',
  'juice_shop',
  'fast_food_restaurant',
  'hamburger_restaurant',
  'pizza_restaurant',
  'sandwich_shop',
  'chicken_restaurant',
  'barbecue_restaurant',
  'seafood_restaurant',
  'steak_house',
  'breakfast_restaurant',
  'brunch_restaurant',
  'buffet_restaurant',
  'cafeteria',
  'deli',
  'diner',
  'food_court',
  'meal_delivery',
  'meal_takeaway',
  'catering_service',
  'tea_house',
  'bar',
  'pub',
  'bar_and_grill',
  'wine_bar',
  'night_club',
  'middle_eastern_restaurant',
  'mediterranean_restaurant',
  'lebanese_restaurant',
  'turkish_restaurant',
  'italian_restaurant',
  'asian_restaurant',
  'chinese_restaurant',
  'japanese_restaurant',
  'sushi_restaurant',
  'indian_restaurant',
  'thai_restaurant',
  'korean_restaurant',
  'mexican_restaurant',
  'american_restaurant',
  'french_restaurant',
  'greek_restaurant',
  'vegetarian_restaurant',
  'vegan_restaurant',

  // Lodging
  'hotel',
  'resort_hotel',
  'extended_stay_hotel',
  'motel',
  'hostel',
  'guest_house',
  'bed_and_breakfast',
  'lodging',
  'campground',
  'rv_park',

  // Health & personal care
  'pharmacy',
  'drugstore',
  'hospital',
  'doctor',
  'dental_clinic',
  'dentist',
  'medical_lab',
  'physiotherapist',
  'veterinary_care',
  'spa',
  'beauty_salon',
  'hair_salon',
  'hair_care',
  'barber_shop',

  // Education
  'school',
  'primary_school',
  'secondary_school',
  'preschool',
  'university',
  'library',

  // Sports & leisure
  'gym',
  'fitness_center',
  'sports_club',
  'sports_complex',
  'stadium',
  'swimming_pool',
  'golf_course',
  'bowling_alley',
  'amusement_park',
  'movie_theater',
  'casino',
  'zoo',
  'aquarium',
  'park',
  'tourist_attraction',
  'museum',
  'art_gallery',
  'event_venue',
  'banquet_hall',
  'wedding_venue',
  'community_center',
  'convention_center',
  'cultural_center',

  // Transport & automotive
  'gas_station',
  'electric_vehicle_charging_station',
  'car_dealer',
  'car_rental',
  'car_repair',
  'car_wash',
  'rest_stop',
  'truck_stop',
  'airport',
  'bus_station',
  'train_station',
  'subway_station',
  'transit_station',
  'taxi_stand',
  'parking',
  'marina',

  // Services & offices
  'bank',
  'atm',
  'accounting',
  'insurance_agency',
  'real_estate_agency',
  'travel_agency',
  'courier_service',
  'moving_company',
  'storage',
  'laundry',
  'tailor',
  'locksmith',
  'lawyer',
  'consultant',
  'corporate_office',
  'child_care_agency',
  'post_office',
  'local_government_office',
  'city_hall',
  'police',
  'fire_station',
  'embassy',
  'courthouse',

  // Places of worship
  'mosque',
  'church',
] as const;

export type ProspectCategory = (typeof PROSPECT_CATEGORIES)[number];

/**
 * The handful shown as one-tap chips before the picker is opened. Everything
 * else lives behind the dialog's search — a flat wall of 190 chips is not a
 * usable control.
 */
export const PROSPECT_FEATURED_CATEGORIES = [
  'supermarket',
  'grocery_store',
  'convenience_store',
  'shopping_mall',
  'wholesaler',
  'liquor_store',
  'gas_station',
  'restaurant',
  'cafe',
] as const satisfies readonly ProspectCategory[];

/**
 * Places caps `includedTypes` per nearby request; asking for more is a 400 on
 * the whole search, so the DTO rejects it before we spend a call finding out.
 */
export const PROSPECT_MAX_CATEGORIES = 50;

/**
 * How many of the rep's own terms one run may carry. Unlike categories — which
 * ride along in a single nearby call — each term costs its own Text Search, so
 * this cap is about the bill, not about what the API will accept.
 */
export const PROSPECT_MAX_KEYWORDS = 5;
