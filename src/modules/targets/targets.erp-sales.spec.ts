import { TargetsService } from './targets.service';
import type { ErpSalesmanSales } from '../erp-sync/erp-sync.service';

/**
 * While the ERP is connected, a target's SALES are the salesman's row on the
 * ERP's Sales Reports → By salesman.
 *
 * cash-van counted its own vouchers and disagreed with that report for every
 * salesman on the 94 server (201: 20,037.160 here, 22,637.090 in the ERP),
 * because the two decide whose sale an invoice is differently. These pin that
 * the ERP's figures replace cash-van's whole — never mixed per row — that they
 * are the ERP's net before tax (the business's choice), and that the ERP being off or
 * silent leaves cash-van's figures in place and says which it is.
 */
describe('TargetsService — sales read from the ERP', () => {
  /** A raw SQL row as the actuals query returns it, for salesman `code`. */
  const raw = (code: string, over: Record<string, string | null> = {}) => ({
    repId: `rep-${code}`, repCode: code, repName: code, targetId: 't', metric: 'AMOUNT',
    targetValue: '30000000', notes: null,
    actualAmount: '20037160', actualVanAmount: '20037160', actualErpAmount: '0', actualQty: '10',
    salesTargetFils: '30000000', collectionTargetFils: null,
    cashPct: '1', creditPct: '2', collectionPct: '0',
    cashSalesFils: '5000000', creditSalesFils: '15037160', collectedFils: '700000',
    salesIncludeCash: 'true',
    ...over,
  });

  const part = (total: number, netExTax: number) => ({ invoiceCount: 1, netExTax, tax: total - netExTax, total });
  const sales = (code: string, cash: [number, number], credit: [number, number]): ErpSalesmanSales => ({
    salesmanId: `s-${code}`, code, name: code,
    cash: part(...cash), credit: part(...credit),
    total: part(cash[0] + credit[0], cash[1] + credit[1]),
  });

  function service(rows: Array<Record<string, string | null>>, erp: Map<string, ErpSalesmanSales> | 'off' | 'unavailable') {
    const ds = { query: jest.fn().mockResolvedValue(rows) };
    const erpSync = { erpSalesBySalesman: jest.fn().mockResolvedValue(erp) };
    return { svc: new TargetsService(ds as never, null as never, erpSync as never), erpSync };
  }

  it("uses the ERP's net before tax, cash and credit — the reported salesman 201", async () => {
    // [with tax, net before tax] per part.
    const erp = new Map([['201', sales('201', [8000, 7000], [18000, 15637.09])]]);
    const { svc, erpSync } = service([raw('201')], erp);
    const [row] = await svc.list(2026, 10);

    expect(erpSync.erpSalesBySalesman).toHaveBeenCalledWith('2026-10-01', '2026-10-31');
    expect(row.salesSource).toBe('erp');
    expect(row.cashSalesFils).toBe(7_000_000);
    expect(row.creditSalesFils).toBe(15_637_090);
    expect(row.totalSalesFils).toBe(22_637_090);
    expect(row.salesProgressPct).toBe(75); // 22,637.090 of 30,000
    // Commission follows the ERP's figures: 1% cash + 2% credit.
    expect(row.commissionOnCashFils + row.commissionOnCreditFils).toBe(70_000 + 312_742);
    // Collections stay cash-van's own.
    expect(row.collectedFils).toBe(700_000);
  });

  it('measures net before tax whatever the include-tax setting says', async () => {
    const erp = new Map([['201', sales('201', [116, 100], [58, 50])]]);
    for (const includeTax of ['true', 'false']) {
      const { svc } = service([raw('201', { includeTax })], erp);
      const [row] = await svc.list(2026, 10);
      expect(row.cashSalesFils).toBe(100_000);
      expect(row.creditSalesFils).toBe(50_000);
    }
  });

  it("totals exactly the ERP's figure, never a fil off from rounding the parts", async () => {
    // Half a fil each in cash and credit: rounded separately they made 2 fils,
    // but the ERP's total is 1 fil.
    const erp = new Map([['106', {
      ...sales('106', [1, 0.0005], [1, 0.0005]),
      total: { invoiceCount: 2, netExTax: 0.001, tax: 0, total: 0.001 },
    }]]);
    const { svc } = service([raw('106')], erp);
    const [row] = await svc.list(2026, 10);
    expect(row.totalSalesFils).toBe(1);
    expect(row.cashSalesFils + row.creditSalesFils).toBe(1);
  });

  it("gives a salesman the ERP has no sales for zero, not cash-van's figure", async () => {
    const { svc } = service([raw('202')], new Map([['201', sales('201', [1, 1], [1, 1])]]));
    const [row] = await svc.list(2026, 10);
    expect(row.salesSource).toBe('erp');
    expect(row.totalSalesFils).toBe(0);
  });

  it("keeps cash-van's own figures while the ERP is off", async () => {
    const { svc } = service([raw('201')], 'off');
    const [row] = await svc.list(2026, 10);
    expect(row.salesSource).toBe('vanflow');
    expect(row.erpUnavailable).toBe(false);
    expect(row.totalSalesFils).toBe(20_037_160);
  });

  it('says so when the ERP is connected but does not answer', async () => {
    const { svc } = service([raw('201')], 'unavailable');
    const row = await svc.getForRep('rep-201', 2026, 12);
    expect(row.salesSource).toBe('vanflow');
    expect(row.erpUnavailable).toBe(true);
    expect(row.totalSalesFils).toBe(20_037_160);
  });

  it('asks the ERP for the whole of a December', async () => {
    const { svc, erpSync } = service([raw('201')], 'off');
    await svc.getForRep('rep-201', 2026, 12);
    expect(erpSync.erpSalesBySalesman).toHaveBeenCalledWith('2026-12-01', '2026-12-31');
  });
});
