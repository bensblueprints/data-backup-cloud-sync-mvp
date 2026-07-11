const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('syncvault', {
  vaultStatus: invoke('vault:status'),
  vaultSetup: invoke('vault:setup'),
  vaultUnlock: invoke('vault:unlock'),
  vaultLock: invoke('vault:lock'),

  destList: invoke('dest:list'),
  destCreate: invoke('dest:create'),
  destTest: invoke('dest:test'),
  destDelete: invoke('dest:delete'),

  folderList: invoke('folder:list'),
  folderPick: invoke('folder:pick'),
  folderAdd: invoke('folder:add'),
  folderUpdate: invoke('folder:update'),
  folderRemove: invoke('folder:remove'),
  folderBackup: invoke('folder:backup'),

  restoreTree: invoke('restore:tree'),
  restoreVersions: invoke('restore:versions'),
  restoreFile: invoke('restore:file'),
  restoreFolder: invoke('restore:folder'),

  settingsGet: invoke('settings:get'),
  settingsSet: invoke('settings:set'),

  on: (channel, cb) => {
    const ok = ['backup:started', 'backup:progress', 'backup:done', 'backup:error'];
    if (!ok.includes(channel)) return;
    ipcRenderer.on(channel, (e, payload) => cb(payload));
  }
});
