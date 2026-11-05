const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('harness', {
  listAdapters: invoke('adapters:list'),
  detectClaude: invoke('claude:detect'),
  loadState: invoke('state:load'),
  saveState: invoke('state:save'),
  pickFolder: invoke('dialog:pickFolder'),
  pickFile: invoke('dialog:pickFile'),
  reveal: invoke('shell:reveal'),
  setTheme: invoke('theme:set'),
  run: invoke('agent:run'),
  cancel: invoke('agent:cancel'),
  setup: {
    status: invoke('setup:status'),
    install: invoke('setup:install'),
    startLogin: invoke('setup:login:start'),
    submitCode: invoke('setup:login:code'),
    cancelLogin: invoke('setup:login:cancel'),
    openUrl: invoke('setup:openUrl'),
  },
  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onSetupEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:event', handler);
    return () => ipcRenderer.removeListener('setup:event', handler);
  },
});
