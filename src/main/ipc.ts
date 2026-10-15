import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/ipc-channels.js';
import { profileSchema } from './config.js';

const boolean = z.boolean();
const delta = z.object({ dx: z.number().finite(), dy: z.number().finite() });
const chatMsg = z.string().min(1).max(4000);
const memId = z.number().int().positive();

const modelSave = profileSchema.partial({ id: true }).extend({ api_key: z.string().max(500).optional() });
const settingsPatch = z.object({ avatar: z.enum(['nino', 'nina']).optional(), notifications: z.boolean().optional(), sounds: z.boolean().optional(), onboarding_done: z.boolean().optional() });
const modelId = z.string().min(1).max(60);
const scriptCall = z.object({ id: z.string().min(1).max(60), params: z.record(z.string().max(40), z.union([z.string().max(1000), z.number().finite()])).default({}) });

const suggestionId = z.string().min(1).max(100);

export interface IpcHandlers {
  getStatus: () => unknown;
  setEnabled: (on: boolean) => unknown;
  togglePause: () => unknown;
  toggleBubble: () => void;
  moveBy: (dx: number, dy: number) => void;
  dragEnd: () => void;
  quit: () => void;
  chatSend: (msg: string) => Promise<unknown>;
  memoryList: () => unknown;
  memoryApprove: (id: number) => unknown;
  memoryReject: (id: number) => unknown;
  memoryDelete: (id: number) => unknown;
  suggestionAccept: (id: string) => Promise<unknown>;
  suggestionDismiss: (id: string) => void;
  fileEditList: () => unknown;
  fileEditApprove: (id: number) => unknown;
  fileEditApproveAll: () => unknown;
  fileEditReject: (id: number) => unknown;
  fileEditRejectAll: () => unknown;
  auditLog: () => unknown;
  configGetFolders: () => string[];
  configAddFolder: () => Promise<string[]>;
  configRemoveFolder: (folder: string) => string[];
  usageGet: () => unknown;
  modelsList: () => unknown;
  modelsSetActive: (id: string) => unknown;
  modelsSave: (p: z.infer<typeof modelSave>) => unknown;
  modelsDelete: (id: string) => unknown;
  modelsDetect: (baseUrl?: string) => Promise<unknown>;
  chatStop: () => boolean;
  chatHistory: () => unknown;
  chatClearHistory: () => number;
  conversationsList: () => unknown;
  conversationNew: () => unknown;
  conversationOpen: (id: number) => unknown;
  conversationDelete: (id: number) => unknown;
  conversationPin: (id: number, pinned: boolean) => unknown;
  chatAttachPick: () => Promise<unknown>;
  chatAttachDrop: (paths: string[]) => unknown;
  chatAttachRemove: (id: string) => unknown;
  chatAttachList: () => unknown;
  chatReveal: (dir: string) => void;
  scriptsList: () => unknown;
  scriptPlan: (id: string, params: Record<string, string | number>) => Promise<unknown>;
  scriptRun: (id: string, params: Record<string, string | number>) => Promise<unknown>;
  scriptUndo: (runId: number) => unknown;
  scriptPick: (kind: 'file' | 'folder') => Promise<string | null>;
  moduleInstall: (id: string) => Promise<unknown>;
  settingsGet: () => unknown;
  settingsSet: (p: z.infer<typeof settingsPatch>) => unknown;
  openUrl: (url: string) => void;
}

export function registerIpc(h: IpcHandlers): void {
  ipcMain.handle(IPC.observerStatus, () => h.getStatus());
  ipcMain.handle(IPC.observerSetEnabled, (_e, raw: unknown) => h.setEnabled(boolean.parse(raw)));
  ipcMain.handle(IPC.observerTogglePause, () => h.togglePause());
  ipcMain.on(IPC.bubbleToggle, () => h.toggleBubble());
  ipcMain.on(IPC.windowMoveBy, (_e, raw: unknown) => {
    const d = delta.safeParse(raw);
    if (d.success) h.moveBy(d.data.dx, d.data.dy);
  });
  ipcMain.on(IPC.windowDragEnd, () => h.dragEnd());
  ipcMain.on(IPC.appQuit, () => h.quit());

  ipcMain.handle(IPC.chatSend, (_e, raw: unknown) => {
    const parsed = chatMsg.safeParse(raw);
    if (!parsed.success) return { error: 'Mensaje inválido' };
    return h.chatSend(parsed.data);
  });
  ipcMain.handle(IPC.memoryList, () => h.memoryList());
  ipcMain.handle(IPC.memoryApprove, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.memoryApprove(parsed.data);
  });
  ipcMain.handle(IPC.memoryReject, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.memoryReject(parsed.data);
  });
  ipcMain.handle(IPC.memoryDelete, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.memoryDelete(parsed.data);
  });

  ipcMain.handle(IPC.suggestionAccept, (_e, raw: unknown) => {
    const parsed = suggestionId.safeParse(raw);
    if (!parsed.success) return { error: 'ID inválido' };
    return h.suggestionAccept(parsed.data);
  });
  ipcMain.handle(IPC.suggestionDismiss, (_e, raw: unknown) => {
    const parsed = suggestionId.safeParse(raw);
    if (parsed.success) h.suggestionDismiss(parsed.data);
  });

  ipcMain.handle(IPC.fileEditList, () => h.fileEditList());
  ipcMain.handle(IPC.fileEditApprove, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return { error: 'ID inválido' };
    return h.fileEditApprove(parsed.data);
  });
  ipcMain.handle(IPC.fileEditApproveAll, () => h.fileEditApproveAll());
  ipcMain.handle(IPC.fileEditReject, (_e, raw: unknown) => {
    const parsed = memId.safeParse(raw);
    if (!parsed.success) return false;
    return h.fileEditReject(parsed.data);
  });
  ipcMain.handle(IPC.fileEditRejectAll, () => h.fileEditRejectAll());
  ipcMain.handle(IPC.auditLog, () => h.auditLog());

  ipcMain.handle(IPC.usageGet, () => h.usageGet());

  ipcMain.handle(IPC.chatStop, () => h.chatStop());
  ipcMain.handle(IPC.chatHistory, () => h.chatHistory());
  ipcMain.handle(IPC.chatClearHistory, () => h.chatClearHistory());
  ipcMain.handle(IPC.conversationsList, () => h.conversationsList());
  ipcMain.handle(IPC.conversationNew, () => h.conversationNew());
  ipcMain.handle(IPC.conversationOpen, (_e, raw: unknown) => {
    const id = memId.safeParse(raw);
    return id.success ? h.conversationOpen(id.data) : { error: 'ID inválido' };
  });
  ipcMain.handle(IPC.conversationDelete, (_e, raw: unknown) => {
    const id = memId.safeParse(raw);
    return id.success ? h.conversationDelete(id.data) : { error: 'ID inválido' };
  });
  ipcMain.handle(IPC.chatAttachPick, () => h.chatAttachPick());
  ipcMain.handle(IPC.chatAttachDrop, (_e, raw: unknown) => {
    const paths = z.array(z.string().min(1).max(2000)).max(50).safeParse(raw);
    return paths.success ? h.chatAttachDrop(paths.data) : { files: [], rejected: [{ name: '?', reason: 'datos no válidos' }] };
  });
  ipcMain.handle(IPC.chatAttachRemove, (_e, raw: unknown) => {
    const id = z.string().min(1).max(40).safeParse(raw);
    return id.success ? h.chatAttachRemove(id.data) : false;
  });
  ipcMain.handle(IPC.chatAttachList, () => h.chatAttachList());
  ipcMain.handle(IPC.chatReveal, (_e, raw: unknown) => {
    const dir = z.string().min(1).max(2000).safeParse(raw);
    if (dir.success) h.chatReveal(dir.data);
  });
  ipcMain.handle(IPC.scriptsList, () => h.scriptsList());
  ipcMain.handle(IPC.scriptPlan, (_e, raw: unknown) => {
    const c = scriptCall.safeParse(raw);
    return c.success ? h.scriptPlan(c.data.id, c.data.params) : { ok: false, error: 'Datos no válidos' };
  });
  ipcMain.handle(IPC.scriptRun, (_e, raw: unknown) => {
    const c = scriptCall.safeParse(raw);
    return c.success ? h.scriptRun(c.data.id, c.data.params) : { ok: false, error: 'Datos no válidos' };
  });
  ipcMain.handle(IPC.scriptUndo, (_e, raw: unknown) => {
    const id = memId.safeParse(raw);
    return id.success ? h.scriptUndo(id.data) : { ok: false, error: 'ID inválido' };
  });
  ipcMain.handle(IPC.scriptPick, (_e, raw: unknown) => {
    const k = z.enum(['file', 'folder']).safeParse(raw);
    return k.success ? h.scriptPick(k.data) : null;
  });
  ipcMain.handle(IPC.moduleInstall, (_e, raw: unknown) => {
    const id = modelId.safeParse(raw);
    return id.success ? h.moduleInstall(id.data) : { ok: false, error: 'ID inválido' };
  });
  ipcMain.handle(IPC.conversationPin, (_e, raw: unknown) => {
    const p = z.object({ id: memId, pinned: boolean }).safeParse(raw);
    return p.success ? h.conversationPin(p.data.id, p.data.pinned) : { error: 'Datos no válidos' };
  });
  ipcMain.handle(IPC.settingsGet, () => h.settingsGet());
  ipcMain.handle(IPC.settingsSet, (_e, raw: unknown) => {
    const p = settingsPatch.safeParse(raw);
    return p.success ? h.settingsSet(p.data) : { error: 'Ajustes no válidos' };
  });

  ipcMain.handle(IPC.modelsList, () => h.modelsList());
  ipcMain.handle(IPC.modelsSetActive, (_e, raw: unknown) => {
    const id = modelId.safeParse(raw);
    return id.success ? h.modelsSetActive(id.data) : { error: 'ID inválido' };
  });
  ipcMain.handle(IPC.modelsSave, (_e, raw: unknown) => {
    const p = modelSave.safeParse(raw);
    return p.success ? h.modelsSave(p.data) : { error: 'Datos del modelo no válidos' };
  });
  ipcMain.handle(IPC.modelsDelete, (_e, raw: unknown) => {
    const id = modelId.safeParse(raw);
    return id.success ? h.modelsDelete(id.data) : { error: 'ID inválido' };
  });
  ipcMain.handle(IPC.modelsDetect, (_e, raw: unknown) => {
    const url = z.string().url().optional().safeParse(raw);
    return url.success ? h.modelsDetect(url.data) : { error: 'URL no válida' };
  });
  ipcMain.handle(IPC.configGetFolders, () => h.configGetFolders());
  ipcMain.handle(IPC.configAddFolder, () => h.configAddFolder());
  ipcMain.handle(IPC.configRemoveFolder, (_e, raw: unknown) => {
    const parsed = z.string().min(1).safeParse(raw);
    if (!parsed.success) return [];
    return h.configRemoveFolder(parsed.data);
  });
  ipcMain.handle(IPC.openUrl, (_e, raw: unknown) => {
    const url = z.string().url().safeParse(raw);
    if (url.success) h.openUrl(url.data);
  });
}
