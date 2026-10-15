import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Diagnóstico: escribe en ~/kogn-worker.log para verificar que el worker arranca y ejecuta
function dlog(msg: string): void {
  try { appendFileSync(join(process.env.HOME ?? '/tmp', 'kogn-worker.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

type InMsg =
  | { type: 'cmd'; id: string; command: string; cwd: string; env: Record<string, string>; timeoutMs: number }
  | { type: 'screenshot'; id: string };

// process.parentPort: disponible en Electron utility process (no en tipos de @types/node)
const port = (process as NodeJS.Process & {
  parentPort: {
    on(e: 'message', cb: (ev: { data: InMsg }) => void): void;
    postMessage(d: unknown): void;
  };
}).parentPort;

dlog('worker iniciado');

// Test al arrancar: verifica que execFile funciona en este contexto
execFile('/bin/echo', ['kogn-worker-ok'], { timeout: 2000 }, (err, stdout) => {
  dlog(err ? `TEST SPAWN FAILED: ${err.message}` : `TEST SPAWN OK: ${stdout.trim()}`);
});

port.on('message', (e) => {
  const msg = e.data;

  // ── Screenshot ────────────────────────────────────────────────────────────
  if (msg.type === 'screenshot') {
    const { id } = msg;
    const tmp = join(tmpdir(), `kogn-ss-${randomBytes(6).toString('hex')}.png`);
    execFile('screencapture', ['-x', '-m', tmp], { timeout: 6000 }, (err) => {
      if (err) { port.postMessage({ id, type: 'screenshot', b64: null }); return; }
      execFile('sips', ['-Z', '1280', tmp], { timeout: 4000 }, () => {
        try {
          const b64 = readFileSync(tmp).toString('base64');
          try { unlinkSync(tmp); } catch {}
          port.postMessage({ id, type: 'screenshot', b64 });
        } catch {
          try { unlinkSync(tmp); } catch {}
          port.postMessage({ id, type: 'screenshot', b64: null });
        }
      });
    });
    return;
  }

  // ── Shell command ─────────────────────────────────────────────────────────
  const { id, command, cwd, env, timeoutMs } = msg;
  dlog(`exec: ${command.slice(0, 80)}`);
  let timedOut = false;

  const child = execFile(
    '/bin/zsh', ['-lc', command],
    { cwd, env, maxBuffer: 200_000 },
    (error, stdout, stderr) => {
      if (timedOut) return;
      const raw = ((stdout ?? '') + (stderr ? '\n' + stderr : '')).trim();
      const output = raw.length > 20_000
        ? `${raw.slice(0, 8_000)}\n...[recortado]...\n${raw.slice(-12_000)}`
        : (raw || '(sin salida)');
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      dlog(`done: code=${code}`);
      port.postMessage({ id, type: 'cmd', code, output, timedOut: false });
    },
  );

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
    port.postMessage({ id, type: 'cmd', code: null, output: `TIMEOUT tras ${Math.round(timeoutMs / 1000)}s.`, timedOut: true });
  }, timeoutMs);

  child.on('close', () => clearTimeout(timer));
  child.on('error', () => clearTimeout(timer));
});
