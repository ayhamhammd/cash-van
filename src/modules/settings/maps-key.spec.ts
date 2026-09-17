import { SettingsService } from './settings.service';

/**
 * The Google Maps key is the one stored key that must come back OUT in the
 * clear: Maps JS runs in the browser and cannot use a key it never receives.
 * So the round trip is the thing worth covering — encrypt on save, decrypt on
 * read — plus the two ways it is allowed to be absent.
 */
describe('SettingsService — the Google Maps browser key', () => {
  const ENV_KEY = 'AIzaFromTheServerEnvironment';
  let saved: Record<string, unknown>;

  /** Minimal service with just the repo + user context the maps paths touch. */
  function makeSvc(row: Record<string, unknown>): SettingsService {
    saved = row;
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      save: jest.fn(async (r: Record<string, unknown>) => { saved = r; return r; }),
      createQueryBuilder: jest.fn(() => ({
        addSelect: () => ({ where: () => ({ getOne: async () => saved }) }),
      })),
    };
    const userCtx = { getUserId: () => 'user-1' };
    return new (SettingsService as unknown as new (...a: unknown[]) => SettingsService)(
      repo, userCtx, null, null, null, null, null, null,
    );
  }

  beforeEach(() => {
    process.env.JOFOTARA_KMS_KEY = 'a'.repeat(64); // deterministic AES key for the test
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it('stores the key encrypted, and hands the browser back the original', async () => {
    const svc = makeSvc({ id: 1 });
    const view = await svc.updateMaps({ apiKey: 'AIzaTheRealKeyValue' });

    // Never stored in the clear, and only the last four are reportable.
    expect(saved.googleMapsApiKeyEncrypted).toBeTruthy();
    expect(saved.googleMapsApiKeyEncrypted).not.toContain('AIzaTheRealKeyValue');
    expect(view.apiKeyLast4).toBe('alue');
    expect(view.isConfigured).toBe(true);
    expect(view.source).toBe('settings');

    // …but the browser gets the whole thing, which is the point.
    await expect(svc.mapsRuntime()).resolves.toMatchObject({
      googleMapsApiKey: 'AIzaTheRealKeyValue',
    });
  });

  it('prefers the stored key over the server environment', async () => {
    process.env.GOOGLE_MAPS_API_KEY = ENV_KEY;
    const svc = makeSvc({ id: 1 });
    await svc.updateMaps({ apiKey: 'AIzaStoredWins' });
    await expect(svc.mapsRuntime()).resolves.toMatchObject({
      googleMapsApiKey: 'AIzaStoredWins',
    });
  });

  it('falls back to the environment when nothing is stored', async () => {
    process.env.GOOGLE_MAPS_API_KEY = ENV_KEY;
    const svc = makeSvc({ id: 1 });
    await expect(svc.mapsRuntime()).resolves.toMatchObject({ googleMapsApiKey: ENV_KEY });
  });

  it('an empty apiKey CLEARS the stored key rather than meaning "unchanged"', async () => {
    process.env.GOOGLE_MAPS_API_KEY = ENV_KEY;
    const svc = makeSvc({ id: 1 });
    await svc.updateMaps({ apiKey: 'AIzaWillBeCleared' });

    const view = await svc.updateMaps({ apiKey: '' });
    expect(saved.googleMapsApiKeyEncrypted).toBeNull();
    expect(view.isConfigured).toBe(false);
    expect(view.source).toBe('environment');
    await expect(svc.mapsRuntime()).resolves.toMatchObject({ googleMapsApiKey: ENV_KEY });
  });

  it('omitting apiKey keeps the current one — editing the Map ID must not wipe it', async () => {
    const svc = makeSvc({ id: 1 });
    await svc.updateMaps({ apiKey: 'AIzaKeepMe' });
    await svc.updateMaps({ mapId: 'roadmap-dark' });

    expect(saved.googleMapsMapId).toBe('roadmap-dark');
    await expect(svc.mapsRuntime()).resolves.toMatchObject({
      googleMapsApiKey: 'AIzaKeepMe',
      googleMapsMapId: 'roadmap-dark',
    });
  });

  it('ciphertext this machine cannot open reads as unset, not as a crash', async () => {
    process.env.GOOGLE_MAPS_API_KEY = ENV_KEY;
    // What a database restored from another install looks like.
    const svc = makeSvc({ id: 1, googleMapsApiKeyEncrypted: 'not-openable-by-this-key' });
    await expect(svc.mapsRuntime()).resolves.toMatchObject({ googleMapsApiKey: ENV_KEY });
  });
});
