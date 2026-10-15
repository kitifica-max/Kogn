import { spawn } from 'node:child_process';

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

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; output: string; timedOut: boolean; aborted?: boolean }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    // ponytail: sin detached — previene EBADF en Electron empaquetado con setsid(); el zsh sigue siendo login shell para heredar PATH del usuario
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const add = (d: Buffer): void => { if (out.length < 200_000) out += d.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = (): void => { child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    let aborted = false;
    const onAbort = (): void => { aborted = true; kill(); }; // "Detener": mata el comando y todo lo que lanzó
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); };
    child.on('error', (e) => { done(); resolve({ code: null, output: String(e), timedOut, aborted }); });
    child.on('close', (code) => { done(); resolve({ code, output: clip(out), timedOut, aborted }); });
  });
}
