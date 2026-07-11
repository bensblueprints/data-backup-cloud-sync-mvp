// The backup engine: scan → hash → dedupe → encrypt → upload → version → prune.
// Content-addressed: an object's remote key is objects/<sha256>.sv1, so
// identical content is uploaded exactly once no matter how many files or
// versions reference it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { encryptFile, sha256File } = require('./crypto');
const { createAdapter } = require('./destinations');

const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

function scanFolder(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.sv-tmp')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          out.push({ abs: p, rel: path.relative(rootDir, p).split(path.sep).join('/'), size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch { /* file vanished mid-scan */ }
      }
    }
  };
  walk(rootDir);
  return out;
}

/**
 * Run one backup pass for a watched folder.
 * Returns { scanned, uploaded, deduped, unchanged, deleted, bytes_uploaded, pruned }.
 */
async function runBackup(db, folder, passphrase, { keepVersions = 5, onProgress = () => {} } = {}) {
  if (!passphrase) throw new Error('A passphrase is required — backups are always encrypted');
  const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(folder.dest_id);
  if (!dest) throw new Error('Destination not found');
  const adapter = createAdapter(dest);

  const latestStmt = db.prepare(`
    SELECT * FROM file_versions WHERE folder_id = ? AND rel_path = ?
    ORDER BY version DESC LIMIT 1
  `);
  const stats = { scanned: 0, uploaded: 0, deduped: 0, unchanged: 0, deleted: 0, bytes_uploaded: 0, pruned: 0 };
  const files = scanFolder(folder.path);
  stats.scanned = files.length;
  const seen = new Set();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-tmp-'));

  try {
    for (const f of files) {
      seen.add(f.rel);
      onProgress({ phase: 'hash', file: f.rel });
      const latest = latestStmt.get(folder.id, f.rel);

      // fast path: same size+mtime as the last version → unchanged, skip hashing
      if (latest && !latest.deleted && latest.size === f.size && latest.mtime === f.mtime) {
        stats.unchanged++;
        continue;
      }

      const hash = await sha256File(f.abs);
      if (latest && !latest.deleted && latest.hash === hash) {
        // content identical (mtime-only touch) — refresh mtime, no new version
        db.prepare('UPDATE file_versions SET mtime = ? WHERE id = ?').run(f.mtime, latest.id);
        stats.unchanged++;
        continue;
      }

      const remoteKey = `objects/${hash}.sv1`;
      const known = db.prepare('SELECT hash FROM objects WHERE hash = ?').get(hash);
      if (known) {
        stats.deduped++; // content already in the store — no upload needed
      } else {
        onProgress({ phase: 'upload', file: f.rel });
        const tmp = path.join(tmpDir, `${hash}.sv1`);
        await encryptFile(f.abs, tmp, passphrase);
        await adapter.putFile(tmp, remoteKey);
        const encSize = fs.statSync(tmp).size;
        fs.rmSync(tmp, { force: true });
        db.prepare('INSERT INTO objects (hash, size, remote_key, created_at) VALUES (?, ?, ?, ?)')
          .run(hash, f.size, remoteKey, Date.now());
        stats.uploaded++;
        stats.bytes_uploaded += encSize;
      }

      const nextVersion = latest ? latest.version + 1 : 1;
      db.prepare(`
        INSERT INTO file_versions (folder_id, rel_path, hash, size, mtime, version, deleted, backed_up_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(folder.id, f.rel, hash, f.size, f.mtime, nextVersion, Date.now());

      // prune: keep last N non-deleted versions per file
      stats.pruned += pruneVersions(db, adapter, folder.id, f.rel, keepVersions);
    }

    // tombstones for files that disappeared since the last pass
    const livePaths = db.prepare(`
      SELECT rel_path, MAX(version) AS v FROM file_versions WHERE folder_id = ? GROUP BY rel_path
    `).all(folder.id);
    for (const row of livePaths) {
      if (seen.has(row.rel_path)) continue;
      const latest = latestStmt.get(folder.id, row.rel_path);
      if (latest && !latest.deleted) {
        db.prepare(`
          INSERT INTO file_versions (folder_id, rel_path, hash, size, mtime, version, deleted, backed_up_at)
          VALUES (?, ?, ?, 0, 0, ?, 1, ?)
        `).run(folder.id, row.rel_path, latest.hash, latest.version + 1, Date.now());
        stats.deleted++;
      }
    }

    db.prepare('UPDATE watched_folders SET last_backup_at = ? WHERE id = ?').run(Date.now(), folder.id);
    return stats;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Keep the newest `keep` versions of a file; drop older rows and orphaned objects. */
function pruneVersions(db, adapter, folderId, relPath, keep) {
  const rows = db.prepare(`
    SELECT * FROM file_versions WHERE folder_id = ? AND rel_path = ? ORDER BY version DESC
  `).all(folderId, relPath);
  const excess = rows.slice(keep);
  let pruned = 0;
  for (const row of excess) {
    db.prepare('DELETE FROM file_versions WHERE id = ?').run(row.id);
    pruned++;
    // remove the object too if nothing references that content anymore
    const refs = db.prepare('SELECT COUNT(*) AS c FROM file_versions WHERE hash = ?').get(row.hash);
    if (refs.c === 0) {
      const obj = db.prepare('SELECT * FROM objects WHERE hash = ?').get(row.hash);
      if (obj) {
        db.prepare('DELETE FROM objects WHERE hash = ?').run(row.hash);
        adapter.remove(obj.remote_key).catch?.(() => {});
        // adapter.remove returns a promise; swallow network errors (object GC is best-effort)
      }
    }
  }
  return pruned;
}

module.exports = { runBackup, scanFolder, pruneVersions };
