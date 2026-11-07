import { randomBytes } from 'node:crypto';
import type { ToolDef } from '../ai/providers.js';
import type { McpServer, OauthBlob, ToolInfo, WorkerIn, WorkerOut } from './protocol.js';

// Lado main del worker MCP: guarda el estado de cada servidor y traduce sus herramientas al formato del modelo.

export interface McpStatus { ok: boolean; tools: ToolInfo[]; error?: string; needsAuth?: boolean }
export interface McpHooks { openUrl(url: string): void; saveOauth(server: string, blob: OauthBlob): void; onStatus(): void }
type McpPort = { postMessage(d: WorkerIn): void; on(ev: 'message', cb: (msg: WorkerOut) => void): void };

const PREFIX = 'mcp__';
const DESC_MAX = 600; // Gmail trae ~30 herramientas: descripciones acotadas para no inflar cada llamada

let workerPort: McpPort | null = null;
let hooks: McpHooks | null = null;
const status = new Map<string, McpStatus>();
const labels = new Map<string, string>();
const byToolName = new Map<string, { server: string; tool: string }>();
const pending = new Map<string, (r: { ok: boolean; text: string }) => void>();

export function initMcpWorker(port: McpPort, h: McpHooks): void {
  workerPort = port;
  hooks = h;
  status.clear();
  port.on('message', (m) => {
    if (m.type === 'status') {
      if (m.server === '*') { console.warn('[kogn] mcp:', m.error); return; }
      status.set(m.server, { ok: m.ok, tools: m.tools, error: m.error, needsAuth: m.needsAuth });
      console.log(`[kogn] mcp ${m.server}: ${m.ok ? `${m.tools.length} herramientas` : m.error}`);
      rebuildIndex();
      h.onStatus();
    } else if (m.type === 'result') {
      const cb = pending.get(m.id);
      if (cb) { pending.delete(m.id); cb(m); }
    } else if (m.type === 'open-url') h.openUrl(m.url);
    else if (m.type === 'oauth') h.saveOauth(m.server, m.blob);
  });
}

/** Nombre de herramienta válido para Anthropic/OpenAI: ^[a-zA-Z0-9_-]{1,64}$ */
export function toolName(server: string, tool: string): string {
  return `${PREFIX}${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function rebuildIndex(): void {
  byToolName.clear();
  for (const [server, s] of status) for (const t of s.tools) byToolName.set(toolName(server, t.name), { server, tool: t.name });
}

export function isMcpTool(name: string): boolean { return name.startsWith(PREFIX); }

/** Herramientas de todas las integraciones conectadas, listas para el modelo. */
export function mcpToolDefs(): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const [server, s] of status) {
    if (!s.ok) continue;
    const label = labels.get(server) ?? server;
    for (const t of s.tools) {
      const schema = t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : {};
      defs.push({
        name: toolName(server, t.name),
        description: `[${label}] ${t.description}`.slice(0, DESC_MAX),
        input_schema: { type: 'object', properties: {}, ...schema },
      });
    }
  }
  return defs;
}

export function mcpConnect(server: McpServer, env: Record<string, string>, oauth: OauthBlob | null): void {
  labels.set(server.id, server.label);
  status.set(server.id, { ok: false, tools: [], error: 'Conectando…' });
  rebuildIndex();
  if (!workerPort) { status.set(server.id, { ok: false, tools: [], error: 'Worker MCP no disponible' }); return; }
  workerPort.postMessage({ type: 'connect', server, env, oauth });
}

export function mcpDisconnect(id: string): void {
  status.delete(id);
  labels.delete(id);
  rebuildIndex();
  workerPort?.postMessage({ type: 'disconnect', server: id });
}

export function mcpStatus(): Record<string, McpStatus> {
  return Object.fromEntries(status);
}

export function mcpCall(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
  const target = byToolName.get(name);
  if (!target) return Promise.resolve({ success: false, message: `Integración desconocida: ${name}` });
  if (!workerPort) return Promise.resolve({ success: false, message: 'Worker MCP no disponible' });
  return new Promise((resolve) => {
    const id = randomBytes(8).toString('hex');
    let settled = false;
    const settle = (r: { ok: boolean; text: string }): void => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      resolve({ success: r.ok, message: r.text });
    };
    const onAbort = (): void => settle({ ok: false, text: '(detenido)' });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, settle);
    workerPort!.postMessage({ type: 'call', id, server: target.server, tool: target.tool, args: input });
  });
}

/** "NOMBRE=valor" por línea → objeto. Líneas sin "=" o vacías se ignoran. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** "npx -y @x/y --flag" → { command, args }. ponytail: sin comillas; basta para npx/uvx/python. */
export function parseCommand(text: string): { command: string; args: string[] } | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length ? { command: parts[0]!, args: parts.slice(1) } : null;
}

/** Hooks reutilizables si el worker se reinicia (se reconectan todos los servidores). */
export function mcpHooks(): McpHooks | null { return hooks; }
