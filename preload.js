/**
 * preload.js – bridges the locked-down renderer to the main process.
 *
 * Exposes a minimal, typed API on window.r2Open for disk-backed config
 * I/O.  The renderer no longer needs nodeIntegration.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('r2Open', {
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (payload) => ipcRenderer.invoke('config:save', payload),
    clear: () => ipcRenderer.invoke('config:clear'),
    path: () => ipcRenderer.invoke('config:path'),
  },
  storage: {
    loadBucketConfig: (bucket) => ipcRenderer.invoke('storage:loadBucketConfig', { bucket }),
    saveBucketConfig: (bucket, payload) => ipcRenderer.invoke('storage:saveBucketConfig', { bucket, ...payload }),
  },
  dialog: {
    showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpen', options),
  },
  fs: {
    pickFolder: (payload) => ipcRenderer.invoke('fs:pickFolder', payload || {}),
    pickFiles: (payload) => ipcRenderer.invoke('fs:pickFiles', payload || {}),
    pickFolders: (payload) => ipcRenderer.invoke('fs:pickFolders', payload || {}),
    walkPaths: (payload) => ipcRenderer.invoke('fs:walkPaths', payload || {}),
    readFile: (payload) => ipcRenderer.invoke('fs:readFile', payload || {}),
    writeTemp: (payload) => ipcRenderer.invoke('fs:writeTemp', payload || {}),
    savePath: (payload) => ipcRenderer.invoke('fs:savePath', payload || {}),
    writeFile: (payload) => ipcRenderer.invoke('fs:writeFile', payload || {}),
    openExternal: (payload) => ipcRenderer.invoke('fs:openExternal', payload || {}),
  },
  fsUtil: {
    join: (segments) => ipcRenderer.invoke('fsUtil:join', { segments }),
    tmpdir: () => ipcRenderer.invoke('fsUtil:tmpdir'),
    exists: (p) => ipcRenderer.invoke('fsUtil:exists', { path: p }),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (payload) => ipcRenderer.invoke('clipboard:writeText', payload || {}),
  },
  net: {
    fetchUrl: (payload) => ipcRenderer.invoke('url:fetch', payload || {}),
  },
  r2: {
    listBuckets: () => ipcRenderer.invoke('r2:listBuckets'),
    listObjects: (payload) => ipcRenderer.invoke('r2:listObjects', payload),
    bucketStats: (payload) => ipcRenderer.invoke('r2:bucketStats', payload),
    getObject: (payload) => ipcRenderer.invoke('r2:getObject', payload || {}),
    deleteObject: (payload) => ipcRenderer.invoke('r2:deleteObject', payload || {}),
    putObjectFromPath: (payload) => ipcRenderer.invoke('r2:putObjectFromPath', payload || {}),
    putObjectFromBytes: (payload) => ipcRenderer.invoke('r2:putObjectFromBytes', payload || {}),
  },
  transfer: {
    add: (payload) => ipcRenderer.invoke('transfer:add', payload),
    list: (payload) => ipcRenderer.invoke('transfer:list', payload || {}),
    clear: () => ipcRenderer.invoke('transfer:clear'),
  },
});