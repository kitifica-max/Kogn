import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../shared/types';

export const DEFAULT_EXCLUDED_APPS = ['Bitwarden', '1Password', 'Keychain Access', 'Wallet'];
export const DEFAULT_EXCLUDED_TITLE_PATTERNS = [
  'banco', 'bancaria', 'contraseña', 'password', 'login',
  'bitwarden', '1password', 'keychain', 'salud', 'médico', 'wallet',
];

export const DEFAULT_SHORTCUTS = {
  pause: 'CommandOrControl+Shift+P',
  toggle_bubble: 'Control+Alt+A',
  summary: 'Control+Alt+R',
  new_chat: 'Control+Alt+N',
};

export const DEFAULT_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' as const, model: 'claude-sonnet-5-5' },
];

export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,48}$/i),
  label: z.string().min(1).max(60),
  provider: z.enum(['anthropic', 'openai', 'ollama']),
  model: z.string().min(1).max(120),
  base_url: z.string().url().optional(),
  price_in: z.number().min(0).optional(),
  price_out: z.number().min(0).optional(),
  num_ctx: z.number().int().min(512).max(1_000_000).optional(),
});

export const mcpServerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,48}$/i),
  label: z.string().min(1).max(60),
  url: z.string().url().optional(),
  command: z.string().min(1).max(300).optional(),
  args: z.array(z.string().max(300)).max(40).optional(),
});

export const scheduledTaskSchema = z.object({
  id: z.string().min(1).max(40),
  prompt: z.string().min(1).max(1000),
  every: z.enum(['hora', 'dia', 'semana']),
  at: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  last_run: z.number().optional(),
});

const schema = z.object({
  allowed_folders: z.array(z.string()).default([]),
  excluded_apps: z.array(z.string()).default(DEFAULT_EXCLUDED_APPS),
  excluded_title_patterns: z.array(z.string()).default(DEFAULT_EXCLUDED_TITLE_PATTERNS),
  retention_hours: z.number().positive().default(24),
  suggestion_level: z.enum(['silencio', 'discreto', 'activo']).default('discreto'),
  memory_enabled: z.boolean().default(true),
  memory_max_items_per_request: z.number().int().positive().default(5),
  observer_poll_ms: z.number().int().min(1000).default(5000),
  launch_at_login: z.boolean().default(true),
  notifications: z.boolean().default(true),
  sounds: z.boolean().default(true),
  onboarding_done: z.boolean().default(false),
  avatar: z.enum(['nino', 'nina']).default('nino'),
  habit_retention_days: z.number().int().min(7).max(365).default(60),
  models: z.array(profileSchema).default(DEFAULT_MODELS), // vacía es válido: el usuario puede quitarlos todos
  active_model: z.string().default(DEFAULT_MODELS[0]!.id),
  mcp_servers: z.array(mcpServerSchema).default([]),
  scheduled_tasks: z.array(scheduledTaskSchema).default([]),
  tray_mode: z.boolean().default(false),
  custom_rules: z.array(z.object({
    app: z.string().min(1),
    title_contains: z.string().optional(),
    minutes: z.number().positive(),
    message: z.string().min(1).max(300),
  })).default([]),
  shortcuts: z.object({
    pause: z.string().min(1).default(DEFAULT_SHORTCUTS.pause),
    toggle_bubble: z.string().min(1).default(DEFAULT_SHORTCUTS.toggle_bubble),
    summary: z.string().min(1).default(DEFAULT_SHORTCUTS.summary),
    new_chat: z.string().min(1).default(DEFAULT_SHORTCUTS.new_chat),
  }).default({ ...DEFAULT_SHORTCUTS }),
});

export function parseConfig(raw: unknown): Config {
  const c = schema.parse(raw);
  // Si el modelo activo ya no existe, cae al primero (o queda vacío si no hay ninguno).
  if (!c.models.some((m) => m.id === c.active_model)) c.active_model = c.models[0]?.id ?? '';
  return c;
}

export function loadConfig(file: string): Config {
  return parseConfig(JSON.parse(readFileSync(file, 'utf8')));
}

let userConfigPath = '';

export function loadUserConfig(userDataDir: string, bundledFile: string): Config {
  userConfigPath = join(userDataDir, 'config.json');
  if (!existsSync(userConfigPath)) {
    copyFileSync(bundledFile, userConfigPath);
  }
  return loadConfig(userConfigPath);
}

export function saveConfig(config: Config): void {
  if (!userConfigPath) return;
  writeFileSync(userConfigPath, JSON.stringify(config, null, 2), 'utf8');
}
