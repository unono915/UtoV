'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** 화면쪽에 노출되는 유일한 창구 */
contextBridge.exposeInMainWorld('utov', {
  // 창 제어
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onState: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('win:state', h);
      return () => ipcRenderer.off('win:state', h);
    },
  },

  // 설정
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  // yt-dlp / ffmpeg 준비
  tools: {
    status: () => ipcRenderer.invoke('tools:status'),
    ensure: (opts) => ipcRenderer.invoke('tools:ensure', opts),
    update: () => ipcRenderer.invoke('tools:update'),
    onProgress: (cb) => {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('tools:progress', h);
      return () => ipcRenderer.off('tools:progress', h);
    },
  },

  // 다운로드
  yt: {
    probe: (url, opts) => ipcRenderer.invoke('yt:probe', url, opts),
    download: (job) => ipcRenderer.invoke('yt:download', job),
    cancel: (jobId) => ipcRenderer.invoke('yt:cancel', jobId),
    onEvent: (cb) => {
      const h = (_e, evt) => cb(evt);
      ipcRenderer.on('job:event', h);
      return () => ipcRenderer.off('job:event', h);
    },
  },

  // 파일 시스템 / 셸
  fs: {
    chooseFolder: (current) => ipcRenderer.invoke('dialog:chooseFolder', current),
    reveal: (filePath) => ipcRenderer.invoke('shell:revealFile', filePath),
    open: (target) => ipcRenderer.invoke('shell:openPath', target),
    external: (url) => ipcRenderer.invoke('shell:openExternal', url),
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
  },

  info: () => ipcRenderer.invoke('app:info'),
});
