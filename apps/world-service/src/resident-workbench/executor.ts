import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LIMITS, WorkbenchError, type Executor } from './contract.js';

const runner = readFileSync(fileURLToPath(new URL('../../../../scripts/containment/workbench-runner.mjs', import.meta.url)), 'utf8');
const cliEnvironment = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' });
export interface RuntimeRecord {
  imageId: string;
  architecture: string;
  os: string;
  nodeVersion: string;
  configEnvNames: string[];
  entrypoint: string[];
  user: string;
}
let activeExecution = false;
/** Docker's own diagnosis before any container exists, inside the unchanged three-second lifecycle (measured 25-40 ms locally). */
const PREFLIGHT_MS = 1000;
const REMOVAL_MS = 1000;
/** Host-side failures that happen before resident bytes can run. Never a module result, never retried here. */
const unavailable = () => new WorkbenchError('executor-unavailable');

/** No default enablement, image discovery, builds, pulls or installs. The host supplies the reviewed record. */
export class DockerWorkbenchExecutor implements Executor {
  #image: string;

  constructor(runtime: RuntimeRecord) {
    if (!/^sha256:[a-f0-9]{64}$/.test(runtime.imageId) || runtime.architecture !== 'arm64'
      || runtime.os !== 'linux' || runtime.nodeVersion !== 'v24.18.1'
      || JSON.stringify(runtime.configEnvNames) !== '["PATH"]'
      || JSON.stringify(runtime.entrypoint) !== '["/usr/bin/node"]' || runtime.user !== '65534:65534') {
      throw new WorkbenchError('unreviewed-runtime');
    }
    this.#image = runtime.imageId;
  }

  async run(source: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    // Busy is a host scheduling fault (or a slot still locked by unconfirmed removal), never the module's.
    if (activeExecution) throw unavailable();
    if (signal?.aborted) throw new WorkbenchError('aborted');
    const data = JSON.stringify(input);
    if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.sourceBytes
      || typeof data !== 'string' || Buffer.byteLength(data) > 8192) throw new WorkbenchError('execution-input-budget');

    activeExecution = true;
    const deadline = Date.now() + LIMITS.runMs;
    const name = `meridian-workbench-${randomUUID()}`;
    let dir: string | undefined, launched = false, removed = true;
    try {
      let modulePath: string, runnerPath: string;
      try {
        dir = mkdtempSync(join(tmpdir(), 'meridian-workbench-'));
        modulePath = join(dir, 'module.mjs');
        runnerPath = join(dir, 'runner.mjs');
        // No journal, checkout, evaluator, fixture suite, canary, socket or host home is beneath this mount.
        writeFileSync(modulePath, source, { mode: 0o444 });
        writeFileSync(runnerPath, runner, { mode: 0o444 });
        chmodSync(dir, 0o755);
      } catch { throw unavailable(); }
      await this.#preflight(deadline, signal);
      const args = ['run', '--pull=never', '--name', name, '--label', 'meridian.workbench=1',
        '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--cpus=0.5', '--memory=128m', '--pids-limit=32', '--tmpfs', '/tmp:rw,size=8m,noexec,nosuid,nodev',
        '--mount', `type=bind,src=${modulePath},dst=/work/module.mjs,readonly`,
        '--mount', `type=bind,src=${runnerPath},dst=/work/runner.mjs,readonly`,
        '--entrypoint', '/usr/bin/node', '-i', this.#image, '/work/runner.mjs'];
      return await new Promise<unknown>((accept, reject) => {
        const child = (() => { try { return spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: cliEnvironment() }); } catch { return undefined; } })();
        if (!child) { reject(unavailable()); return; }
        // Without a pid the CLI never started, so no container can exist and none is removed.
        launched = child.pid !== undefined;
        const chunks: Buffer[] = [];
        let out = 0, err = 0, reason: string | undefined, settled = false;
        const fail = (code: string) => { reason ??= code; child.kill('SIGKILL'); };
        const abort = () => fail('aborted');
        // Reserve up to one second for forced removal, within the complete three second lifecycle.
        const runMs = Math.max(1, deadline - Date.now() - REMOVAL_MS);
        const timer = setTimeout(() => fail('execution-deadline'), runMs);
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(hard);
          signal?.removeEventListener('abort', abort);
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
          if (reason) { reject(new WorkbenchError(reason)); return; }
          try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new WorkbenchError('invalid-output')); }
        };
        const hard = setTimeout(() => { fail('execution-deadline'); settle(); }, runMs + 50);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.length;
          if (out > LIMITS.stdoutBytes) fail('stdout-budget'); else chunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => { err += chunk.length; if (err > LIMITS.stderrBytes) fail('stderr-budget'); });
        child.stdin.on('error', () => fail('execution-failed'));
        child.on('error', () => { reason ??= launched ? 'execution-failed' : 'executor-unavailable'; });
        child.on('close', code => { if (code !== 0) reason ??= 'execution-failed'; settle(); });
        child.stdin.end(data);
      });
    } finally {
      // Killing the client alone does not remove its container. A cleanup failure keeps the slot locked for the operator.
      if (launched) removed = await new Promise<boolean>(done => {
        const cleanup = spawn('docker', ['rm', '-f', name], { stdio: ['ignore', 'ignore', 'pipe'], env: cliEnvironment() });
        let finished = false, error = '';
        const finish = (ok: boolean) => { if (finished) return; finished = true; clearTimeout(timer); done(ok); };
        const timer = setTimeout(() => { cleanup.kill('SIGKILL'); cleanup.stderr.destroy(); finish(false); }, Math.max(1, deadline - Date.now()));
        cleanup.stderr.on('data', (chunk: Buffer) => { if (error.length < 1024) error += chunk.toString('utf8').slice(0, 1024 - error.length); });
        cleanup.on('error', () => finish(false));
        cleanup.on('close', code => finish(code === 0 || (code === 1 && error.trim() === `Error response from daemon: No such container: ${name}`)));
      }).catch(() => false);
      let temporary = true;
      try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { temporary = false; }
      if (!removed) throw new WorkbenchError('cleanup-failed');
      activeExecution = false;
      // Private module bytes could not be removed from host tmp: a host fault, not a measurement.
      if (!temporary) throw unavailable();
    }
  }

  /** `docker image inspect` never pulls, builds, mounts or starts anything; any failure means no container was created. */
  async #preflight(deadline: number, signal?: AbortSignal): Promise<void> {
    const present = await new Promise<boolean>(done => {
      const inspect = spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', this.#image], { stdio: ['ignore', 'pipe', 'ignore'], env: cliEnvironment() });
      let finished = false, id = '';
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        inspect.stdout.destroy();
        done(ok);
      };
      const stop = () => { inspect.kill('SIGKILL'); finish(false); };
      const timer = setTimeout(stop, Math.max(1, Math.min(PREFLIGHT_MS, deadline - Date.now() - REMOVAL_MS)));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      inspect.stdout.on('data', (chunk: Buffer) => { if (id.length < 256) id += chunk.toString('utf8').slice(0, 256 - id.length); });
      inspect.on('error', () => finish(false));
      inspect.on('close', code => finish(code === 0 && id.trim() === this.#image));
    }).catch(() => false);
    if (signal?.aborted) throw new WorkbenchError('aborted');
    if (!present) throw unavailable();
  }
}
