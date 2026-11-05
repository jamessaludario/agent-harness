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
  openExternal: invoke('shell:openExternal'),
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
  browser: {
    setBounds: invoke('browser:bounds'),
    setVisible: invoke('browser:visible'),
    go: invoke('browser:go'),
    nav: invoke('browser:nav'),
    openExternal: invoke('browser:external'),
    onState: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('browser:state', handler);
      return () => ipcRenderer.removeListener('browser:state', handler);
    },
  },
  memory: {
    list: invoke('memory:list'),
    save: invoke('memory:save'),
    remove: invoke('memory:remove'),
    toggle: invoke('memory:toggle'),
    resolve: invoke('memory:resolve'),
    setLearning: invoke('memory:learning'),
    importSkill: invoke('memory:importSkill'),
    condense: invoke('memory:condense'),
    onLearned: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('memory:learned', handler);
      return () => ipcRenderer.removeListener('memory:learned', handler);
    },
  },
  term: {
    run: invoke('term:run'),
    kill: invoke('term:kill'),
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('term:event', handler);
      return () => ipcRenderer.removeListener('term:event', handler);
    },
  },
  appVersion: invoke('app:version'),
  checkForUpdates: invoke('update:check'),
  installUpdate: invoke('update:install'),
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
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
