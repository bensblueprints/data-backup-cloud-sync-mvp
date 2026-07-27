// Syncvault — Electron main process: owns the DB, backup engine and scheduler.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');

const { openDb, getSetting, setSetting } = require('../lib/db');
const { runBackup } = require('../lib/backup');
const { treeAsOf, versionsOf, restoreVersion, restoreFolder } = require('../lib/restore');
const { startScheduler, computeNextRun } = require('../lib/scheduler');
const { createAdapter } = require('../lib/destinations');
const { gateLicense, registerLicenseIpc } = require('./license-gate');

let win = null;
let db = null;
let stopScheduler = null;
let sessionPassphrase = ''; // held in memory only — never persisted in plaintext

function passphraseCheckHash(passphrase, saltHex) {
  return crypto.scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32).toString('hex');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function backupFolder(folder) {
  if (!sessionPassphrase) throw new Error('Unlock with your passphrase first');
  const keep = Number(getSetting(db, 'keep_versions', '5')) || 5;
  send('backup:started', { folderId: folder.id });
  try {
    const stats = await runBackup(db, folder, sessionPassphrase, {
      keepVersions: keep,
      onProgress: (p) => send('backup:progress', { folderId: folder.id, ...p })
    });
    send('backup:done', { folderId: folder.id, stats });
    return stats;
  } catch (e) {
    send('backup:error', { folderId: folder.id, error: e.message });
    throw e;
  }
}

app.whenReady().then(async () => {
  if (!(await gateLicense())) return; // quit already requested
  registerLicenseIpc();

  db = openDb(path.join(app.getPath('userData'), 'data', 'syncvault.db'));

  stopScheduler = startScheduler(db, (folder) => {
    if (!sessionPassphrase) return; // locked — skip scheduled runs
    return backupFolder(folder);
  });

  win = new BrowserWindow({
    width: 1200,
    height: 820,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    title: 'Syncvault',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  app.on('window-all-closed', () => {
    if (stopScheduler) stopScheduler();
    app.quit();
  });
});

/* ── passphrase / lock ─────────────────────────────────────────────────────── */
ipcMain.handle('vault:status', () => {
  const salt = getSetting(db, 'pp_salt', '');
  return { initialized: !!salt, unlocked: !!sessionPassphrase };
});

ipcMain.handle('vault:setup', (e, passphrase) => {
  if (getSetting(db, 'pp_salt', '')) throw new Error('Already initialized');
  if (!passphrase || passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting(db, 'pp_salt', salt);
  setSetting(db, 'pp_check', passphraseCheckHash(passphrase, salt));
  sessionPassphrase = passphrase;
  return { ok: true };
});

ipcMain.handle('vault:unlock', (e, passphrase) => {
  const salt = getSetting(db, 'pp_salt', '');
  if (!salt) throw new Error('Not initialized');
  if (passphraseCheckHash(passphrase, salt) !== getSetting(db, 'pp_check', '')) {
    throw new Error('Wrong passphrase');
  }
  sessionPassphrase = passphrase;
  return { ok: true };
});

ipcMain.handle('vault:lock', () => { sessionPassphrase = ''; return { ok: true }; });

/* ── destinations ──────────────────────────────────────────────────────────── */
ipcMain.handle('dest:list', () => db.prepare('SELECT * FROM destinations ORDER BY id').all());

ipcMain.handle('dest:create', (e, { name, type, config }) => {
  if (!['local', 's3'].includes(type)) throw new Error('type must be local or s3');
  const info = db.prepare('INSERT INTO destinations (name, type, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(String(name || type), type, JSON.stringify(config || {}), Date.now());
  return db.prepare('SELECT * FROM destinations WHERE id = ?').get(info.lastInsertRowid);
});

ipcMain.handle('dest:test', async (e, id) => {
  const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(id);
  if (!dest) throw new Error('not found');
  return createAdapter(dest).test();
});

ipcMain.handle('dest:delete', (e, id) => {
  const used = db.prepare('SELECT COUNT(*) AS c FROM watched_folders WHERE dest_id = ?').get(id);
  if (used.c) throw new Error('Destination is in use by a watched folder');
  db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
  return { ok: true };
});

/* ── watched folders ───────────────────────────────────────────────────────── */
ipcMain.handle('folder:list', () => {
  return db.prepare(`
    SELECT wf.*, d.name AS dest_name, d.type AS dest_type,
      (SELECT COUNT(DISTINCT rel_path) FROM file_versions WHERE folder_id = wf.id AND deleted = 0) AS file_count
    FROM watched_folders wf JOIN destinations d ON d.id = wf.dest_id ORDER BY wf.id
  `).all().map((f) => ({ ...f, next_run: computeNextRun(f.schedule, f.last_backup_at) }));
});

ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('folder:add', (e, { path: folderPath, dest_id, schedule }) => {
  const fs = require('fs');
  if (!folderPath || !fs.existsSync(folderPath)) throw new Error('Folder does not exist');
  const info = db.prepare('INSERT INTO watched_folders (path, dest_id, schedule, created_at) VALUES (?, ?, ?, ?)')
    .run(folderPath, Number(dest_id), ['manual', 'continuous', 'hourly', 'daily'].includes(schedule) ? schedule : 'manual', Date.now());
  return db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(info.lastInsertRowid);
});

ipcMain.handle('folder:update', (e, { id, schedule }) => {
  db.prepare('UPDATE watched_folders SET schedule = ? WHERE id = ?')
    .run(['manual', 'continuous', 'hourly', 'daily'].includes(schedule) ? schedule : 'manual', id);
  return { ok: true };
});

ipcMain.handle('folder:remove', (e, id) => {
  db.prepare('DELETE FROM watched_folders WHERE id = ?').run(id);
  return { ok: true };
});

ipcMain.handle('folder:backup', async (e, id) => {
  const folder = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id);
  if (!folder) throw new Error('not found');
  return backupFolder(folder);
});

/* ── browse + restore ──────────────────────────────────────────────────────── */
ipcMain.handle('restore:tree', (e, { folderId, asOf }) => treeAsOf(db, folderId, asOf || Date.now()));
ipcMain.handle('restore:versions', (e, { folderId, relPath }) => versionsOf(db, folderId, relPath));

ipcMain.handle('restore:file', async (e, { versionId }) => {
  if (!sessionPassphrase) throw new Error('Unlock first');
  const v = db.prepare('SELECT * FROM file_versions WHERE id = ?').get(versionId);
  const r = await dialog.showSaveDialog(win, { defaultPath: v ? v.rel_path.split('/').pop() : 'restored-file' });
  if (r.canceled) return null;
  return restoreVersion(db, versionId, r.filePath, sessionPassphrase);
});

ipcMain.handle('restore:folder', async (e, { folderId, asOf }) => {
  if (!sessionPassphrase) throw new Error('Unlock first');
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Restore into…' });
  if (r.canceled) return null;
  return restoreFolder(db, folderId, r.filePaths[0], sessionPassphrase, asOf || Date.now());
});

/* ── settings ──────────────────────────────────────────────────────────────── */
ipcMain.handle('settings:get', () => ({
  keep_versions: Number(getSetting(db, 'keep_versions', '5')) || 5
}));
ipcMain.handle('settings:set', (e, { keep_versions }) => {
  const n = Math.max(1, Math.min(100, Number(keep_versions) || 5));
  setSetting(db, 'keep_versions', String(n));
  return { ok: true, keep_versions: n };
});
