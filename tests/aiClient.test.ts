import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDb, cfg } from './helpers.js';
import { AiClient } from '../src/ai/client.js';
import { usageTotals } from '../src/ai/cost.js';
import type { Provider, ChatRequest, LlmResult } from '../src/ai/providers.js';
import type { ModelProfile } from '../src/shared/types.js';

const local: ModelProfile = { id: 'l', label: 'Local', provider: 'ollama', model: 'qwen3:8b' };
const paid: ModelProfile = { id: 'p', label: 'Pago', provider: 'openai', model: 'gpt-x', price_in: 1, price_out: 2 };

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const step = (text: string, calls: LlmResult['toolCalls'] = []): LlmResult => ({
  text, toolCalls: calls, usage, stop: calls.length ? 'tool_use' : 'end',
  assistantMsg: { role: 'assistant', content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((c) => ({ type: 'tool_use' as const, ...c }))] },
});

// Proveedor simulado: responde en orden y guarda lo que recibió
function script(results: LlmResult[]): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return { requests, provider: { async chat(req) { requests.push(JSON.parse(JSON.stringify(req))); return results[Math.min(i++, results.length - 1)]!; } } };
}

let base: string, allowed: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'agentik-ai-')); allowed = join(base, 'allowed'); mkdirSync(allowed); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

function client(db: ReturnType<typeof memoryDb>, resolve: () => { provider: Provider; profile: ModelProfile }) {
  return new AiClient(db, { ...cfg, allowed_folders: [allowed], memory_enabled: false }, join(base, 'backups'), resolve);
}

describe('bucle del agente con cualquier proveedor', () => {
  it('ejecuta herramientas, devuelve los resultados al modelo y responde con el texto de la última ronda', async () => {
    const db = memoryDb();
    const { provider, requests } = script([
      step('Voy a crear la carpeta', [{ id: 'c1', name: 'create_folder', input: { path: join(allowed, 'Fotos') } }]),
      step('Listo, creé Fotos'),
    ]);
    const r = await client(db, () => ({ provider, profile: local })).chat('crea Fotos');
    expect(existsSync(join(allowed, 'Fotos'))).toBe(true);
    expect(r.reply).toBe('Listo, creé Fotos');
    expect(r.opsExecuted).toBe(1);
    // la 2ª llamada lleva el mensaje del asistente y el resultado de la herramienta
    const msgs = requests[1]!.messages;
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false }] });
    expect(requests[0]!.tools.map((t) => t.name)).toContain('organize_folder');
    expect(requests[0]!.system).toContain('Kogn');
  });

  it('los errores de herramienta vuelven al modelo sin romper el bucle (rutas sensibles, argumentos faltantes, herramientas inventadas)', async () => {
    const db = memoryDb();
    writeFileSync(join(allowed, '.env'), 'SECRETO=1');
    const { provider, requests } = script([
      step('', [
        { id: 'a', name: 'write_file', input: { path: join(allowed, '.env'), content: 'x' } },
        { id: 'b', name: 'create_folder', input: {} },
        { id: 'c', name: 'volar', input: {} },
      ]),
      step('No pude hacerlo'),
    ]);
    const r = await client(db, () => ({ provider, profile: local })).chat('haz cosas');
    const results = (requests[1]!.messages.at(-1)!.content as any[]);
    expect(results.map((x) => x.is_error)).toEqual([true, true, true]);
    expect(results[0].content).toMatch(/sensible/i);
    expect(r.opsExecuted).toBe(0);
    expect(r.reply).toBe('No pude hacerlo');
  });

  it('resuelve el modelo en CADA mensaje: cambiar de modelo surte efecto de inmediato', async () => {
    const db = memoryDb();
    const a = script([step('respuesta A')]);
    const b = script([step('respuesta B')]);
    let active: 'a' | 'b' = 'a';
    const ai = client(db, () => (active === 'a' ? { provider: a.provider, profile: local } : { provider: b.provider, profile: paid }));
    expect((await ai.chat('hola')).reply).toBe('respuesta A');
    active = 'b';
    expect((await ai.chat('hola otra vez')).reply).toBe('respuesta B');
    expect(b.requests[0]!.messages.map((m) => m.content)).toContain('hola'); // el historial de texto se conserva
  });

  it('registra el costo con el precio del perfil: local $0, de pago según su tarifa', async () => {
    const db = memoryDb();
    await client(db, () => ({ provider: script([step('ok')]).provider, profile: local })).chat('x');
    expect(usageTotals(db).today).toBe(0);
    await client(db, () => ({ provider: script([step('ok')]).provider, profile: paid })).chat('x');
    expect(usageTotals(db).today).toBeCloseTo(3); // 1M entrada × $1 + 1M salida × $2
    const rows = db.prepare('SELECT model FROM usage ORDER BY id').all() as { model: string }[];
    expect(rows.map((r) => r.model)).toEqual(['qwen3:8b', 'gpt-x']);
  });

  it('si el proveedor falla (p. ej. falta la clave), el error llega tal cual al llamador', async () => {
    const db = memoryDb();
    const ai = client(db, () => { throw new Error('Falta la API key de "Claude". Agrégala en la pestaña Modelo.'); });
    await expect(ai.chat('hola')).rejects.toThrow(/pestaña Modelo/);
  });

  it('el bloque estático del system es idéntico entre llamadas aunque cambie lo dinámico (cacheable)', async () => {
    const db = memoryDb();
    const a = script([step('uno')]);
    const ai = new AiClient(db, { ...cfg, allowed_folders: [allowed], memory_enabled: false }, join(base, 'backups'), () => ({ provider: a.provider, profile: local }));
    await ai.chat('hola');
    writeFileSync(join(allowed, 'nuevo.txt'), 'x'); // cambia el listado de carpetas (dinámico)
    await ai.chat('otra vez');
    const [r1, r2] = a.requests;
    expect(r1!.systemParts!.static).toBe(r2!.systemParts!.static);
    expect(r1!.systemParts!.static).toContain('Kogn');
    expect(r1!.systemParts!.dynamic).not.toBe(r2!.systemParts!.dynamic);
    expect(r1!.system).toBe(r1!.systemParts!.static + '\n\n' + r1!.systemParts!.dynamic);
    expect(JSON.stringify(r1!.tools)).toBe(JSON.stringify(r2!.tools));
  });

  it('compacta resultados de rondas anteriores: la 3ª llamada lleva el 1er resultado resumido y el último completo', async () => {
    const db = memoryDb();
    writeFileSync(join(allowed, 'a.txt'), 'hola');
    const { provider, requests } = script([
      step('', [{ id: 'r1', name: 'list_folder', input: { path: allowed } }]),
      step('', [{ id: 'r2', name: 'read_file', input: { path: join(allowed, 'a.txt') } }]),
      step('Listo'),
    ]);
    await client(db, () => ({ provider, profile: local })).chat('mira');
    const groups = requests[2]!.messages.filter((m) => Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === 'tool_result'));
    expect(groups).toHaveLength(2);
    expect((groups[0]!.content as any)[0].content).toMatch(/^\[resultado previo: list_folder → \d+ bytes, ok\]$/);
    expect((groups[1]!.content as any)[0].content).toBe('hola');
    // cada tool_use tiene su tool_result
    const ids = (t: string) => requests[2]!.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as any[]).filter((b) => b.type === t).map((b) => b.id ?? b.tool_use_id) : []));
    expect(ids('tool_result')).toEqual(ids('tool_use'));
  });

  it('presupuesto: read_file y el listado de carpetas son más cortos con modelos locales que con la nube', async () => {
    const big = 'a'.repeat(20000);
    writeFileSync(join(allowed, 'grande.txt'), big);
    for (let i = 0; i < 120; i++) writeFileSync(join(allowed, `f${String(i).padStart(3, '0')}.txt`), '');
    const readCall = () => step('', [{ id: 'r', name: 'read_file', input: { path: join(allowed, 'grande.txt') } }]);
    const run = async (profile: ModelProfile) => {
      const s = script([readCall(), step('ok')]);
      await client(memoryDb(), () => ({ provider: s.provider, profile })).chat('lee');
      const out = (s.requests[1]!.messages.at(-1)!.content as any[])[0].content as string;
      const dyn = s.requests[0]!.systemParts!.dynamic;
      return { out, dyn };
    };
    const l = await run(local);
    expect(l.out).toBe('a'.repeat(3072) + '\n(truncado)');
    expect(l.dyn).toMatch(/\(\+\d+ más\)/);
    expect(l.dyn.split('\n').filter((x) => x.endsWith('.txt')).length).toBe(30);
    const c = await run(paid);
    expect(c.out).toBe('a'.repeat(10240) + '\n(truncado)');
    expect(c.dyn.split('\n').filter((x) => x.endsWith('.txt')).length).toBe(100);
    writeFileSync(join(allowed, 'chico.txt'), 'corto');
    const s2 = script([step('', [{ id: 'r', name: 'read_file', input: { path: join(allowed, 'chico.txt') } }]), step('ok')]);
    await client(memoryDb(), () => ({ provider: s2.provider, profile: local })).chat('lee');
    expect((s2.requests[1]!.messages.at(-1)!.content as any[])[0].content).toBe('corto'); // sin "(truncado)" si cabe
  });

  it('guarda en el historial del modelo qué hizo en el turno (sin cambiar la respuesta visible)', async () => {
    const db = memoryDb();
    const { provider, requests } = script([
      step('', [{ id: 'c1', name: 'create_folder', input: { path: join(allowed, 'Fotos') } }]),
      step('Listo, creé Fotos'),
      step('Deshecho'),
    ]);
    const ai = client(db, () => ({ provider, profile: local }));
    const r = await ai.chat('crea Fotos');
    expect(r.reply).toBe('Listo, creé Fotos'); // lo visible no cambia
    await ai.chat('deshaz eso');
    const prev = requests[2]!.messages.find((m) => m.role === 'assistant' && typeof m.content === 'string')!.content as string;
    expect(prev).toContain('Listo, creé Fotos');
    expect(prev).toContain('[acciones de este turno]');
    expect(prev).toContain('create_folder Fotos');
    expect(prev).not.toContain(allowed); // solo nombre base, sin ruta completa
  });

  it('move_file se fusionó en move_files: un solo elemento mueve/renombra, y el nombre viejo ya no existe', async () => {
    const db = memoryDb();
    writeFileSync(join(allowed, 'viejo.txt'), 'x');
    const { provider, requests } = script([
      step('', [{ id: 'm', name: 'move_files', input: { moves: [{ source: join(allowed, 'viejo.txt'), destination: join(allowed, 'nuevo.txt') }] } }]),
      step('Listo'),
    ]);
    const r = await client(db, () => ({ provider, profile: local })).chat('renombra viejo');
    expect(existsSync(join(allowed, 'nuevo.txt'))).toBe(true);
    expect(existsSync(join(allowed, 'viejo.txt'))).toBe(false);
    expect(r.opsExecuted).toBe(1);
    const names = requests[0]!.tools.map((t) => t.name);
    expect(names).toContain('move_files');
    expect(names).not.toContain('move_file');
    expect(names).toContain('list_folder'); // se conserva: da tamaño, fecha y profundidad que el listado inicial no tiene
  });

  it('se detiene en el límite de rondas y lo avisa', async () => {
    const db = memoryDb();
    const loop = step('', [{ id: 'x', name: 'list_folder', input: { path: allowed } }]);
    const r = await client(db, () => ({ provider: script([loop]).provider, profile: local })).chat('sin fin');
    expect(r.reply).toMatch(/límite de \d+ rondas/);
  });
});

describe('extensión de herramientas (integraciones y tareas)', () => {
  it('las herramientas de la extensión viajan al modelo y sus llamadas se enrutan; lo demás sigue igual', async () => {
    const db = memoryDb();
    const calls: string[] = [];
    const ext = {
      tools: () => [{ name: 'mcp__gmail__search', description: 'Busca', input_schema: { type: 'object', properties: {} } }],
      async call(name: string) { if (!name.startsWith('mcp__')) return null; calls.push(name); return { success: true, message: '2 correos', ops: 1 }; },
    };
    const { provider, requests } = script([
      step('', [{ id: 'g1', name: 'mcp__gmail__search', input: { q: 'urgente' } }, { id: 'g2', name: 'volar', input: {} }]),
      step('Tienes 2 correos urgentes'),
    ]);
    const ai = new AiClient(db, { ...cfg, allowed_folders: [allowed], memory_enabled: false }, join(base, 'backups'), () => ({ provider, profile: local }), undefined, ext);
    const r = await ai.chat('¿algo urgente?');
    expect(requests[0]!.tools.map((t) => t.name)).toContain('mcp__gmail__search');
    expect(calls).toEqual(['mcp__gmail__search']);
    const results = (requests[1]!.messages.at(-1)!.content as any[]);
    expect(results.map((x) => x.is_error)).toEqual([false, true]);
    expect(r.opsExecuted).toBe(1);
    expect(r.reply).toBe('Tienes 2 correos urgentes');
  });
});
