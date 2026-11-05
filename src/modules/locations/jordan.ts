/**
 * Jordan and its twelve governorates, with their ISO 3166-2 codes — the same
 * codes JoFotara takes as a buyer's `cityCode`. Seeded by
 * POST /locations/seed-jordan; areas are never seeded.
 */
export const JORDAN = { nameAr: 'الأردن', nameEn: 'Jordan', code: 'JO' } as const;

export const JORDAN_GOVERNORATES: ReadonlyArray<{ code: string; nameAr: string; nameEn: string }> = [
  { code: 'JO-AM', nameAr: 'عمّان', nameEn: 'Amman' },
  { code: 'JO-IR', nameAr: 'إربد', nameEn: 'Irbid' },
  { code: 'JO-AZ', nameAr: 'الزرقاء', nameEn: 'Zarqa' },
  { code: 'JO-BA', nameAr: 'البلقاء', nameEn: 'Balqa' },
  { code: 'JO-MA', nameAr: 'المفرق', nameEn: 'Mafraq' },
  { code: 'JO-JA', nameAr: 'جرش', nameEn: 'Jerash' },
  { code: 'JO-AJ', nameAr: 'عجلون', nameEn: 'Ajloun' },
  { code: 'JO-MD', nameAr: 'مادبا', nameEn: 'Madaba' },
  { code: 'JO-KA', nameAr: 'الكرك', nameEn: 'Karak' },
  { code: 'JO-AT', nameAr: 'الطفيلة', nameEn: 'Tafilah' },
  { code: 'JO-MN', nameAr: 'معان', nameEn: "Ma'an" },
  { code: 'JO-AQ', nameAr: 'العقبة', nameEn: 'Aqaba' },
];
