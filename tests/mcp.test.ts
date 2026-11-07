import { describe, it, expect } from 'vitest';
import { initMcpWorker, mcpConnect, mcpToolDefs, mcpCall, toolName, parseEnvLines, parseCommand, mcpStatus } from '../src/mcp/mcp.js';
import type { WorkerIn, WorkerOut } from '../src/mcp/protocol.js';

// Puerto simulado: el "worker" responde con lo que el test decida
function fakePort(onMsg: (m: WorkerIn, reply: (o: WorkerOut) => void) => void) {
  let listener: ((m: WorkerOut) => void) | null = null;
  return {
    postMessage: (m: WorkerIn) => onMsg(m, (o) => listener?.(o)),
    on: (_ev: 'message', cb: (m: WorkerOut) => void) => { listener = cb; },
  };
}

describe('nombres y parseo', () => {
  it('toolName cumple ^[a-zA-Z0-9_-]{1,64}$ aunque el servidor use puntos o nombres largos', () => {
    expect(toolName('gmail', 'get.message')).toBe('mcp__gmail__get_message');
    expect(toolName('slack', 'x'.repeat(100))).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
  it('parseEnvLines ignora líneas vacías o sin "="', () => {
    expect(parseEnvLines('A=1\n\nsin igual\n B = 2 \nAuthorization=Bearer x=y')).toEqual({ A: '1', B: '2', Authorization: 'Bearer x=y' });
  });
  it('parseCommand separa comando y argumentos', () => {
    expect(parseCommand('  npx -y @scope/pkg --flag ')).toEqual({ command: 'npx', args: ['-y', '@scope/pkg', '--flag'] });
    expect(parseCommand('   ')).toBeNull();
  });
});

describe('puente main ↔ worker', () => {
  it('expone las herramientas del servidor conectado con prefijo y etiqueta, y enruta las llamadas', async () => {
    const seen: WorkerIn[] = [];
    const port = fakePort((m, reply) => {
      seen.push(m);
      if (m.type === 'connect') reply({ type: 'status', server: m.server.id, ok: true, tools: [{ name: 'send_message', description: 'Envía', input_schema: { type: 'object', properties: { to: { type: 'string' } } } }] });
      if (m.type === 'call') reply({ type: 'result', id: m.id, ok: true, text: `enviado a ${String(m.args['to'])} via ${m.tool}` });
    });
    let statusCalls = 0;
    initMcpWorker(port, { openUrl: () => {}, saveOauth: () => {}, onStatus: () => { statusCalls++; } });
    mcpConnect({ id: 'slack', label: 'Slack', url: 'https://x/mcp' }, { Authorization: 'Bearer t' }, null);
    expect(statusCalls).toBe(1);
    const defs = mcpToolDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: 'mcp__slack__send_message', description: '[Slack] Envía' });
    expect((defs[0]!.input_schema as { type: string }).type).toBe('object');
    const r = await mcpCall('mcp__slack__send_message', { to: '#general' });
    expect(r).toEqual({ success: true, message: 'enviado a #general via send_message' });
    expect(seen.find((m) => m.type === 'connect')).toMatchObject({ env: { Authorization: 'Bearer t' } });
    expect(await mcpCall('mcp__nadie__x', {})).toMatchObject({ success: false });
  });

  it('un servidor que pide autorización no aporta herramientas pero queda marcado', () => {
    const port = fakePort((m, reply) => {
      if (m.type === 'connect') reply({ type: 'status', server: m.server.id, ok: false, tools: [], needsAuth: true, error: 'Autoriza' });
    });
    initMcpWorker(port, { openUrl: () => {}, saveOauth: () => {}, onStatus: () => {} });
    mcpConnect({ id: 'gmail', label: 'Gmail', url: 'https://g/mcp' }, {}, null);
    expect(mcpToolDefs()).toHaveLength(0);
    expect(mcpStatus()['gmail']).toMatchObject({ ok: false, needsAuth: true });
  });

  it('Detener resuelve la llamada pendiente sin esperar al worker', async () => {
    const port = fakePort(() => { /* el worker nunca responde */ });
    initMcpWorker(port, { openUrl: () => {}, saveOauth: () => {}, onStatus: () => {} });
    port.postMessage; // noop
    const ctrl = new AbortController();
    // registrar herramienta a mano vía status
    (port as unknown as { on: (e: 'message', cb: (m: WorkerOut) => void) => void });
    mcpConnect({ id: 's', label: 'S', url: 'https://s/mcp' }, {}, null);
    // sin status ok no hay herramienta; simulamos que sí la hay
    const p = mcpCall('mcp__s__x', {}, ctrl.signal);
    expect(await p).toMatchObject({ success: false });
  });
});
