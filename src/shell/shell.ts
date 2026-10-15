import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; output: string; timedOut: boolean; aborted?: boolean }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    // Electron cierra fd 0/1/2 en apps empaquetadas; libuv los reasigna para pipes;
    // Chromium los vuelve a cerrar → EBADF al leer. Solución: sin pipes en el padre.
    // El shell redirige stdout+stderr al archivo tmp antes de ejecutar el comando.
    const tmp = join(tmpdir(), `kogn-${randomBytes(6).toString('hex')}.out`);
    const wrapped = `(\n${command}\n) >${tmp} 2>&1`;

    const child = spawn('/bin/zsh', ['-lc', wrapped], {
      cwd: opts.cwd,
      env,
      stdio: 'ignore', // sin pipes → sin FDs que Chromium pueda corromper
    });

    let timedOut = false;
    let aborted = false;

    const kill = (): void => { child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = (): void => { aborted = true; kill(); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); };

    const readTmp = (): string => {
      try {
        const out = readFileSync(tmp, 'utf8').slice(0, 200_000);
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return clip(out);
      } catch { return '(sin salida)'; }
    };

    child.on('error', (e) => {
      done();
      try { unlinkSync(tmp); } catch { /* ignore */ }
      resolve({ code: null, output: String(e), timedOut, aborted });
    });
    child.on('close', (code) => { done(); resolve({ code, output: readTmp(), timedOut, aborted }); });
  });
}
