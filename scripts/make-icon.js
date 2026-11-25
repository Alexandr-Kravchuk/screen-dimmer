// Renders assets/icon.icns (app icon) with Electron offscreen rendering.
// Usage: npx electron scripts/make-icon.js   (macOS only: needs iconutil)
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svg = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 1024 1024">` +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#3a3f5c"/><stop offset="1" stop-color="#14151f"/></linearGradient></defs>' +
  '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>' +
  '<rect x="250" y="300" width="524" height="370" rx="44" fill="none" stroke="#e8eaf6" stroke-width="44"/>' +
  '<line x1="400" y1="760" x2="624" y2="760" stroke="#e8eaf6" stroke-width="44" stroke-linecap="round"/>' +
  '<path d="M540 380 A118 118 0 1 0 650 560 A96 96 0 0 1 540 380 Z" fill="#8ab4ff"/>' +
  '</svg>';

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const set = path.join(os.tmpdir(), 'screen-dimmer.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  // render once at 1024 px, downscale the rest with sips
  const w = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${svg(1024)}</body></html>`;
  await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const master = path.join(set, 'icon_512x512@2x.png');
  fs.writeFileSync(master, img.resize({ width: 1024, height: 1024 }).toPNG());
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const s = base * scale;
      const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`;
      if (s === 1024) continue;
      execFileSync('sips', ['-z', String(s), String(s), master, '--out', path.join(set, name)], { stdio: 'ignore' });
    }
  }
  const out = path.join(__dirname, '..', 'assets', 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', set, '-o', out]);
  console.log('written', out);
  app.quit();
});
