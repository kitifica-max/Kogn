import { execFile } from 'node:child_process';

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

    // execFile con pipes: mismo patrón que activeWindow.ts (funciona en app empaquetada).
    // spawn con stdio:'ignore' falla con EBADF en Electron porque libuv intenta
    // manipular /dev/null en fds que Chromium ya cerró.
    let timedOut = false;
    let aborted = false;

    const child = execFile(
      '/bin/zsh', ['-lc', command],
      { cwd: opts.cwd, env, maxBuffer: 200_000 },
      (error, stdout, stderr) => {
        const raw = ((stdout ?? '') + (stderr ? '\n' + stderr : '')).trim();
        const output = clip(raw || '(sin salida)');
        const code = error
          ? (typeof error.code === 'number' ? error.code : null)
          : 0;
        resolve({ code, output, timedOut, aborted });
      },
    );

    const kill = (): void => { child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);

    const onAbort = (): void => { aborted = true; kill(); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    });

    child.on('error', () => { /* el callback de execFile ya lo maneja */ });
  });
}
