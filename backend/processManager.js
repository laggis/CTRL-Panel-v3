// ─────────────────────────────────────────────
//  ProcessManager
//  Manages child processes, logs, and stats
// ─────────────────────────────────────────────
const { spawn }    = require('child_process');
const { EventEmitter } = require('events');
const os           = require('os');
const path         = require('path');

// How to launch each script type
const LAUNCHERS = {
  python:      { cmd: 'python3',        argsFn: (p) => [p] },
  python2:     { cmd: 'python2',        argsFn: (p) => [p] },
  node:        { cmd: 'node',           argsFn: (p) => [p] },
  npm_start:   { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', argsFn: (p) => ['start'] },
  discord_py:  { cmd: 'python3',        argsFn: (p) => [p] },
  discord_js:  { cmd: 'node',           argsFn: (p) => [p] },
  shell:       { cmd: 'bash',           argsFn: (p) => [p] },
  batch:       { cmd: 'cmd.exe',        argsFn: (p) => ['/c', p] },
  powershell:  { cmd: 'powershell.exe', argsFn: (p) => ['-ExecutionPolicy', 'Bypass', '-File', p] },
};

const MAX_LOG_LINES = 500;
const MAX_RESTARTS  = 5;   // stop auto-restart after this many consecutive failures

class ProcessManager extends EventEmitter {
  constructor(configStore, webhookManager = null) {
    super();
    this.config   = configStore;
    this.webhook  = webhookManager;
    this.procs    = {};   // id → runtime state
    this._statsTimer = null;

    // Load saved config and init runtime state
    const saved = this.config.load();
    saved.forEach(proc => this._initRuntime(proc));

    // Auto-start processes marked with autoStart after a short delay
    // (gives the server a moment to finish initializing)
    setTimeout(() => {
      const toStart = Object.values(this.procs).filter(r => r.autoStart);
      if (toStart.length > 0) {
        console.log(`[ProcessManager] Auto-starting ${toStart.length} process(es)...`);
        toStart.forEach(r => this.start(r.id));
      }
    }, 1500);

    // Poll CPU/mem every 5s for running processes
    this._statsTimer = setInterval(() => this._pollStats(), 5000);
  }

  // ── Internal ──────────────────────────────

  _initRuntime(proc) {
    this.procs[proc.id] = {
      ...proc,
      status:          'stopped',
      pid:             null,
      uptime:          null,
      startedAt:       null,
      restarts:        0,
      crashCount:      0,   // consecutive failure counter (resets on clean start)
      _stopRequested:  false,
      _restartTimer:   null,
      autoStart:       proc.autoStart || false,
      cpu:             '-',
      mem:             '-',
      logs:            [],
      child:           null,
    };
  }

  _log(id, level, message) {
    const entry = {
      time:  new Date().toISOString(),
      level,
      message,
    };
    const runtime = this.procs[id];
    if (!runtime) return;

    runtime.logs.push(entry);
    if (runtime.logs.length > MAX_LOG_LINES) runtime.logs.shift();

    this.emit('log', { id, line: entry });
  }

  _setStatus(id, status, pid = null) {
    const runtime = this.procs[id];
    if (!runtime) return;
    runtime.status = status;
    runtime.pid    = pid;
    this.config.updateStatus(id, status);
    this.emit('status', { id, status, pid });
  }

  async _pollStats() {
    for (const [id, runtime] of Object.entries(this.procs)) {
      if (runtime.status !== 'running' || !runtime.pid) continue;
      try {
        const stats = await getProcStats(runtime.pid);
        runtime.cpu = stats.cpu;
        runtime.mem = stats.mem;
        this.emit('stats', { id, cpu: stats.cpu, mem: stats.mem });
      } catch (_) { /* process may have died */ }
    }
  }

  // ── Public API ────────────────────────────

  getAll() {
    return Object.values(this.procs).map(r => this._serialize(r));
  }

  get(id) {
    const r = this.procs[id];
    return r ? this._serialize(r) : null;
  }

  _serialize(r) {
    return {
      id:          r.id,
      name:        r.name,
      type:        r.type,
      path:        r.path,
      cwd:         r.cwd,
      env:         r.env,
      autoRestart: r.autoRestart,
      autoStart:   r.autoStart || false,
      description: r.description || '',
      status:      r.status,
      pid:         r.pid,
      uptime:      r.startedAt ? formatUptime(Date.now() - r.startedAt) : '-',
      restarts:    r.restarts,
      cpu:         r.cpu,
      mem:         r.mem,
    };
  }

  add(procDef) {
    this._initRuntime(procDef);
    this.config.save(Object.values(this.procs).map(r => ({
      id: r.id, name: r.name, type: r.type, path: r.path,
      cwd: r.cwd, env: r.env, autoRestart: r.autoRestart, autoStart: r.autoStart || false, description: r.description,
    })));
    return this.get(procDef.id);
  }

  update(id, fields) {
    const runtime = this.procs[id];
    if (!runtime) return null;
    // Allowed editable fields
    const allowed = ['name', 'type', 'path', 'cwd', 'env', 'autoRestart', 'autoStart', 'description'];
    allowed.forEach(k => { if (fields[k] !== undefined) runtime[k] = fields[k]; });
    this.config.save(Object.values(this.procs).map(r => ({
      id: r.id, name: r.name, type: r.type, path: r.path,
      cwd: r.cwd, env: r.env, autoRestart: r.autoRestart, autoStart: r.autoStart || false, description: r.description,
    })));
    return this.get(id);
  }

  remove(id) {
    const runtime = this.procs[id];
    if (!runtime) return false;
    if (runtime.status === 'running') this.stop(id);
    delete this.procs[id];
    this.config.save(Object.values(this.procs).map(r => ({
      id: r.id, name: r.name, type: r.type, path: r.path,
      cwd: r.cwd, env: r.env, autoRestart: r.autoRestart, autoStart: r.autoStart || false, description: r.description,
    })));
    return true;
  }

  async start(id) {
    const runtime = this.procs[id];
    if (!runtime) return { ok: false, error: 'Process not found' };
    if (runtime.status === 'running') return { ok: false, error: 'Already running' };

    const launcher = LAUNCHERS[runtime.type];
    if (!launcher) return { ok: false, error: `Unknown type: ${runtime.type}` };

    const cmd  = launcher.cmd;
    const args = launcher.argsFn(runtime.path);
    const env  = { ...process.env, ...runtime.env };
    const cwd  = runtime.cwd || path.dirname(runtime.path);

    this._log(id, 'info', `Starting: ${cmd} ${args.join(' ')}`);
    this._setStatus(id, 'starting');

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',  // required for .cmd files on Windows
      });
    } catch (err) {
      this._log(id, 'error', `Failed to spawn: ${err.message}`);
      this._setStatus(id, 'error');
      return { ok: false, error: err.message };
    }

    runtime.child        = child;
    runtime.startedAt    = Date.now();
    runtime.crashCount   = 0;   // reset consecutive failure counter on each successful spawn
    runtime._stopRequested = false;
    if (runtime._restartTimer) { clearTimeout(runtime._restartTimer); runtime._restartTimer = null; }
    this._setStatus(id, 'running', child.pid);
    this._log(id, 'ok', `Process started (PID ${child.pid})`);

    // Stream stdout
    child.stdout.on('data', data => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) this._log(id, 'info', line);
      });
    });

    // Stream stderr
    child.stderr.on('data', data => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) this._log(id, 'error', line);
      });
    });

    // Handle exit
    child.on('exit', (code, signal) => {
      runtime.child = null;
      runtime.cpu   = '-';
      runtime.mem   = '-';

      if (code === 0) {
        this._log(id, 'ok', `Process exited cleanly (code 0)`);
        this._setStatus(id, 'stopped');
      } else if (signal) {
        this._log(id, 'warn', `Process killed by signal: ${signal}`);
        this._setStatus(id, 'stopped');
      } else {
        this._log(id, 'error', `Process exited with code ${code}`);
        this._setStatus(id, 'error');

        // Auto-restart logic with max-restart cap
        if (runtime.autoRestart === 'always' || runtime.autoRestart === 'on-failure') {
          runtime.crashCount = (runtime.crashCount || 0) + 1;

          if (runtime.crashCount >= MAX_RESTARTS) {
            // Hit the limit — give up and fire a Discord alert
            this._log(id, 'error',
              `Auto-restart limit reached (${MAX_RESTARTS} consecutive failures). Giving up.`
            );
            this._setStatus(id, 'error');
            if (this.webhook) {
              this.webhook.notifyMaxRestarts(runtime.name, MAX_RESTARTS);
            }
          } else {
            const delay = Math.min(1000 * Math.pow(2, Math.min(runtime.restarts, 5)), 30000);
            this._log(id, 'warn',
              `Auto-restarting in ${delay/1000}s... (attempt ${runtime.crashCount}/${MAX_RESTARTS})`
            );
            runtime._restartTimer = setTimeout(() => {
              runtime._restartTimer = null;
              if (!runtime._stopRequested && this.procs[id]?.status === 'error') {
                runtime.restarts++;
                this.start(id);
              }
            }, delay);
          }
        }
      }
    });

    child.on('error', (err) => {
      this._log(id, 'error', `Process error: ${err.message}`);
      this._setStatus(id, 'error');
    });

    return { ok: true, pid: child.pid };
  }

  async stop(id) {
    const runtime = this.procs[id];
    if (!runtime) return { ok: false, error: 'Not found' };

    // Cancel any pending auto-restart timer immediately
    runtime._stopRequested = true;
    if (runtime._restartTimer) {
      clearTimeout(runtime._restartTimer);
      runtime._restartTimer = null;
      this._log(id, 'warn', 'Pending auto-restart cancelled by user.');
    }

    if (!runtime.child) {
      this._setStatus(id, 'stopped');
      return { ok: true };
    }

    this._log(id, 'warn', 'Stop requested by user');

    return new Promise((resolve) => {
      const child = runtime.child;

      const timeout = setTimeout(() => {
        this._log(id, 'warn', 'Graceful stop timed out, sending SIGKILL');
        child.kill('SIGKILL');
      }, 5000);

      child.once('exit', () => {
        clearTimeout(timeout);
        this._setStatus(id, 'stopped');
        resolve({ ok: true });
      });

      child.kill('SIGTERM');
    });
  }

  async restart(id) {
    const runtime = this.procs[id];
    if (!runtime) return { ok: false, error: 'Not found' };

    this._log(id, 'warn', 'Restart requested');
    runtime.restarts++;
    runtime.crashCount = 0;  // reset crash loop counter on manual restart

    if (runtime.child) await this.stop(id);
    return this.start(id);
  }

  async stopAll() {
    const ids = Object.keys(this.procs).filter(id => this.procs[id].status === 'running');
    await Promise.all(ids.map(id => this.stop(id)));
  }

  async bulkAction(action) {
    const ids = Object.keys(this.procs);
    const results = await Promise.all(ids.map(id => this[action](id)));
    return results;
  }

  getLogs(id, lines = 200) {
    const runtime = this.procs[id];
    if (!runtime) return null;
    return runtime.logs.slice(-lines);
  }

  sendStdin(id, command) {
    const runtime = this.procs[id];
    if (!runtime?.child?.stdin?.writable) return false;
    runtime.child.stdin.write(command + '\n');
    this._log(id, 'debug', `> ${command}`);
    return true;
  }

  // ── Install dependencies ───────────────────
  // Runs `npm install` or `pip install -r requirements.txt` in the process cwd.
  // Streams output back via a callback so the frontend can show live progress.
  installDeps(id, onData) {
    const runtime = this.procs[id];
    if (!runtime) return { ok: false, error: 'Process not found' };

    const cwd = runtime.cwd || path.dirname(runtime.path);
    const isNode = runtime.type === 'node' || runtime.type === 'discord_js' || runtime.type === 'npm_start';
    const isPython = ['python', 'python2', 'discord_py'].includes(runtime.type);

    let cmd, args;
    if (isNode) {
      cmd  = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      args = ['install'];
    } else if (isPython) {
      cmd  = process.platform === 'win32' ? 'pip' : 'pip3';
      args = ['install', '-r', 'requirements.txt'];
    } else {
      return { ok: false, error: `No install command for type: ${runtime.type}` };
    }

    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',  // required for .cmd files on Windows
      });

      child.stdout.on('data', d => onData?.('out', d.toString()));
      child.stderr.on('data', d => onData?.('err', d.toString()));

      child.on('exit', (code) => {
        resolve({ ok: code === 0, code });
      });
      child.on('error', (err) => {
        onData?.('err', `Failed to run ${cmd}: ${err.message}\n`);
        resolve({ ok: false, error: err.message });
      });
    });
  }
}

// ── Helpers ──────────────────────────────────

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

async function getProcStats(pid) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    if (process.platform === 'win32') {
      exec(`wmic process where processid=${pid} get WorkingSetSize,PercentProcessorTime /format:csv`, (err, out) => {
        if (err) return resolve({ cpu: '-', mem: '-' });
        const lines = out.trim().split('\n').filter(Boolean);
        if (lines.length < 2) return resolve({ cpu: '-', mem: '-' });
        const vals = lines[1].split(',');
        resolve({ cpu: `${vals[2] || '?'}%`, mem: formatMem(parseInt(vals[3]) || 0) });
      });
    } else {
      exec(`ps -p ${pid} -o %cpu,rss --no-headers 2>/dev/null`, (err, out) => {
        if (err || !out.trim()) return resolve({ cpu: '-', mem: '-' });
        const [cpu, rss] = out.trim().split(/\s+/);
        resolve({ cpu: `${cpu}%`, mem: formatMem((parseInt(rss) || 0) * 1024) });
      });
    }
  });
}

function formatMem(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

module.exports = ProcessManager;
