/**
 * Built-in fallback layouts: one per voucher kind, each reproducing the 80 mm
 * thermal receipt the dashboard printed before templates existed. They are the
 * fallback when nothing is saved and the starting point the designer offers as
 * "the existing design" (docs/SPEC-print-templates.md §5).
 *
 * The shape is the designer's TemplateLayout: a page (mm) with three zones and
 * elements inside them. Fixed elements (LOGO/TEXT/DIVIDER) are positioned
 * absolutely inside their zone; flow elements (ITEMS_TABLE/TOTALS_BLOCK) stack
 * top to bottom. Both renderers lay a zone out the same way, which is why the
 * built-ins keep every fixed element in the header/footer and only flow
 * elements in the body — a fixed text in the body would sit on top of the
 * table, and a zone's minHeight has to cover its absolutely placed children.
 */
import { ARABIC_KIND_NAMES, DOCUMENT_TYPES, type DocumentType } from './dto/invoice-template.dto';

/** The only element types a built-in may use (the mobile renderer draws no more). */
export const BUILTIN_ELEMENT_TYPES = ['LOGO', 'TEXT', 'DIVIDER', 'ITEMS_TABLE', 'TOTALS_BLOCK', 'QR_CODE'] as const;
export type BuiltinElementType = (typeof BUILTIN_ELEMENT_TYPES)[number];

export type Zone = 'header' | 'body' | 'footer';

export interface BuiltinElement {
  id: string;
  type: BuiltinElementType;
  zone: Zone;
  x: number;
  y: number;
  width: number;
  height: number | null;
  props: Record<string, unknown>;
}

export interface BuiltinLayout {
  version: 1;
  layout: {
    width: number;
    height: number | null;
    unit: 'mm';
    margins: { top: number; right: number; bottom: number; left: number };
    zones: { header: { minHeight: number }; body: { flex: true }; footer: { minHeight: number } };
  };
  elements: BuiltinElement[];
}

/** 80 mm roll, 4 mm margins → 72 mm of printable width. */
const PAGE_WIDTH = 80;
const MARGIN = 4;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

function page(headerMinHeight: number, footerMinHeight: number, elements: BuiltinElement[]): BuiltinLayout {
  return {
    version: 1,
    layout: {
      width: PAGE_WIDTH,
      height: null,
      unit: 'mm',
      margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      zones: {
        header: { minHeight: headerMinHeight },
        body: { flex: true },
        footer: { minHeight: footerMinHeight },
      },
    },
    elements,
  };
}

type TextProps = {
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  direction?: 'ltr' | 'rtl';
  fontFamily?: 'sans' | 'arabic' | 'mono';
  lineHeight?: number;
  color?: string;
};

function text(id: string, zone: Zone, y: number, height: number, content: string, props: TextProps = {}): BuiltinElement {
  return {
    id, type: 'TEXT', zone, x: 0, y, width: CONTENT_WIDTH, height,
    props: { content, fontSize: 9, align: 'left', ...props },
  };
}

function arabic(id: string, zone: Zone, y: number, height: number, content: string, props: TextProps = {}): BuiltinElement {
  return text(id, zone, y, height, content, { align: 'center', direction: 'rtl', fontFamily: 'arabic', ...props });
}

function divider(id: string, zone: Zone, y: number, style: 'solid' | 'dashed' = 'dashed'): BuiltinElement {
  return { id, type: 'DIVIDER', zone, x: 0, y, width: CONTENT_WIDTH, height: 0.5, props: { color: '#000', style } };
}

function logo(id: string): BuiltinElement {
  const width = 30;
  return {
    id, type: 'LOGO', zone: 'header', x: (CONTENT_WIDTH - width) / 2, y: 0, width, height: 12,
    props: { fit: 'contain', align: 'center' },
  };
}

/** Logo + company block, 0 → 32 mm of the header. Every receipt opens with it. */
function companyHeader(p: string): BuiltinElement[] {
  return [
    logo(`${p}_logo`),
    arabic(`${p}_company`, 'header', 13, 6, '{{company.nameAr}}', { fontSize: 12, fontWeight: 'bold' }),
    text(`${p}_tax_no`, 'header', 19.5, 4, 'Tax No: {{company.taxNumber}}', { fontSize: 8, align: 'center' }),
    text(`${p}_tel`, 'header', 23.5, 4, 'Tel: {{company.phone1}}', { fontSize: 8, align: 'center' }),
    arabic(`${p}_address`, 'header', 27.5, 4, '{{company.addressAr}}', { fontSize: 8 }),
    divider(`${p}_div_company`, 'header', 32),
  ];
}

const ITEM_COLUMNS = [
  { key: 'name', labelEn: 'Item', labelAr: 'الصنف', width: 30, align: 'left' },
  { key: 'qty', labelEn: 'Qty', labelAr: 'الكمية', width: 8, align: 'center' },
  { key: 'price', labelEn: 'Price', labelAr: 'السعر', width: 14, align: 'right' },
  { key: 'taxPct', labelEn: 'Tax%', labelAr: 'ضريبة%', width: 8, align: 'right' },
  { key: 'discount', labelEn: 'Disc.', labelAr: 'خصم', width: 10, align: 'right', hide: false },
  { key: 'total', labelEn: 'Total', labelAr: 'الإجمالي', width: 14, align: 'right' },
];

/**
 * The generic receipt: SALE, RETURN, ORDER, PURCHASE, IN, OUT, ADJUSTMENT,
 * TRANSFER_IN, TRANSFER_OUT. Company block, tax-exempt stamp (empty when not
 * exempt), voucher meta, the items table, totals, payments, thank-you line.
 */
function genericReceipt(kind: DocumentType): BuiltinLayout {
  const p = kind.toLowerCase();
  return page(66, 14, [
    ...companyHeader(p),
    text(`${p}_tax_exempt`, 'header', 33, 5, '{{invoice.taxExempt}}', { fontWeight: 'bold', align: 'center' }),
    text(
      `${p}_meta`, 'header', 38.5, 25,
      'Voucher #: {{invoice.number}}\nKind: {{invoice.kindName}}\nDate: {{invoice.date}} {{invoice.time}}\nCreated by: {{invoice.cashier}}\nParty: {{invoice.customer.name}}',
      { lineHeight: 1.5 },
    ),
    divider(`${p}_div_meta`, 'header', 64),
    {
      id: `${p}_items`, type: 'ITEMS_TABLE', zone: 'body', x: 0, y: 0, width: CONTENT_WIDTH, height: null,
      props: { columns: ITEM_COLUMNS },
    },
    {
      id: `${p}_totals`, type: 'TOTALS_BLOCK', zone: 'body', x: 22, y: 2, width: 50, height: null,
      props: {
        rows: [
          { label: 'Items', labelAr: 'عدد الأصناف', value: '{{invoice.itemCount}}' },
          { label: 'Total', labelAr: 'المجموع', value: '{{invoice.subtotal}}' },
          { label: 'Total discount', labelAr: 'إجمالي الخصم', value: '{{invoice.discount}}' },
          { label: 'Total tax', labelAr: 'إجمالي الضريبة', value: '{{invoice.taxTotal}}' },
          { label: 'Net total', labelAr: 'الصافي', value: '{{invoice.total}}', style: 'bold' },
          { label: 'Paid', labelAr: 'المدفوع', value: '{{invoice.paid}}' },
        ],
      },
    },
    text(`${p}_payments`, 'footer', 0, 5, '{{invoice.payments}}', { fontSize: 8 }),
    divider(`${p}_div_footer`, 'footer', 6),
    text(`${p}_thanks`, 'footer', 8, 5, 'Thank you · {{invoice.date}}', { fontSize: 8, align: 'center' }),
  ]);
}

/** Stock → stock transfer: from/to block, a picking-list table, two signature lines. */
function transferNote(): BuiltinLayout {
  const p = 'transfer';
  return page(62, 20, [
    logo(`${p}_logo`),
    arabic(`${p}_company`, 'header', 13, 6, '{{company.nameAr}}', { fontSize: 12, fontWeight: 'bold' }),
    text(`${p}_title`, 'header', 19.5, 6, 'Stock Transfer · تحويل مخزون', { fontSize: 11, fontWeight: 'bold', align: 'center' }),
    divider(`${p}_div_title`, 'header', 26),
    text(
      `${p}_meta`, 'header', 27.5, 20,
      'Voucher #: {{invoice.number}}\nDate: {{invoice.date}} {{invoice.time}}\nCreated by: {{invoice.cashier}}\nItems: {{invoice.itemCount}}',
      { lineHeight: 1.5 },
    ),
    divider(`${p}_div_box_top`, 'header', 48, 'solid'),
    text(`${p}_from`, 'header', 49.5, 5, 'From / من: {{invoice.fromStore}}', { fontWeight: 'bold' }),
    text(`${p}_to`, 'header', 54.5, 5, 'To / إلى: {{invoice.toStore}}', { fontWeight: 'bold' }),
    divider(`${p}_div_box_bottom`, 'header', 60, 'solid'),
    {
      id: `${p}_items`, type: 'ITEMS_TABLE', zone: 'body', x: 0, y: 0, width: CONTENT_WIDTH, height: null,
      props: {
        columns: [
          { key: 'name', labelEn: 'Item', labelAr: 'الصنف', width: 34, align: 'left' },
          { key: 'sku', labelEn: 'SKU', labelAr: 'الرمز', width: 14, align: 'left' },
          { key: 'unit', labelEn: 'Unit', labelAr: 'الوحدة', width: 10, align: 'center' },
          { key: 'qty', labelEn: 'Qty', labelAr: 'الكمية', width: 10, align: 'right' },
        ],
      },
    },
    divider(`${p}_div_footer`, 'footer', 0),
    text(`${p}_sender`, 'footer', 2, 8, 'Sender / المرسل ________'),
    text(`${p}_receiver`, 'footer', 10, 8, 'Receiver / المستلم ________'),
  ]);
}

/** Receipt / payment voucher: the party, one big amount, how it was paid, a signature. */
function paymentVoucher(kind: 'PAYMENT_IN' | 'PAYMENT_OUT'): BuiltinLayout {
  const p = kind.toLowerCase();
  const title = kind === 'PAYMENT_IN' ? `Receipt Voucher · ${ARABIC_KIND_NAMES.PAYMENT_IN}` : `Payment Voucher · ${ARABIC_KIND_NAMES.PAYMENT_OUT}`;
  const party = kind === 'PAYMENT_IN' ? 'Received from / استلمنا من' : 'Paid to / دفعنا إلى';
  return page(78, 28, [
    ...companyHeader(p),
    text(`${p}_title`, 'header', 33, 6, title, { fontSize: 12, fontWeight: 'bold', align: 'center' }),
    divider(`${p}_div_title`, 'header', 39.5),
    text(
      `${p}_meta`, 'header', 41, 15,
      'Voucher #: {{invoice.number}}\nDate: {{invoice.date}} {{invoice.time}}\nCreated by: {{invoice.cashier}}',
      { lineHeight: 1.5 },
    ),
    text(`${p}_party`, 'header', 56, 6, `${party}: {{invoice.customer.name}}`, { fontWeight: 'bold' }),
    divider(`${p}_div_amount_top`, 'header', 62.5, 'solid'),
    text(`${p}_amount_label`, 'header', 64, 4, 'Amount / المبلغ', { fontSize: 8, align: 'center' }),
    text(`${p}_amount`, 'header', 68, 9, '{{invoice.total}}', { fontSize: 16, fontWeight: 'bold', align: 'center' }),
    divider(`${p}_div_amount_bottom`, 'header', 77.5, 'solid'),
    text(`${p}_payment_type`, 'footer', 1.5, 5, 'Payment type / طريقة الدفع: {{invoice.paymentType}}'),
    text(`${p}_reference`, 'footer', 6.5, 5, 'Reference / المرجع: {{invoice.reference}}'),
    text(`${p}_note`, 'footer', 11.5, 8, '{{invoice.note}}', { fontSize: 8 }),
    text(`${p}_signature`, 'footer', 21, 6, 'Signature / التوقيع ________'),
  ]);
}

function build(kind: DocumentType): BuiltinLayout {
  switch (kind) {
    case 'TRANSFER':
      return transferNote();
    case 'PAYMENT_IN':
    case 'PAYMENT_OUT':
      return paymentVoucher(kind);
    default:
      return genericReceipt(kind);
  }
}

/** One built-in layout per voucher kind, built once. */
export const BUILTIN_LAYOUTS: Readonly<Record<DocumentType, BuiltinLayout>> = Object.fromEntries(
  DOCUMENT_TYPES.map((k) => [k, build(k)]),
) as Record<DocumentType, BuiltinLayout>;

export function builtinFor(documentType: DocumentType): BuiltinLayout {
  return BUILTIN_LAYOUTS[documentType];
}
