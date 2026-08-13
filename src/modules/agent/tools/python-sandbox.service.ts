import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { QueryResult } from '../agent.types';

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Files the script wrote to /job/out, capped and size-limited. */
  files: Array<{ name: string; bytes: number; buffer: Buffer }>;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
}

export class SandboxDisabledError extends Error {}

/** stdout/stderr the model sees. Long enough to debug, short enough not to
 *  blow the context window when a script prints a whole frame. */
const MAX_OUTPUT_CHARS = 8_000;
/** Per artifact. A chart is tens of KB; anything past this is a mistake. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 6;

/**
 * Runs model-authored Python in a disposable container.
 *
 * WHY A CONTAINER AND NOT A SUBPROCESS. The script is written by a language
 * model from a prompt that may contain text a rep typed on a phone. Treating it
 * as hostile is the only safe posture, and a subprocess in the API container
 * would share that process's network, filesystem and database credentials.
 *
 * THE FOUR THINGS THAT MAKE IT SAFE, in order of importance:
 *
 *   1. --network none. The analysis has no reason to reach anything, and this
 *      removes exfiltration as a CATEGORY rather than as a rule to enforce.
 *      Without it, every other control is decoration.
 *   2. No credentials. Data arrives as a file the API already fetched with an
 *      already-validated SELECT. The sandbox cannot reach the database even if
 *      it wanted to, and there is nothing in it to steal.
 *   3. --read-only with a small noexec tmpfs, so the script cannot persist
 *      anything or drop a binary and run it.
 *   4. Hard caps: memory, cpus, pids, and a wall clock that SIGKILLs. A model
 *      that writes `while True` must cost 30 seconds, not the server.
 *
 * WHAT THIS DOES NOT SOLVE, stated plainly: spawning containers requires access
 * to the Docker socket, and that access is root-equivalent on the host. Handing
 * it to the API process trades a sandboxing problem for a privilege problem.
 * That is the reason this ships DISABLED and why the runbook tells a site to
 * weigh it rather than assuming it is free.
 */
@Injectable()
export class PythonSandboxService {
  private readonly logger = new Logger(PythonSandboxService.name);
  private readonly enabled: boolean;
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly maxRows: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('agent.python.enabled', false);
    this.image = this.config.get<string>(
      'agent.python.image',
      'vanflow-pysandbox:latest',
    );
    this.timeoutMs = this.config.get<number>('agent.python.timeoutMs', 30_000);
    this.memory = this.config.get<string>('agent.python.memory', '512m');
    this.cpus = this.config.get<string>('agent.python.cpus', '1');
    this.maxRows = this.config.get<number>('agent.python.maxRows', 50_000);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Write the job, run it, collect whatever it produced.
   *
   * The job directory is always removed, including when docker never started —
   * otherwise a failing sandbox slowly fills the host disk with query results.
   */
  async run(code: string, data: QueryResult | null): Promise<SandboxResult> {
    if (!this.enabled) {
      throw new SandboxDisabledError(
        'The Python sandbox is not enabled on this server (AI_PYTHON_ENABLED). ' +
          'Answer with SQL instead, or ask an administrator to turn it on.',
      );
    }

    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'vanflow-py-'));
    const outDir = join(dir, 'out');

    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(dir, 'main.py'), code, 'utf-8');

      if (data) {
        const rows = data.rows.slice(0, this.maxRows);
        await writeFile(
          join(dir, 'data.json'),
          JSON.stringify(rows),
          'utf-8',
        );
      }

      const result = await this.spawnDocker(dir);
      const files = await this.collectOutputs(outDir);

      return {
        ...result,
        files,
        durationMs: Date.now() - started,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawnDocker(
    dir: string,
  ): Promise<Omit<SandboxResult, 'files' | 'durationMs'>> {
    const args = [
      'run',
      '--rm',
      '--network', 'none',
      '--read-only',
      '--memory', this.memory,
      '--memory-swap', this.memory, // equal to memory = swap disabled
      '--cpus', this.cpus,
      '--pids-limit', '64',
      // noexec: the script may write scratch files but cannot make one runnable.
      '--tmpfs', '/tmp:rw,size=64m,noexec,nosuid',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      // The job is read-only to the container; only /job/out is writable, and
      // it is a separate mount so the script cannot rewrite its own source and
      // confuse the transcript about what actually ran.
      '-v', `${dir}:/job:ro`,
      '-v', `${join(dir, 'out')}:/job/out:rw`,
      '-w', '/job',
      this.image,
      'python', '/job/main.py',
    ];

    return new Promise((resolve) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL, not SIGTERM: a wedged interpreter ignores the polite one and
        // this timeout is the only thing standing between a bad script and the
        // server.
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (c: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += c.toString('utf-8');
      });
      child.stderr.on('data', (c: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += c.toString('utf-8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        // Almost always "docker: not found" or a permission denial on the
        // socket. Say which, because the fix is completely different.
        resolve({
          ok: false,
          stdout,
          stderr: `Could not start the sandbox: ${err.message}`,
          timedOut: false,
          exitCode: null,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          stdout: this.clip(stdout),
          stderr: this.clip(
            timedOut
              ? `${stderr}\n[killed after ${this.timeoutMs}ms]`
              : stderr,
          ),
          timedOut,
          exitCode: code,
        });
      });
    });
  }

  /** Files from /job/out, capped in count and size. */
  private async collectOutputs(
    outDir: string,
  ): Promise<SandboxResult['files']> {
    let names: string[];
    try {
      names = await readdir(outDir);
    } catch {
      return [];
    }

    const files: SandboxResult['files'] = [];
    for (const name of names.sort().slice(0, MAX_FILES)) {
      // Basename only. A script that writes "../../etc/passwd" gets its path
      // flattened rather than honoured.
      const safe = name.replace(/[/\\]/g, '_');
      try {
        const buffer = await readFile(join(outDir, name));
        if (buffer.length > MAX_FILE_BYTES) {
          this.logger.warn(`Sandbox output ${safe} too large; skipped`);
          continue;
        }
        files.push({ name: safe, bytes: buffer.length, buffer });
      } catch {
        /* a directory or an unreadable entry — skip it */
      }
    }
    return files;
  }

  private clip(text: string): string {
    return text.length > MAX_OUTPUT_CHARS
      ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`
      : text;
  }
}
