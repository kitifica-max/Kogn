export type CharacterState =
  | 'reposo'
  | 'observando'
  | 'pensando'
  | 'con-sugerencia'
  | 'esperando-aprobacion'
  | 'pausado'
  | 'exito'
  | 'confuso'
  | 'pendiente'; // respuesta sin leer: salta en bucle hasta que se abre el chat

export interface ObserverStatus {
  enabled: boolean;
  paused: boolean;
  permissionsOk: boolean;
}

export interface ActiveWindow {
  app: string;
  title: string;
}

export type ProviderKind = 'anthropic' | 'openai' | 'ollama';

// Perfil de modelo: qué API usar y con qué parámetros. La API key NO va aquí (se guarda cifrada aparte).
export interface ModelProfile {
  id: string;
  label: string;
  provider: ProviderKind;
  model: string;
  base_url?: string; // openai / ollama
  price_in?: number; // $ por millón de tokens (opcional; los locales cuestan 0)
  price_out?: number;
  num_ctx?: number; // ollama: ventana de contexto
}

export interface CustomRule {
  app: string;
  title_contains?: string;
  minutes: number;
  message: string;
}

export interface Shortcuts {
  pause: string;
  toggle_bubble: string;
  summary: string;
  new_chat: string;
}

export interface McpServerConfig {
  id: string;
  label: string;
  url?: string;
  command?: string;
  args?: string[];
}

export interface ScheduledTaskConfig {
  id: string;
  prompt: string;
  every: 'hora' | 'dia' | 'semana';
  at?: string;
  weekday?: number;
  last_run?: number;
}

export interface Config {
  allowed_folders: string[];
  excluded_apps: string[];
  excluded_title_patterns: string[];
  retention_hours: number;
  suggestion_level: 'silencio' | 'discreto' | 'activo';
  memory_enabled: boolean;
  memory_max_items_per_request: number;
  observer_poll_ms: number;
  custom_rules: CustomRule[];
  shortcuts: Shortcuts;
  launch_at_login: boolean;
  notifications: boolean;
  sounds: boolean;
  onboarding_done: boolean;
  avatar: 'nino' | 'nina';
  habit_retention_days: number;
  models: ModelProfile[];
  active_model: string;
  mcp_servers: McpServerConfig[];
  scheduled_tasks: ScheduledTaskConfig[];
  tray_mode: boolean;
}

export interface NewEvent {
  ts: number;
  kind: 'app_focus' | 'file_change';
  app?: string | null;
  title?: string | null;
  path?: string | null;
  duration_ms?: number | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type MemoryTipo = 'preferencia' | 'proyecto' | 'decisión' | 'contexto';
export type MemoryEstado = 'propuesto' | 'aprobado' | 'rechazado';

export type FileEditStatus = 'propuesto' | 'aprobado' | 'rechazado' | 'aplicado' | 'fallido';

export interface FileEdit {
  id: number;
  ts: number;
  path: string;
  status: FileEditStatus;
  backup_path: string | null;
  diff: string | null;
}

export interface Memory {
  id: number;
  contenido: string;
  tipo: MemoryTipo;
  fuente: string;
  estado: MemoryEstado;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}
