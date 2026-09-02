/**
 * Built-in fallback layouts, used when no template is saved for a document
 * type. The shape is the designer's TemplateLayout: a page (mm) with three
 * zones and absolutely positioned elements. Kept in sync with the frontend
 * render engine, which is the only consumer of the element props.
 */

export const BUILTIN_INVOICE = {
  version: 1,
  layout: {
    width: 210,
    height: 297,
    unit: 'mm',
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    zones: {
      header: { minHeight: 45 },
      body: { flex: true },
      footer: { minHeight: 20 },
    },
  },
  elements: [
    {
      id: 'bi_logo',
      type: 'LOGO',
      zone: 'header', x: 0, y: 0, width: 30, height: 20,
      props: { fit: 'contain', align: 'left' },
    },
    {
      id: 'bi_name_en',
      type: 'TEXT',
      zone: 'header', x: 35, y: 2, width: 100, height: 8,
      props: { content: '{{company.nameEn}}', fontSize: 14, fontWeight: 'bold', align: 'left' },
    },
    {
      id: 'bi_name_ar',
      type: 'TEXT',
      zone: 'header', x: 35, y: 11, width: 100, height: 7,
      props: { content: '{{company.nameAr}}', fontSize: 12, fontWeight: 'bold', align: 'right', direction: 'rtl', fontFamily: 'arabic' },
    },
    {
      id: 'bi_tax_no',
      type: 'TEXT',
      zone: 'header', x: 35, y: 20, width: 100, height: 5,
      props: { content: 'VAT: {{company.taxNumber}}', fontSize: 8, align: 'left', color: '#555' },
    },
    {
      id: 'bi_inv_meta',
      type: 'TEXT',
      zone: 'header', x: 140, y: 2, width: 60, height: 30,
      props: { content: 'Invoice: {{invoice.number}}\nDate: {{invoice.date}}\nCashier: {{invoice.cashier}}', fontSize: 9, align: 'right', lineHeight: 1.6 },
    },
    {
      id: 'bi_div1',
      type: 'DIVIDER',
      zone: 'header', x: 0, y: 42, width: 190, height: 0.5,
      props: { color: '#ccc', style: 'solid' },
    },
    {
      id: 'bi_table',
      type: 'ITEMS_TABLE',
      zone: 'body', x: 0, y: 0, width: 190, height: null,
      props: {
        columns: [
          { key: 'name', labelEn: 'Item', labelAr: 'الصنف', width: 80, align: 'left' },
          { key: 'qty', labelEn: 'Qty', labelAr: 'الكمية', width: 20, align: 'center', hide: false },
          { key: 'price', labelEn: 'Price', labelAr: 'السعر', width: 40, align: 'right', hide: false },
          { key: 'discount', labelEn: 'Disc.', labelAr: 'خصم', width: 20, align: 'right', hide: false },
          { key: 'total', labelEn: 'Total', labelAr: 'المجموع', width: 30, align: 'right' },
        ],
      },
    },
    {
      id: 'bi_totals',
      type: 'TOTALS_BLOCK',
      zone: 'body', x: 110, y: null, width: 80, height: null,
      props: {
        rows: [
          { label: 'Subtotal', labelAr: 'المجموع الفرعي', value: '{{invoice.subtotal}}' },
          { label: 'Discount', labelAr: 'الخصم', value: '{{invoice.discount}}' },
          { label: 'VAT', labelAr: 'الضريبة', value: '{{invoice.taxTotal}}' },
          { label: 'TOTAL', labelAr: 'الإجمالي', value: '{{invoice.total}}', style: 'bold' },
          { label: 'Paid', labelAr: 'المدفوع', value: '{{invoice.paid}}', hide: false },
          { label: 'Change', labelAr: 'الفكة', value: '{{invoice.change}}', hide: false },
        ],
      },
    },
    {
      id: 'bi_div2',
      type: 'DIVIDER',
      zone: 'footer', x: 0, y: 0, width: 190, height: 0.5,
      props: { color: '#ccc', style: 'dashed' },
    },
    {
      id: 'bi_footer',
      type: 'TEXT',
      zone: 'footer', x: 0, y: 3, width: 190, height: 8,
      props: { content: '{{company.footerNote}}', fontSize: 8, align: 'center', color: '#777' },
    },
    {
      // JoFotara tax-invoice + QR block — self-hiding when no accepted e-invoice.
      id: 'bi_tax_invoice',
      type: 'TAX_INVOICE',
      zone: 'footer', x: 0, y: 12, width: 190, height: 36,
      props: {},
    },
  ],
};

/** 60 mm weight-item label. */
export const BUILTIN_SCALE_LABEL = {
  version: 1,
  layout: {
    width: 60,
    height: null,
    unit: 'mm',
    margins: { top: 2, right: 2, bottom: 2, left: 2 },
    zones: {
      header: { minHeight: 16 },
      body: { flex: true },
      footer: { minHeight: 10 },
    },
  },
  elements: [
    {
      id: 'sl_name_ar', type: 'TEXT',
      zone: 'header', x: 0, y: 0, width: 56, height: 6,
      props: { content: '{{scale.productNameAr}}', fontSize: 11, fontWeight: 'bold', align: 'center', direction: 'rtl', fontFamily: 'arabic' },
    },
    {
      id: 'sl_name_en', type: 'TEXT',
      zone: 'header', x: 0, y: 6, width: 56, height: 5,
      props: { content: '{{scale.productNameEn}}', fontSize: 9, align: 'center' },
    },
    {
      id: 'sl_div1', type: 'DIVIDER',
      zone: 'header', x: 0, y: 12, width: 56, height: 0.5,
      props: { color: '#ccc', style: 'solid' },
    },
    {
      id: 'sl_weight', type: 'TEXT',
      zone: 'body', x: 0, y: 0, width: 56, height: 5,
      props: { content: 'الوزن / Weight: {{scale.weight}} {{scale.weightUnit}}', fontSize: 9, align: 'left' },
    },
    {
      id: 'sl_price', type: 'TEXT',
      zone: 'body', x: 0, y: 5, width: 56, height: 5,
      props: { content: 'السعر / Price: {{scale.unitPrice}}/{{scale.weightUnit}}', fontSize: 9, align: 'left' },
    },
    {
      id: 'sl_total', type: 'TEXT',
      zone: 'body', x: 0, y: 10, width: 56, height: 6,
      props: { content: 'الإجمالي / Total: {{scale.totalPrice}}', fontSize: 10, fontWeight: 'bold', align: 'left' },
    },
    {
      id: 'sl_barcode', type: 'TEXT',
      zone: 'footer', x: 0, y: 0, width: 56, height: 6,
      props: { content: '{{scale.barcode}}', fontSize: 10, fontFamily: 'mono', align: 'center' },
    },
    {
      id: 'sl_date', type: 'TEXT',
      zone: 'footer', x: 0, y: 6, width: 56, height: 4,
      props: { content: '{{scale.date}}', fontSize: 7, align: 'center', color: '#777' },
    },
  ],
};

/**
 * Single product-barcode label, sized to tile 3 × 10 on an A4 sheet (~62 × 26 mm
 * with an 8 mm page margin and 4 mm gaps). The frontend repeats it per
 * item × copies in a CSS grid.
 */
export const BUILTIN_BARCODE_LABEL = {
  version: 1,
  layout: {
    width: 62,
    height: 26,
    unit: 'mm',
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    zones: {
      header: { minHeight: 9 },
      body: { flex: true },
      footer: { minHeight: 5 },
    },
  },
  elements: [
    {
      id: 'bl_name_ar', type: 'TEXT',
      zone: 'header', x: 0, y: 0, width: 60, height: 5,
      props: { content: '{{barcode.nameAr}}', fontSize: 8, fontWeight: 'bold', align: 'center', direction: 'rtl', fontFamily: 'arabic' },
    },
    {
      id: 'bl_name_en', type: 'TEXT',
      zone: 'header', x: 0, y: 5, width: 60, height: 4,
      props: { content: '{{barcode.nameEn}}', fontSize: 7, align: 'center' },
    },
    {
      id: 'bl_image', type: 'TEXT',
      // Explicit height: the barcode SVG is width/height 100%, which only
      // resolves against a parent with a definite height.
      zone: 'body', x: 0, y: 0, width: 60, height: 10,
      props: { content: '{{barcode.image}}', fontSize: 9, align: 'center' },
    },
    {
      id: 'bl_sku', type: 'TEXT',
      zone: 'footer', x: 0, y: 0, width: 30, height: 5,
      props: { content: '{{barcode.sku}}', fontSize: 7, fontFamily: 'mono', align: 'left' },
    },
    {
      id: 'bl_price', type: 'TEXT',
      zone: 'footer', x: 30, y: 0, width: 30, height: 5,
      props: { content: '{{barcode.price}}', fontSize: 8, fontWeight: 'bold', align: 'right' },
    },
  ],
};
