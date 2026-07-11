/* Syncvault renderer — talks to main via the preload bridge only. */
const sv = window.syncvault;
const $ = (id) => document.getElementById(id);

function fmtTime(ms) { return ms ? new Date(ms).toLocaleString() : 'never'; }
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function log(msg) {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
  while (el.children.length > 60) el.removeChild(el.lastChild);
}

/* ── lock screen ── */
async function initLock() {
  const st = await sv.vaultStatus();
  if (st.unlocked) return showMain();
  $('lockScreen').classList.remove('hidden');
  if (!st.initialized) {
    $('lockTitle').textContent = 'Create your vault passphrase';
    $('btnUnlock').textContent = 'Create vault';
  }
  $('btnUnlock').onclick = async () => {
    const pp = $('ppInput').value;
    try {
      const s = await sv.vaultStatus();
      if (s.initialized) await sv.vaultUnlock(pp);
      else await sv.vaultSetup(pp);
      showMain();
    } catch (e) {
      $('lockErr').textContent = e.message.replace(/^.*Error: /, '');
    }
  };
  $('ppInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnUnlock').click(); });
}

function showMain() {
  $('lockScreen').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('btnLock').classList.remove('hidden');
  $('lockState').textContent = 'unlocked';
  $('lockState').className = 'pill ok';
  refreshAll();
}

$('btnLock').onclick = async () => { await sv.vaultLock(); location.reload(); };

/* ── tabs ── */
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    ['folders', 'destinations', 'restore', 'settings'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
    if (b.dataset.tab === 'restore') loadRestore();
  };
});

/* ── folders ── */
async function loadFolders() {
  const folders = await sv.folderList();
  const tb = $('folderTable').querySelector('tbody');
  tb.innerHTML = '';
  for (const f of folders) {
    const tr = document.createElement('tr');
    const tds = [f.path, `${f.dest_name} (${f.dest_type})`, f.schedule, String(f.file_count), fmtTime(f.last_backup_at)];
    for (const t of tds) { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); }
    const act = document.createElement('td');
    const bBackup = document.createElement('button'); bBackup.textContent = 'Back up now'; bBackup.className = 'primary';
    bBackup.onclick = async () => {
      bBackup.disabled = true;
      try { await sv.folderBackup(f.id); } catch (e) { log('ERROR ' + e.message); }
      bBackup.disabled = false;
      loadFolders();
    };
    const sel = document.createElement('select');
    for (const s of ['manual', 'continuous', 'hourly', 'daily']) {
      const o = document.createElement('option'); o.value = s; o.textContent = s;
      if (s === f.schedule) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => sv.folderUpdate({ id: f.id, schedule: sel.value }).then(loadFolders);
    const bDel = document.createElement('button'); bDel.textContent = '✕'; bDel.className = 'danger';
    bDel.onclick = () => sv.folderRemove(f.id).then(loadFolders);
    act.append(bBackup, ' ', sel, ' ', bDel);
    tr.appendChild(act);
    tb.appendChild(tr);
  }
}

$('btnAddFolder').onclick = async () => {
  const dests = await sv.destList();
  if (!dests.length) { alert('Add a destination first (Destinations tab).'); return; }
  const sel = $('dlgFolderDest');
  sel.innerHTML = '';
  for (const d of dests) { const o = document.createElement('option'); o.value = d.id; o.textContent = `${d.name} (${d.type})`; sel.appendChild(o); }
  $('dlgFolderPath').value = '';
  $('dlgFolder').showModal();
};
$('dlgPick').onclick = async () => { const p = await sv.folderPick(); if (p) $('dlgFolderPath').value = p; };
$('dlgFolderCancel').onclick = () => $('dlgFolder').close();
$('dlgFolderSave').onclick = async () => {
  try {
    await sv.folderAdd({ path: $('dlgFolderPath').value, dest_id: Number($('dlgFolderDest').value), schedule: $('dlgFolderSchedule').value });
    $('dlgFolder').close();
    loadFolders();
  } catch (e) { alert(e.message); }
};

/* ── destinations ── */
async function loadDests() {
  const dests = await sv.destList();
  const tb = $('destTable').querySelector('tbody');
  tb.innerHTML = '';
  for (const d of dests) {
    const cfg = JSON.parse(d.config_json || '{}');
    const tr = document.createElement('tr');
    for (const t of [d.name, d.type, d.type === 'local' ? cfg.path : `${cfg.bucket}${cfg.endpoint ? ' @ ' + cfg.endpoint : ' (AWS)'}`]) {
      const td = document.createElement('td'); td.textContent = t || ''; tr.appendChild(td);
    }
    const act = document.createElement('td');
    const bTest = document.createElement('button'); bTest.textContent = 'Test';
    bTest.onclick = async () => {
      bTest.textContent = '…';
      try { const r = await sv.destTest(d.id); bTest.textContent = '✅'; log(`Destination OK: ${r.detail}`); }
      catch (e) { bTest.textContent = '❌'; log('Destination FAILED: ' + e.message); }
      setTimeout(() => (bTest.textContent = 'Test'), 2500);
    };
    const bDel = document.createElement('button'); bDel.textContent = '✕'; bDel.className = 'danger';
    bDel.onclick = () => sv.destDelete(d.id).then(loadDests).catch((e) => alert(e.message));
    act.append(bTest, ' ', bDel);
    tr.appendChild(act);
    tb.appendChild(tr);
  }
}

$('dDestType').onchange = () => {
  const s3 = $('dDestType').value === 's3';
  $('dS3Fields').classList.toggle('hidden', !s3);
  $('dLocalFields').classList.toggle('hidden', s3);
};
$('btnAddDest').onclick = () => $('dlgDest').showModal();
$('dDestCancel').onclick = () => $('dlgDest').close();
$('dDestSave').onclick = async () => {
  const type = $('dDestType').value;
  const config = type === 'local'
    ? { path: $('dLocalPath').value }
    : {
        endpoint: $('dS3Endpoint').value || undefined,
        region: $('dS3Region').value || 'us-east-1',
        bucket: $('dS3Bucket').value,
        prefix: $('dS3Prefix').value || '',
        accessKeyId: $('dS3Key').value,
        secretAccessKey: $('dS3Secret').value
      };
  try {
    await sv.destCreate({ name: $('dDestName').value, type, config });
    $('dlgDest').close();
    loadDests();
  } catch (e) { alert(e.message); }
};

/* ── restore ── */
async function loadRestore() {
  const folders = await sv.folderList();
  const sel = $('restoreFolderSel');
  sel.innerHTML = '';
  for (const f of folders) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.path; sel.appendChild(o); }
  sel.onchange = renderTree;
  $('asOf').onchange = renderTree;
  renderTree();
}

async function renderTree() {
  const folderId = Number($('restoreFolderSel').value);
  if (!folderId) return;
  const asOf = $('asOf').value ? new Date($('asOf').value).getTime() : Date.now();
  const tree = await sv.restoreTree({ folderId, asOf });
  const tb = $('treeTable').querySelector('tbody');
  tb.innerHTML = '';
  for (const v of tree) {
    const tr = document.createElement('tr');
    for (const t of [v.rel_path, fmtSize(v.size), 'v' + v.version, fmtTime(v.backed_up_at)]) {
      const td = document.createElement('td'); td.textContent = t; tr.appendChild(td);
    }
    const act = document.createElement('td');
    const b = document.createElement('button'); b.textContent = 'Restore…';
    b.onclick = async () => {
      try { const r = await sv.restoreFile({ versionId: v.id }); if (r) log(`Restored ${r.rel_path} v${r.version} → ${r.target}`); }
      catch (e) { alert(e.message); }
    };
    act.appendChild(b);
    tr.appendChild(act);
    tb.appendChild(tr);
  }
}

$('btnRestoreAll').onclick = async () => {
  const folderId = Number($('restoreFolderSel').value);
  const asOf = $('asOf').value ? new Date($('asOf').value).getTime() : Date.now();
  try {
    const r = await sv.restoreFolder({ folderId, asOf });
    if (r) log(`Restored ${r.length} files`);
  } catch (e) { alert(e.message); }
};

/* ── settings ── */
async function loadSettings() {
  const s = await sv.settingsGet();
  $('keepVersions').value = s.keep_versions;
}
$('btnSaveSettings').onclick = async () => {
  await sv.settingsSet({ keep_versions: Number($('keepVersions').value) });
  log('Settings saved');
};

/* ── backup events ── */
sv.on('backup:started', ({ folderId }) => log(`Backup started (folder #${folderId})`));
sv.on('backup:progress', ({ file, phase }) => { /* could show per-file progress */ });
sv.on('backup:done', ({ folderId, stats }) =>
  log(`Backup done (folder #${folderId}): ${stats.uploaded} uploaded, ${stats.deduped} deduped, ${stats.unchanged} unchanged, ${fmtSize(stats.bytes_uploaded)} sent`));
sv.on('backup:error', ({ folderId, error }) => log(`Backup FAILED (folder #${folderId}): ${error}`));

function refreshAll() { loadFolders(); loadDests(); loadSettings(); }
initLock();
