// Syncvault smoke test — exercises the REAL backup engine end-to-end under
// plain Node (no Electron GUI needed):
//   • encryption at rest: raw archive bytes scanned for plaintext markers
//   • versioning + point-in-time restore
//   • content-hash dedupe (identical content uploaded once)
//   • prune to N versions
//   • local + S3-compatible destinations (S3 mocked by a local fixture server)
//   • wrong passphrase → loud GCM failure
//   • schedule math
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const { openDb } = require('../lib/db');
const { runBackup } = require('../lib/backup');
const { treeAsOf, versionsOf, restoreVersion, restoreFolder } = require('../lib/restore');
const { computeNextRun, isDue } = require('../lib/scheduler');
const { encryptFile, decryptFile, SV1_MAGIC } = require('../lib/crypto');
const { createS3Mock } = require('./s3-mock');

const S3_PORT = 6473; // offset port — other build agents run concurrently
const MARKER = 'SYNCVAULT_SECRET_PLAINTEXT_MARKER_e6a1b2c3'; // must never appear in stored archives
const PASS = 'correct horse battery staple';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-smoke-'));
const srcDir = path.join(work, 'source');
const destDir = path.join(work, 'dest-local');
const restoreDir = path.join(work, 'restored');
const dbPath = path.join(work, 'index.db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeFixtures() {
  fs.mkdirSync(path.join(srcDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'notes.txt'), `Top secret notes.\n${MARKER}\nline 3\n`);
  fs.writeFileSync(path.join(srcDir, 'docs', 'report.md'), `# Report\n${MARKER} appears here too.\n`);
  // two identical files → dedupe must upload the content once
  fs.writeFileSync(path.join(srcDir, 'copy-a.bin'), `identical-content ${MARKER}`);
  fs.writeFileSync(path.join(srcDir, 'copy-b.bin'), `identical-content ${MARKER}`);
}

function scanDirForMarker(dir) {
  let found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes(MARKER)) found.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

async function main() {
  console.log('1. Fixtures + DB + local destination');
  writeFixtures();
  const db = openDb(dbPath);
  const destInfo = db.prepare("INSERT INTO destinations (name, type, config_json, created_at) VALUES ('local', 'local', ?, ?)")
    .run(JSON.stringify({ path: destDir }), Date.now());
  const folderInfo = db.prepare("INSERT INTO watched_folders (path, dest_id, schedule, created_at) VALUES (?, ?, 'manual', ?)")
    .run(srcDir, destInfo.lastInsertRowid, Date.now());
  const folder = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(folderInfo.lastInsertRowid);

  console.log('2. Backup #1 → runs, versions land, dedupe works');
  const s1 = await runBackup(db, folder, PASS, { keepVersions: 2 });
  assert.strictEqual(s1.scanned, 4, 'must scan 4 files');
  // 4 files but copy-a/copy-b share content → exactly 3 uploads, 1 dedupe
  assert.strictEqual(s1.uploaded, 3, `exactly 3 unique objects uploaded (got ${s1.uploaded})`);
  assert.strictEqual(s1.deduped, 1, 'identical file must dedupe (0 bytes re-uploaded)');
  const objCount = db.prepare('SELECT COUNT(*) c FROM objects').get().c;
  assert.strictEqual(objCount, 3, 'objects table must hold exactly 3 content hashes');

  console.log('3. ENCRYPTION AT REST: raw archive bytes contain no plaintext marker');
  const leaks = scanDirForMarker(destDir);
  assert.strictEqual(leaks.length, 0, `plaintext marker leaked into stored archives: ${leaks.join(', ')}`);
  // and every stored object is a valid SV1 container
  const objectsDir = path.join(destDir, 'objects');
  const objFiles = fs.readdirSync(objectsDir);
  assert.strictEqual(objFiles.length, 3, '3 encrypted objects on disk');
  for (const f of objFiles) {
    const head = fs.readFileSync(path.join(objectsDir, f)).subarray(0, 3);
    assert.ok(head.equals(SV1_MAGIC), `${f} must start with SV1 magic`);
  }
  console.log('   0 plaintext leaks across', objFiles.length, 'encrypted objects ✓');

  console.log('4. Restore round-trip: decrypted content matches byte-for-byte');
  const tree1 = treeAsOf(db, folder.id);
  assert.strictEqual(tree1.length, 4, 'tree shows all 4 files');
  const notesV1 = tree1.find((v) => v.rel_path === 'notes.txt');
  const r1 = await restoreVersion(db, notesV1.id, path.join(restoreDir, 'notes-v1.txt'), PASS);
  assert.ok(r1.target.endsWith('notes-v1.txt'));
  assert.strictEqual(
    fs.readFileSync(path.join(restoreDir, 'notes-v1.txt'), 'utf8'),
    `Top secret notes.\n${MARKER}\nline 3\n`,
    'restored content must match original exactly'
  );

  console.log('5. Wrong passphrase → loud GCM auth failure, no silent garbage');
  await assert.rejects(
    restoreVersion(db, notesV1.id, path.join(restoreDir, 'should-not-exist.txt'), 'wrong-passphrase'),
    /Unsupported state or unable to authenticate/i,
    'wrong passphrase must throw a GCM auth error'
  );

  console.log('6. Versioning: modify → backup #2 → 2 versions, v1 still restorable');
  await sleep(20);
  const t_between = Date.now();
  await sleep(20);
  fs.writeFileSync(path.join(srcDir, 'notes.txt'), 'Completely new content v2.\n');
  const s2 = await runBackup(db, folder, PASS, { keepVersions: 2 });
  assert.strictEqual(s2.uploaded, 1, 'only the changed file uploads');
  assert.strictEqual(s2.unchanged, 3, 'unchanged files skipped');
  const vers = versionsOf(db, folder.id, 'notes.txt');
  assert.strictEqual(vers.length, 2, 'notes.txt must have exactly 2 versions');
  assert.deepStrictEqual(vers.map((v) => v.version), [2, 1]);
  // point-in-time browse: as of t_between the tree still shows v1 content hash
  const treeThen = treeAsOf(db, folder.id, t_between);
  assert.strictEqual(treeThen.find((v) => v.rel_path === 'notes.txt').version, 1, 'as-of browse must return v1');
  // restore v2 and v1 and check both contents
  await restoreVersion(db, vers[0].id, path.join(restoreDir, 'notes-v2.txt'), PASS);
  assert.strictEqual(fs.readFileSync(path.join(restoreDir, 'notes-v2.txt'), 'utf8'), 'Completely new content v2.\n');
  await restoreVersion(db, vers[1].id, path.join(restoreDir, 'notes-v1-again.txt'), PASS);
  assert.ok(fs.readFileSync(path.join(restoreDir, 'notes-v1-again.txt'), 'utf8').includes(MARKER), 'v1 restore must return the ORIGINAL content');

  console.log('7. Incremental no-op: backup #3 with no changes uploads nothing');
  const s3 = await runBackup(db, folder, PASS, { keepVersions: 2 });
  assert.strictEqual(s3.uploaded, 0, 'no-change backup must upload 0 objects');
  assert.strictEqual(s3.bytes_uploaded, 0, 'no-change backup must send 0 bytes');

  console.log('8. Prune: keepVersions=2 → a third change drops v1 and its orphaned object');
  fs.writeFileSync(path.join(srcDir, 'notes.txt'), 'v3 content — prune should kick in.\n');
  const s4 = await runBackup(db, folder, PASS, { keepVersions: 2 });
  assert.strictEqual(s4.pruned, 1, 'one old version pruned');
  const versAfter = versionsOf(db, folder.id, 'notes.txt');
  assert.deepStrictEqual(versAfter.map((v) => v.version), [3, 2], 'only v3 and v2 remain');
  await sleep(150); // best-effort remote GC
  const v1ObjGone = !db.prepare('SELECT 1 FROM objects WHERE hash = ?').get(vers[1].hash);
  assert.ok(v1ObjGone, 'orphaned v1 object must be dropped from the index');

  console.log('9. Deletion tombstones: removed file disappears from the current tree');
  fs.rmSync(path.join(srcDir, 'docs', 'report.md'));
  const s5 = await runBackup(db, folder, PASS, { keepVersions: 2 });
  assert.strictEqual(s5.deleted, 1, 'one deletion tombstone recorded');
  const treeNow = treeAsOf(db, folder.id);
  assert.ok(!treeNow.some((v) => v.rel_path === 'docs/report.md'), 'deleted file must not appear in current tree');

  console.log('10. S3-compatible destination (LOCAL fixture server — no live network)');
  const mock = createS3Mock();
  await mock.listen(S3_PORT);
  const s3DestInfo = db.prepare("INSERT INTO destinations (name, type, config_json, created_at) VALUES ('mock-s3', 's3', ?, ?)")
    .run(JSON.stringify({
      endpoint: `http://127.0.0.1:${S3_PORT}`,
      region: 'us-east-1',
      bucket: 'test-bucket',
      prefix: 'sv',
      accessKeyId: 'AKIAMOCK',
      secretAccessKey: 'mock-secret',
      forcePathStyle: true
    }), Date.now());
  const src2 = path.join(work, 'source2');
  fs.mkdirSync(src2, { recursive: true });
  fs.writeFileSync(path.join(src2, 'cloud.txt'), `cloud file ${MARKER}\n`);
  const f2Info = db.prepare("INSERT INTO watched_folders (path, dest_id, schedule, created_at) VALUES (?, ?, 'daily', ?)")
    .run(src2, s3DestInfo.lastInsertRowid, Date.now());
  const folder2 = db.prepare('SELECT * FROM watched_folders WHERE id = ?').get(f2Info.lastInsertRowid);

  const s6 = await runBackup(db, folder2, PASS, { keepVersions: 2 });
  assert.strictEqual(s6.uploaded, 1, 'S3 backup must upload 1 object');
  // the mock's stored bytes must be encrypted (no marker) and SV1-framed
  const storedKeys = [...mock.store.keys()];
  assert.strictEqual(storedKeys.length, 1, 'exactly 1 object in the mock bucket');
  assert.ok(storedKeys[0].startsWith('test-bucket/sv/objects/'), `key layout (got ${storedKeys[0]})`);
  const storedBytes = mock.store.get(storedKeys[0]);
  assert.ok(!storedBytes.includes(MARKER), 'S3-stored bytes must NOT contain the plaintext marker');
  assert.ok(storedBytes.subarray(0, 3).equals(SV1_MAGIC), 'S3-stored object must be SV1-encrypted');

  // restore from the mock bucket
  const cloudTree = treeAsOf(db, folder2.id);
  await restoreVersion(db, cloudTree[0].id, path.join(restoreDir, 'cloud-restored.txt'), PASS);
  assert.strictEqual(fs.readFileSync(path.join(restoreDir, 'cloud-restored.txt'), 'utf8'), `cloud file ${MARKER}\n`,
    'S3 restore round-trip must match');
  // dedupe against S3: re-adding identical content in a new file re-uses the object
  fs.writeFileSync(path.join(src2, 'cloud-copy.txt'), `cloud file ${MARKER}\n`);
  const s7 = await runBackup(db, folder2, PASS, { keepVersions: 2 });
  assert.strictEqual(s7.uploaded, 0, 'identical content must NOT re-upload to S3');
  assert.strictEqual(s7.deduped, 1, 'S3 dedupe counted');
  await mock.close();

  console.log('11. Full-folder restore reproduces the current tree');
  const fullDir = path.join(work, 'full-restore');
  const results = await restoreFolder(db, folder.id, fullDir, PASS);
  assert.strictEqual(results.length, 3, '3 live files restored (report.md deleted)');
  assert.ok(fs.existsSync(path.join(fullDir, 'copy-a.bin')));
  assert.strictEqual(fs.readFileSync(path.join(fullDir, 'notes.txt'), 'utf8'), 'v3 content — prune should kick in.\n');

  console.log('12. Schedule math is exact');
  assert.strictEqual(computeNextRun('manual', Date.now()), null, 'manual never auto-runs');
  assert.strictEqual(computeNextRun('hourly', 1000), 1000 + 3600_000, 'hourly = last + 1h');
  assert.strictEqual(computeNextRun('daily', 1000), 1000 + 86400_000, 'daily = last + 24h');
  assert.strictEqual(computeNextRun('continuous', 1000), 1000 + 300_000, 'continuous = last + 5m');
  const now = Date.now();
  assert.ok(isDue({ schedule: 'hourly', last_backup_at: now - 3700_000 }, now), 'overdue hourly is due');
  assert.ok(!isDue({ schedule: 'hourly', last_backup_at: now - 100_000 }, now), 'recent hourly is not due');
  assert.ok(isDue({ schedule: 'daily', last_backup_at: null }, now), 'never-backed-up is due immediately');

  console.log('13. Crypto primitives: standalone encrypt/decrypt round trip');
  const plainP = path.join(work, 'prim.txt');
  const encP = path.join(work, 'prim.sv1');
  const decP = path.join(work, 'prim.out');
  fs.writeFileSync(plainP, MARKER.repeat(10));
  await encryptFile(plainP, encP, PASS);
  assert.ok(!fs.readFileSync(encP).includes(MARKER), 'encrypted file must not contain plaintext');
  await decryptFile(encP, decP, PASS);
  assert.strictEqual(fs.readFileSync(decP, 'utf8'), MARKER.repeat(10));

  db.close();
  console.log('\n✅ All Syncvault smoke tests passed');
}

async function cleanup(code) {
  await sleep(200);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* windows lock — harmless */ }
  process.exit(code);
}

main()
  .then(() => cleanup(0))
  .catch(async (err) => {
    console.error('\n❌ Smoke test failed:', err.message);
    console.error(err.stack);
    await cleanup(1);
  });
