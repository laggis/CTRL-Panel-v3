// ─────────────────────────────────────────────
//  ProcessManager
//  Manages child processes, logs, and stats
// ─────────────────────────────────────────────
const { spawn }    = require('child_process');
const { EventEmitter } = require('events');
const net          = require('net');
const os           = require('os');
const path         = require('path');

const IS_WIN = process.platform === 'win32';

// How to launch each script type
const LAUNCHERS = {
  // pythonw.exe = windowless Python binary on Windows — never flashes a console window
  python:     { cmd: IS_WIN ? 'pythonw.exe'    : 'python3', argsFn: (p) => [p],                        shell: false },
  python2:    { cmd: IS_WIN ? 'pythonw.exe'    : 'python2', argsFn: (p) => [p],                        shell: false },
  node:       { cmd: IS_WIN ? 'node.exe'       : 'node',    argsFn: (p) => [p],                        shell: false },
  npm_start:  { cmd: IS_WIN ? 'npm.cmd'        : 'npm',     argsFn: ()  => ['start'],                  shell: IS_WIN },
  discord_py: { cmd: IS_WIN ? 'pythonw.exe'    : 'python3', argsFn: (p) => [p],                        shell: false },
  discord_js: { cmd: IS_WIN ? 'node.exe'       : 'node',    argsFn: (p) => [p],                        shell: false },
  shell:      { cmd: IS_WIN ? 'cmd.exe'        : 'bash',    argsFn: (p) => IS_WIN ? ['/c', p] : [p],   shell: false },
  batch:      { cmd: 'cmd.exe',                              argsFn: (p) => ['/c', p],                  shell: false },
  powershell: { cmd: IS_WIN ? 'powershell.exe' : 'pwsh',    argsFn: (p) => ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', p], shell: false },
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
      port:            proc.port || null,   // optional port to verify after start
      customCmd:       proc.customCmd || null,   // override launch command e.g. 'python3.12', 'py'
      customArgs:      proc.customArgs || null,  // extra args appended after script path
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
      port:        r.port || null,
      customCmd:   r.customCmd || null,
      customArgs:  r.customArgs || null,
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
      cwd: r.cwd, env: r.env, autoRestart: r.autoRestart, autoStart: r.autoStart || false,
      port: r.port || null, customCmd: r.customCmd || null, customArgs: r.customArgs || null, description: r.description,
    })));
    return this.get(procDef.id);
  }

  update(id, fields) {
    const runtime = this.procs[id];
    if (!runtime) return null;
    // Allowed editable fields
    const allowed = ['name', 'type', 'path', 'cwd', 'env', 'autoRestart', 'autoStart', 'port', 'customCmd', 'customArgs', 'description'];
    allowed.forEach(k => { if (fields[k] !== undefined) runtime[k] = fields[k]; });
    this.config.save(Object.values(this.procs).map(r => ({
      id: r.id, name: r.name, type: r.type, path: r.path,
      cwd: r.cwd, env: r.env, autoRestart: r.autoRestart, autoStart: r.autoStart || false,
      port: r.port || null, customCmd: r.customCmd || null, customArgs: r.customArgs || null, description: r.description,
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
      cwd: r.cwd, env: r.env, autoRestart: r.autoRestart, autoStart: r.autoStart || false,
      port: r.port || null, customCmd: r.customCmd || null, customArgs: r.customArgs || null, description: r.description,
    })));
    return true;
  }

  async start(id) {
    const runtime = this.procs[id];
    if (!runtime) return { ok: false, error: 'Process not found' };
    if (runtime.status === 'running') return { ok: false, error: 'Already running' };

    const launcher = LAUNCHERS[runtime.type];
    if (!launcher) return { ok: false, error: `Unknown type: ${runtime.type}` };

    // If a custom command is set, use it instead of the default launcher cmd.
    // On Windows, if no extension given, try pythonw.exe for python-like commands,
    // otherwise append .exe so Node can find it directly without shell:true.
    const usingCustomCmd = !!(runtime.customCmd && runtime.customCmd.trim());
    let rawCmd = usingCustomCmd ? runtime.customCmd.trim() : launcher.cmd;
    if (IS_WIN && usingCustomCmd && !path.extname(rawCmd)) {
      // If it looks like a python command, use the windowless variant
      rawCmd = /^python/i.test(rawCmd) ? 'pythonw.exe' : rawCmd + '.exe';
    }
    const shell = usingCustomCmd ? false : (launcher.shell || false);
    const baseArgs = launcher.argsFn(runtime.path);
    const extraArgs = runtime.customArgs ? runtime.customArgs.trim().split(/\s+/).filter(Boolean) : [];
    const args = [...baseArgs, ...extraArgs];
    const cmd  = rawCmd;

    const env  = { ...process.env, ...runtime.env };
    const cwd  = runtime.cwd || path.dirname(runtime.path);

    this._log(id, 'info', `Starting: ${cmd} ${args.join(' ')}${runtime.customCmd ? ` [custom cmd: ${runtime.customCmd}]` : ''}`);
    this._setStatus(id, 'starting');

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
        windowsHide: true,
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
    this._log(id, 'ok', `Process started (PID ${child.pid})`);

    // If a port is configured, stay in 'starting' until the port is actually listening.
    // This prevents the panel from showing 'running' while the script is still booting.
    if (runtime.port) {
      this._setStatus(id, 'starting', child.pid);
      this._log(id, 'info', `Waiting for port ${runtime.port} to open...`);
      waitForPort(runtime.port, 30000).then(opened => {
        // Only flip to running if the process is still alive and we didn't request a stop
        if (!runtime._stopRequested && runtime.child && runtime.child.pid === child.pid) {
          if (opened) {
            this._setStatus(id, 'running', child.pid);
            this._log(id, 'ok', `Port ${runtime.port} is open — process confirmed running`);
          } else {
            this._log(id, 'warn', `Port ${runtime.port} did not open within 30s — process may have failed to bind`);
            // Still mark running if the process is alive; the script might not use a port yet
            if (runtime.child) this._setStatus(id, 'running', child.pid);
          }
        }
      });
    } else {
      this._setStatus(id, 'running', child.pid);
    }

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
            // Minimum 10s delay so slow-shutting scripts have time to fully exit
            const delay = Math.max(10000, Math.min(1000 * Math.pow(2, Math.min(runtime.restarts, 5)), 30000));
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

    // Wait 10s before restarting — gives slow/weird-shutdown scripts time to fully exit
    this._log(id, 'info', 'Waiting 10s before restart to allow full shutdown...');
    this._setStatus(id, 'restarting');
    await new Promise(resolve => setTimeout(resolve, 10000));

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
        shell: process.platform === 'win32' && cmd.endsWith('.cmd'), // only for npm.cmd
        windowsHide: true,
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

// Polls a TCP port until it accepts a connection (process is truly up) or times out.
// Tries every 500ms for up to `timeoutMs` milliseconds.
// Returns true if port opened, false if timed out.
function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    function attempt() {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error',   () => { sock.destroy(); retry(); });
      sock.on('timeout', () => { sock.destroy(); retry(); });
      sock.connect(port, '127.0.0.1');
    }
    function retry() {
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(attempt, 500);
    }
    attempt();
  });
}

module.exports = ProcessManager;
