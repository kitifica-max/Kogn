import { randomBytes } from 'node:crypto';

// ponytail: red de seguridad best-effort contra desastres irreversibles, no un sandbox.
const BLOCKED: RegExp[] = [
  /\bsudo\b/,
  /\bmkfs\b|\bdiskutil\s+(erase|partition|reformat|secure)/i,
  /\bdd\b[^;&|\n]*\bof=\/dev\//,
  /:\(\)\s*\{/,
  /\b(curl|wget)\b[^;&\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\brm\b[^;&|\n]*\s-\w*[rR]\w*[^;&|\n]*\s(\/|~|\$HOME|\/Users(\/[^/\s]+)?|\/(System|Library|Applications|usr|etc|bin|sbin))\/?\*?(\s|$)/,
];

export function isBlockedCommand(command: string): boolean {
  return BLOCKED.some((re) => re.test(command));
}

function clip(s: string): string {
  return s.length > 20_000 ? `${s.slice(0, 8_000)}\n...[recortado]...\n${s.slice(-12_000)}` : s;
}

// ── Utility Process IPC ───────────────────────────────────────────────────────
type WorkerMsg = { id: string; code: number | null; output: string; timedOut: boolean };
type ShellPort = {
  postMessage(d: unknown): void;
  on(ev: 'message', cb: (msg: WorkerMsg) => void): void;
};

let workerPort: ShellPort | null = null;
const pending = new Map<string, (r: WorkerMsg) => void>();

export function initShellWorker(port: ShellPort): void {
  workerPort = port;
  port.on('message', (msg) => {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  });
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; output: string; timedOut: boolean; aborted?: boolean }> {
  if (!workerPort) {
    return Promise.resolve({ code: 1, output: 'Shell worker no disponible', timedOut: false });
  }

  return new Promise((resolve) => {
    const env = { ...process.env } as Record<string, string>;
    delete env['ANTHROPIC_API_KEY'];

    const id = randomBytes(8).toString('hex');
    let settled = false;

    const settle = (r: { code: number | null; output: string; timedOut: boolean; aborted?: boolean }): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    pending.set(id, (msg) => settle({ code: msg.code, output: clip(msg.output), timedOut: msg.timedOut }));

    const onAbort = (): void => {
      pending.delete(id);
      settle({ code: null, output: '(detenido)', timedOut: false, aborted: true });
    };

    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    workerPort!.postMessage({ id, command, cwd: opts.cwd, env, timeoutMs: opts.timeoutMs });
  });
}
