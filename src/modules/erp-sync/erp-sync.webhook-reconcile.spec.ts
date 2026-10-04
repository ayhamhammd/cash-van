import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * A stock change in the ERP ends with the vans matched to it.
 *
 * The webhook pulls the movement feed; a feed can drop a row, and until now the
 * van stayed short until someone pressed "Match ERP". A stock webhook now runs
 * that same match once the pull lands — once per burst, not once per change,
 * because it reads the ERP's whole stock snapshot.
 */
function makeSvc(): any {
  const args: any[] = new Array(23).fill(null);
  args[1] = { getErpConfig: jest.fn().mockResolvedValue({ enabled: true, baseUrl: 'x', apiKey: 'y' }) };
  const svc = new (ErpSyncService as any)(...args) as any;
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  svc.scheduledPull = jest.fn().mockResolvedValue(undefined);
  svc.runStockReconcile = jest.fn().mockResolvedValue(undefined);
  return svc;
}

/** Let the timers fire and the promises they start settle. */
async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

// Loading the service module is slow on a busy machine; the timers are fake.
jest.setTimeout(30_000);

describe('ERP webhook → van stock match', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a stock change pulls, then matches the vans to the ERP', async () => {
    const svc = makeSvc();
    svc.triggerWebhookSync('stock');

    await advance(1000);
    expect(svc.scheduledPull).toHaveBeenCalledTimes(1);
    expect(svc.runStockReconcile).not.toHaveBeenCalled();

    await advance(3000);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(1);
  });

  it('a change that names no entity is treated as stock', async () => {
    const svc = makeSvc();
    svc.triggerWebhookSync();
    await advance(5000);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(1);
  });

  it('a customer or price change pulls but does not match stock', async () => {
    const svc = makeSvc();
    svc.triggerWebhookSync('customer');
    svc.triggerWebhookSync('price');
    await advance(30_000);
    expect(svc.scheduledPull).toHaveBeenCalledTimes(1);
    expect(svc.runStockReconcile).not.toHaveBeenCalled();
  });

  it('a burst of stock changes is one pull and one match', async () => {
    const svc = makeSvc();
    for (let i = 0; i < 10; i++) svc.triggerWebhookSync('stock');
    await advance(5000);
    expect(svc.scheduledPull).toHaveBeenCalledTimes(1);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(1);
  });

  it('a change soon after a match waits out the gap, and is still matched', async () => {
    const svc = makeSvc();
    svc.triggerWebhookSync('stock');
    await advance(5000);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(1);

    // Another transfer a few seconds later.
    svc.triggerWebhookSync('stock');
    await advance(5000);
    expect(svc.scheduledPull).toHaveBeenCalledTimes(2);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(1); // inside the 20 s gap

    await advance(20_000);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(2);
  });

  it('waits for a match already running instead of colliding with it', async () => {
    const svc = makeSvc();
    svc.reconciling = true; // someone pressed Match ERP
    svc.triggerWebhookSync('stock');
    await advance(5000);
    expect(svc.runStockReconcile).not.toHaveBeenCalled();

    svc.reconciling = false;
    await advance(5000);
    expect(svc.runStockReconcile).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the ERP connection is off', async () => {
    const svc = makeSvc();
    svc.settings.getErpConfig.mockResolvedValue({ enabled: false });
    svc.triggerWebhookSync('stock');
    await advance(10_000);
    expect(svc.runStockReconcile).not.toHaveBeenCalled();
  });
});
