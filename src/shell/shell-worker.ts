import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Diagnóstico: escribe en ~/kogn-worker.log para verificar que el worker arranca y ejecuta
function dlog(msg: string): void {
  try { appendFileSync(join(process.env.HOME ?? '/tmp', 'kogn-worker.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

interface CmdRequest {
  id: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

interface CmdResponse {
  id: string;
  code: number | null;
  output: string;
  timedOut: boolean;
}

// process.parentPort: disponible en Electron utility process (no en tipos de @types/node)
const port = (process as NodeJS.Process & { parentPort: { on(e: 'message', cb: (ev: { data: CmdRequest }) => void): void; postMessage(d: unknown): void } }).parentPort;

dlog('worker iniciado');

// Test al arrancar: verifica que execFile funciona en este contexto
execFile('/bin/echo', ['kogn-worker-ok'], { timeout: 2000 }, (err, stdout) => {
  dlog(err ? `TEST SPAWN FAILED: ${err.message}` : `TEST SPAWN OK: ${stdout.trim()}`);
});

port.on('message', (e) => {
  const { id, command, cwd, env, timeoutMs } = e.data;
  dlog(`exec: ${command.slice(0, 80)}`);

  let timedOut = false;

  const child = execFile(
    '/bin/zsh', ['-lc', command],
    { cwd, env, maxBuffer: 200_000 },
    (error, stdout, stderr) => {
      if (timedOut) return; // el timer ya envió la respuesta
      const raw = ((stdout ?? '') + (stderr ? '\n' + stderr : '')).trim();
      const output = raw.length > 20_000
        ? `${raw.slice(0, 8_000)}\n...[recortado]...\n${raw.slice(-12_000)}`
        : (raw || '(sin salida)');
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      dlog(`done: code=${code}`);
      const resp: CmdResponse = { id, code, output, timedOut: false };
      port.postMessage(resp);
    },
  );

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
    const resp: CmdResponse = { id, code: null, output: `TIMEOUT tras ${Math.round(timeoutMs / 1000)}s.`, timedOut: true };
    port.postMessage(resp);
  }, timeoutMs);

  child.on('close', () => clearTimeout(timer));
  child.on('error', () => clearTimeout(timer)); // execFile callback ya maneja el error
});
