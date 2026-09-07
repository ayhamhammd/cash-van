# Print templates — the contract shared by API, dashboard and mobile

One template system prints every voucher the company issues: the admin designs a
layout per voucher kind in the dashboard's Template Designer, marks one as the
default (or pins one to a store), and both the dashboard and the salesman's app
print that layout. This file is the contract the three sides agree on.

## 1. Document types = voucher kinds

`documentType` on a template is the voucher's `transKind`:

| documentType | Arabic | notes |
|---|---|---|
| SALE | سند بيع | |
| RETURN | سند مرتجع | |
| ORDER | طلبية | |
| TRANSFER | سند تحويل | stock → stock; has `fromStore` / `toStore` |
| TRANSFER_IN | تحميل المركبة | |
| TRANSFER_OUT | تنزيل المركبة | |
| IN | إدخال للمخزن | |
| OUT | إخراج من المخزن | |
| PURCHASE | سند شراء | |
| ADJUSTMENT | تسوية | |
| PAYMENT_IN | سند قبض | money in; totals = amount |
| PAYMENT_OUT | سند صرف | money out |

## 2. Resolution

`GET /invoice-templates/resolve?documentType=SALE&branchId=<warehouse id>`
returns, in order: the template pinned to that store → the global default for
the kind → the built-in layout (`id: null`). `branchId` is the warehouse **id**;
`storeNumber=<whNumber>` is accepted as an alternative and looked up.

`GET /invoice-templates/resolve-all?storeNumber=VAN1` returns every kind at
once, for a device to cache:

```json
{ "templates": { "SALE": {…}, "RETURN": {…}, "TRANSFER": {…}, … },
  "version": "2026-09-07T10:00:00.000Z" }
```

`version` is the newest `updatedAt` among saved templates (or `"builtin"`).
A device keeps the whole object in its settings store and refreshes it after
login and, best effort, when a print screen opens. Offline printing uses the
cached copy; with nothing cached the app falls back to its own receipt.

`GET /invoice-templates/builtin/:documentType` returns the built-in layout so
the designer can open "the existing design" and save it as a new template.

## 3. Template JSON

```ts
interface Template {
  id: string | null;            // null = built-in
  name: string;
  documentType: DocumentType;   // §1
  paperSize: "A4" | "A5" | "THERMAL_80";   // 210 / 148 / 80 mm wide
  isDefault: boolean;
  branchId: string | null;
  layout: {
    version: 1;
    layout: {
      width: number; height: number | null; unit: "mm";
      margins: { top; right; bottom; left };            // mm
      zones: { header: { minHeight }; body: { flex: true }; footer: { minHeight } };
    };
    elements: Element[];
  };
}
interface Element {
  id: string;
  type: "LOGO" | "TEXT" | "DIVIDER" | "SPACER" | "ITEMS_TABLE" | "TOTALS_BLOCK"
      | "QR_CODE" | "TAX_INVOICE" | "REPORT_TABLE" | "SHIFTS_TABLE";
  zone: "header" | "body" | "footer";
  x: number; y: number; width: number; height: number | null;   // mm, inside the zone
  props: {
    // TEXT
    content?: string;               // may contain {{tokens}} and "\n"
    fontSize?: number;              // pt (default 10)
    fontWeight?: "normal" | "bold";
    align?: "left" | "center" | "right";
    direction?: "ltr" | "rtl";
    color?: string;                 // css hex; thermal printers print black
    fontFamily?: "sans" | "arabic" | "mono";
    lineHeight?: number;            // default 1.4
    // LOGO
    fit?: "contain" | "cover" | "fill";   // + align
    // ITEMS_TABLE
    columns?: { key; labelEn; labelAr; width; align; hide? }[];
    // TOTALS_BLOCK
    rows?: { label; labelAr; value; style?: "bold" | "normal"; hide? }[];  // value holds a token
    // QR_CODE
    data?: string;                  // token or literal; an image URL/data: URL is drawn as-is
    // DIVIDER
    style?: "solid" | "dashed" | "dotted";
  };
}
```

**Layout semantics (both renderers must match):**

- The page is the three zones stacked: header (at least `minHeight`), body
  (grows with content), footer (at least `minHeight`). Page padding = margins.
- Elements with a fixed `height` are positioned absolutely at (`x`, `y`) inside
  their zone. `LOGO`, `TEXT`, `DIVIDER`, `SPACER`, `QR_CODE` are always fixed.
- `ITEMS_TABLE`, `TOTALS_BLOCK`, `TAX_INVOICE`, `REPORT_TABLE`, `SHIFTS_TABLE`
  are **flow** elements: laid out top to bottom in element order inside the
  zone, each shifted by its (`x`, `y`) relative to where the flow put it, with
  the given `width`. Their height is their content.
- `width` is the box width in mm; text wraps inside it; overflow is clipped.
- Font size is points: 1 pt = 25.4/72 mm.
- A renderer may ignore `color` on a monochrome device.
- **Convention for authored layouts:** a zone's height is only a *minimum*, and
  fixed elements do not push flow elements down. So put fixed elements (text,
  logo, dividers) in the header and footer, and flow elements (tables, totals)
  in the body; size the header/footer `minHeight` to cover their children. The
  built-ins follow this and the designer should nudge authors the same way.

## 4. Placeholder tokens

`{{token}}` inside `content`, `rows[].value` and `data`. Unknown tokens render
as an empty string. Money tokens are formatted with the company decimals
(3 for JOD) and the currency code.

| token | meaning |
|---|---|
| company.nameAr / company.nameEn / company.taxNumber / company.addressAr / company.addressEn / company.phone1 / company.phone2 / company.email / company.website / company.footerNote / company.footerNoteAr | company profile |
| branch.name / branch.address / branch.phone | the store the voucher belongs to |
| invoice.number | voucher number |
| invoice.kind | transKind code |
| invoice.kindName | the kind's Arabic name (§1) |
| invoice.date / invoice.time | `YYYY-MM-DD` / `HH:mm` |
| invoice.cashier | who created it (user code / salesman name) |
| invoice.customer.name / invoice.customer.number / invoice.customer.phone / invoice.customer.taxNumber / invoice.customer.address | party |
| invoice.store / invoice.fromStore / invoice.toStore | store names (TRANSFER uses from/to) |
| invoice.reference | referenced voucher (original sale for a return, order for a sale, supplier invoice for a purchase) |
| invoice.note | free note |
| invoice.itemCount | number of lines |
| invoice.subtotal / invoice.discount / invoice.taxTotal / invoice.total / invoice.paid / invoice.change | money |
| invoice.payments | "CASH: 6.500 JOD  CARD: …" |
| invoice.paymentType | the (first) payment type |
| invoice.taxExempt | the stamp text when the voucher is tax-exempt, else empty |
| invoice.taxExemptionNumber | |
| invoice.qrData | tax QR payload/image when present |

Items table column keys: `name`, `sku`, `barcode`, `qty`, `unit`, `price`,
`taxPct`, `discount`, `tax`, `total`. A gift line (100 % discounted) prints
`name` with the suffix " (هدية)".

## 5. Built-in layouts

The API ships one built-in layout per kind reproducing the receipt each surface
printed before templates existed (80 mm thermal). They are the fallback when
nothing is saved and the starting point the designer offers as "the existing
design". Editing one and saving creates a new row; built-ins are never
modified.
