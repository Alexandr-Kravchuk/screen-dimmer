const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dimmer', {
  getState: () => ipcRenderer.invoke('get-state'),
  getRect: () => ipcRenderer.invoke('get-rect'),
  update: (patch) => ipcRenderer.send('update', patch),
  moveTo: (x, y) => ipcRenderer.send('move-to', x, y),
  dragEnd: () => ipcRenderer.send('drag-end'),
  nudge: (dx, dy) => ipcRenderer.send('nudge', dx, dy),
  resizeTo: (w, h) => ipcRenderer.send('resize-to', w, h),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  onApply: (cb) => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('apply', listener);
    return () => ipcRenderer.removeListener('apply', listener);
  },
});
