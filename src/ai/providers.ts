import Anthropic from '@anthropic-ai/sdk';
import type { ModelProfile } from '../shared/types.js';
import type { Usage } from './cost.js';

// Formato interno de mensajes = bloques estilo Anthropic. Cada proveedor lo convierte a su API.
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ToolResultContent = string | Array<{ type: 'text'; text: string } | ImageBlock>;
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: ToolResultContent; is_error?: boolean }
  | { type: 'thinking'; thinking: string } // razonamiento de modelos locales (gpt-oss): se devuelve tal cual en el turno siguiente
  | ImageBlock;
export interface Msg { role: 'user' | 'assistant'; content: string | Block[] }
export interface ToolCall { id: string; name: string; input: Record<string, unknown> }

/** system = texto completo (OpenAI/Ollama lo usan tal cual). systemParts separa lo estático (cacheable) de lo dinámico. */
export interface SystemParts { static: string; dynamic: string }
export interface ChatRequest { system: string; systemParts?: SystemParts; tools: ToolDef[]; messages: Msg[]; maxTokens: number; signal?: AbortSignal }
export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: 'end' | 'tool_use' | 'max_tokens';
  assistantMsg: Msg; // para devolverlo tal cual al continuar el bucle de herramientas
}
export interface Provider { chat(req: ChatRequest): Promise<LlmResult> }

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const REQUEST_TIMEOUT_MS = 10 * 60_000; // los modelos locales pueden tardar
const stripThink = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim(); // razonamiento en línea (qwen3, deepseek...)
const trimUrl = (u: string): string => u.replace(/\/+$/, '');

async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS), // "Detener" corta la petición
  });
  const raw = await res.text();
  if (!res.ok) throw new HttpError(res.status, raw);
  try { return JSON.parse(raw); } catch { throw new Error(`Respuesta no válida del servidor: ${raw.slice(0, 200)}`); }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`${status} ${body.slice(0, 300)}`);
  }
}

// ═══ Anthropic ═══════════════════════════════════════════════════════════════════════════
export class AnthropicProvider implements Provider {
  private client: Anthropic;
  constructor(private model: string, apiKey?: string, client?: Anthropic) {
    this.client = client ?? new Anthropic(apiKey ? { apiKey } : {});
  }

  async chat(req: ChatRequest): Promise<LlmResult> {
    // Caché de prompt: herramientas + bloque estático se cachean; lo dinámico (eventos, recuerdos, carpetas) va después, sin caché.
    const cached = { type: 'ephemeral' } as const;
    const system: string | Anthropic.TextBlockParam[] = req.systemParts
      ? [
          { type: 'text', text: req.systemParts.static, cache_control: cached },
          ...(req.systemParts.dynamic ? [{ type: 'text' as const, text: req.systemParts.dynamic }] : []),
        ]
      : req.system;
    const tools = req.tools.map((t, i) => (i === req.tools.length - 1 ? { ...t, cache_control: cached } : t));
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system,
      tools: tools as Anthropic.Tool[],
      messages: req.messages as Anthropic.MessageParam[],
    }, req.signal ? { signal: req.signal } : undefined);
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const b of res.content) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
    return {
      text, toolCalls, usage: res.usage,
      stop: toolCalls.length ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
      assistantMsg: { role: 'assistant', content: res.content as unknown as Block[] }, // tal cual (incluye bloques de razonamiento)
    };
  }
}

// ═══ Compatible con OpenAI (OpenAI, OpenRouter, Groq, LM Studio, vLLM...) ═════════════════
export function toOpenAiMessages(system: string, msgs: Msg[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of msgs) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) => (b.type === 'tool_use'
        ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content : b.content.flatMap((c) => c.type === 'text' ? [c.text] : []).join('');
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
        } else if (b.type === 'text') out.push({ role: 'user', content: b.text });
        // image blocks: skip for non-vision OpenAI models
      }
    }
  }
  return out;
}

export class OpenAiProvider implements Provider {
  constructor(private p: ModelProfile, private apiKey: string | undefined, private fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  async chat(req: ChatRequest): Promise<LlmResult> {
    const base = trimUrl(this.p.base_url ?? 'https://api.openai.com/v1');
    const data = await postJson(this.fetchImpl, `${base}/chat/completions`,
      this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, {
        model: this.p.model,
        max_tokens: req.maxTokens,
        messages: toOpenAiMessages(req.system, req.messages),
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      }, req.signal);
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: c.function?.name ?? '',
      input: parseArgs(c.function?.arguments),
    }));
    const text = stripThink(msg.content ?? '');
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text, toolCalls,
      usage: { input_tokens: (data.usage?.prompt_tokens ?? 0) - cached, output_tokens: data.usage?.completion_tokens ?? 0, cache_read_input_tokens: cached },
      stop: toolCalls.length ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
      assistantMsg: { role: 'assistant', content: assistantBlocks(text, toolCalls) },
    };
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

function assistantBlocks(text: string, calls: ToolCall[], thinking = ''): Block[] {
  const blocks: Block[] = [];
  if (thinking) blocks.push({ type: 'thinking', thinking });
  if (text) blocks.push({ type: 'text', text });
  for (const c of calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  return blocks;
}

// ═══ Ollama (API nativa: permite fijar num_ctx; el endpoint /v1 trunca el contexto en silencio) ═══
export function toOllamaMessages(system: string, msgs: Msg[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  const names = new Map<string, string>(); // id de llamada → nombre (Ollama pide tool_name en el resultado)
  for (const m of msgs) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) => {
        if (b.type !== 'tool_use') return [];
        names.set(b.id, b.name);
        return [{ function: { name: b.name, arguments: b.input } }];
      });
      // gpt-oss pide reenviar su razonamiento al continuar tras una llamada a herramienta
      const thinking = m.content.flatMap((b) => (b.type === 'thinking' ? [b.thinking] : [])).join('');
      out.push({ role: 'assistant', content: text, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content : b.content.flatMap((c) => c.type === 'text' ? [c.text] : []).join('');
          out.push({ role: 'tool', tool_name: names.get(b.tool_use_id) ?? 'tool', content });
        } else if (b.type === 'text') out.push({ role: 'user', content: b.text });
        // image blocks: skip for Ollama
      }
    }
  }
  return out;
}

export class OllamaProvider implements Provider {
  private seq = 0;
  constructor(private p: ModelProfile, private fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  async chat(req: ChatRequest): Promise<LlmResult> {
    const base = trimUrl(this.p.base_url ?? 'http://localhost:11434');
    let data: any;
    try {
      data = await postJson(this.fetchImpl, `${base}/api/chat`, {}, {
        model: this.p.model,
        stream: false,
        messages: toOllamaMessages(req.system, req.messages),
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        options: { num_ctx: this.p.num_ctx ?? 8192, num_predict: req.maxTokens },
      }, req.signal);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400 && /tools/i.test(e.body)) {
        throw new Error(`El modelo "${this.p.model}" no soporta herramientas, y Kogn las necesita. Prueba con uno que sí (qwen3, llama3.1, mistral-nemo...).`);
      }
      if (e instanceof HttpError && e.status === 404) {
        throw new Error(`Ollama no tiene el modelo "${this.p.model}". Descárgalo con: ollama pull ${this.p.model}`);
      }
      if (e instanceof TypeError) throw new Error(`No pude conectar con Ollama en ${base}. ¿Está abierto?`);
      throw e;
    }
    const msg = data.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
      id: `call_${Date.now()}_${this.seq++}`,
      name: c.function?.name ?? '',
      input: parseArgs(c.function?.arguments),
    }));
    const text = stripThink(msg.content ?? '');
    const thinking = typeof msg.thinking === 'string' ? msg.thinking : '';
    return {
      text, toolCalls,
      usage: { input_tokens: data.prompt_eval_count ?? 0, output_tokens: data.eval_count ?? 0 },
      stop: toolCalls.length ? 'tool_use' : data.done_reason === 'length' ? 'max_tokens' : 'end',
      assistantMsg: { role: 'assistant', content: assistantBlocks(text, toolCalls, thinking) },
    };
  }
}

// ═══ Fábrica ═════════════════════════════════════════════════════════════════════════════
export function createProvider(profile: ModelProfile, apiKey: string | undefined, fetchImpl?: FetchLike): Provider {
  switch (profile.provider) {
    case 'anthropic':
      if (!apiKey) throw new Error(`Falta la API key de "${profile.label}". Agrégala en la pestaña Modelo.`);
      return new AnthropicProvider(profile.model, apiKey);
    case 'openai':
      return new OpenAiProvider(profile, apiKey, fetchImpl);
    case 'ollama':
      return new OllamaProvider(profile, fetchImpl);
  }
}

/** Modelos instalados en un servidor Ollama (GET /api/tags). */
export async function listOllamaModels(baseUrl: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string[]> {
  const res = await fetchImpl(`${trimUrl(baseUrl)}/api/tags`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(4000) });
  const raw = await res.text();
  if (!res.ok) throw new HttpError(res.status, raw);
  const data = JSON.parse(raw);
  return (data.models ?? []).map((m: { name: string }) => m.name);
}
