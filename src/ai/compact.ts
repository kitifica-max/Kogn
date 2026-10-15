import type { Msg, Block } from './providers.js';

const MARK = '[resultado previo:';

const hasResults = (m: Msg): m is Msg & { content: Block[] } =>
  Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');

/**
 * Reemplaza el contenido de los tool_result de rondas anteriores por una línea corta.
 * Conserva completo solo el último grupo. Cada tool_use mantiene su tool_result (la API lo exige).
 * `names` mapea tool_use_id → nombre de herramienta. Idempotente.
 */
export function compactToolResults(msgs: Msg[], names: Map<string, string>): void {
  let last = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (hasResults(msgs[i]!)) { last = i; break; }
  for (let i = 0; i < last; i++) {
    const m = msgs[i]!;
    if (!hasResults(m)) continue;
    msgs[i] = {
      ...m,
      content: m.content.map((b): Block => {
        if (b.type !== 'tool_result') return b;
        const textContent = typeof b.content === 'string' ? b.content : b.content.flatMap((c) => c.type === 'text' ? [c.text] : []).join('');
        if (textContent.startsWith(MARK)) return b;
        const tool = names.get(b.tool_use_id) ?? 'herramienta';
        return { ...b, content: `${MARK} ${tool} → ${Buffer.byteLength(textContent)} bytes, ${b.is_error ? 'error' : 'ok'}]` };
      }),
    };
  }
}
