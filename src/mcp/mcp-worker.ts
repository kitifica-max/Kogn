import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAUTH_PORT, type McpServer, type OauthBlob, type WorkerIn, type WorkerOut } from './protocol.js';

// Worker MCP: corre en un utilityProcess de Electron porque el main process no puede hacer spawn
// (EBADF con LSUIElement). Aquí viven los clientes MCP, los procesos stdio y el flujo OAuth.

const port = (process as NodeJS.Process & {
  parentPort: { on(e: 'message', cb: (ev: { data: WorkerIn }) => void): void; postMessage(d: unknown): void };
}).parentPort;
const post = (m: WorkerOut): void => port.postMessage(m);
console.log('[mcp-worker] iniciado');

interface Conn {
  server: McpServer;
  env: Record<string, string>;
  oauth: OauthBlob;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}
const conns = new Map<string, Conn>();

const OAUTH_KEYS = new Set(['CLIENT_ID', 'CLIENT_SECRET']);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clip = (s: string): string => (s.length > 20_000 ? `${s.slice(0, 12_000)}\n...[recortado]...\n${s.slice(-6_000)}` : s);

// PATH del zsh de login: la app empaquetada no ve brew/nvm y "npx" no existiría.
let loginPath = '';
function pathForSpawn(): string {
  if (!loginPath) {
    try { loginPath = execFileSync('/bin/zsh', ['-lc', 'echo -n "$PATH"'], { timeout: 5000 }).toString(); } catch { loginPath = ''; }
    const extra = '/opt/homebrew/bin:/usr/local/bin';
    loginPath = [loginPath, process.env['PATH'] ?? '', extra].filter(Boolean).join(':');
  }
  return loginPath;
}

function provider(c: Conn): OAuthClientProvider {
  const redirect = `http://127.0.0.1:${OAUTH_PORT}/cb/${c.server.id}`;
  const persist = (): void => post({ type: 'oauth', server: c.server.id, blob: c.oauth });
  return {
    get redirectUrl() { return redirect; },
    get clientMetadata() {
      return {
        client_name: 'Kogn', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: c.env['CLIENT_SECRET'] ? 'client_secret_post' : 'none',
      };
    },
    state() { c.oauth.state = randomBytes(16).toString('hex'); persist(); return c.oauth.state; },
    clientInformation() {
      // Google (Gmail) no registra clientes al vuelo: el usuario pone CLIENT_ID/CLIENT_SECRET de su propio proyecto.
      if (c.env['CLIENT_ID']) return { client_id: c.env['CLIENT_ID'], ...(c.env['CLIENT_SECRET'] ? { client_secret: c.env['CLIENT_SECRET'] } : {}) };
      return c.oauth.client as OAuthClientInformationMixed | undefined;
    },
    saveClientInformation(info) { c.oauth.client = info; persist(); },
    tokens() { return c.oauth.tokens as OAuthTokens | undefined; },
    saveTokens(t) { c.oauth.tokens = t; persist(); },
    redirectToAuthorization(url) { ensureLoopback(); post({ type: 'open-url', url: url.toString() }); },
    saveCodeVerifier(v) { c.oauth.verifier = v; persist(); },
    codeVerifier() { if (!c.oauth.verifier) throw new Error('Falta el verificador PKCE; vuelve a conectar.'); return c.oauth.verifier; },
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') delete c.oauth.tokens;
      if (scope === 'all' || scope === 'client') delete c.oauth.client;
      if (scope === 'all' || scope === 'verifier') delete c.oauth.verifier;
      persist();
    },
  };
}

// Servidor local que recibe el ?code= del navegador al terminar la autorización.
let loopback = false;
function ensureLoopback(): void {
  if (loopback) return;
  loopback = true;
  createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = u.pathname.match(/^\/cb\/([\w.-]+)$/);
    const c = m ? conns.get(m[1]!) : undefined;
    const code = u.searchParams.get('code');
    const ok = c && code && c.transport instanceof StreamableHTTPClientTransport && (!c.oauth.state || c.oauth.state === u.searchParams.get('state'));
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ok ? '<p style="font-family:sans-serif">Listo. Ya puedes volver a Kogn.</p>' : '<p>Solicitud no válida.</p>');
    if (!ok) return;
    const t = c.transport as StreamableHTTPClientTransport;
    t.finishAuth(code)
      .then(() => connect(c.server, c.env, c.oauth))
      .catch((e) => post({ type: 'status', server: c.server.id, ok: false, tools: [], error: `OAuth falló: ${errMsg(e)}` }));
  }).listen(OAUTH_PORT, '127.0.0.1').on('error', (e) => post({ type: 'status', server: '*', ok: false, tools: [], error: `Puerto OAuth ocupado: ${errMsg(e)}` }));
}

async function disconnect(id: string): Promise<void> {
  const c = conns.get(id);
  if (!c) return;
  conns.delete(id);
  try { await c.client.close(); } catch { /* ya cerrado */ }
}

async function connect(server: McpServer, env: Record<string, string>, oauth: OauthBlob | null): Promise<void> {
  await disconnect(server.id);
  const client = new Client({ name: 'kogn', version: '1.0' });
  const c: Conn = { server, env, oauth: oauth ?? {}, client, transport: null as never };
  if (server.url) {
    const headers = Object.fromEntries(Object.entries(env).filter(([k]) => !OAUTH_KEYS.has(k)));
    c.transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers }, authProvider: provider(c) });
  } else if (server.command) {
    c.transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...getDefaultEnvironment(), PATH: pathForSpawn(), ...env }, stderr: 'ignore' });
  } else {
    post({ type: 'status', server: server.id, ok: false, tools: [], error: 'Falta URL o comando' });
    return;
  }
  conns.set(server.id, c);
  try {
    await client.connect(c.transport);
    const { tools } = await client.listTools();
    post({ type: 'status', server: server.id, ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Record<string, unknown> })) });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      post({ type: 'status', server: server.id, ok: false, tools: [], needsAuth: true, error: 'Autoriza el acceso en el navegador' });
      return;
    }
    await disconnect(server.id);
    post({ type: 'status', server: server.id, ok: false, tools: [], error: errMsg(e) });
  }
}

async function call(id: string, serverId: string, tool: string, args: Record<string, unknown>): Promise<void> {
  const c = conns.get(serverId);
  if (!c) { post({ type: 'result', id, ok: false, text: 'Integración no conectada. Revisa Ajustes → Integraciones.' }); return; }
  try {
    const r = await c.client.callTool({ name: tool, arguments: args });
    const blocks = Array.isArray(r.content) ? r.content as Array<Record<string, unknown>> : [];
    let text = blocks.map((b) => (b['type'] === 'text' ? String(b['text']) : b['type'] === 'image' ? '(imagen)' : JSON.stringify(b))).join('\n');
    if (!text && r.structuredContent) text = JSON.stringify(r.structuredContent);
    post({ type: 'result', id, ok: !r.isError, text: clip(text || '(sin contenido)') });
  } catch (e) {
    const needsAuth = e instanceof UnauthorizedError;
    if (needsAuth) post({ type: 'status', server: serverId, ok: false, tools: [], needsAuth: true, error: 'Autoriza el acceso en el navegador' });
    post({ type: 'result', id, ok: false, text: needsAuth ? 'La integración necesita autorización: pide al usuario que la conecte en Ajustes → Integraciones.' : errMsg(e), needsAuth });
  }
}

port.on('message', (e) => {
  const m = e.data;
  if (m.type === 'connect') void connect(m.server, m.env, m.oauth);
  else if (m.type === 'disconnect') void disconnect(m.server);
  else if (m.type === 'call') void call(m.id, m.server, m.tool, m.args);
});
