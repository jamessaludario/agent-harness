// Renders src/assets/icon.svg to PNGs and packs build/icon.ico.
// Run with:  npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'src', 'assets', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

let master;
// Windows won't make tiny windows, so render once at 512 and downscale.
async function renderMaster() {
  const size = 512;
  const win = new BrowserWindow({ show: false, width: size, height: size, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = '<html><body style="margin:0;background:transparent">' + svg.replace('width="256" height="256"', 'width="512" height="512"') + '</body></html>';
  const tmp = path.join(require('node:os').tmpdir(), 'rubick-icon.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 300));
  master = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
}
const render = async (size) => (size === 512 ? master : master.resize({ width: size, height: size, quality: 'best' })).toPNG();

function packIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = entries.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    await renderMaster();
    const entries = [];
    for (const size of ICO_SIZES) entries.push({ size, png: await render(size) });
    fs.writeFileSync(path.join(root, 'build', 'icon.ico'), packIco(entries));
    fs.writeFileSync(path.join(root, 'src', 'assets', 'icon.png'), await render(512));
    console.log('icons written');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
