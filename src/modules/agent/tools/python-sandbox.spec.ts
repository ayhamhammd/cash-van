import { ConfigService } from '@nestjs/config';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  PythonSandboxService,
  SandboxDisabledError,
} from './python-sandbox.service';

function svc(overrides: Record<string, unknown> = {}): PythonSandboxService {
  const values: Record<string, unknown> = {
    'agent.python.enabled': false,
    'agent.python.image': 'vanflow-pysandbox:latest',
    'agent.python.timeoutMs': 30_000,
    'agent.python.memory': '512m',
    'agent.python.cpus': '1',
    'agent.python.maxRows': 50_000,
    ...overrides,
  };
  const config = {
    get: <T>(key: string, fallback: T): T =>
      (key in values ? (values[key] as T) : fallback),
  } as unknown as ConfigService;
  return new PythonSandboxService(config);
}

describe('PythonSandboxService', () => {
  describe('the default posture', () => {
    it('is DISABLED unless a site explicitly turns it on', () => {
      expect(svc().isEnabled()).toBe(false);
    });

    it('refuses to run, with a message telling the model to use SQL instead', async () => {
      await expect(svc().run('print(1)', null)).rejects.toBeInstanceOf(
        SandboxDisabledError,
      );
      await expect(svc().run('print(1)', null)).rejects.toThrow(
        /AI_PYTHON_ENABLED/,
      );
    });

    it('reports enabled once configured', () => {
      expect(svc({ 'agent.python.enabled': true }).isEnabled()).toBe(true);
    });
  });

  describe('when the sandbox cannot run', () => {
    /**
     * Enabled but pointed at an image that does not exist — exactly what a site
     * sees if it sets the flag without building the image. Two failure modes
     * are possible depending on the host (docker missing entirely, or docker
     * present and rejecting the image) and BOTH must resolve rather than throw:
     * a broken sandbox has to come back as a tool result the model can read and
     * work around, not as an exception that kills the turn.
     */
    it('resolves with ok=false and an explanation, never throws', async () => {
      const res = await svc({
        'agent.python.enabled': true,
        'agent.python.image': 'vanflow-sandbox-does-not-exist:0',
      }).run('print(1)', null);

      expect(res.ok).toBe(false);
      expect(res.files).toEqual([]);
      expect(res.stderr.length).toBeGreaterThan(0);
    }, 60_000);

    it('cleans up its job directory even when the run fails', async () => {
      const before = (await readdir(tmpdir())).filter((n) =>
        n.startsWith('vanflow-py-'),
      ).length;
      await svc({
        'agent.python.enabled': true,
        'agent.python.image': 'vanflow-sandbox-does-not-exist:0',
      }).run('print(1)', null);
      const after = (await readdir(tmpdir())).filter((n) =>
        n.startsWith('vanflow-py-'),
      ).length;
      // A failing sandbox that leaves its job directory behind slowly fills the
      // host disk with query results.
      expect(after).toBeLessThanOrEqual(before);
    }, 60_000);
  });
});
