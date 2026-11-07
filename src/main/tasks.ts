import type { ToolDef } from '../ai/providers.js';

// Tareas programadas: Kogn las ejecuta solo (sin que el usuario escriba) cuando toca.
export interface ScheduledTask {
  id: string;
  prompt: string;
  every: 'hora' | 'dia' | 'semana';
  at?: string; // "HH:MM" (dia, semana)
  weekday?: number; // 0=domingo … 6=sábado (semana)
  last_run?: number;
}

function atToday(now: Date, at: string | undefined): Date {
  const [h, m] = (at ?? '09:00').split(':').map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** Última ocurrencia programada ≤ now; null si es "cada hora". */
export function lastScheduled(t: ScheduledTask, nowMs: number): number | null {
  const now = new Date(nowMs);
  if (t.every === 'hora') return null;
  const target = atToday(now, t.at);
  if (t.every === 'dia') {
    if (target.getTime() > nowMs) target.setDate(target.getDate() - 1);
    return target.getTime();
  }
  const wd = t.weekday ?? 1;
  target.setDate(target.getDate() - ((target.getDay() - wd + 7) % 7));
  if (target.getTime() > nowMs) target.setDate(target.getDate() - 7);
  return target.getTime();
}

export function isDue(t: ScheduledTask, nowMs = Date.now()): boolean {
  if (t.every === 'hora') return !t.last_run || nowMs - t.last_run >= 3_600_000;
  const target = lastScheduled(t, nowMs)!;
  return !t.last_run || t.last_run < target;
}

export function describeTask(t: ScheduledTask): string {
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const when = t.every === 'hora' ? 'cada hora' : t.every === 'dia' ? `cada día a las ${t.at ?? '09:00'}` : `cada ${days[t.weekday ?? 1]} a las ${t.at ?? '09:00'}`;
  return `${when}: ${t.prompt}`;
}

export const SCHEDULE_TOOL: ToolDef = {
  name: 'schedule_task',
  description: 'Programar, listar o quitar tareas recurrentes que Kogn ejecuta solo, sin que el usuario escriba (p. ej. "cada mañana a las 9 revisa Gmail y resume lo urgente"). El prompt se ejecuta tal cual como si lo escribiera el usuario, con todas las herramientas disponibles.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list'] },
      prompt: { type: 'string', description: 'add: instrucción completa y autocontenida a ejecutar' },
      every: { type: 'string', enum: ['hora', 'dia', 'semana'] },
      at: { type: 'string', description: 'HH:MM (dia/semana), default 09:00' },
      weekday: { type: 'number', description: '0=domingo … 6=sábado (semana), default 1' },
      id: { type: 'string', description: 'remove: id de la tarea (ver list)' },
    },
    required: ['action'],
  },
};

/** Ejecuta la herramienta schedule_task sobre la lista (muta `tasks`). Devuelve el mensaje para el modelo. */
export function applyScheduleTool(tasks: ScheduledTask[], input: Record<string, unknown>): { success: boolean; message: string; changed: boolean } {
  const action = input.action;
  if (action === 'list') {
    return { success: true, changed: false, message: tasks.length ? tasks.map((t) => `${t.id} — ${describeTask(t)}`).join('\n') : '(sin tareas programadas)' };
  }
  if (action === 'remove') {
    const i = tasks.findIndex((t) => t.id === input.id);
    if (i < 0) return { success: false, changed: false, message: 'No existe esa tarea' };
    tasks.splice(i, 1);
    return { success: true, changed: true, message: 'Tarea quitada.' };
  }
  if (action === 'add') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const every = input.every === 'hora' || input.every === 'semana' ? input.every : 'dia';
    if (!prompt) return { success: false, changed: false, message: 'Falta prompt' };
    if (tasks.length >= 20) return { success: false, changed: false, message: 'Máximo 20 tareas' };
    const at = typeof input.at === 'string' && /^\d{1,2}:\d{2}$/.test(input.at) ? input.at : undefined;
    const weekday = typeof input.weekday === 'number' ? Math.min(6, Math.max(0, Math.round(input.weekday))) : undefined;
    const t: ScheduledTask = { id: `t${Date.now().toString(36)}`, prompt: prompt.slice(0, 1000), every, ...(at ? { at } : {}), ...(weekday !== undefined ? { weekday } : {}) };
    tasks.push(t);
    return { success: true, changed: true, message: `Programada (${t.id}): ${describeTask(t)}` };
  }
  return { success: false, changed: false, message: 'action debe ser add, remove o list' };
}
