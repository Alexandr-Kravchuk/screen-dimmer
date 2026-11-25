const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName('Screen Dimmer');

  // Three windows instead of one, so the interactive parts NEVER toggle
  // between click-through and interactive (that toggle races on macOS and
  // lets every other click fall through to the app underneath):
  //   dimWin  - the dark overlay, ALWAYS click-through
  //   barWin  - the control bar, ALWAYS interactive
  //   gripWin - the resize handle, ALWAYS interactive
  const BAR_H = 42;
  const GRIP = 24;
  const MIN_W = 480;
  const MIN_H = 80;

  const STATE_FILE = path.join(app.getPath('userData'), 'dimmer-state.json');

  let dimWin, barWin, gripWin;
  let tray = null;
  let saveTimer = null;
  let layoutLock = false;
  let master = null; // dim rectangle {x, y, w, h}

  const defaultState = () => ({ opacity: 0.6, passthrough: false, full: false });

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const s = { ...defaultState(), ...raw };
      // pass-through makes the bar unclickable; never start in that mode
      s.passthrough = false;
      delete s.clickThrough;
      delete s.blur; // removed feature
      return s;
    } catch {
      return defaultState();
    }
  }

  let state = loadState();

  function saveStateDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStateNow, 400);
  }

  function saveStateNow() {
    try {
      if (master) state.bounds = { x: master.x, y: master.y, width: master.w, height: master.h };
      const { passthrough, ...persisted } = state;
      fs.writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }

  // ---------- layout ----------

  function sanitizeBounds(b) {
    if (!b || !b.width || !b.height) return null;
    const { x, y, width: w, height: h } = b;
    const display = screen.getAllDisplays().find(
      (d) =>
        x < d.bounds.x + d.bounds.width &&
        x + w > d.bounds.x &&
        y < d.bounds.y + d.bounds.height &&
        y + h > d.bounds.y
    );
    return display ? { x, y, w, h } : null;
  }

  function defaultBounds() {
    const p = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(p).workArea;
    const w = Math.min(560, Math.round(wa.width * 0.6));
    const h = Math.min(360, Math.round(wa.height * 0.6));
    return {
      x: Math.round(wa.x + (wa.width - w) / 2),
      y: Math.round(wa.y + (wa.height - h) / 2),
      w,
      h,
    };
  }

  // display the overlay lives on (by the centre of its normal rectangle)
  function currentDisplay() {
    return screen.getDisplayNearestPoint({
      x: Math.round(master.x + master.w / 2),
      y: Math.round(master.y + master.h / 2),
    });
  }

  function layout() {
    if (!dimWin || !barWin || !gripWin) return;
    layoutLock = true;
    try {
      if (state.full) {
        // dim the whole display below the menu bar (macOS won't place a
        // window over it anyway), Dock included - the dim layer is
        // click-through, so the Dock stays usable. `master` keeps the normal
        // rectangle to come back to.
        const d = currentDisplay();
        const top = d.workArea.y;
        dimWin.setBounds({
          x: d.bounds.x,
          y: top,
          width: d.bounds.width,
          height: d.bounds.y + d.bounds.height - top,
        });
        barWin.setBounds({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: BAR_H });
        if (gripWin.isVisible()) gripWin.hide();
        return;
      }
      if (dimWin.isVisible() && !gripWin.isVisible()) gripWin.showInactive();
      dimWin.setBounds({ x: master.x, y: master.y, width: master.w, height: master.h });
      barWin.setBounds({ x: master.x, y: master.y, width: master.w, height: BAR_H });
      gripWin.setBounds({
        x: master.x + master.w - GRIP,
        y: master.y + master.h - GRIP,
        width: GRIP,
        height: GRIP,
      });
    } finally {
      layoutLock = false;
    }
  }

  // ---------- windows ----------

  function makeWindow(opts) {
    const w = new BrowserWindow({
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // the app is never active (tray-only, windows shown inactive); without
      // this macOS spends the first click on activating the window
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
      ...opts,
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    return w;
  }

  function createWindows() {
    master = sanitizeBounds(state.bounds) || defaultBounds();

    dimWin = makeWindow({ x: master.x, y: master.y, width: master.w, height: master.h, movable: false, title: 'Screen Dimmer' });
    // bar & grip are child windows of the dim layer: macOS moves children
    // together with the parent atomically, so nothing lags behind on drag
    barWin = makeWindow({
      parent: dimWin,
      x: master.x, y: master.y, width: master.w, height: BAR_H,
      movable: false, title: 'Screen Dimmer',
    });
    gripWin = makeWindow({
      parent: dimWin,
      x: master.x + master.w - GRIP,
      y: master.y + master.h - GRIP,
      width: GRIP, height: GRIP,
      movable: false, title: 'Screen Dimmer',
    });

    // the dim layer never takes the mouse
    dimWin.setIgnoreMouseEvents(true, { forward: true });

    dimWin.loadFile('dim.html');
    barWin.loadFile('bar.html');
    gripWin.loadFile('grip.html');

    const ready = [dimWin, barWin, gripWin].map(
      (w) => new Promise((res) => w.once('ready-to-show', res))
    );
    Promise.all(ready).then(() => {
      dimWin.showInactive();
      barWin.showInactive();
      if (!state.full) gripWin.showInactive();
      // keep stacking: dim at the bottom, bar & grip above it
      barWin.moveTop();
      gripWin.moveTop();
      layout();
      applyPassthrough();
      applyToAll();
    });

    for (const w of [dimWin, barWin, gripWin]) {
      w.on('moved', saveStateDebounced);
      w.on('resized', saveStateDebounced);
      w.on('close', saveStateNow);
    }
  }

  // ---------- state ----------

  function applyPassthrough() {
    if (barWin && !barWin.isDestroyed())
      barWin.setIgnoreMouseEvents(!!state.passthrough, { forward: true });
    if (gripWin && !gripWin.isDestroyed())
      gripWin.setIgnoreMouseEvents(!!state.passthrough, { forward: true });
  }

  function applyToAll() {
    for (const w of [dimWin, barWin]) {
      if (w && !w.isDestroyed()) w.webContents.send('apply', state);
    }
  }

  function sanitizePatch(patch) {
    const out = {};
    if (!patch || typeof patch !== 'object') return out;
    if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity))
      out.opacity = Math.min(0.95, Math.max(0.05, patch.opacity));
    if ('passthrough' in patch) out.passthrough = !!patch.passthrough;
    if ('full' in patch) out.full = !!patch.full;
    return out;
  }

  function updateState(patch) {
    const wasFull = state.full;
    Object.assign(state, sanitizePatch(patch));
    if (state.full !== wasFull) layout();
    applyPassthrough();
    applyToAll();
    refreshTray();
    saveStateDebounced();
  }

  function hideAll() {
    for (const w of [dimWin, barWin, gripWin]) if (w && !w.isDestroyed()) w.hide();
    refreshTray();
  }

  function showAll() {
    if (!dimWin || dimWin.isDestroyed()) return;
    dimWin.showInactive();
    barWin.showInactive();
    if (!state.full) gripWin.showInactive();
    barWin.moveTop();
    gripWin.moveTop();
    layout();
    refreshTray();
  }

  function toggleVisibility() {
    if (!dimWin || dimWin.isDestroyed()) return;
    if (dimWin.isVisible()) hideAll();
    else showAll();
  }

  // keep the overlay reachable after a monitor is unplugged / rearranged
  function ensureOnScreen() {
    if (!master) return;
    const ok = sanitizeBounds({ x: master.x, y: master.y, width: master.w, height: master.h });
    master = ok || defaultBounds();
    layout();
    saveStateDebounced();
  }

  function resetBounds() {
    if (!master) return;
    state.full = false;
    applyToAll();
    refreshTray();
    master = defaultBounds();
    layout();
    saveStateDebounced();
  }

  // ---------- tray ----------

  function trayIcon() {
    // nativeImage can't decode SVG, so the icons ship as PNG (@2x is picked up
    // automatically). macOS: a black template image the menu bar tints for
    // light/dark. Windows/Linux: a colored icon, visible on any taskbar.
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
      img.setTemplateImage(true);
      return img;
    }
    return nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayColor.png'));
  }

  const modLabel = process.platform === 'darwin' ? '⌘' : 'Ctrl';

  function menuTemplate() {
    const p = Math.round(state.opacity * 100);
    return [
      { label: 'Screen Dimmer', enabled: false },
      {
        label: 'Opacity',
        submenu: [20, 40, 60, 80, 95].map((v) => ({
          label: `${v}%`,
          type: 'radio',
          checked: p === v,
          click: () => updateState({ opacity: v / 100 }),
        })),
      },
      { type: 'separator' },
      {
        label: 'Pass-through everything (incl. bar)',
        type: 'checkbox',
        checked: !!state.passthrough,
        click: (mi) => updateState({ passthrough: mi.checked }),
      },
      {
        label: `Full screen  (${modLabel}⇧F)`,
        type: 'checkbox',
        checked: !!state.full,
        click: (mi) => updateState({ full: mi.checked }),
      },
      { type: 'separator' },
      { label: 'Reset position & size', click: resetBounds },
      {
        label: isShown()
          ? `Hide  (${modLabel}⇧D)`
          : `Show  (${modLabel}⇧D)`,
        click: toggleVisibility,
      },
      {
        label: `Toggle pass-through  (${modLabel}⇧P)`,
        click: () => updateState({ passthrough: !state.passthrough }),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { saveStateNow(); app.quit(); } },
    ];
  }

  function isShown() {
    return !!(dimWin && !dimWin.isDestroyed() && dimWin.isVisible());
  }

  function refreshTray() {
    if (!tray) return;
    tray.setToolTip(`Screen Dimmer — ${isShown() ? 'click to hide' : 'click to show'}`);
  }

  function createTray() {
    tray = new Tray(trayIcon());
    // left click = show/hide, right click (or Ctrl+click) = menu.
    // No setContextMenu(): on macOS it would swallow the left click.
    tray.on('click', (e) => {
      if (e.ctrlKey) tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate()));
      else toggleVisibility();
    });
    tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate())));
    refreshTray();
  }

  // ---------- ipc ----------

  ipcMain.handle('get-state', () => state);
  ipcMain.handle('get-rect', () => master);

  ipcMain.on('update', (_e, patch) => updateState(patch));

  // drag of the bar, driven by the renderer (no native app-region drag:
  // that moves only the bar and the rest catches up a frame later)
  ipcMain.on('move-to', (_e, x, y) => {
    if (!master || state.full || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const next = { x: Math.round(x), y: Math.round(y), width: master.w, height: master.h };
    if (next.x === master.x && next.y === master.y) return;
    if (!sanitizeBounds(next)) return;
    master.x = next.x;
    master.y = next.y;
    if (dimWin && !dimWin.isDestroyed()) {
      layoutLock = true;
      try { dimWin.setPosition(master.x, master.y); } finally { layoutLock = false; }
    }
    saveStateDebounced();
  });

  ipcMain.on('drag-end', () => { if (master) layout(); });

  ipcMain.on('nudge', (_e, dx, dy) => {
    if (!master || state.full) return;
    const next = { x: master.x + Math.round(dx), y: master.y + Math.round(dy), width: master.w, height: master.h };
    if (!sanitizeBounds(next)) return; // don't push it off every screen
    master.x = next.x;
    master.y = next.y;
    layout();
    saveStateDebounced();
  });

  ipcMain.on('resize-to', (_e, w, h) => {
    if (!master || state.full) return;
    const wa = screen
      .getDisplayNearestPoint({ x: master.x + master.w / 2, y: master.y + master.h / 2 })
      .workArea;
    w = Math.max(MIN_W, Math.min(Math.round(w), wa.width));
    h = Math.max(MIN_H, Math.min(Math.round(h), wa.height));
    let x = master.x;
    let y = master.y;
    if (x + w > wa.x + wa.width) x = wa.x + wa.width - w;
    if (y + h > wa.y + wa.height) y = wa.y + wa.height - h;
    if (x < wa.x) x = wa.x;
    if (y < wa.y) y = wa.y;
    master = { x, y, w, h };
    layout();
    saveStateDebounced();
  });

  ipcMain.on('hide', () => { if (dimWin && !dimWin.isDestroyed()) hideAll(); });
  ipcMain.on('quit', () => { saveStateNow(); app.quit(); });

  // ---------- lifecycle ----------

  app.whenReady().then(() => {
    // tray utility: no Dock icon on macOS
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    createWindows();
    createTray();

    globalShortcut.register('CommandOrControl+Shift+D', toggleVisibility);
    globalShortcut.register('CommandOrControl+Shift+F', () =>
      updateState({ full: !state.full })
    );
    globalShortcut.register('CommandOrControl+Shift+P', () =>
      updateState({ passthrough: !state.passthrough })
    );

    screen.on('display-removed', ensureOnScreen);
    screen.on('display-metrics-changed', ensureOnScreen);

    app.on('activate', () => {
      if (!dimWin || dimWin.isDestroyed()) createWindows();
      else showAll();
    });
  });

  app.on('second-instance', () => {
    if (dimWin && !dimWin.isDestroyed()) showAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    clearTimeout(saveTimer);
    saveStateNow();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
