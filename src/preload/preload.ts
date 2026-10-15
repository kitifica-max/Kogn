import { contextBridge, ipcRenderer, webUtils } from 'electron';

const IPC = {
  observerStatus: 'observer:status',
  observerSetEnabled: 'observer:set-enabled',
  observerTogglePause: 'observer:toggle-pause',
  bubbleToggle: 'bubble:toggle',
  windowMoveBy: 'window:move-by',
  windowDragEnd: 'window:drag-end',
  appQuit: 'app:quit',
  characterState: 'character:state',
  observerChanged: 'observer:changed',
  chatSend: 'chat:send',
  chatReply: 'chat:reply',
  chatThinking: 'chat:thinking',
  chatClear: 'chat:clear',
  memoryList: 'memory:list',
  memoryApprove: 'memory:approve',
  memoryReject: 'memory:reject',
  memoryDelete: 'memory:delete',
  memoryProposed: 'memory:proposed',
  memoryRefresh: 'memory:refresh',
  suggestionShow: 'suggestion:show',
  suggestionAccept: 'suggestion:accept',
  suggestionDismiss: 'suggestion:dismiss',
  fileEditList: 'file-edit:list',
  fileEditApprove: 'file-edit:approve',
  fileEditApproveAll: 'file-edit:approve-all',
  fileEditReject: 'file-edit:reject',
  fileEditRejectAll: 'file-edit:reject-all',
  fileEditProposed: 'file-edit:proposed',
  auditLog: 'audit:log',
  configGetFolders: 'config:get-folders',
  configAddFolder: 'config:add-folder',
  configRemoveFolder: 'config:remove-folder',
  usageGet: 'usage:get',
  modelsList: 'models:list',
  modelsSetActive: 'models:set-active',
  modelsSave: 'models:save',
  modelsDelete: 'models:delete',
  modelsDetect: 'models:detect',
  chatStop: 'chat:stop',
  chatHistory: 'chat:history',
  chatClearHistory: 'chat:clear-history',
  conversationsList: 'conversations:list',
  conversationNew: 'conversations:new',
  conversationOpen: 'conversations:open',
  conversationDelete: 'conversations:delete',
  conversationPin: 'conversations:pin',
  chatAttachPick: 'chat:attach-pick',
  chatAttachDrop: 'chat:attach-drop',
  chatAttachRemove: 'chat:attach-remove',
  chatAttachList: 'chat:attach-list',
  chatReveal: 'chat:reveal',
  scriptsList: 'scripts:list',
  scriptPlan: 'scripts:plan',
  scriptRun: 'scripts:run',
  scriptUndo: 'scripts:undo',
  scriptPick: 'scripts:pick',
  moduleInstall: 'modules:install',
  moduleProgress: 'modules:progress',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  avatarChanged: 'avatar:changed',
  openUrl: 'open:url',
} as const;

const INVOKE: string[] = [
  IPC.observerStatus, IPC.observerSetEnabled, IPC.observerTogglePause,
  IPC.chatSend, IPC.memoryList, IPC.memoryApprove, IPC.memoryReject, IPC.memoryDelete,
  IPC.suggestionAccept, IPC.suggestionDismiss,
  IPC.fileEditList, IPC.fileEditApprove, IPC.fileEditApproveAll, IPC.fileEditReject, IPC.fileEditRejectAll, IPC.auditLog,
  IPC.configGetFolders, IPC.configAddFolder, IPC.configRemoveFolder, IPC.usageGet,
  IPC.modelsList, IPC.modelsSetActive, IPC.modelsSave, IPC.modelsDelete, IPC.modelsDetect,
  IPC.settingsGet, IPC.settingsSet,
  IPC.chatStop, IPC.chatHistory, IPC.chatClearHistory,
  IPC.conversationsList, IPC.conversationNew, IPC.conversationOpen, IPC.conversationDelete, IPC.conversationPin,
  IPC.chatAttachPick, IPC.chatAttachDrop, IPC.chatAttachRemove, IPC.chatAttachList, IPC.chatReveal,
  IPC.scriptsList, IPC.scriptPlan, IPC.scriptRun, IPC.scriptUndo, IPC.scriptPick, IPC.moduleInstall,
  IPC.openUrl,
];
const SEND: string[] = [IPC.bubbleToggle, IPC.windowMoveBy, IPC.windowDragEnd, IPC.appQuit];
const LISTEN: string[] = [IPC.characterState, IPC.observerChanged, IPC.chatReply, IPC.chatThinking, IPC.chatClear, IPC.memoryProposed, IPC.memoryRefresh, IPC.avatarChanged, IPC.suggestionShow, IPC.fileEditProposed, IPC.moduleProgress];

contextBridge.exposeInMainWorld('agentik', {
  channels: IPC,
  /** Ruta real de un archivo soltado en la ventana (el navegador ya no la expone). */
  pathForFile: (f: File): string => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  invoke: (channel: string, payload?: unknown) => {
    if (!INVOKE.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  send: (channel: string, payload?: unknown) => {
    if (!SEND.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!LISTEN.includes(channel)) throw new Error(`IPC canal no permitido: ${channel}`);
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
