import { fstatSync, openSync } from 'node:fs';

// Electron cierra fd 0/1/2 en apps empaquetadas (LSUIElement). El kernel reutiliza
// esos fd para los pipes internos de spawn → EBADF. Mantenerlos abiertos lo evita.
for (let fd = 0; fd < 3; fd++) {
  try { fstatSync(fd); } catch { try { openSync('/dev/null', 'r+'); } catch {} }
}

import { app, BrowserWindow, dialog, globalShortcut, Notification, safeStorage, screen, shell, systemPreferences } from 'electron';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { openDb, getState, setState, type Db } from '../db/db.js';
import { Observer } from '../observer/observer.js';
import { readActiveWindow } from '../observer/activeWindow.js';
import { purgeExpired } from '../observer/retention.js';
import { startFileWatcher } from '../observer/fileWatcher.js';
import { loadUserConfig, saveConfig } from './config.js';
import { registerIpc } from './ipc.js';
import { IPC } from '../shared/ipc-channels.js';
import { AiClient } from '../ai/client.js';
import { createProvider, listOllamaModels } from '../ai/providers.js';
import { SecretStore } from './secrets.js';
import { notificationBody, shouldNotify } from './notify.js';
import { learn, MIN_HABIT_DAYS } from '../memory/insights.js';
import { abortable } from '../chat/abort.js';
import { broadFolderReason, sanitizeFolders, setInternalRoots, isInsideInternalRoot } from '../shared/paths.js';
import { Attachments, namesLine } from '../chat/attachments.js';
import { planScript, runScript, undoRun, listScripts, listRuns, type Deps as ScriptDeps } from '../scripts/engine.js';
import { resolveBin, moduleStatus, installModule } from '../scripts/modules.js';
import {
  saveExchange, loadHistory, modelContext, clearHistory, listConversations, newConversation, openConversation,
  deleteConversation, setPinned, activeConversation, type ChatKind,
} from '../chat/history.js';
import { proposeMemory, approveMemory, rejectMemory, deleteMemory, listMemories } from '../memory/memory.js';
import { SuggestionEngine, type Suggestion } from '../suggestions/engine.js';
import { dailySummary } from '../summary/daily.js';
import { usageTotals, costReport } from '../ai/cost.js';
import { gitToday, resume } from '../git/git.js';
import { scanDisk, formatReport, cleanLast } from '../disk/disk.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { approveFileEdit, approveAllFileEdits, rejectFileEdit, rejectAllFileEdits, listFileEdits, getAuditLog } from '../files/fileTools.js';
import type { CharacterState, Config, Memory, MemoryTipo, ModelProfile, ObserverStatus } from '../shared/types.js';

// Las API keys ya no se leen de archivos .env: se configuran en la pestaña Modelo y se guardan cifradas.

// Los datos viven en la carpeta histórica "agetik": cambiarla perdería DB, config y recuerdos.
app.setPath('userData', join(app.getPath('appData'), 'agetik'));

const CHAR_SIZE = { width: 150, height: 160 };
const BUBBLE_SIZE = { width: 360, height: 480 };
const RETENTION_EVERY_MS = 60 * 60 * 1000;

let character: BrowserWindow | null = null;
let bubble: BrowserWindow | null = null;
let db: Db;
let observer: Observer;
let config: Config;
let ai: AiClient;
let suggestions: SuggestionEngine;
let activeSuggestion: Suggestion | null = null;
let backupDir: string;
let fileWatcher: FSWatcher | null = null;

// Red de seguridad: un error no capturado se registra y la app sigue (antes aparecía el diálogo de error y se cerraba).
process.on('uncaughtException', (e) => console.error('[agentik] error no capturado:', e instanceof Error ? e.stack ?? e.message : e));
process.on('unhandledRejection', (e) => console.error('[agentik] promesa rechazada:', e instanceof Error ? e.message : e));
let secrets: SecretStore;
let pendingReply = false; // hay una respuesta sin leer: el personaje salta hasta que abras el chat

// ── Modelos: perfiles en config.json, claves cifradas aparte ──────────────────────────────
function activeProfile(): ModelProfile | undefined {
  return config.models.find((m) => m.id === config.active_model);
}

function keyFor(p: ModelProfile): string | undefined {
  return secrets.get(p.id) ?? undefined;
}

function modelsState(): { active: string; profiles: Array<ModelProfile & { hasKey: boolean }> } {
  return { active: config.active_model, profiles: config.models.map((m) => ({ ...m, hasKey: secrets.has(m.id) })) };
}

function uniqueModelId(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'modelo';
  let id = base;
  for (let n = 2; config.models.some((m) => m.id === id); n++) id = `${base}-${n}`;
  return id;
}

// ── Ajustes (avatar, avisos, sonido) ───────────────────────────────────────────────────────
function settingsState(): { avatar: Config['avatar']; notifications: boolean; sounds: boolean; onboarding_done: boolean; version: string; screenRecording: string } {
  const screenRecording = systemPreferences.getMediaAccessStatus('screen');
  return { avatar: config.avatar, notifications: config.notifications, sounds: config.sounds, onboarding_done: config.onboarding_done, version: app.getVersion(), screenRecording };
}

function handleSettingsSet(p: Partial<ReturnType<typeof settingsState>>): unknown {
  const avatarChanged = p.avatar !== undefined && p.avatar !== config.avatar;
  if (p.avatar !== undefined) config.avatar = p.avatar;
  if (p.notifications !== undefined) config.notifications = p.notifications;
  if (p.sounds !== undefined) config.sounds = p.sounds;
  if (p.onboarding_done !== undefined) config.onboarding_done = p.onboarding_done;
  saveConfig(config);
  if (avatarChanged) character?.webContents.send(IPC.avatarChanged, config.avatar); // cambia sin reiniciar
  return settingsState();
}

function handleModelsSave(p: Omit<ModelProfile, 'id'> & { id?: string; api_key?: string }): unknown {
  const { api_key, ...rest } = p;
  const id = rest.id ?? uniqueModelId(rest.label);
  const profile: ModelProfile = { ...rest, id };
  try {
    if (api_key?.trim()) secrets.set(id, api_key);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'No pude guardar la clave' };
  }
  const i = config.models.findIndex((m) => m.id === id);
  if (i >= 0) config.models[i] = profile;
  else config.models.push(profile);
  saveConfig(config);
  return modelsState();
}

function handleModelsDelete(id: string): unknown {
  if (!config.models.some((m) => m.id === id)) return { error: 'Ese modelo no existe' };
  config.models = config.models.filter((m) => m.id !== id);
  secrets.delete(id);
  if (config.active_model === id) config.active_model = config.models[0]?.id ?? '';
  saveConfig(config);
  return modelsState();
}

function handleModelsSetActive(id: string): unknown {
  if (!config.models.some((m) => m.id === id)) return { error: 'Ese modelo no existe' };
  config.active_model = id;
  saveConfig(config);
  return modelsState();
}

async function handleModelsDetect(baseUrl?: string): Promise<unknown> {
  const url = baseUrl ?? 'http://localhost:11434';
  try {
    return { models: await listOllamaModels(url) };
  } catch {
    return { error: `No pude conectar con Ollama en ${url}. ¿Está abierto?` };
  }
}
const SUGGESTION_POLL_MS = 30_000;

function restartFileWatcher(): void {
  try {
    void fileWatcher?.close();
    fileWatcher = startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));
  } catch (e) {
    fileWatcher = null;
    console.warn('[agentik] no pude iniciar el vigilante:', e instanceof Error ? e.message : e);
  }
}

// ── Biblioteca de scripts y módulos (ffmpeg, whisper…)
let modulesDir = '';
let attachments: Attachments;
const scriptBin = (name: string): string | null => resolveBin(name, modulesDir);
const scriptDeps = (): ScriptDeps => ({ db, config, bin: scriptBin });

async function pickPath(kind: 'file' | 'folder'): Promise<string | null> {
  const r = await dialog.showOpenDialog({ properties: [kind === 'folder' ? 'openDirectory' : 'openFile'], defaultPath: config.allowed_folders[0] });
  showBubble(); // el cuadro de diálogo le quita el foco al chat y lo oculta
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
}

async function handleAddFolder(): Promise<string[]> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] });
  if (result.canceled || result.filePaths.length === 0) return config.allowed_folders;
  const rejected: string[] = [];
  for (const folder of result.filePaths) {
    const reason = broadFolderReason(folder);
    if (reason) rejected.push(`• ${folder}: ${reason}`);
    else if (!config.allowed_folders.includes(folder)) config.allowed_folders.push(folder);
  }
  if (rejected.length) {
    void dialog.showMessageBox({
      type: 'warning',
      title: 'Carpeta demasiado amplia',
      message: 'No agregué esa carpeta',
      detail: `${rejected.join('\n')}\n\nAutorizar una carpeta le da a Kogn permiso para leer, mover y escribir ahí, y para vigilar todo lo que cambie. Elige una carpeta concreta, como Descargas, Documentos o la de un proyecto.`,
    });
  }
  saveConfig(config);
  restartFileWatcher();
  return config.allowed_folders;
}

function handleRemoveFolder(folder: string): string[] {
  config.allowed_folders = config.allowed_folders.filter(f => f !== folder);
  saveConfig(config);
  restartFileWatcher();
  return config.allowed_folders;
}

function savedPosition(): { x: number; y: number } {
  const raw = getState(db, 'window_position');
  if (raw) {
    try {
      return JSON.parse(raw) as { x: number; y: number };
    } catch { /* corrupto */ }
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - CHAR_SIZE.width - 16,
    y: workArea.y + workArea.height - CHAR_SIZE.height - 16,
  };
}

function characterStateFor(s: ObserverStatus): CharacterState {
  if (pendingReply) return 'pendiente';
  if (!s.enabled) return 'reposo';
  if (s.paused) return 'pausado';
  return 'observando';
}

function setCharacterState(state: CharacterState): void {
  const observing = observer.status().enabled && !observer.status().paused;
  character?.webContents.send(IPC.characterState, { state, observing, sound: config.sounds });
}

function pushStatus(s: ObserverStatus): void {
  setCharacterState(characterStateFor(s));
  bubble?.webContents.send(IPC.observerChanged, s);
}

function positionBubble(): void {
  if (!character || !bubble) return;
  const [cx, cy] = character.getPosition();
  const { workArea } = screen.getDisplayNearestPoint({ x: cx, y: cy });
  let x = cx + CHAR_SIZE.width - BUBBLE_SIZE.width;
  let y = cy - BUBBLE_SIZE.height - 8;
  if (y < workArea.y) y = cy + CHAR_SIZE.height + 8;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - BUBBLE_SIZE.width));
  bubble.setPosition(Math.round(x), Math.round(y));
}

function createWindows(): void {
  const pos = savedPosition();
  character = new BrowserWindow({
    ...CHAR_SIZE,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  character.setAlwaysOnTop(true, 'floating');
  character.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  character.loadFile(join(__dirname, '../renderer/character.html'));

  bubble = new BrowserWindow({
    ...BUBBLE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  bubble.setAlwaysOnTop(true, 'floating');
  bubble.loadFile(join(__dirname, '../renderer/bubble.html'));
  bubble.on('blur', () => { bubbleBlurHiddenAt = Date.now(); bubble?.hide(); });
  bubble.on('show', clearPending); // al abrir el chat termina el aviso
}

// Hacer clic en el avatar le quita el foco al chat y lo oculta (blur) justo antes de que llegue el clic.
// Sin esto el clic lo reabriría: así un clic abre y el siguiente cierra.
let bubbleBlurHiddenAt = 0;
function toggleBubbleFromAvatar(): void {
  if (bubble && !bubble.isVisible() && Date.now() - bubbleBlurHiddenAt < 600) return;
  toggleBubble();
}

function toggleBubble(): void {
  if (!bubble) return;
  if (bubble.isVisible()) {
    bubble.hide();
    return;
  }
  positionBubble();
  bubble.show();
  bubble.focus();
}

const VALID_TIPOS: MemoryTipo[] = ['preferencia', 'proyecto', 'decisión', 'contexto'];

const SUMMARY_RE = /^\s*¿?\s*(resumen(\s+del\s+d[ií]a)?|qu[eé]\s+avanc[eé](\s+hoy)?|mi\s+avance(\s+de\s+hoy)?)\s*[?.!]*\s*$/i;
const RESUME_RE = /^\s*¿?\s*(retoma|retomar|d[oó]nde\s+me\s+qued[eé]|en\s+qu[eé]\s+(estaba|iba))\s*[?.!]*\s*$/i;

async function localSummary(): Promise<string> {
  const base = dailySummary(db, Math.min(24, config.retention_hours));
  const git = await gitToday(workRoots()).catch(() => '');
  return git ? `${base}\n\n${git}` : base;
}

const COST_RE = /^\s*¿?\s*(gasto|consumo|cu[aá]nto\s+(he\s+gastado|llevo(\s+gastado)?|llevamos|cuesta\s+el\s+agente))(\s+(hoy|de\s+hoy|del\s+mes))?\s*[?.!]*\s*$/i;
const LEARN_RE = /^\s*¿?\s*(aprende(\s+de\s+mis\s+(proyectos|h[aá]bitos))?|actualiza\s+(mi\s+)?memoria|qu[eé]\s+has\s+aprendido(\s+de\s+m[ií])?)\s*[?.!]*\s*$/i;
const CLEAN_RE = /^\s*(limpia|limpiar|limpia todo)\s*[.!?]?\s*$/i;
const DISK_RE = /(espacio|disco)/i;
const DISK_VERB_RE = /(libera|liberar|liberes|revis|limpi|cu[aá]nto|falta|lleno|llen[oa]|ocupa|pesa)/i;

function workRoots(): string[] {
  const h = homedir();
  return [...new Set([...config.allowed_folders, ...['Documents', 'Developer', 'Projects', 'Desktop'].map((d) => join(h, d))])]
    .filter((p) => existsSync(p));
}

// Comandos que se resuelven en la Mac, sin modelo y sin tokens.
async function localCommand(msg: string): Promise<string | null> {
  if (SUMMARY_RE.test(msg)) return localSummary();
  if (RESUME_RE.test(msg)) return resume(workRoots());
  if (COST_RE.test(msg)) return costReport(usageTotals(db));
  if (LEARN_RE.test(msg)) return learnReply();
  if (CLEAN_RE.test(msg)) return cleanLast(db);
  if (/^\s*espacio\s*[.!?]?\s*$/i.test(msg) || (DISK_RE.test(msg) && DISK_VERB_RE.test(msg))) {
    return formatReport(await scanDisk({ roots: workRoots() }));
  }
  return null;
}

// Una sola tarea a la vez: "Detener" la corta. historyEpoch invalida el guardado de lo que estaba en curso
// si en medio se borró el historial (así no reaparece nada de lo borrado).
let chatAbort: AbortController | null = null;
let historyEpoch = 0;

function stopChat(): boolean {
  const running = chatAbort !== null;
  chatAbort?.abort();
  return running;
}

/** Borra el historial por completo (y corta lo que esté en curso). */
function wipeChat(): number {
  stopChat();
  historyEpoch++;
  ai.clearSession();
  attachments.purgeAll();
  return clearHistory(db);
}

/** Cambió la conversación activa: corta lo que esté en curso y el modelo retoma solo el contexto de la nueva. */
function switchedConversation(): void {
  attachments.clearDrafts(); // lo adjuntado y no enviado se descarta al cambiar de conversación
  stopChat();
  historyEpoch++;
  ai.clearSession();
  ai.loadHistory(modelContext(db));
}

async function handleChat(msg: string, opts: { asAssistant?: boolean } = {}): Promise<{ reply: string; stopped?: boolean; attachDir?: string }> {
  let flash: CharacterState | null = null; // reacción breve del personaje al terminar
  let notice: { title: string; body: string } | null = null; // aviso nativo si no estás mirando la burbuja
  let record: { reply: string; kind: ChatKind } | null = null; // lo que queda en el historial
  let shownMsg = msg; // el mensaje tal como se ve en el chat (con los nombres de los adjuntos)
  let attachDir: string | undefined;
  const epoch = historyEpoch;
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  chatAbort = ctrl;
  setCharacterState('pensando');
  bubble?.webContents.send(IPC.chatThinking, true);

  try {
    let local: string | null;
    try {
      // "limpia" borra archivos: no se deja a medias con un Detener que solo aparenta parar
      local = CLEAN_RE.test(msg) ? await localCommand(msg) : await abortable(localCommand(msg), signal);
    } catch (e) {
      if (signal.aborted) { record = { reply: 'Detenido.', kind: 'stopped' }; return { reply: 'Detenido.', stopped: true }; }
      throw e;
    }
    if (local !== null) { record = { reply: local, kind: 'local' }; notice = { title: 'Kogn', body: local }; return { reply: local }; }

    const att = attachments.commit(activeConversation(db)); // si hay adjuntos pendientes, viajan con este mensaje
    if (att) { shownMsg = `${msg}\n${namesLine(att.files)}`; attachDir = att.dir; }
    const result = await ai.chat(msg, signal, att ?? undefined);

    if (result.stopped) {
      record = { reply: result.reply, kind: 'stopped' };
      return { reply: result.reply, stopped: true }; // sin aviso ni reacción: tú lo pediste
    }

    if (result.proposedMemory) {
      const tipo = VALID_TIPOS.includes(result.proposedMemory.tipo as MemoryTipo)
        ? result.proposedMemory.tipo as MemoryTipo
        : 'contexto';
      const mem = proposeMemory(db, result.proposedMemory.contenido, tipo, 'chat');
      if (mem) {
        bubble?.webContents.send(IPC.memoryProposed, mem);
      }
    }

    if (result.opsExecuted > 0) flash = 'exito';
    notice = { title: result.opsExecuted > 0 ? 'Kogn: tarea lista' : 'Kogn', body: result.reply };

    if (result.opsExecuted > 0) {
      showToastInBubble(`${result.opsExecuted} operaciones ejecutadas`);
    }

    record = { reply: result.reply, kind: 'ai' };
    return { reply: result.reply, attachDir };
  } catch (err: unknown) {
    flash = 'confuso';
    const message = err instanceof Error ? err.message : 'Error desconocido';
    notice = { title: 'Kogn: algo falló', body: message };
    record = { reply: `Error: ${message}`, kind: 'error' };
    return { reply: `Error: ${message}` };
  } finally {
    chatAbort = null;
    if (record && epoch === historyEpoch) {
      // una sugerencia aceptada se ve como mensaje del asistente, no como algo que escribiste
      if (opts.asAssistant) { saveExchange(db, null, msg, record.kind); saveExchange(db, null, record.reply, record.kind); }
      else saveExchange(db, shownMsg, record.reply, record.kind);
    }
    // Si la respuesta llega y no estás mirando la burbuja: queda pendiente (pop + salto) hasta que la abras
    if (notice && !lookingAtBubble()) pendingReply = true;
    const base = characterStateFor(observer.status());
    setCharacterState(pendingReply ? base : (flash ?? base));
    if (flash && !pendingReply) setTimeout(() => setCharacterState(characterStateFor(observer.status())), 3000);
    bubble?.webContents.send(IPC.chatThinking, false);
    if (notice) notify(notice.title, notice.body);
  }
}

function lookingAtBubble(): boolean {
  return !!bubble?.isVisible() && !!bubble?.isFocused();
}

function clearPending(): void {
  if (!pendingReply) return;
  pendingReply = false;
  setCharacterState(characterStateFor(observer.status()));
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  if (!shouldNotify({ enabled: config.notifications, bubbleVisible: !!bubble?.isVisible(), bubbleFocused: !!bubble?.isFocused() })) return;
  const n = new Notification({ title, body: notificationBody(body), silent: config.sounds }); // con sonido propio (pop) la notificación va en silencio
  n.on('click', showBubble);
  n.show();
}

// Aprende proyectos y hábitos y los PROPONE (se guardan solo si los apruebas).
let learning = false;
async function runLearning(): Promise<{ created: Memory[]; habitDays: number }> {
  if (learning || !config.memory_enabled) return { created: [], habitDays: 0 };
  learning = true;
  try {
    const r = await learn(db, workRoots());
    if (r.created.length) {
      bubble?.webContents.send(IPC.memoryRefresh);
      const n = r.created.length;
      notify('Kogn aprendió algo de ti', `${n} ${n === 1 ? 'recuerdo nuevo espera' : 'recuerdos nuevos esperan'} tu aprobación en la pestaña Memoria.`);
    }
    return r;
  } finally {
    learning = false;
  }
}

async function learnReply(): Promise<string> {
  if (!config.memory_enabled) return 'La memoria está desactivada en la configuración.';
  const r = await runLearning();
  const out = [r.created.length
    ? `Te propuse ${r.created.length} ${r.created.length === 1 ? 'recuerdo nuevo' : 'recuerdos nuevos'}:\n${r.created.slice(0, 5).map((m) => `• ${m.contenido}`).join('\n')}\nApruébalos en la pestaña Memoria.`
    : 'No encontré nada nuevo que proponerte.'];
  if (r.habitDays < MIN_HABIT_DAYS) out.push(`Los hábitos necesitan al menos ${MIN_HABIT_DAYS} días con el observador activo (llevo ${r.habitDays}).`);
  return out.join('\n');
}

function showToastInBubble(text: string): void {
  bubble?.webContents.executeJavaScript(
    `(typeof showToast === 'function') && showToast(${JSON.stringify(text)})`,
  ).catch(() => {});
}

function showBubble(): void {
  if (bubble && !bubble.isVisible()) toggleBubble();
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const actions: Record<keyof Config['shortcuts'], () => void> = {
    pause: () => observer.togglePause(),
    toggle_bubble: toggleBubble,
    summary: () => { showBubble(); void localSummary().then((t) => bubble?.webContents.send(IPC.chatReply, t)); },
    new_chat: () => { // conversación nueva: las anteriores se conservan (hasta el tope)
      const r = newConversation(db);
      if ('error' in r) { showBubble(); showToastInBubble('Todas tus conversaciones están fijadas: suelta alguna para crear otra'); return; }
      switchedConversation();
      showBubble();
      bubble?.webContents.send(IPC.chatClear);
    },
  };
  for (const [name, run] of Object.entries(actions)) {
    const accel = config.shortcuts[name as keyof Config['shortcuts']];
    try {
      if (!globalShortcut.register(accel, run)) console.warn(`[agentik] atajo "${accel}" (${name}) ya está en uso`);
    } catch {
      console.warn(`[agentik] atajo inválido "${accel}" (${name})`);
    }
  }
}

function evaluateSuggestions(): void {
  if (!observer.isActive) return;
  const s = suggestions.evaluate();
  if (!s) return;
  activeSuggestion = s;
  setCharacterState('con-sugerencia');
  bubble?.webContents.send(IPC.suggestionShow, s);
}

async function handleSuggestionAccept(id: string): Promise<{ reply: string }> {
  if (!activeSuggestion || activeSuggestion.id !== id) return { reply: '' };
  const text = activeSuggestion.text;
  activeSuggestion = null;
  return handleChat(text, { asAssistant: true });
}

function handleSuggestionDismiss(id: string): void {
  if (!activeSuggestion || activeSuggestion.id !== id) return;
  suggestions.dismiss(activeSuggestion.rule);
  activeSuggestion = null;
  setCharacterState(characterStateFor(observer.status()));
}

app.whenReady().then(() => {
  app.dock?.hide();

  config = loadUserConfig(app.getPath('userData'), join(app.getAppPath(), 'config.json'));
  // Una carpeta demasiado amplia ya guardada (p. ej. "/" por un clic accidental) se quita antes de vigilar nada.
  const cleaned = sanitizeFolders(config.allowed_folders);
  if (cleaned.removed.length) {
    config.allowed_folders = cleaned.kept;
    saveConfig(config);
  }
  db = openDb(join(app.getPath('userData'), 'agetik.db'));
  backupDir = join(app.getPath('userData'), 'backups');
  modulesDir = join(app.getPath('userData'), 'modules');
  attachments = new Attachments(join(app.getPath('userData'), 'adjuntos'));
  setInternalRoots([attachments.root]); // los adjuntos cuentan como zona autorizada para scripts y herramientas
  attachments.purgeOld(); // fuera lo de hace más de 14 días y los borradores que quedaron sin enviar
  observer = new Observer(db, config, readActiveWindow, pushStatus);
  secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  ai = new AiClient(db, config, backupDir, () => {
    const profile = activeProfile();
    if (!profile) throw new Error('No hay ningún modelo configurado. Agrega uno en la pestaña Modelo.');
    return { profile, provider: createProvider(profile, keyFor(profile)) };
  });
  ai.loadHistory(modelContext(db)); // la conversación sigue donde la dejaste
  suggestions = new SuggestionEngine(db, config);

  // ponytail: solo empaquetada; en dev registraría el binario de Electron como login item
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.launch_at_login });

  createWindows();
  if (cleaned.removed.length) {
    void dialog.showMessageBox({
      type: 'warning',
      title: 'Quité una carpeta demasiado amplia',
      message: 'Kogn quitó carpetas autorizadas que eran peligrosas',
      detail: `${cleaned.removed.map((r) => `• ${r.path}: ${r.reason}`).join('\n')}\n\nPuedes agregar carpetas concretas en la pestaña Archivos.`,
    });
  }

  registerIpc({
    getStatus: () => observer.status(),
    setEnabled: (on) => observer.setEnabled(on),
    togglePause: () => observer.togglePause(),
    toggleBubble: toggleBubbleFromAvatar,
    moveBy: (dx, dy) => {
      if (!character) return;
      const [x, y] = character.getPosition();
      character.setPosition(Math.round(x + dx), Math.round(y + dy));
    },
    dragEnd: () => {
      if (!character) return;
      const [x, y] = character.getPosition();
      setState(db, 'window_position', JSON.stringify({ x, y }));
    },
    quit: () => app.quit(),
    chatSend: handleChat,
    memoryList: () => listMemories(db),
    memoryApprove: (id) => approveMemory(db, id),
    memoryReject: (id) => rejectMemory(db, id),
    memoryDelete: (id) => deleteMemory(db, id),
    suggestionAccept: handleSuggestionAccept,
    suggestionDismiss: handleSuggestionDismiss,
    fileEditList: () => listFileEdits(db),
    fileEditApprove: (id) => approveFileEdit(db, id, backupDir),
    fileEditApproveAll: () => approveAllFileEdits(db, backupDir),
    fileEditReject: (id) => rejectFileEdit(db, id),
    fileEditRejectAll: () => rejectAllFileEdits(db),
    auditLog: () => getAuditLog(db),
    configGetFolders: () => config.allowed_folders,
    configAddFolder: handleAddFolder,
    configRemoveFolder: handleRemoveFolder,
    usageGet: () => usageTotals(db),
    modelsList: modelsState,
    modelsSetActive: handleModelsSetActive,
    modelsSave: handleModelsSave,
    modelsDelete: handleModelsDelete,
    modelsDetect: handleModelsDetect,
    chatStop: stopChat,
    chatHistory: () => loadHistory(db),
    chatClearHistory: wipeChat,
    chatAttachPick: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], defaultPath: app.getPath('downloads') });
      showBubble(); // el diálogo le quita el foco al chat y lo oculta
      return r.canceled ? { files: [], rejected: [] } : attachments.stage(activeConversation(db), r.filePaths);
    },
    chatAttachDrop: (paths) => attachments.stage(activeConversation(db), paths),
    chatAttachRemove: (id) => attachments.remove(activeConversation(db), id),
    chatAttachList: () => attachments.list(activeConversation(db)).map(({ id, name, size }) => ({ id, name, size })),
    chatReveal: (dir) => { if (isInsideInternalRoot(dir)) shell.showItemInFolder(dir); },
    scriptsList: () => ({ scripts: listScripts({ bin: scriptBin }), modules: moduleStatus(modulesDir), runs: listRuns(db, 8) }),
    scriptPlan: (id, params) => planScript(scriptDeps(), id, params),
    scriptRun: (id, params) => runScript(scriptDeps(), id, params),
    scriptUndo: (runId) => undoRun(scriptDeps(), runId),
    scriptPick: pickPath,
    moduleInstall: async (id) => {
      const r = await installModule(id, { modulesDir, onProgress: (f) => bubble?.webContents.send(IPC.moduleProgress, { id, fraction: f }) });
      return { ...r, modules: moduleStatus(modulesDir) };
    },
    conversationsList: () => listConversations(db),
    conversationNew: () => {
      const r = newConversation(db);
      if ('error' in r) return r;
      switchedConversation();
      return r;
    },
    conversationOpen: (id) => {
      if (!openConversation(db, id)) return { error: 'La conversación ya no existe' };
      switchedConversation();
      return { ok: true };
    },
    conversationDelete: (id) => {
      const wasActive = activeConversation(db) === id;
      if (!deleteConversation(db, id)) return { error: 'La conversación ya no existe' };
      attachments.purgeConversation(id);
      if (wasActive) switchedConversation();
      return { ok: true, activeChanged: wasActive };
    },
    conversationPin: (id, pinned) => (setPinned(db, id, pinned) ? { ok: true } : { error: 'La conversación ya no existe' }),
    settingsGet: settingsState,
    settingsSet: handleSettingsSet,
    openUrl: (url: string) => { shell.openExternal(url); },
  });

  setInterval(() => void observer.tick(), config.observer_poll_ms);
  setInterval(evaluateSuggestions, SUGGESTION_POLL_MS);
  purgeExpired(db, config.retention_hours, Date.now(), config.habit_retention_days);
  setInterval(() => purgeExpired(db, config.retention_hours, Date.now(), config.habit_retention_days), RETENTION_EVERY_MS);
  fileWatcher = startFileWatcher(config.allowed_folders, (p) => observer.recordFileChange(p));

  registerShortcuts();
  if (!config.onboarding_done) setTimeout(showBubble, 1500); // primera vez: abre la burbuja para mostrar la guía de inicio
  // Aprende de fondo solo si ya activaste el observador (sin tu activación no se observa nada).
  const autoLearn = (): void => { if (observer.status().enabled) void runLearning(); };
  setTimeout(autoLearn, 30_000);
  setInterval(autoLearn, 12 * 3_600_000);

  pushStatus(observer.status());
});

app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  db?.close();
});
