import {
  app,
  BrowserWindow,
  dialog,
  shell,
  safeStorage,
  Menu,
  Notification,
  Tray,
  nativeTheme,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../server/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const portalWindows = new Map();
let mainWindow,
  studio,
  tray,
  shuttingDown = false;
if (process.env.STUDIO_HEADLESS_TEST) console.log('STUDIO_MODULE_LOADED');
if (!process.env.STUDIO_TEST_DATA && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});
const allowedURL = (value) => {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('仅支持 HTTP / HTTPS 地址');
  return u.href;
};
async function debugCommand(contents, method, params = {}) {
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  return contents.debugger.sendCommand(method, params);
}
async function portal(node, action, args) {
  let win = portalWindows.get(node.id);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1180,
      height: 820,
      show: false,
      title: node.data.name || '浏览器',
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `persist:studio-portal-${node.id}`,
      },
    });
    portalWindows.set(node.id, win);
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) =>
      callback(false),
    );
    await win.loadURL(allowedURL(node.data.url || 'https://example.com'));
  }
  if (action === 'show') {
    win.show();
    win.focus();
    return { shown: true };
  }
  if (action === 'navigate') {
    await win.loadURL(allowedURL(args.url));
    node.data.url = args.url;
    studio.store.changed(true);
  }
  if (action === 'click' || action === 'type') {
    const selector = `[data-studio-ref=${JSON.stringify(String(args.ref))}]`;
    const bounds = await win.webContents.executeJavaScript(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('元素编号已失效，请重新读取页面'); e.scrollIntoView({block:'center'}); e.focus(); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    await debugCommand(win.webContents, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: bounds.x,
      y: bounds.y,
      button: 'left',
      clickCount: 1,
    });
    await debugCommand(win.webContents, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: bounds.x,
      y: bounds.y,
      button: 'left',
      clickCount: 1,
    });
    if (action === 'type')
      await debugCommand(win.webContents, 'Input.insertText', { text: String(args.text || '') });
  }
  if (action === 'screenshot')
    return {
      image: (await win.webContents.capturePage()).toDataURL(),
      url: win.webContents.getURL(),
    };
  const data = await win.webContents.executeJavaScript(
    `(() => { const all = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).slice(0,100); const elements=all.map((e,i)=>{e.dataset.studioRef=String(i+1);return {ref:String(i+1),tag:e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name')||'').slice(0,160)}}); return {title:document.title,text:(document.body?.innerText||'').slice(0,24000),elements}; })()`,
  );
  return { ...data, url: win.webContents.getURL() };
}
app
  .whenReady()
  .then(async () => {
    if (process.env.STUDIO_HEADLESS_TEST) console.log('STUDIO_ELECTRON_READY');
    app.setName('Agent Studio');
    const dataDirectory =
      process.env.STUDIO_TEST_DATA || path.join(app.getPath('userData'), 'workspace');
    studio = await createStudio({
      directory: dataDirectory,
      desktop: true,
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error('Windows 凭据加密不可用，Key 未保存');
        return safeStorage.encryptString(value).toString('base64');
      },
      decrypt: (value) => {
        try {
          return safeStorage.decryptString(Buffer.from(value, 'base64'));
        } catch {
          return null;
        }
      },
      pickDirectory: async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
          title: '选择项目目录',
          properties: ['openDirectory'],
        });
        return r.canceled ? null : r.filePaths[0];
      },
      pickFile: async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
          title: '选择工具的可执行文件',
          properties: ['openFile'],
          filters: [
            { name: '可执行文件', extensions: ['exe', 'js', 'mjs', 'cjs'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        return r.canceled ? null : r.filePaths[0];
      },
      openFolder: (directory) => shell.openPath(directory),
      portal,
      closePortal: (id) => {
        portalWindows.get(id)?.close();
        portalWindows.delete(id);
      },
    });
    if (process.env.STUDIO_HEADLESS_TEST) console.log('STUDIO_BACKEND_READY');
    mainWindow = new BrowserWindow({
      width: 1510,
      height: 980,
      minWidth: 960,
      minHeight: 680,
      show: !process.env.STUDIO_HEADLESS_TEST,
      title: 'Agent Studio',
      backgroundColor: '#f7f8fa',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#f7f8fa', symbolColor: '#45474e', height: 48 },
      autoHideMenuBar: true,
      icon: fs.existsSync(path.join(root, 'electron', 'icon.png'))
        ? path.join(root, 'electron', 'icon.png')
        : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });
    if (process.env.STUDIO_HEADLESS_TEST) console.log('STUDIO_WINDOW_CREATED');
    let lastWindowTheme = '';
    const updateWindowTheme = () => {
      const theme = studio.store.state.settings.theme || 'light';
      const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
      const key = dark ? 'dark' : 'light';
      if (key === lastWindowTheme || mainWindow.isDestroyed()) return;
      lastWindowTheme = key;
      mainWindow.setBackgroundColor(dark ? '#202228' : '#f7f8fa');
      if (process.platform === 'win32')
        mainWindow.setTitleBarOverlay({
          color: dark ? '#202228' : '#f7f8fa',
          symbolColor: dark ? '#c9cfdb' : '#45474e',
          height: 48,
        });
    };
    updateWindowTheme();
    studio.store.on('change', updateWindowTheme);
    nativeTheme.on('updated', updateWindowTheme);
    const notifiedTasks = new Set(
      studio.store.state.tasks.filter((t) => t.endedAt).map((t) => t.id),
    );
    studio.store.on('change', () => {
      if (!studio.store.state.settings.notifications) return;
      for (const t of studio.store.state.tasks)
        if (t.endedAt && !notifiedTasks.has(t.id)) {
          notifiedTasks.add(t.id);
          const node = studio.store.state.nodes.find((n) => n.id === t.nodeId);
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: 'Agent Studio',
              body:
                (node?.data.name || '任务') +
                (t.status === 'completed' ? ' 已完成' : ' 已停止或需要检查'),
            });
            notification.on('click', () => {
              mainWindow.show();
              mainWindow.focus();
            });
            notification.show();
          }
        }
    });
    mainWindow.on('close', (event) => {
      if (!shuttingDown && studio.store.state.settings.keepAlive) {
        event.preventDefault();
        mainWindow.hide();
        if (!tray) {
          tray = new Tray(path.join(root, 'electron', 'icon.png'));
          tray.setToolTip('Agent Studio · 后台运行');
          tray.setContextMenu(
            Menu.buildFromTemplate([
              {
                label: '显示工作台',
                click: () => {
                  mainWindow.show();
                  mainWindow.focus();
                },
              },
              { label: '退出并停止任务', click: () => app.quit() },
            ]),
          );
          tray.on('double-click', () => {
            mainWindow.show();
            mainWindow.focus();
          });
        }
      }
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && !url.startsWith(studio.url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(studio.url + '/')) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '工作台',
          submenu: [
            { role: 'reload', label: '刷新界面' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
        { role: 'editMenu', label: '编辑' },
        { role: 'viewMenu', label: '视图' },
      ]),
    );
    await mainWindow.loadURL(studio.launchUrl);
    if (process.env.STUDIO_HEADLESS_TEST) console.log('STUDIO_PAGE_LOADED');
    if (process.env.STUDIO_HEADLESS_TEST) globalThis.__studioTest = studio;
    if (process.env.STUDIO_TEST_READY)
      fs.writeFileSync(
        process.env.STUDIO_TEST_READY,
        JSON.stringify({ url: studio.url, pid: process.pid }),
      );
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
      if (shuttingDown) return;
      event.preventDefault();
      shuttingDown = true;
      for (const w of portalWindows.values()) w.destroy();
      studio.close().finally(() => app.quit());
    });
  })
  .catch((error) => {
    console.error('Agent Studio startup failed:', error);
    if (!process.env.STUDIO_HEADLESS_TEST)
      dialog.showErrorBox('Agent Studio 无法启动', error.message);
    app.exit(1);
  });
