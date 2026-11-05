// Auto-update via GitHub Releases (electron-updater). Only active in the
// installed app; `npm start` (unpackaged) reports status "dev" and does nothing.

const { app } = require('electron');

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function init(send) {
  if (!app.isPackaged) {
    return {
      check: async () => send({ type: 'dev' }),
      install: () => {},
    };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // applies on next quit even if the user ignores the banner

  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ type: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => send({ type: 'none' }));
  autoUpdater.on('download-progress', (p) => send({ type: 'progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send({ type: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => send({ type: 'error', message: String(e?.message || e).slice(0, 200) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // errors arrive via the 'error' event
  setTimeout(check, 5000);
  setInterval(check, FOUR_HOURS);

  return { check, install: () => autoUpdater.quitAndInstall() };
}

module.exports = { init };
