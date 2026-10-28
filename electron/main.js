/**
 * electron/main.js —— 桌面版入口
 *
 * 只做一件事：开一个浏览器窗口加载 public/index.html。
 * 合成、量化、GIF 编码仍然全部跑在渲染进程的 canvas 里，和网页版共享同一套代码；
 * 因此这里不注入 Node、不加载 preload、不允许页面内跳转或开新窗口。
 *
 *   npm run electron        本地以桌面窗口运行
 *   npm run electron:dir    生成免安装目录（dist/win-unpacked 等）
 *   npm run electron:build  生成当前平台的安装包
 */
'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, shell, nativeTheme } = require('electron');

const APP_ID = 'com.imgcompare.gif';
const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');

// 页面是深色主题，窗口标题栏/滚动条也跟随深色
nativeTheme.themeSource = 'dark';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1020',
    title: 'img-compare-gif · 前后对比 GIF 生成器',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', function () {
    win.show();
  });

  win.loadFile(INDEX_FILE);

  // 外链交给系统浏览器，页面内不允许开新窗口
  win.webContents.setWindowOpenHandler(function ({ url }) {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 只允许留在本地页面，避免误跳转到外部地址
  win.webContents.on('will-navigate', function (event, url) {
    if (new URL(url).protocol !== 'file:') {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  return win;
}

app.whenReady().then(function () {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  // Windows/Linux 去掉原生菜单栏，更像一个独立软件；macOS 保留系统菜单
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
