// Restore: browse the backed-up tree as of any point in time, pull objects,
// decrypt, write. Wrong passphrase fails loudly (GCM auth), never corrupts.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decryptFile } = require('./crypto');
const { createAdapter } = require('./destinations');

/**
 * The file tree of a folder as of `asOf` (epoch ms, default now):
 * for each rel_path, the newest version with backed_up_at <= asOf.
 * Tombstoned (deleted) entries are excluded.
 */
function treeAsOf(db, folderId, asOf = Date.now()) {
  const rows = db.prepare(`
    SELECT fv.* FROM file_versions fv
    JOIN (
      SELECT rel_path, MAX(version) AS v FROM file_versions
      WHERE folder_id = ? AND backed_up_at <= ?
      GROUP BY rel_path
    ) latest ON latest.rel_path = fv.rel_path AND latest.v = fv.version
    WHERE fv.folder_id = ?
    ORDER BY fv.rel_path
  `).all(folderId, asOf, folderId);
  return rows.filter((r) => !r.deleted);
}

function versionsOf(db, folderId, relPath) {
  return db.prepare(`
    SELECT * FROM file_versions WHERE folder_id = ? AND rel_path = ? ORDER BY version DESC
  `).all(folderId, relPath);
}

/** Restore one specific file version to targetPath. */
async function restoreVersion(db, versionId, targetPath, passphrase) {
  const v = db.prepare('SELECT * FROM file_versions WHERE id = ?').get(versionId);
  if (!v) throw new Error('Version not found');
  if (v.deleted) throw new Error('This version is a deletion marker');
  const folder = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(v.folder_id);
  const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(folder.dest_id);
  const obj = db.prepare('SELECT * FROM objects WHERE hash = ?').get(v.hash);
  if (!obj) throw new Error('Backing object no longer exists (pruned?)');
  const adapter = createAdapter(dest);

  const tmp = path.join(os.tmpdir(), `sv-restore-${process.pid}-${Date.now()}.sv1`);
  try {
    await adapter.downloadTo(obj.remote_key, tmp);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await decryptFile(tmp, targetPath, passphrase);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  db.prepare('INSERT INTO restore_log (rel_path, version, target_path, restored_at) VALUES (?, ?, ?, ?)')
    .run(v.rel_path, v.version, targetPath, Date.now());
  return { rel_path: v.rel_path, version: v.version, target: targetPath };
}

/** Restore a whole folder as of a point in time into targetDir. */
async function restoreFolder(db, folderId, targetDir, passphrase, asOf = Date.now()) {
  const tree = treeAsOf(db, folderId, asOf);
  const results = [];
  for (const v of tree) {
    const target = path.join(targetDir, v.rel_path.replace(/\//g, path.sep));
    results.push(await restoreVersion(db, v.id, target, passphrase));
  }
  return results;
}

module.exports = { treeAsOf, versionsOf, restoreVersion, restoreFolder };
