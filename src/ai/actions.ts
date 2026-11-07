import { basename, dirname } from 'node:path';
import { isSensitivePath } from '../observer/filters.js';
import { isSensitiveText } from '../memory/filters.js';

export const MAX_ACTION_LINES = 5;

/** Herramientas que cambian algo (las de solo lectura no son "acciones" que se puedan deshacer). */
const MUTATING = new Set(['organize_folder', 'move_files', 'create_folder', 'copy_file', 'write_file', 'run_command', 'run_script']);

// Formas típicas de secretos en una línea de comandos (isSensitiveText no las cubre).
const SECRET_IN_CMD = /\bBearer\b|authorization|\bsk-[\w-]{8,}|\bgh[pousr]_\w{8,}|\bxox[abprs]-|\bAKIA[0-9A-Z]{8,}|(token|secret|passwd|pass|key)\s*[=:]\S|--(password|token|secret)/i;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const name = (p: unknown): string => (typeof p === 'string' && p ? basename(p) : '');

/**
 * Una línea corta por herramienta exitosa, p. ej. "organize_folder Downloads → 130 movidos".
 * Solo nombres base (sin rutas completas) y nunca contenido de archivos. null = no se registra.
 */
export function actionLine(tool: string, input: Record<string, unknown>, message: string): string | null {
  if (tool.startsWith('mcp__')) return tool; // integración externa: solo el nombre (el resultado puede traer correos o mensajes)
  if (!MUTATING.has(tool)) return null;
  const paths = [input.folder, input.path, input.source, input.destination];
  if (tool === 'run_script' && input.params && typeof input.params === 'object') paths.push(...Object.values(input.params as Record<string, unknown>));
  if (tool === 'move_files' && Array.isArray(input.moves)) {
    for (const m of input.moves as { source?: unknown; destination?: unknown }[]) paths.push(m?.source, m?.destination);
  }
  if (paths.some((p) => typeof p === 'string' && isSensitivePath(p))) return null;

  const first = message.split('\n')[0]!.slice(0, 80);
  switch (tool) {
    case 'organize_folder': return `organize_folder ${name(input.folder)} → ${first}`;
    case 'move_files': {
      const moves = Array.isArray(input.moves) ? input.moves as { destination?: unknown }[] : [];
      const dest = moves[0]?.destination;
      return `move_files → ${first}${typeof dest === 'string' ? ` (a ${basename(dirname(dest))})` : ''}`;
    }
    case 'run_script': return `run_script ${str(input.id).slice(0, 40)} → ${first}`;
    case 'create_folder': return `create_folder ${name(input.path)}`;
    case 'copy_file': return `copy_file ${name(input.source)} → ${name(input.destination)}`;
    case 'write_file': return `write_file ${name(input.path)}`;
    case 'run_command': {
      const cmd = str(input.command).trim().replace(/\s+/g, ' ');
      if (!cmd || isSensitiveText(cmd) || SECRET_IN_CMD.test(cmd)) return 'run_command';
      return `run_command ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`;
    }
  }
  return null;
}

/** Bloque para el historial del modelo (no se muestra ni se guarda en el chat del usuario). */
export function actionsBlock(lines: string[]): string {
  return lines.length ? '\n[acciones de este turno]\n' + lines.slice(-MAX_ACTION_LINES).join('\n') : '';
}
