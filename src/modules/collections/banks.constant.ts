/**
 * Curated list of Jordanian banks — the single source for the cheque "bank"
 * dropdown (web + app). `bankName` on a cheque stays free text (we store the
 * chosen display name), and the UI offers an "Other → free text" escape hatch,
 * so this list can grow without a migration.
 */
export interface BankRef {
  code: string;
  nameAr: string;
  nameEn: string;
}

export const JORDAN_BANKS: BankRef[] = [
  { code: 'ARAB', nameAr: 'البنك العربي', nameEn: 'Arab Bank' },
  { code: 'HBTF', nameAr: 'البنك العربي الإسلامي الدولي / بنك الإسكان', nameEn: 'Housing Bank (HBTF)' },
  { code: 'JOKB', nameAr: 'البنك الأردني الكويتي', nameEn: 'Jordan Kuwait Bank' },
  { code: 'CABK', nameAr: 'بنك القاهرة عمان', nameEn: 'Cairo Amman Bank' },
  { code: 'BOJX', nameAr: 'بنك الأردن', nameEn: 'Bank of Jordan' },
  { code: 'AHLI', nameAr: 'البنك الأهلي الأردني', nameEn: 'Jordan Ahli Bank' },
  { code: 'ETIH', nameAr: 'بنك الاتحاد', nameEn: 'Bank al Etihad' },
  { code: 'CAPB', nameAr: 'بنك المال (كابيتال بنك)', nameEn: 'Capital Bank' },
  { code: 'JCBK', nameAr: 'البنك التجاري الأردني', nameEn: 'Jordan Commercial Bank' },
  { code: 'JIBA', nameAr: 'البنك الإسلامي الأردني', nameEn: 'Jordan Islamic Bank' },
  { code: 'SAFW', nameAr: 'بنك صفوة الإسلامي', nameEn: 'Safwa Islamic Bank' },
  { code: 'ABCJ', nameAr: 'بنك ABC (الأردن)', nameEn: 'ABC Bank (Jordan)' },
  { code: 'INVB', nameAr: 'بنك الاستثمار العربي الأردني', nameEn: 'Invest Bank' },
  { code: 'SGBJ', nameAr: 'سوسيته جنرال - الأردن', nameEn: 'Societe Generale Jordan' },
  { code: 'ARBK', nameAr: 'البنك العقاري المصري العربي', nameEn: 'Egyptian Arab Land Bank' },
  { code: 'AUDI', nameAr: 'بنك عودة', nameEn: 'Bank Audi' },
  { code: 'CBIJ', nameAr: 'البنك التجاري الدولي', nameEn: 'National Bank of Kuwait (NBK)' },
  { code: 'RAJH', nameAr: 'مصرف الراجحي', nameEn: 'Al Rajhi Bank' },
  { code: 'CBRO', nameAr: 'البنك المركزي الأردني', nameEn: 'Central Bank of Jordan' },
];
