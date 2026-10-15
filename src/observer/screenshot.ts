import { execFile } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Flash RAM: capturas del día en memoria, borradas al día siguiente.
// Solo se persiste lo que el AI guarda con remember_memory.
const FLASH_MAX = 12;
interface FlashEntry { ts: number; b64: string }
const flash: FlashEntry[] = [];
let flashDay = new Date().toDateString();

function flushIfNewDay(): void {
  const today = new Date().toDateString();
  if (today !== flashDay) { flash.length = 0; flashDay = today; }
}

export function addToFlash(b64: string): void {
  flushIfNewDay();
  flash.push({ ts: Date.now(), b64 });
  if (flash.length > FLASH_MAX) flash.shift();
}

export function latestFlash(): string | null {
  flushIfNewDay();
  return flash.length > 0 ? flash[flash.length - 1].b64 : null;
}

export async function takeScreenshot(): Promise<string | null> {
  const tmp = join(tmpdir(), `kogn-ss-${randomBytes(6).toString('hex')}.png`);
  return new Promise((resolve) => {
    // -x: sin sonido, -m: pantalla principal únicamente
    execFile('screencapture', ['-x', '-m', tmp], { timeout: 6000 }, (err) => {
      if (err) { resolve(null); return; }
      // Redimensionar a max 1280px (reduce tokens ~70%)
      execFile('sips', ['-Z', '1280', tmp], { timeout: 4000 }, () => {
        try {
          const b64 = readFileSync(tmp).toString('base64');
          try { unlinkSync(tmp); } catch {}
          resolve(b64);
        } catch { resolve(null); }
      });
    });
  });
}
