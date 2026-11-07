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
  lastHttp?: string; // última respuesta no-2xx (estado + WWW-Authenticate): el SDK no la expone en el error
}
const conns = new Map<string, Conn>();

const OAUTH_KEYS = new Set(['CLIENT_ID', 'CLIENT_SECRET', 'SCOPES']); // van al flujo OAuth, no como cabeceras
// Gmail publica 20 scopes; pedir todos asusta en el consentimiento. Leer/etiquetar + redactar basta para las herramientas.
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose';
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Mensaje corto para la UI: el error de Google si el cuerpo lo trae, sin JSON enormes, con el estado HTTP del POST. */
const httpErr = (c: Conn | undefined, e: unknown): string => {
  let m = errMsg(e);
  const json = m.match(/\{[\s\S]*\}\s*$/);
  if (json) {
    try {
      const body = JSON.parse(json[0]) as { error?: { code?: number; status?: string; message?: string }; result?: unknown };
      const err = body.error;
      m = m.slice(0, json.index) + (err ? `${err.status ?? err.code ?? ''} ${err.message ?? ''}`.trim() : body.result ? '(respuesta válida con estado de error)' : json[0].slice(0, 120));
    } catch { m = m.replace(/\{[\s\S]{200,}$/, '{…}'); }
  }
  m = m.slice(0, 400);
  return c?.lastHttp ? `${m} [${c.lastHttp}]` : m;
};

// fetch envuelto: guarda el estado de las respuestas fallidas y permite acotar los scopes OAuth
// (Google publica 20 scopes de Gmail y el SDK los pide todos; SCOPES=... en las claves los reemplaza).
function diagFetch(c: Conn): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const res = await fetch(url, init);
    const u = url.toString();
    const scopes = c.env['SCOPES'] ?? (c.server.url && /gmailmcp\.googleapis\.com/.test(c.server.url) ? GMAIL_SCOPES : '');
    if (res.ok && scopes && u.includes('/.well-known/oauth-protected-resource')) {
      const data = await res.json() as Record<string, unknown>;
      data['scopes_supported'] = scopes.split(/[\s,]+/).filter(Boolean);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!res.ok && init?.method === 'POST') { // solo el POST: el GET (stream SSE) y el DELETE (cierre) dan 405 en Google y el SDK los ignora
      const www = res.headers.get('www-authenticate');
      c.lastHttp = `HTTP ${res.status} en ${new URL(u).pathname}${www ? ` · ${www.slice(0, 200)}` : ''}`;
    }
    return res;
  };
}
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
    redirectToAuthorization(url) {
      ensureLoopback();
      // Google solo da refresh token con access_type=offline (si no, pide iniciar sesión cada hora).
      if (/\.google\.com$/.test(url.hostname)) { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); }
      post({ type: 'open-url', url: url.toString() });
    },
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
      .catch((e) => post({ type: 'status', server: c.server.id, ok: false, tools: [], error: `OAuth falló: ${httpErr(c, e)}` }));
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
    c.transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers }, authProvider: provider(c), fetch: diagFetch(c) });
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
    const error = httpErr(c, e); // antes de cerrar: el cierre hace más peticiones
    await disconnect(server.id);
    post({ type: 'status', server: server.id, ok: false, tools: [], error });
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
    post({ type: 'result', id, ok: false, text: needsAuth ? 'La integración necesita autorización: pide al usuario que la conecte en Ajustes → Integraciones.' : httpErr(c, e), needsAuth });
  }
}

port.on('message', (e) => {
  const m = e.data;
  if (m.type === 'connect') void connect(m.server, m.env, m.oauth);
  else if (m.type === 'disconnect') void disconnect(m.server);
  else if (m.type === 'call') void call(m.id, m.server, m.tool, m.args);
});
