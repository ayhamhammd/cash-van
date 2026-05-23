# Jordan Sales Tax — Calculation, Accounting & JoFotara Integration
## Complete Technical Specification — Node.js / TypeScript

---

## 1. Project Setup

```bash
mkdir jordan-tax-service && cd jordan-tax-service
npm init -y

# Runtime dependencies
npm install axios uuid dayjs

# Dev dependencies
npm install -D typescript ts-node @types/node @types/uuid nodemon

# Init TypeScript
npx tsc --init
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `package.json` scripts
```json
{
  "scripts": {
    "dev":   "nodemon --exec ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

### Project structure
```
src/
├── constants/
│   └── tax.constants.ts
├── models/
│   └── invoice.models.ts
├── services/
│   ├── tax-calculator.service.ts
│   ├── jofotara-builder.service.ts
│   ├── jofotara-api.service.ts
│   ├── tax-ledger.service.ts
│   └── invoice.service.ts
├── utils/
│   └── currency.utils.ts
└── index.ts
```

---

## 2. Constants — `src/constants/tax.constants.ts`

```typescript
export enum TaxType {
  TAXABLE   = 'TAXABLE',    // Tax added on top — price excludes tax
  INCLUSIVE = 'INCLUSIVE',  // Tax embedded in price — extract internally
  EXEMPT    = 'EXEMPT',     // No tax applied
}

export enum DiscountType {
  PERCENTAGE   = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
}

export enum PaymentMethod {
  CASH       = '012',
  RECEIVABLE = '022',
}

export enum InvoiceType {
  GENERAL_SALE  = '011',
  SPECIAL_SALE  = '021',
  CREDIT_NOTE   = '381',   // Return / credit invoice
}

export enum TaxCategory {
  STANDARD  = 'S',   // 16%
  ZERO_RATED = 'Z',  // 0%  — exports, basic foods
  EXEMPT    = 'E',   // 0%  — healthcare, education, medicines
}

export enum JoFotaraStatus {
  PENDING   = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  VALIDATED = 'VALIDATED',
  REJECTED  = 'REJECTED',
  ERROR     = 'ERROR',
}

export enum LedgerEntryType {
  SALE   = 'SALE',
  RETURN = 'RETURN',
}

export const JordanTax = {
  STANDARD_RATE      : 0.16,       // 16%
  FILS_DECIMALS      : 3,          // JOD precision
  ARCHIVE_YEARS      : 4,
  BUYER_ID_THRESHOLD : 10_000,     // JOD — buyer ID required above this
  DATE_FORMAT        : 'DD-MM-YYYY',
} as const;

export const TaxCategoryRates: Record<TaxCategory, number> = {
  [TaxCategory.STANDARD]   : 0.16,
  [TaxCategory.ZERO_RATED] : 0.00,
  [TaxCategory.EXEMPT]     : 0.00,
};
```

---

## 3. Models — `src/models/invoice.models.ts`

```typescript
import {
  TaxType, DiscountType, PaymentMethod, InvoiceType,
  TaxCategory, JoFotaraStatus, LedgerEntryType,
} from '../constants/tax.constants';

// ─── Input Models ─────────────────────────────────────────────────────────────

export interface InvoiceItem {
  id                : string;
  productName       : string;
  productCode       : string;
  taxType           : TaxType;
  taxRate           : number;           // decimal: 0.16 for 16%
  taxCategory       : TaxCategory;
  quantity          : number;
  unitPrice         : number;
  unitOfMeasure     ?: string;          // default: 'PCE'
  lineDiscountType  ?: DiscountType;    // default: PERCENTAGE
  lineDiscountValue ?: number;          // default: 0
}

export interface InvoiceDiscount {
  type  : DiscountType;
  value : number;
}

export interface Buyer {
  name     : string;
  tin      ?: string;    // Tax ID — required B2B or if total >= 10,000 JOD
  nin      ?: string;    // National ID
  pn       ?: string;    // Passport number
  phone    ?: string;
  address  ?: string;
  cityCode ?: string;    // e.g. 'JO-IR' for Irbid
}

export interface Seller {
  name    : string;
  tin     : string;      // Tax registration number (required)
  address ?: string;
  phone   ?: string;
}

// ─── Calculation Results ──────────────────────────────────────────────────────

export interface LineCalculation {
  item                 : InvoiceItem;
  subtotal             : number;
  lineDiscountAmount   : number;
  netAfterLineDiscount : number;
  taxableBase          : number;   // net before tax (0 for EXEMPT)
  taxAmount            : number;
  lineTotal            : number;
}

export interface InvoiceSummary {
  invoiceId                 : string;
  invoiceUuid               : string;
  issueDate                 : Date;
  invoiceType               : InvoiceType;
  paymentMethod             : PaymentMethod;
  seller                    : Seller;
  buyer                     : Buyer;
  lines                     : LineCalculation[];

  // Totals
  subtotalBeforeDiscounts   : number;
  totalLineDiscounts        : number;
  netAfterLineDiscounts     : number;
  invoiceDiscountAmount     : number;

  // Nets by type (after invoice discount)
  netTaxable                : number;
  netInclusive              : number;
  netExempt                 : number;

  // Tax
  taxOnTaxable              : number;
  taxExtractedFromInclusive : number;
  totalTax                  : number;
  grandTotal                : number;

  // JoFotara tracking
  jofotaraStatus            : JoFotaraStatus;
  jofotaraQrCode            ?: string;
  jofotaraRegistrationNum   ?: string;
  notes                     ?: string;
}

// ─── Return / Credit Note ─────────────────────────────────────────────────────

export interface ReturnItem {
  originalItem   : InvoiceItem;
  returnQuantity : number;
  reason         ?: string;
}

export interface CreditNoteSummary {
  creditNoteId              : string;
  creditNoteUuid            : string;
  issueDate                 : Date;
  originalInvoiceId         : string;
  originalInvoiceUuid       : string;
  originalInvoiceDate       : Date;
  reasonForReturn           : string;
  seller                    : Seller;
  buyer                     : Buyer;
  lines                     : LineCalculation[];

  subtotalBeforeDiscounts   : number;
  totalLineDiscounts        : number;
  netAfterLineDiscounts     : number;
  totalReturnTax            : number;
  grandReturnTotal          : number;

  jofotaraStatus            : JoFotaraStatus;
  jofotaraQrCode            ?: string;
}

// ─── Tax Ledger ───────────────────────────────────────────────────────────────

export interface TaxLedgerEntry {
  entryId                   : string;
  entryType                 : LedgerEntryType;
  documentNumber            : string;
  referenceDocumentNumber   ?: string;
  entryDate                 : Date;
  buyerName                 : string;
  buyerTin                  ?: string;
  taxableAmount             : number;   // negative for returns
  taxAmount                 : number;   // negative for returns
  grandTotal                : number;   // negative for returns
  jofotaraStatus            : JoFotaraStatus;
  qrCode                    ?: string;
  createdAt                 : Date;
}

export interface PeriodTaxSummary {
  periodFrom       : Date;
  periodTo         : Date;
  totalSales       : number;
  totalSalesTax    : number;
  totalReturns     : number;   // negative
  totalReturnsTax  : number;   // negative
  netOutputTax     : number;   // payable to ISTD
  invoiceCount     : number;
  creditNoteCount  : number;
}

// ─── API Models ───────────────────────────────────────────────────────────────

export interface JoFotaraCredentials {
  clientId    : string;
  secretKey   : string;
  sandboxMode ?: boolean;
}

export interface JoFotaraResponse {
  success            : boolean;
  qrCode             ?: string;
  registrationNumber ?: string;
  errorCode          ?: string;
  errorMessage       ?: string;
}

export interface ValidationError {
  field   : string;
  message : string;
}
```

---

## 4. Currency Utilities — `src/utils/currency.utils.ts`

```typescript
import { JordanTax } from '../constants/tax.constants';

/**
 * Rounds to 3 decimal places (Jordanian fils precision).
 * Apply only at display/storage layer, never during intermediate calculations.
 */
export const toFils = (value: number): number =>
  Math.round(value * 1_000) / 1_000;

/**
 * Formats a number as a JOD string with 3 decimal places.
 */
export const formatJOD = (value: number): string =>
  value.toFixed(JordanTax.FILS_DECIMALS);

/**
 * Clamps a value between min and max.
 */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Returns 0 safely — prevents -0 in outputs.
 */
export const safeZero = (value: number): number => value === 0 ? 0 : value;
```

---

## 5. Tax Calculator — `src/services/tax-calculator.service.ts`

```typescript
import { v4 as uuidv4 } from 'uuid';
import {
  TaxType, DiscountType, PaymentMethod, InvoiceType, JoFotaraStatus,
  LedgerEntryType,
} from '../constants/tax.constants';
import {
  InvoiceItem, InvoiceDiscount, Buyer, Seller,
  LineCalculation, InvoiceSummary, ReturnItem, CreditNoteSummary,
} from '../models/invoice.models';
import { clamp } from '../utils/currency.utils';

export class TaxCalculatorService {

  // ── Public API ─────────────────────────────────────────────────────────────

  calculateLine(item: InvoiceItem): LineCalculation {
    const qty   = item.quantity  ?? 0;
    const price = item.unitPrice ?? 0;
    const rate  = item.taxRate   ?? 0;

    const subtotal         = qty * price;
    const lineDiscountAmt  = this.computeDiscount(
      subtotal,
      item.lineDiscountType  ?? DiscountType.PERCENTAGE,
      item.lineDiscountValue ?? 0,
    );
    const net = subtotal - lineDiscountAmt;

    switch (item.taxType) {
      case TaxType.TAXABLE: {
        const tax = net * rate;
        return {
          item, subtotal,
          lineDiscountAmount   : lineDiscountAmt,
          netAfterLineDiscount : net,
          taxableBase          : net,
          taxAmount            : tax,
          lineTotal            : net + tax,
        };
      }

      case TaxType.INCLUSIVE: {
        // Tax is embedded: extract it
        // tax = net × r / (1 + r)
        const tax     = net * (rate / (1 + rate));
        const basePre = net - tax;
        return {
          item, subtotal,
          lineDiscountAmount   : lineDiscountAmt,
          netAfterLineDiscount : net,
          taxableBase          : basePre,
          taxAmount            : tax,
          lineTotal            : net,           // unchanged — tax already inside
        };
      }

      case TaxType.EXEMPT:
      default: {
        return {
          item, subtotal,
          lineDiscountAmount   : lineDiscountAmt,
          netAfterLineDiscount : net,
          taxableBase          : 0,
          taxAmount            : 0,
          lineTotal            : net,
        };
      }
    }
  }

  calculateInvoice(
    invoiceId      : string,
    seller         : Seller,
    buyer          : Buyer,
    items          : InvoiceItem[],
    invoiceDiscount: InvoiceDiscount = { type: DiscountType.PERCENTAGE, value: 0 },
    paymentMethod  : PaymentMethod   = PaymentMethod.CASH,
    invoiceType    : InvoiceType     = InvoiceType.GENERAL_SALE,
    notes          ?: string,
  ): InvoiceSummary {

    const lines = items.map(item => this.calculateLine(item));

    const subtotalBeforeDiscounts = this.sum(lines, l => l.subtotal);
    const totalLineDiscounts      = this.sum(lines, l => l.lineDiscountAmount);

    const sumNetT   = this.netByType(lines, TaxType.TAXABLE);
    const sumNetI   = this.netByType(lines, TaxType.INCLUSIVE);
    const sumNetE   = this.netByType(lines, TaxType.EXEMPT);
    const sumNetAll = sumNetT + sumNetI + sumNetE;

    const invDisc = this.computeDiscount(sumNetAll, invoiceDiscount.type, invoiceDiscount.value);

    const discT = this.proportional(invDisc, sumNetT, sumNetAll);
    const discI = this.proportional(invDisc, sumNetI, sumNetAll);
    const discE = this.proportional(invDisc, sumNetE, sumNetAll);

    const finalT = sumNetT - discT;
    const finalI = sumNetI - discI;
    const finalE = sumNetE - discE;

    // Re-calculate tax per-line after invoice discount (respects individual rates)
    const taxOnT = this.recalcTax(lines, TaxType.TAXABLE, finalT, sumNetT,
      (net, rate) => net * rate);

    const taxInI = this.recalcTax(lines, TaxType.INCLUSIVE, finalI, sumNetI,
      (net, rate) => net * (rate / (1 + rate)));

    const totalTax   = taxOnT + taxInI;
    const grandTotal = finalT + taxOnT + finalI + finalE;

    return {
      invoiceId,
      invoiceUuid               : uuidv4(),
      issueDate                 : new Date(),
      invoiceType,
      paymentMethod,
      seller,
      buyer,
      lines,
      subtotalBeforeDiscounts,
      totalLineDiscounts,
      netAfterLineDiscounts     : sumNetAll,
      invoiceDiscountAmount     : invDisc,
      netTaxable                : finalT,
      netInclusive              : finalI,
      netExempt                 : finalE,
      taxOnTaxable              : taxOnT,
      taxExtractedFromInclusive : taxInI,
      totalTax,
      grandTotal,
      jofotaraStatus            : JoFotaraStatus.PENDING,
      notes,
    };
  }

  calculateCreditNote(
    creditNoteId    : string,
    originalInvoice : InvoiceSummary,
    returnItems     : ReturnItem[],
    reasonForReturn : string,
  ): CreditNoteSummary {

    // Build return lines using the same tax rules as the original
    const returnLines = returnItems.map(ret => {
      const returnItem: InvoiceItem = {
        ...ret.originalItem,
        quantity: ret.returnQuantity,
      };
      return this.calculateLine(returnItem);
    });

    const subtotalBeforeDiscounts = this.sum(returnLines, l => l.subtotal);
    const totalLineDiscounts      = this.sum(returnLines, l => l.lineDiscountAmount);
    const netAfterLineDiscounts   = this.sum(returnLines, l => l.netAfterLineDiscount);
    const totalReturnTax          = this.sum(returnLines, l => l.taxAmount);
    const grandReturnTotal        = this.sum(returnLines, l => l.lineTotal);

    return {
      creditNoteId,
      creditNoteUuid          : uuidv4(),
      issueDate               : new Date(),
      originalInvoiceId       : originalInvoice.invoiceId,
      originalInvoiceUuid     : originalInvoice.invoiceUuid,
      originalInvoiceDate     : originalInvoice.issueDate,
      reasonForReturn,
      seller                  : originalInvoice.seller,
      buyer                   : originalInvoice.buyer,
      lines                   : returnLines,
      subtotalBeforeDiscounts,
      totalLineDiscounts,
      netAfterLineDiscounts,
      totalReturnTax,
      grandReturnTotal,
      jofotaraStatus          : JoFotaraStatus.PENDING,
    };
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private computeDiscount(base: number, type: DiscountType, value: number): number {
    const raw = type === DiscountType.PERCENTAGE
      ? base * (value / 100)
      : value;
    return clamp(raw, 0, base);
  }

  private proportional(total: number, part: number, whole: number): number {
    return whole > 0 ? total * (part / whole) : 0;
  }

  private netByType(lines: LineCalculation[], type: TaxType): number {
    return lines
      .filter(l => l.item.taxType === type)
      .reduce((acc, l) => acc + l.netAfterLineDiscount, 0);
  }

  private recalcTax(
    lines       : LineCalculation[],
    type        : TaxType,
    finalTypeNet: number,
    sumTypeNet  : number,
    taxFn       : (net: number, rate: number) => number,
  ): number {
    if (sumTypeNet <= 0) return 0;
    return lines
      .filter(l => l.item.taxType === type)
      .reduce((acc, line) => {
        const lineFinal = line.netAfterLineDiscount * (finalTypeNet / sumTypeNet);
        return acc + taxFn(lineFinal, line.item.taxRate);
      }, 0);
  }

  private sum<T>(arr: T[], fn: (item: T) => number): number {
    return arr.reduce((acc, item) => acc + fn(item), 0);
  }
}
```

---

## 6. JoFotara JSON Builder — `src/services/jofotara-builder.service.ts`

```typescript
import dayjs from 'dayjs';
import { TaxType, TaxCategory, InvoiceType, PaymentMethod, JordanTax } from '../constants/tax.constants';
import { InvoiceSummary, CreditNoteSummary, LineCalculation, Buyer, Seller } from '../models/invoice.models';
import { toFils, formatJOD } from '../utils/currency.utils';

type JsonObject = Record<string, unknown>;

export class JoFotaraBuilderService {

  private readonly DATE_FMT = JordanTax.DATE_FORMAT;

  // ── Sales Invoice ──────────────────────────────────────────────────────────

  buildInvoicePayload(invoice: InvoiceSummary): JsonObject {
    return {
      invoiceId       : invoice.invoiceId,
      uuid            : invoice.invoiceUuid,
      issueDate       : dayjs(invoice.issueDate).format(this.DATE_FMT),
      invoiceTypeCode : invoice.invoiceType,
      paymentMeans    : invoice.paymentMethod,
      ...(invoice.notes ? { note: invoice.notes } : {}),

      accountingSupplierParty : this.buildSeller(invoice.seller),
      accountingCustomerParty : this.buildBuyer(invoice.buyer, invoice.grandTotal),

      invoiceLines     : this.buildLines(invoice.lines),
      taxTotal         : this.buildTaxTotal(invoice.lines, invoice.totalTax),
      legalMonetaryTotal: this.buildMonetaryTotal({
        lineExtensionAmount  : invoice.netAfterLineDiscounts,
        taxExclusiveAmount   : invoice.netTaxable + invoice.netExempt,
        taxInclusiveAmount   : invoice.grandTotal,
        allowanceTotalAmount : invoice.totalLineDiscounts + invoice.invoiceDiscountAmount,
        payableAmount        : invoice.grandTotal,
      }),
    };
  }

  // ── Credit Note (Return) ───────────────────────────────────────────────────

  buildCreditNotePayload(cn: CreditNoteSummary): JsonObject {
    return {
      invoiceId       : cn.creditNoteId,
      uuid            : cn.creditNoteUuid,
      issueDate       : dayjs(cn.issueDate).format(this.DATE_FMT),
      invoiceTypeCode : InvoiceType.CREDIT_NOTE,
      paymentMeans    : PaymentMethod.CASH,
      reasonForReturn : cn.reasonForReturn,

      // Mandatory reference to the original invoice
      billingReference: {
        invoiceDocumentReference: {
          id        : cn.originalInvoiceId,
          uuid      : cn.originalInvoiceUuid,
          issueDate : dayjs(cn.originalInvoiceDate).format(this.DATE_FMT),
        },
      },

      accountingSupplierParty : this.buildSeller(cn.seller),
      accountingCustomerParty : this.buildBuyer(cn.buyer, cn.grandReturnTotal),

      invoiceLines     : this.buildLines(cn.lines),
      taxTotal         : this.buildTaxTotal(cn.lines, cn.totalReturnTax),
      legalMonetaryTotal: this.buildMonetaryTotal({
        lineExtensionAmount  : cn.netAfterLineDiscounts,
        taxExclusiveAmount   : cn.netAfterLineDiscounts,
        taxInclusiveAmount   : cn.grandReturnTotal,
        allowanceTotalAmount : cn.totalLineDiscounts,
        payableAmount        : cn.grandReturnTotal,
      }),
    };
  }

  // ── Private Builders ───────────────────────────────────────────────────────

  private buildSeller(seller: Seller): JsonObject {
    return {
      party: {
        partyName   : { name: seller.name },
        partyTaxScheme: {
          companyId : seller.tin,
          taxScheme : { id: 'VAT' },
        },
        ...(seller.address ? { postalAddress: { streetName: seller.address } } : {}),
      },
    };
  }

  private buildBuyer(buyer: Buyer, grandTotal: number): JsonObject {
    const idRequired = grandTotal >= JordanTax.BUYER_ID_THRESHOLD;
    const idType     = buyer.tin ? 'TIN' : buyer.nin ? 'NIN' : buyer.pn ? 'PN' : null;
    const idValue    = buyer.tin ?? buyer.nin ?? buyer.pn ?? null;
    const hasId      = idValue !== null;

    return {
      party: {
        partyName: { name: buyer.name },
        ...(idRequired || hasId ? {
          partyIdentification: { id: idValue, schemeId: idType },
          ...(buyer.tin ? {
            partyTaxScheme: { companyId: buyer.tin, taxScheme: { id: 'VAT' } },
          } : {}),
        } : {}),
        ...(buyer.phone   ? { contact:       { telephone: buyer.phone } }   : {}),
        ...(buyer.address ? { postalAddress: { streetName: buyer.address } } : {}),
        ...(buyer.cityCode ? { postalAddress: { cityCode: buyer.cityCode } } : {}),
      },
    };
  }

  private buildLines(lines: LineCalculation[]): JsonObject[] {
    return lines.map((line, idx) => {
      const item    = line.item;
      const catCode = item.taxType === TaxType.EXEMPT
        ? TaxCategory.EXEMPT
        : item.taxCategory;

      return {
        id              : String(idx + 1),
        invoicedQuantity: {
          quantity : item.quantity,
          unitCode : item.unitOfMeasure ?? 'PCE',
        },
        lineExtensionAmount: formatJOD(toFils(line.netAfterLineDiscount)),

        ...(line.lineDiscountAmount > 0 ? {
          allowanceCharge: {
            chargeIndicator : false,
            amount          : formatJOD(toFils(line.lineDiscountAmount)),
            baseAmount      : formatJOD(toFils(line.subtotal)),
          },
        } : {}),

        taxTotal: {
          taxAmount  : formatJOD(toFils(line.taxAmount)),
          taxSubtotal: {
            taxableAmount : formatJOD(toFils(line.taxableBase)),
            taxAmount     : formatJOD(toFils(line.taxAmount)),
            taxCategory   : {
              id       : catCode,
              percent  : (item.taxType === TaxType.EXEMPT ? 0 : item.taxRate) * 100,
              taxScheme: { id: 'VAT' },
            },
          },
        },

        item: {
          name            : item.productName,
          sellersItemId   : item.productCode,
          classifiedTaxCategory: {
            id       : catCode,
            percent  : item.taxRate * 100,
            taxScheme: { id: 'VAT' },
          },
        },

        price: {
          priceAmount : formatJOD(toFils(item.unitPrice)),
          baseQuantity: 1,
        },
      };
    });
  }

  private buildTaxTotal(lines: LineCalculation[], totalTax: number): JsonObject {
    // Group by (taxCategory, taxRate) for subtotals
    const groups = new Map<string, { taxable: number; tax: number; code: string; rate: number }>();

    lines.forEach(line => {
      const catCode = line.item.taxType === TaxType.EXEMPT
        ? TaxCategory.EXEMPT : line.item.taxCategory;
      const key = `${catCode}-${line.item.taxRate}`;

      if (!groups.has(key)) {
        groups.set(key, { taxable: 0, tax: 0, code: catCode, rate: line.item.taxRate });
      }
      const entry = groups.get(key)!;
      entry.taxable += line.taxableBase;
      entry.tax     += line.taxAmount;
    });

    const taxSubtotals = Array.from(groups.values()).map(g => ({
      taxableAmount : formatJOD(toFils(g.taxable)),
      taxAmount     : formatJOD(toFils(g.tax)),
      taxCategory   : {
        id       : g.code,
        percent  : g.rate * 100,
        taxScheme: { id: 'VAT' },
      },
    }));

    return {
      taxAmount   : formatJOD(toFils(totalTax)),
      taxSubtotal : taxSubtotals,
    };
  }

  private buildMonetaryTotal(amounts: {
    lineExtensionAmount  : number;
    taxExclusiveAmount   : number;
    taxInclusiveAmount   : number;
    allowanceTotalAmount : number;
    payableAmount        : number;
  }): JsonObject {
    return Object.fromEntries(
      Object.entries(amounts).map(([k, v]) => [k, formatJOD(toFils(v))])
    );
  }
}
```

---

## 7. JoFotara API Client — `src/services/jofotara-api.service.ts`

```typescript
import axios, { AxiosInstance } from 'axios';
import { JoFotaraCredentials, JoFotaraResponse, InvoiceSummary, CreditNoteSummary } from '../models/invoice.models';
import { JoFotaraBuilderService } from './jofotara-builder.service';

export class JoFotaraApiService {

  private readonly http: AxiosInstance;
  private readonly builder: JoFotaraBuilderService;

  constructor(private readonly credentials: JoFotaraCredentials) {
    const baseURL = credentials.sandboxMode
      ? 'https://jofotara-sandbox.gov.jo/api/v1'
      : 'https://jofotara.gov.jo/api/v1';

    this.http = axios.create({
      baseURL,
      timeout: 30_000,
      headers: {
        'Content-Type' : 'application/json',
        'clientId'     : credentials.clientId,
        'secretKey'    : credentials.secretKey,
      },
    });

    this.builder = new JoFotaraBuilderService();
  }

  // ── Submit Sales Invoice ───────────────────────────────────────────────────

  async submitInvoice(invoice: InvoiceSummary): Promise<JoFotaraResponse> {
    const payload = this.builder.buildInvoicePayload(invoice);
    return this.post('/invoice', payload);
  }

  // ── Submit Credit Note (Return) ────────────────────────────────────────────

  async submitCreditNote(creditNote: CreditNoteSummary): Promise<JoFotaraResponse> {
    const payload = this.builder.buildCreditNotePayload(creditNote);
    return this.post('/invoice', payload);   // same endpoint — type code differs
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async post(endpoint: string, body: object): Promise<JoFotaraResponse> {
    try {
      const { data } = await this.http.post(endpoint, body);
      return {
        success            : true,
        qrCode             : data.qrCode             ?? undefined,
        registrationNumber : data.registrationNumber ?? undefined,
      };
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const data = err.response?.data ?? {};
        return {
          success      : false,
          errorCode    : data.errorCode    ?? err.code,
          errorMessage : data.errorMessage ?? err.message,
        };
      }
      return {
        success      : false,
        errorCode    : 'UNKNOWN_ERROR',
        errorMessage : String(err),
      };
    }
  }
}
```

---

## 8. Tax Ledger Service — `src/services/tax-ledger.service.ts`

```typescript
import { v4 as uuidv4 } from 'uuid';
import { LedgerEntryType, JoFotaraStatus } from '../constants/tax.constants';
import {
  TaxLedgerEntry, InvoiceSummary, CreditNoteSummary, PeriodTaxSummary,
} from '../models/invoice.models';

export class TaxLedgerService {

  private readonly entries: TaxLedgerEntry[] = [];

  // ── Post Invoice (positive entry) ──────────────────────────────────────────

  postInvoice(invoice: InvoiceSummary): TaxLedgerEntry {
    const entry: TaxLedgerEntry = {
      entryId                 : uuidv4(),
      entryType               : LedgerEntryType.SALE,
      documentNumber          : invoice.invoiceId,
      entryDate               : invoice.issueDate,
      buyerName               : invoice.buyer.name,
      buyerTin                : invoice.buyer.tin,
      taxableAmount           : invoice.netTaxable + invoice.netInclusive,
      taxAmount               : invoice.totalTax,
      grandTotal              : invoice.grandTotal,
      jofotaraStatus          : invoice.jofotaraStatus,
      qrCode                  : invoice.jofotaraQrCode,
      createdAt               : new Date(),
    };
    this.entries.push(entry);
    return entry;
  }

  // ── Post Credit Note (negative entry) ─────────────────────────────────────

  postCreditNote(creditNote: CreditNoteSummary): TaxLedgerEntry {
    const entry: TaxLedgerEntry = {
      entryId                 : uuidv4(),
      entryType               : LedgerEntryType.RETURN,
      documentNumber          : creditNote.creditNoteId,
      referenceDocumentNumber : creditNote.originalInvoiceId,
      entryDate               : creditNote.issueDate,
      buyerName               : creditNote.buyer.name,
      buyerTin                : creditNote.buyer.tin,
      taxableAmount           : -creditNote.netAfterLineDiscounts,  // negative
      taxAmount               : -creditNote.totalReturnTax,         // negative
      grandTotal              : -creditNote.grandReturnTotal,       // negative
      jofotaraStatus          : creditNote.jofotaraStatus,
      qrCode                  : creditNote.jofotaraQrCode,
      createdAt               : new Date(),
    };
    this.entries.push(entry);
    return entry;
  }

  // ── Period Summary (for monthly tax filing) ────────────────────────────────

  periodSummary(from: Date, to: Date): PeriodTaxSummary {
    const inRange = (d: Date) => d >= from && d <= to;
    const validated = this.entries.filter(
      e => inRange(e.entryDate) && e.jofotaraStatus === JoFotaraStatus.VALIDATED
    );

    const sales   = validated.filter(e => e.entryType === LedgerEntryType.SALE);
    const returns = validated.filter(e => e.entryType === LedgerEntryType.RETURN);

    const sum = (arr: TaxLedgerEntry[], fn: (e: TaxLedgerEntry) => number) =>
      arr.reduce((acc, e) => acc + fn(e), 0);

    const totalSalesTax   = sum(sales,   e => e.taxAmount);
    const totalReturnsTax = sum(returns, e => e.taxAmount); // already negative

    return {
      periodFrom      : from,
      periodTo        : to,
      totalSales      : sum(sales,   e => e.grandTotal),
      totalSalesTax,
      totalReturns    : sum(returns, e => e.grandTotal),    // negative
      totalReturnsTax,
      netOutputTax    : totalSalesTax + totalReturnsTax,    // ← payable to ISTD
      invoiceCount    : sales.length,
      creditNoteCount : returns.length,
    };
  }

  getAll(): TaxLedgerEntry[] {
    return [...this.entries];
  }
}
```

---

## 9. Invoice Validator — `src/services/invoice-validator.service.ts`

```typescript
import { TaxType, TaxCategory, JordanTax } from '../constants/tax.constants';
import { InvoiceSummary, ValidationError } from '../models/invoice.models';

export class InvoiceValidatorService {

  validate(invoice: InvoiceSummary): ValidationError[] {
    const errors: ValidationError[] = [];

    // Seller TIN is always required
    if (!invoice.seller.tin?.trim()) {
      errors.push({ field: 'seller.tin', message: 'Seller TIN is required' });
    }

    // Buyer ID required for large invoices (>= 10,000 JOD)
    const buyerId = invoice.buyer.tin ?? invoice.buyer.nin ?? invoice.buyer.pn ?? '';
    if (invoice.grandTotal >= JordanTax.BUYER_ID_THRESHOLD && !buyerId.trim()) {
      errors.push({
        field   : 'buyer.id',
        message : `Buyer TIN/NIN/PN is required for invoices >= ${JordanTax.BUYER_ID_THRESHOLD} JOD`,
      });
    }

    // Must have at least one line
    if (invoice.lines.length === 0) {
      errors.push({ field: 'lines', message: 'Invoice must have at least one line item' });
    }

    // Validate each line
    invoice.lines.forEach((line, idx) => {
      const prefix = `lines[${idx}]`;
      const item   = line.item;

      if (!item.productName?.trim()) {
        errors.push({ field: `${prefix}.productName`, message: 'Product name is required' });
      }

      if (item.quantity <= 0) {
        errors.push({ field: `${prefix}.quantity`, message: 'Quantity must be greater than zero' });
      }

      if (item.unitPrice < 0) {
        errors.push({ field: `${prefix}.unitPrice`, message: 'Unit price cannot be negative' });
      }

      // Taxable items with zero rate must be explicitly zero-rated
      if (
        item.taxType === TaxType.TAXABLE &&
        item.taxRate <= 0 &&
        item.taxCategory !== TaxCategory.ZERO_RATED
      ) {
        errors.push({
          field   : `${prefix}.taxRate`,
          message : `Taxable item "${item.productName}" has zero rate but is not marked as ZERO_RATED`,
        });
      }
    });

    // Grand total must be positive
    if (invoice.grandTotal < 0) {
      errors.push({ field: 'grandTotal', message: 'Grand total cannot be negative' });
    }

    return errors;
  }
}
```

---

## 10. Invoice Service (Orchestrator) — `src/services/invoice.service.ts`

```typescript
import {
  InvoiceItem, InvoiceDiscount, Buyer, Seller,
  InvoiceSummary, ReturnItem, CreditNoteSummary, PeriodTaxSummary,
} from '../models/invoice.models';
import { PaymentMethod, InvoiceType, JoFotaraStatus, DiscountType } from '../constants/tax.constants';
import { TaxCalculatorService }    from './tax-calculator.service';
import { JoFotaraApiService }      from './jofotara-api.service';
import { TaxLedgerService }        from './tax-ledger.service';
import { InvoiceValidatorService } from './invoice-validator.service';

export class InvoiceService {

  private readonly calculator : TaxCalculatorService;
  private readonly validator  : InvoiceValidatorService;

  constructor(
    private readonly jofotaraApi : JoFotaraApiService,
    private readonly ledger      : TaxLedgerService,
  ) {
    this.calculator = new TaxCalculatorService();
    this.validator  = new InvoiceValidatorService();
  }

  // ── Create & Submit Invoice ────────────────────────────────────────────────

  async createAndSubmit(
    invoiceId       : string,
    seller          : Seller,
    buyer           : Buyer,
    items           : InvoiceItem[],
    invoiceDiscount : InvoiceDiscount = { type: DiscountType.PERCENTAGE, value: 0 },
    paymentMethod   : PaymentMethod   = PaymentMethod.CASH,
    notes           ?: string,
  ): Promise<InvoiceSummary> {

    // Step 1 — Calculate
    const invoice = this.calculator.calculateInvoice(
      invoiceId, seller, buyer, items, invoiceDiscount, paymentMethod,
      InvoiceType.GENERAL_SALE, notes,
    );

    // Step 2 — Validate before sending
    const errors = this.validator.validate(invoice);
    if (errors.length > 0) {
      throw new Error(`Invoice validation failed:\n${errors.map(e => `  • ${e.field}: ${e.message}`).join('\n')}`);
    }

    // Step 3 — Submit to JoFotara
    const response = await this.jofotaraApi.submitInvoice(invoice);

    // Step 4 — Update status
    invoice.jofotaraStatus          = response.success ? JoFotaraStatus.VALIDATED : JoFotaraStatus.REJECTED;
    invoice.jofotaraQrCode          = response.qrCode;
    invoice.jofotaraRegistrationNum = response.registrationNumber;

    // Step 5 — Post to ledger (only if validated)
    if (response.success) {
      this.ledger.postInvoice(invoice);
    } else {
      console.error(`JoFotara rejected invoice ${invoiceId}: [${response.errorCode}] ${response.errorMessage}`);
    }

    return invoice;
  }

  // ── Create & Submit Return (Credit Note) ───────────────────────────────────

  async createAndSubmitReturn(
    creditNoteId    : string,
    originalInvoice : InvoiceSummary,
    returnItems     : ReturnItem[],
    reason          : string,
  ): Promise<CreditNoteSummary> {

    // Step 1 — Calculate return amounts
    const creditNote = this.calculator.calculateCreditNote(
      creditNoteId, originalInvoice, returnItems, reason,
    );

    // Step 2 — Submit to JoFotara
    const response = await this.jofotaraApi.submitCreditNote(creditNote);

    // Step 3 — Update status
    creditNote.jofotaraStatus  = response.success ? JoFotaraStatus.VALIDATED : JoFotaraStatus.REJECTED;
    creditNote.jofotaraQrCode  = response.qrCode;

    // Step 4 — Post negative entry to ledger
    if (response.success) {
      this.ledger.postCreditNote(creditNote);
    } else {
      console.error(`JoFotara rejected credit note ${creditNoteId}: [${response.errorCode}] ${response.errorMessage}`);
    }

    return creditNote;
  }

  // ── Monthly Tax Report ─────────────────────────────────────────────────────

  monthlyReport(year: number, month: number): PeriodTaxSummary {
    const from = new Date(year, month - 1, 1);
    const to   = new Date(year, month, 0);   // last day of month
    return this.ledger.periodSummary(from, to);
  }
}
```

---

## 11. Entry Point — `src/index.ts`

```typescript
import { InvoiceService }      from './services/invoice.service';
import { JoFotaraApiService }  from './services/jofotara-api.service';
import { TaxLedgerService }    from './services/tax-ledger.service';
import { TaxCalculatorService } from './services/tax-calculator.service';
import {
  TaxType, TaxCategory, DiscountType, PaymentMethod, JordanTax,
} from './constants/tax.constants';
import { InvoiceItem, InvoiceDiscount, Buyer, Seller, ReturnItem } from './models/invoice.models';
import { formatJOD } from './utils/currency.utils';

async function main() {

  // ── Setup ──────────────────────────────────────────────────────────────────

  const credentials = {
    clientId    : process.env.JOFOTARA_CLIENT_ID  ?? 'your-client-id',
    secretKey   : process.env.JOFOTARA_SECRET_KEY ?? 'your-secret-key',
    sandboxMode : true,
  };

  const ledger  = new TaxLedgerService();
  const service = new InvoiceService(
    new JoFotaraApiService(credentials),
    ledger,
  );

  // ── Parties ────────────────────────────────────────────────────────────────

  const seller: Seller = {
    name    : 'ABC Trading Co.',
    tin     : '123456789',
    address : 'King Abdullah II St, Amman',
  };

  const buyer: Buyer = {
    name     : 'Customer Ltd.',
    tin      : '987654321',
    phone    : '0791234567',
    cityCode : 'JO-IR',   // Irbid
  };

  // ── Invoice Items ──────────────────────────────────────────────────────────

  const items: InvoiceItem[] = [
    {
      // 1. Mobile phone — TAXABLE 16%, 5% line discount
      id              : 'L1',
      productName     : 'Mobile Phone',
      productCode     : 'MOB-001',
      taxType         : TaxType.TAXABLE,
      taxRate         : JordanTax.STANDARD_RATE,
      taxCategory     : TaxCategory.STANDARD,
      quantity        : 2,
      unitPrice       : 250.00,
      lineDiscountType : DiscountType.PERCENTAGE,
      lineDiscountValue: 5,
    },
    {
      // 2. Wireless headset — INCLUSIVE 16%, 5 JOD fixed line discount
      id              : 'L2',
      productName     : 'Wireless Headset',
      productCode     : 'AUD-002',
      taxType         : TaxType.INCLUSIVE,
      taxRate         : JordanTax.STANDARD_RATE,
      taxCategory     : TaxCategory.STANDARD,
      quantity        : 1,
      unitPrice       : 57.60,
      lineDiscountType : DiscountType.FIXED_AMOUNT,
      lineDiscountValue: 5,
    },
    {
      // 3. Medical consultation — EXEMPT
      id              : 'L3',
      productName     : 'Medical Consultation',
      productCode     : 'MED-003',
      taxType         : TaxType.EXEMPT,
      taxRate         : 0,
      taxCategory     : TaxCategory.EXEMPT,
      quantity        : 1,
      unitPrice       : 80.00,
    },
  ];

  const invoiceDiscount: InvoiceDiscount = {
    type  : DiscountType.PERCENTAGE,
    value : 5,
  };

  // ── Create & Submit Invoice ────────────────────────────────────────────────

  console.log('Creating invoice...');
  const invoice = await service.createAndSubmit(
    'INV-2025-0001',
    seller,
    buyer,
    items,
    invoiceDiscount,
    PaymentMethod.RECEIVABLE,
    'Sales rep: Ahmed - Visit #42',
  );

  console.log('\n=== INVOICE RESULT ===');
  console.log(`Status      : ${invoice.jofotaraStatus}`);
  console.log(`QR Code     : ${invoice.jofotaraQrCode ?? 'N/A'}`);
  console.log(`Grand Total : ${formatJOD(invoice.grandTotal)} JOD`);
  console.log(`Total Tax   : ${formatJOD(invoice.totalTax)} JOD`);
  console.log(`Tax Taxable : ${formatJOD(invoice.taxOnTaxable)} JOD`);
  console.log(`Tax Incl.   : ${formatJOD(invoice.taxExtractedFromInclusive)} JOD`);

  // ── Partial Return: Customer Returns 1 Phone ───────────────────────────────

  console.log('\nCreating return (1 phone)...');
  const returnItems: ReturnItem[] = [
    {
      originalItem   : items[0],   // Mobile Phone
      returnQuantity : 1,
      reason         : 'Defective screen',
    },
  ];

  const creditNote = await service.createAndSubmitReturn(
    'CN-2025-0001',
    invoice,
    returnItems,
    'Defective screen — customer return',
  );

  console.log('\n=== CREDIT NOTE RESULT ===');
  console.log(`Status        : ${creditNote.jofotaraStatus}`);
  console.log(`Return Amount : ${formatJOD(creditNote.grandReturnTotal)} JOD`);
  console.log(`Reversed Tax  : ${formatJOD(creditNote.totalReturnTax)} JOD`);

  // ── Monthly Tax Report (May 2025) ──────────────────────────────────────────

  const report = service.monthlyReport(2025, 5);
  console.log('\n=== MONTHLY TAX REPORT — May 2025 ===');
  console.log(`Total Sales      : ${formatJOD(report.totalSales)} JOD`);
  console.log(`Sales Tax        : ${formatJOD(report.totalSalesTax)} JOD`);
  console.log(`Total Returns    : ${formatJOD(report.totalReturns)} JOD`);
  console.log(`Returns Tax Rev. : ${formatJOD(report.totalReturnsTax)} JOD`);
  console.log(`Net Output Tax   : ${formatJOD(report.netOutputTax)} JOD  ← Pay to ISTD`);
  console.log(`Invoices         : ${report.invoiceCount}`);
  console.log(`Credit Notes     : ${report.creditNoteCount}`);
}

main().catch(console.error);
```

---

## 12. Environment Variables — `.env`

```env
JOFOTARA_CLIENT_ID=your-client-id-from-istd
JOFOTARA_SECRET_KEY=your-secret-key-from-istd
JOFOTARA_SANDBOX=true
NODE_ENV=development
```

Load with `dotenv`:
```bash
npm install dotenv
```
```typescript
// Top of index.ts
import 'dotenv/config';
```

---

## 13. Quick-Calc (No JoFotara) — Pure calculation only

If you only need to calculate tax without submitting to JoFotara:

```typescript
import { TaxCalculatorService } from './services/tax-calculator.service';
import { TaxType, TaxCategory, DiscountType, JordanTax } from './constants/tax.constants';
import { formatJOD } from './utils/currency.utils';

const calc = new TaxCalculatorService();

const invoice = calc.calculateInvoice(
  'INV-LOCAL-001',
  { name: 'My Store', tin: '111222333' },
  { name: 'Walk-in Customer' },
  [
    {
      id: '1', productName: 'Product A', productCode: 'A',
      taxType: TaxType.TAXABLE, taxRate: JordanTax.STANDARD_RATE,
      taxCategory: TaxCategory.STANDARD,
      quantity: 3, unitPrice: 100,
      lineDiscountType: DiscountType.PERCENTAGE, lineDiscountValue: 10,
    },
  ],
);

console.log('Grand Total:', formatJOD(invoice.grandTotal), 'JOD');
console.log('Total Tax:',  formatJOD(invoice.totalTax),   'JOD');
```

---

## 14. Tax Flow Summary

```
SALE
 items (TAXABLE / INCLUSIVE / EXEMPT)
    ↓ line discounts (% or fixed per line)
 net per line
    ↓ invoice discount (% or fixed, distributed proportionally)
 final nets by type
    ↓ tax recalculated per line using individual rates
 totalTax  &  grandTotal
    ↓ validate → submit to JoFotara → receive QR
 post to ledger  (+)

RETURN (Credit Note)
 return quantities of original items
    ↓ same tax rules applied on return qty
 returnTax  &  grandReturnTotal
    ↓ reference originalInvoiceUuid → submit to JoFotara
 post to ledger  (−)

NET OUTPUT TAX (monthly)
 Σ salesTax − Σ returnsTax  =  netOutputTax → payable to ISTD
```

---

*Specification v2.0 — Node.js / TypeScript*
*JoFotara Phase 2 (April 2025) — Jordan ISTD — Standard Rate: 16% — Currency: JOD (3 decimal places)*
