'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 설정
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (next) => ipcRenderer.invoke('save-settings', next),
  listGeminiModels: () => ipcRenderer.invoke('list-gemini-models'),
  onModelChanged: (cb) => ipcRenderer.on('model-changed', (_e, p) => cb(p)),

  // 창 제어
  close: () => ipcRenderer.send('window-close'),
  minimize: () => ipcRenderer.send('window-minimize'),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  toggleTrigger: () => ipcRenderer.invoke('toggle-trigger'),

  // 트리거 (클립보드 자동 / 단축키)
  onClipboard: (cb) =>
    ipcRenderer.on('clipboard-change', (_e, payload) => cb(payload)),
  onHotkeyLookup: (cb) =>
    ipcRenderer.on('hotkey-lookup', (_e, payload) => cb(payload)),
  onHotkeyEmpty: (cb) => ipcRenderer.on('hotkey-empty', () => cb()),
  onAppSkipped: (cb) =>
    ipcRenderer.on('app-skipped', (_e, payload) => cb(payload)),

  // 조회 (스트리밍)
  lookup: (requestId, text, context) =>
    ipcRenderer.send('lookup', { requestId, text, context }),
  ask: (requestId, question) =>
    ipcRenderer.send('ask', { requestId, question }),
  onChunk: (cb) => ipcRenderer.on('lookup-chunk', (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on('lookup-done', (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on('lookup-error', (_e, p) => cb(p)),
  onImage: (cb) => ipcRenderer.on('lookup-image', (_e, p) => cb(p)),

  // 외부 링크 열기
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // 논문 노트 라이브러리
  libList: () => ipcRenderer.invoke('lib-list'),
  libCreate: (title) => ipcRenderer.invoke('lib-create', title),
  libSelect: (id) => ipcRenderer.invoke('lib-select', id),
  libRename: (id, title) => ipcRenderer.invoke('lib-rename', { id, title }),
  libDelete: (id) => ipcRenderer.invoke('lib-delete', id),
  libGet: (id) => ipcRenderer.invoke('lib-get', id),
  onPaperUpdated: (cb) => ipcRenderer.on('paper-updated', (_e, p) => cb(p)),
});
