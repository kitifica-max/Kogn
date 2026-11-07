// Mensajes entre el main process y el worker MCP (utilityProcess). Sin dependencias: lo importan ambos lados.
export interface McpServer {
  id: string;
  label: string;
  url?: string; // servidor remoto (Streamable HTTP), p. ej. Gmail o Slack oficiales
  command?: string; // servidor local por stdio
  args?: string[];
}

export interface ToolInfo { name: string; description: string; input_schema: Record<string, unknown> }

/** Lo que el flujo OAuth necesita recordar entre sesiones. Se guarda cifrado en el Llavero. */
export interface OauthBlob { tokens?: unknown; client?: unknown; verifier?: string; state?: string }

export type WorkerIn =
  | { type: 'connect'; server: McpServer; env: Record<string, string>; oauth: OauthBlob | null }
  | { type: 'disconnect'; server: string }
  | { type: 'call'; id: string; server: string; tool: string; args: Record<string, unknown> };

export type WorkerOut =
  | { type: 'status'; server: string; ok: boolean; tools: ToolInfo[]; error?: string; needsAuth?: boolean }
  | { type: 'result'; id: string; ok: boolean; text: string; needsAuth?: boolean }
  | { type: 'open-url'; url: string }
  | { type: 'oauth'; server: string; blob: OauthBlob };

export const OAUTH_PORT = 48219; // fijo: la redirect_uri registrada debe ser estable entre arranques
