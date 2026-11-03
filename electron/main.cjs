const { app, BrowserWindow, session, shell, dialog, ipcMain, screen, desktopCapturer, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { MeetingDetector } = require('./detection.cjs');
let runtime, origin, mainWindow, chickenWindow, detector;
let quitting = false;
const webPreferences = () => ({ nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') });
const localPage = (url, route) => { try { const u = new URL(url); return u.origin === origin && (!route || u.pathname === route); } catch { return false; } };
function configureWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || localPage(url, '/bridge')) return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 780, title: 'Quicken audio', backgroundColor: '#ffffff', webPreferences: webPreferences() } };
    if (localPage(url, '/popup')) { void showChicken(); return { action: 'deny' }; }
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => { if (!localPage(url)) event.preventDefault(); });
  win.webContents.on('did-create-window', configureWindow);
}
async function showChicken() {
  if (chickenWindow && !chickenWindow.isDestroyed()) { chickenWindow.showInactive(); return; }
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  chickenWindow = new BrowserWindow({ x: x + width - 370, y: y + height - 460, width: 350, height: 440, frame: false, transparent: true, hasShadow: false, alwaysOnTop: true, resizable: false, skipTaskbar: true, title: 'Quicken chicken', show: false, webPreferences: webPreferences() });
  chickenWindow.setAlwaysOnTop(true, 'floating');
  chickenWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  configureWindow(chickenWindow);
  await chickenWindow.loadURL(`${origin}/popup#access=${runtime.store.accessToken}`);
  chickenWindow.showInactive();
}
async function start() {
  const base = app.getAppPath();
  require('dotenv').config({ path: path.join(base, '.env'), quiet: true });
  app.setName('Quicken');
  process.env.QUICKEN_NATIVE_DIR = app.isPackaged ? process.resourcesPath : path.join(base, 'native/bin');
  const { createApplication } = await import(path.join(base, 'dist-server/server/app.js'));
  runtime = createApplication({ dataDir: process.env.QUICKEN_DATA_DIR || (app.isPackaged ? path.join(app.getPath('userData'), 'workspace') : path.join(base, '.quicken')), staticDir: path.join(base, 'dist') });
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(4317, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:4317';
  const allowed = (contents, permission) => ['media', 'display-capture', 'speaker-selection'].includes(permission) && !!contents && localPage(contents.getURL(), '/bridge');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.userGesture || !request.frame || !localPage(request.frame.url, '/bridge')) return callback(null);
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback(sources[0] ? { video: sources[0], audio: 'loopback' } : null);
    } catch { callback(null); }
  });
  ipcMain.on('quicken:main', (event, target) => {
    if (!localPage(event.sender.getURL(), '/') && !localPage(event.sender.getURL(), '/popup')) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
    const navigation = {};
    if (target?.view === 'connections') navigation.view = 'connections';
    if (typeof target?.meetingId === 'string' && runtime.store.records.has(target.meetingId)) navigation.meetingId = target.meetingId;
    mainWindow.webContents.send('quicken:navigate', navigation);
  });
  ipcMain.on('quicken:expand-chicken', (event, expanded) => {
    if (event.sender !== chickenWindow?.webContents || typeof expanded !== 'boolean') return;
    const bounds = chickenWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(expanded ? 380 : 350, area.width);
    const height = Math.min(expanded ? 580 : 440, area.height);
    const x = Math.max(area.x, Math.min(bounds.x + bounds.width - width, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(bounds.y + bounds.height - height, area.y + area.height - height));
    chickenWindow.setBounds({ x, y, width, height });
  });
  ipcMain.on('quicken:chicken', event => { if (localPage(event.sender.getURL())) void showChicken(); });
  ipcMain.on('quicken:hide-chicken', event => { if (event.sender === chickenWindow?.webContents) chickenWindow.hide(); });
  const detectorPreference = path.join(app.getPath('userData'),'meeting-hints.json');
  let detectionEnabled = true;
  try { detectionEnabled = JSON.parse(fs.readFileSync(detectorPreference,'utf8')).enabled !== false; } catch { /* First launch uses activity hints. */ }
  let lastHintAt = 0;
  detector = new MeetingDetector(app.isPackaged ? path.join(process.resourcesPath,'quicken-audio-activity') : path.join(base,'native/bin/quicken-audio-activity'), state => {
    for(const win of BrowserWindow.getAllWindows()) if(localPage(win.webContents.getURL(),'/') || localPage(win.webContents.getURL(),'/popup')) win.webContents.send('quicken:detection',state);
    if(state.apps.length && Date.now()-lastHintAt>600_000 && ![...runtime.store.records.values()].some(r=>['live','joining','ending'].includes(r.meeting.status))) { lastHintAt=Date.now();void showChicken(); }
  });
  const ownerWindow = event => localPage(event.sender.getURL(),'/') || localPage(event.sender.getURL(),'/popup');
  const setDetection = enabled => {
    detectionEnabled=enabled;fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.writeFileSync(detectorPreference,JSON.stringify({enabled}),{mode:0o600});
    detector.setEnabled(enabled);const item=Menu.getApplicationMenu()?.getMenuItemById('detection');if(item)item.checked=enabled;
  };
  ipcMain.handle('quicken:get-detection',event=>ownerWindow(event)?detector.state:{enabled:false,apps:[]});
  ipcMain.on('quicken:set-detection',(event,enabled)=>{if(ownerWindow(event)&&typeof enabled==='boolean')setDetection(enabled);});
  mainWindow = new BrowserWindow({ width: 1380, height: 960, minWidth: 760, minHeight: 640, title: 'Quicken', backgroundColor: '#ffffff', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 15 }, webPreferences: webPreferences() });
  configureWindow(mainWindow);
  mainWindow.on('close', () => { if (!quitting) app.quit(); });
  app.dock?.setIcon(path.join(base, 'dist/chicken.png'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Quicken', submenu: [{ role: 'about' }, { label: 'Show chicken', click: () => void showChicken() }, { id:'detection',label:'Suggest meetings from microphone activity',type:'checkbox',checked:detectionEnabled,click:item=>setDetection(item.checked) }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  await mainWindow.loadURL(`${origin}/#access=${runtime.store.accessToken}`);
  await showChicken();
  void runtime.warmLocal().catch(() => {});
  detector.setEnabled(detectionEnabled);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('Quicken could not start', error.code === 'EADDRINUSE' ? 'Port 4317 is already in use. Stop the terminal server before opening Quicken.' : error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !runtime) return;
    event.preventDefault(); quitting = true; detector?.stop();
    void runtime.endActive().finally(() => runtime.close()).finally(() => app.quit());
  });
}
