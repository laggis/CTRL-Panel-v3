// ─────────────────────────────────────────────
//  Scheduler
//  Scheduled restart jobs per process
// ─────────────────────────────────────────────
const fs = require('fs');

class Scheduler {
  constructor(filePath, processManager) {
    this.filePath = filePath;
    this.manager  = processManager;
    this.jobs     = {};    // id → { processId, interval, nextRun, timer, ... }
    this._load();
    this._rescheduleAll();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      // Restore job definitions (not timers)
      raw.forEach(job => {
        this.jobs[job.id] = { ...job, timer: null };
      });
    } catch (e) {
      console.error('[Scheduler] Failed to load:', e.message);
    }
  }

  _save() {
    const toSave = Object.values(this.jobs).map(j => ({
      id:        j.id,
      processId: j.processId,
      action:    j.action,
      intervalMs: j.intervalMs,
      label:     j.label,
      enabled:   j.enabled,
      createdAt: j.createdAt,
    }));
    fs.writeFileSync(this.filePath, JSON.stringify(toSave, null, 2));
  }

  _rescheduleAll() {
    Object.values(this.jobs).forEach(job => {
      if (job.enabled) this._schedule(job.id);
    });
  }

  _schedule(jobId) {
    const job = this.jobs[jobId];
    if (!job) return;

    if (job.timer) clearInterval(job.timer);

    job.nextRun = new Date(Date.now() + job.intervalMs).toISOString();

    job.timer = setInterval(async () => {
      const proc = this.manager.procs[job.processId];
      if (!proc) return;

      console.log(`[Scheduler] Running "${job.action}" on "${proc.name}" (job: ${job.label})`);

      job.lastRun = new Date().toISOString();
      job.nextRun = new Date(Date.now() + job.intervalMs).toISOString();

      try {
        await this.manager[job.action](job.processId);
      } catch (e) {
        console.error(`[Scheduler] Job failed:`, e.message);
      }
    }, job.intervalMs);
  }

  // ── Public API ────────────────────────────

  list() {
    return Object.values(this.jobs).map(j => ({
      id:        j.id,
      processId: j.processId,
      action:    j.action,
      intervalMs: j.intervalMs,
      label:     j.label,
      enabled:   j.enabled,
      lastRun:   j.lastRun || null,
      nextRun:   j.nextRun || null,
      createdAt: j.createdAt,
    }));
  }

  add({ processId, action, intervalMs, label }) {
    if (!['restart', 'start', 'stop'].includes(action)) {
      throw new Error('Action must be restart, start, or stop');
    }
    if (!intervalMs || intervalMs < 60000) {
      throw new Error('Minimum interval is 1 minute');
    }

    const { v4: uuidv4 } = require('uuid');
    const job = {
      id:         uuidv4(),
      processId,
      action,
      intervalMs,
      label:      label || `${action} every ${formatInterval(intervalMs)}`,
      enabled:    true,
      createdAt:  new Date().toISOString(),
      lastRun:    null,
      nextRun:    null,
      timer:      null,
    };

    this.jobs[job.id] = job;
    this._schedule(job.id);
    this._save();
    return this._public(job);
  }

  remove(jobId) {
    const job = this.jobs[jobId];
    if (!job) return false;
    if (job.timer) clearInterval(job.timer);
    delete this.jobs[jobId];
    this._save();
    return true;
  }

  toggle(jobId) {
    const job = this.jobs[jobId];
    if (!job) throw new Error('Job not found');
    job.enabled = !job.enabled;
    if (job.enabled) {
      this._schedule(jobId);
    } else {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      job.nextRun = null;
    }
    this._save();
    return this._public(job);
  }

  getForProcess(processId) {
    return Object.values(this.jobs)
      .filter(j => j.processId === processId)
      .map(j => this._public(j));
  }

  _public(j) {
    return {
      id:         j.id,
      processId:  j.processId,
      action:     j.action,
      intervalMs: j.intervalMs,
      label:      j.label,
      enabled:    j.enabled,
      lastRun:    j.lastRun || null,
      nextRun:    j.nextRun || null,
      createdAt:  j.createdAt,
    };
  }
}

function formatInterval(ms) {
  const s = ms / 1000;
  if (s < 3600) return `${Math.round(s/60)}m`;
  if (s < 86400) return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}d`;
}

module.exports = Scheduler;
