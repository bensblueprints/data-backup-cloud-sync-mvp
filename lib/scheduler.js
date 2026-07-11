// Schedule logic (pure — unit-tested) + the polling loop used by the app.
const SCHEDULES = ['manual', 'continuous', 'hourly', 'daily'];

const INTERVALS = {
  continuous: 5 * 60 * 1000,      // every 5 minutes
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000
};

/** Next run time for a folder, or null for manual schedules. */
function computeNextRun(schedule, lastBackupAt, now = Date.now()) {
  if (!INTERVALS[schedule]) return null; // manual
  if (!lastBackupAt) return now;         // never backed up → due immediately
  return lastBackupAt + INTERVALS[schedule];
}

/** True when a folder is due for backup. */
function isDue(folder, now = Date.now()) {
  const next = computeNextRun(folder.schedule, folder.last_backup_at, now);
  return next !== null && next <= now;
}

/**
 * Start the scheduler loop. `runFolder(folder)` is called for each due folder.
 * Returns a stop() function.
 */
function startScheduler(db, runFolder, tickMs = 60 * 1000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const folders = db.prepare("SELECT * FROM watched_folders WHERE schedule != 'manual'").all();
      for (const f of folders) {
        if (isDue(f)) {
          try { await runFolder(f); } catch (e) { console.warn('[scheduler]', f.path, e.message); }
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

module.exports = { SCHEDULES, INTERVALS, computeNextRun, isDue, startScheduler };
