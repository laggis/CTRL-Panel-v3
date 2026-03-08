# CTRL Panel v3 — Script & Bot Process Manager

Web-based control panel for managing Discord bots and scripts with live logs, uptime charts, scheduling, Discord alerts, and 2FA.

---

## Features

- 🖥️ **Live Dashboard** — real-time process status, CPU & memory stats
- 📋 **Live Logs** — streaming log viewer with pause, export, and clear
- 📊 **Uptime Charts** — per-process uptime history recorded every 5 minutes
- ⏰ **Scheduler** — auto-restart / start / stop jobs on an interval
- 🔔 **Discord Webhook Alerts** — get notified on crash, start, stop, restart, or when a process gives up after 5 failed restarts
- 🔐 **Multi-user Auth** — JWT-based login with roles (Admin / Operator / Viewer)
- 🛡️ **Two-Factor Authentication** — TOTP-based 2FA support
- 📦 **Dependency Installer** — run `npm install` or `pip install -r requirements.txt` directly from the UI with live output
- 📂 **File Browser** — navigate your filesystem to pick script paths instead of typing them manually
- ✏️ **Edit Scripts** — update any registered script's path, type, env vars, or settings at any time
- 🏷️ **Tags & Notes** — label and annotate processes
- 🔁 **Auto-restart with crash limit** — automatically restarts on failure, stops after 5 consecutive crashes and fires a Discord alert

---

## Quick Start

### 1. Install
```bash
cd backend
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env — set JWT_SECRET to something random!
```

### 3. Start
```bash
npm start
```

### 4. Open in browser
```
http://localhost:3001/login.html
```

Default credentials: **admin / admin123** — change this immediately after first login!

---

## Supported Script Types

| Type | Runs with |
|------|-----------|
| Discord Bot (Python) | `python3 script.py` |
| Discord Bot (Node.js) | `node script.js` |
| Python Script | `python3 script.py` |
| Node.js App | `node script.js` |
| Node.js App (npm start) | `npm start` in working directory |
| Shell Script | `bash script.sh` |
| Batch File (Windows) | `cmd.exe /c script.bat` |
| PowerShell Script (Windows) | `powershell.exe -File script.ps1` |

---

## Adding Scripts

Click **+ Add Script** and fill in:
- **Name** — a friendly label for the process
- **Type** — select from the supported types above
- **Script Path** — absolute path, e.g. `C:\bots\mybot\index.js` — or click 📂 to browse
- **Working Dir** — defaults to the script's parent folder (required for `npm start`)
- **Env Vars** — space-separated `KEY=VALUE` pairs, e.g. `TOKEN=abc DEBUG=true`
- **Auto-Restart** — Always / On Failure / Never

> **Tip:** For `npm start`, point the Script Path field at the folder containing `package.json` — not a `.js` file.

---

## Process Actions

Each process card has the following action buttons:

| Button | Action |
|--------|--------|
| ▶ | Start |
| ⏹ | Stop (also cancels any pending auto-restart) |
| ↺ | Restart |
| 📦 | Install dependencies (`npm install` or `pip install -r requirements.txt`) |
| ✏️ | Edit script settings |
| 🏷️ | Edit tags |
| 🗑️ | Remove |

---

## Auto-Restart & Crash Protection

When **Auto-Restart** is set to *On Failure* or *Always*, the panel will automatically restart the process using exponential backoff (1s → 2s → 4s → 8s → 16s).

After **5 consecutive crashes**, the panel stops trying and:
- Sets the process to error state
- Logs "Auto-restart limit reached"
- Fires a Discord webhook alert (if configured)

Clicking **Stop** at any time cancels any pending restart timer immediately. A manual **Restart** resets the crash counter.

---

## Discord Webhook Alerts

Go to **Settings → Discord Webhook Alerts** and paste your webhook URL.

You can enable alerts for:
- 💥 Crash / Error
- ▶️ Start
- ⏹️ Stop
- 🔄 Restart
- 💀 Max restarts reached (always fires if configured)

Optionally add a **Role ID** to ping a role on alerts. Click **Send Test** to verify it's working.

---

## Scheduling

Select a process → open the **Schedule** tab in the right panel, or click ⏰.

Add a job by choosing an action (restart / start / stop) and an interval (minutes / hours / days). Jobs persist across server restarts.

---

## Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access — users, add/delete/edit scripts, start/stop/restart, settings |
| **Operator** | Start/stop/restart, add/edit scripts, view logs, manage schedules |
| **Viewer** | View processes and logs only |

---

## Security Notes

- Change `JWT_SECRET` in `.env` before exposing to the internet
- Change the default `admin` password immediately after first login
- Enable **Two-Factor Authentication** in Settings for extra protection
- Tokens expire after 24 hours
- Login endpoint is rate-limited (20 attempts per 15 minutes)

---

## File Structure

```
ctrl-panel/
├── backend/
│   ├── server.js           # Express + WebSocket server
│   ├── processManager.js   # Spawn/stop/restart/log/stats + install deps
│   ├── webhookManager.js   # Discord webhook alerts
│   ├── authManager.js      # JWT auth, bcrypt, 2FA, roles
│   ├── scheduler.js        # Scheduled jobs
│   ├── configStore.js      # processes.json persistence
│   ├── processes.json      # Your registered scripts (auto-created)
│   ├── users.json          # User accounts (auto-created)
│   ├── schedules.json      # Scheduled jobs (auto-created)
│   ├── webhook.json        # Webhook config (auto-created)
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── index.html          # Main dashboard
    └── login.html          # Login page
```
