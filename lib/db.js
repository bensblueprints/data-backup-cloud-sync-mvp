const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function nativeBindingPath() {
  // Under Electron the Node-ABI binding won't load; use the vendored Electron prebuild.
  if (!process.versions.electron) return null;
  const p = path.join(__dirname, '..', 'vendor', 'better_sqlite3-electron.node');
  return fs.existsSync(p) ? p : null;
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const nativeBinding = nativeBindingPath();
  const db = new Database(dbPath, nativeBinding ? { nativeBinding } : {});
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,                 -- local | s3
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watched_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      dest_id INTEGER NOT NULL,
      schedule TEXT NOT NULL DEFAULT 'manual',  -- manual | hourly | daily | continuous
      last_backup_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,              -- sha256 of PLAINTEXT content (dedupe key)
      size INTEGER NOT NULL,
      remote_key TEXT NOT NULL,           -- objects/<hash>.sv1
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      rel_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      version INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, -- tombstone marker
      backed_up_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS restore_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL,
      version INTEGER,
      target_path TEXT NOT NULL,
      restored_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_versions_folder_path ON file_versions(folder_id, rel_path, version);
  `);

  return db;
}

function getSetting(db, key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
}

module.exports = { openDb, getSetting, setSetting };
