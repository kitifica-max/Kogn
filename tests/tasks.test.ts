import { describe, it, expect } from 'vitest';
import { isDue, applyScheduleTool, describeTask, type ScheduledTask } from '../src/main/tasks.js';

const at = (y: number, m: number, d: number, h: number, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

describe('isDue', () => {
  it('cada hora: la primera vez y luego cada 60 min', () => {
    const t: ScheduledTask = { id: 'a', prompt: 'x', every: 'hora' };
    expect(isDue(t, at(2026, 11, 6, 10))).toBe(true);
    t.last_run = at(2026, 11, 6, 10);
    expect(isDue(t, at(2026, 11, 6, 10, 30))).toBe(false);
    expect(isDue(t, at(2026, 11, 6, 11))).toBe(true);
  });
  it('cada día a las 09:00: no antes de la hora; sí después; no dos veces el mismo día', () => {
    const t: ScheduledTask = { id: 'a', prompt: 'x', every: 'dia', at: '09:00', last_run: at(2026, 11, 5, 9, 1) };
    expect(isDue(t, at(2026, 11, 6, 8, 59))).toBe(false);
    expect(isDue(t, at(2026, 11, 6, 9, 0))).toBe(true);
    t.last_run = at(2026, 11, 6, 9, 0);
    expect(isDue(t, at(2026, 11, 6, 18))).toBe(false);
    expect(isDue(t, at(2026, 11, 7, 9, 5))).toBe(true);
  });
  it('semanal (lunes 10:00): se dispara el lunes y no vuelve hasta el siguiente; si la app estaba cerrada, al abrir', () => {
    const t: ScheduledTask = { id: 'a', prompt: 'x', every: 'semana', weekday: 1, at: '10:00' };
    expect(isDue(t, at(2026, 11, 8, 12))).toBe(true); // nunca corrió: domingo, debe la del lunes pasado
    t.last_run = at(2026, 11, 2, 10); // lunes 2 nov
    expect(isDue(t, at(2026, 11, 8, 12))).toBe(false); // domingo 8: aún no toca
    expect(isDue(t, at(2026, 11, 9, 10))).toBe(true); // lunes 9 a las 10
    expect(isDue(t, at(2026, 11, 11, 9))).toBe(true); // miércoles: la del lunes quedó pendiente (app cerrada)
  });
});

describe('schedule_task', () => {
  it('add, list, remove', () => {
    const tasks: ScheduledTask[] = [];
    const a = applyScheduleTool(tasks, { action: 'add', prompt: 'revisa Gmail', every: 'dia', at: '9:00' });
    expect(a).toMatchObject({ success: true, changed: true });
    expect(tasks).toHaveLength(1);
    expect(describeTask(tasks[0]!)).toBe('cada día a las 9:00: revisa Gmail');
    expect(applyScheduleTool(tasks, { action: 'list' }).message).toContain(tasks[0]!.id);
    expect(applyScheduleTool(tasks, { action: 'remove', id: 'nope' }).success).toBe(false);
    expect(applyScheduleTool(tasks, { action: 'remove', id: tasks[0]!.id })).toMatchObject({ success: true, changed: true });
    expect(tasks).toHaveLength(0);
    expect(applyScheduleTool(tasks, { action: 'add', every: 'dia' }).success).toBe(false);
  });
});
