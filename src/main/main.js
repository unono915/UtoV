'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');

const store = require('./store');
const tools = require('./tools');
const ytdlp = require('./ytdlp');
const server = require('./server');
const { rendererDir, userBinDir } = require('./paths');

let win = null;
let staticServer = null;

app.setAppUserModelId('kr.utov.app');
// 애니메이션이 많은 화면이 아니므로 배터리 절약보다 부드러움을 택한다
app.commandLine.appendSwitch('disable-renderer-backgrounding');

/* ------------------------------------------------------------------ 창 */

async function createWindow() {
  staticServer = await server.start(rendererDir());

  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: store.load().theme === 'light' ? '#F4F4F6' : '#0B0B0F',
    title: 'UtoV',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.removeMenu();

  // loadURL 이 끝난 뒤에 붙이면 ready-to-show 를 이미 놓쳤을 수 있다.
  // 먼저 걸어 두고, 그래도 안 뜨면 로드 완료 시점에 한 번 더 깨운다.
  win.once('ready-to-show', () => win.show());
  await win.loadURL(staticServer.url);
  if (!win.isDestroyed() && !win.isVisible()) win.show();

  // 창 상태를 화면에 알려서 최대화 아이콘을 바꿔준다
  const pushWindowState = () =>
    win && !win.isDestroyed() && win.webContents.send('win:state', { maximized: win.isMaximized() });
  win.on('maximize', pushWindowState);
  win.on('unmaximize', pushWindowState);

  // 바깥 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== staticServer.url) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ------------------------------------------------------------- 앱 수명 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    tools.cleanup();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  ytdlp.cancelAll();
  if (staticServer) staticServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => ytdlp.cancelAll());

/* ----------------------------------------------------------------- IPC */

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// --- 창 제어
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:isMaximized', () => Boolean(win && win.isMaximized()));

// --- 설정
ipcMain.handle('settings:get', () => store.load());
ipcMain.handle('settings:set', (_e, patch) => {
  const next = store.save(patch || {});
  if (patch && patch.theme && win && !win.isDestroyed()) {
    win.setBackgroundColor(patch.theme === 'light' ? '#F4F4F6' : '#0B0B0F');
    nativeTheme.themeSource = patch.theme;
  }
  return next;
});

// --- 도구 준비/갱신
ipcMain.handle('tools:status', () => tools.status());
ipcMain.handle('tools:ensure', async (_e, opts) => {
  try {
    return { ok: true, status: await tools.ensure((p) => send('tools:progress', p), opts || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('tools:update', async () => {
  try {
    return { ok: true, ...(await tools.updateYtdlp((p) => send('tools:progress', p))) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- 폴더 / 파일
ipcMain.handle('dialog:chooseFolder', async (_e, current) => {
  const result = await dialog.showOpenDialog(win, {
    title: '저장할 폴더 선택',
    defaultPath: current && fs.existsSync(current) ? current : app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '이 폴더 사용',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:revealFile', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('shell:openPath', async (_e, target) => {
  if (!target) return false;
  if (!fs.existsSync(target)) {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return true;
    }
    return false;
  }
  const err = await shell.openPath(target);
  return err === '';
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('fs:exists', (_e, p) => Boolean(p) && fs.existsSync(p));

// --- yt-dlp
ipcMain.handle('yt:probe', async (_e, url, opts) => {
  try {
    return { ok: true, info: await ytdlp.probe(url, store.load(), opts || {}) };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.utovCode || 'unknown',
      raw: err.utovRaw || '',
    };
  }
});

ipcMain.handle('yt:download', (_e, job) => {
  const settings = store.load();
  const merged = Object.assign({ outDir: settings.outDir }, job);
  try {
    const jobId = ytdlp.start(merged, settings, (evt) => send('job:event', evt));
    return { ok: true, jobId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('yt:cancel', (_e, jobId) => ytdlp.cancel(jobId));

// --- 정보
ipcMain.handle('app:info', () => ({
  strategies: ytdlp.STRATEGIES,
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  binDir: userBinDir(),
  userData: app.getPath('userData'),
  platform: process.platform,
}));
