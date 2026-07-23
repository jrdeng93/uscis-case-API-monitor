# USCIS Case API Monitor

> **Disclaimer**: This project is for educational and personal use only. Automated access to USCIS/login.gov may violate their Terms of Service. The authors are not responsible for any consequences arising from the use of this tool. Use at your own risk.

Automated USCIS case status monitor that checks your immigration cases periodically via the USCIS API and notifies you via Discord when something changes. Currently supports IOE receipt numbers.

## Features

- **Multi-case monitoring** — track multiple receipt numbers simultaneously
- **Manual login + saved session** — Playwright logs in once and saves cookies to `state/auth.json`
- **SMS/iMessage OTP** — reads verification codes from macOS Messages database during manual login
- **Session handling** — scheduled checks reuse saved auth and auto-reauth by default when needed
- **Change detection** — SHA-based field-level diff on `updatedAt`, `events`, `closed`, `actionRequired`
- **Discord notifications** — sends alerts on case changes (or a quiet heartbeat when nothing changed)
- **Built-in scheduler** — runs daily at 9am, 12pm, 3pm, 6pm, and 9pm ET by default

## Requirements

- macOS (for iMessage/SMS OTP reading)
- Node.js 20+
- Python 3.10+
- Google Chrome installed
- Full Disk Access granted to the app/terminal used for manual login when using SMS/iMessage OTP

## Install

```bash
npm install
npx playwright install chromium
```

## Configure

Copy the example config and fill in your details:

```bash
cp config.example.json config.local.json
```

Edit `config.local.json`:

```json
{
  "uscisEmail": "you@example.com",
  "uscisUsername": "you@example.com",
  "uscisPassword": "your-password",
  "receiptNumbers": [
    "IOE0000000000",
    "IOE0000000001"
  ],
  "loginUrl": "https://my.uscis.gov/oidc/login",
  "monitorUrl": "https://myaccount.uscis.gov/",
  "apiUrl": "https://my.uscis.gov/account/case-service/api/cases",
  "caseStatusApiUrl": "https://my.uscis.gov/account/case-service/api/case_status",
  "discordWebhookUrl": "https://discord.com/api/webhooks/...",
  "scheduler": {
    "intervalHours": 3,
    "autoReauth": true,
    "reauthReminderHours": 6
  },
  "otp": {
    "mode": "sms-imessage",
    "timeoutSeconds": 300,
    "pollIntervalSeconds": 2,
    "sinceSeconds": 1200,
    "codeRegex": "\\b(\\d{6})\\b"
  }
}
```

### OTP Modes

**SMS/iMessage** (recommended for macOS):
```json
"otp": {
  "mode": "sms-imessage",
  "timeoutSeconds": 300,
  "pollIntervalSeconds": 2,
  "sinceSeconds": 1200,
  "codeRegex": "\\b(\\d{6})\\b"
}
```
Reads OTP codes directly from the macOS Messages database. Requires Full Disk Access permission.

**IMAP Email**:
```json
"otp": {
  "mode": "imap",
  "timeoutSeconds": 180,
  "pollIntervalSeconds": 5,
  "sinceSeconds": 900,
  "imapHost": "imap.mail.me.com",
  "imapPort": 993,
  "imapUsername": "you@example.com",
  "imapPassword": "your-app-specific-password",
  "imapMailbox": "INBOX",
  "imapUseSsl": true,
  "senderContains": "uscis",
  "subjectContains": "verification",
  "codeRegex": "\\b(\\d{6})\\b"
}
```

### Discord Notifications

Set `discordWebhookUrl` in config, or use the environment variable:

```bash
export USCIS_MONITOR_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
```

- **No changes**: sends a simple timestamp + "no changes found"
- **Changes detected**: sends a rich embed with receipt number, API group, changed fields, and new events

### How To Read Update Alerts

Most scheduled checks should report **no changes**. A change alert means the monitor detected a JSON difference between the latest response and `state/case-history.json`; it does not always mean USCIS made a substantive case decision.

Each update alert should answer three questions:

- **Which case changed**: the embed title and `Receipt Number` field identify the case, for example `IOE0000000000`.
- **Which API changed**: API-specific changes are grouped as `cases API Changed` or `case_status API Changed`.
- **Where it changed**: the field body lists readable differences such as `updatedAtTimestamp: old → new`, `events: 2 → 4`, `documents: [0 items] → [1 item]`, `statusTitle: old → new`, or `data became available`.

Interpretation guide:

- `cases API Changed` usually matters more for myUSCIS account case details, documents, notices, evidence requests, and internal event timestamps.
- `case_status API Changed` is the public/new status-style API. It may change because fields become available, response shape changes, jurisdiction/status text changes, or USCIS updates public status metadata.
- If the auxiliary `case_status` API fails while the primary `cases` API succeeds, the monitor preserves the previous successful auxiliary response and sends an API warning instead of a false case-change alert.
- `data became available` often means the API started returning a usable response after previously missing/null data. Treat this as a baseline/API availability change unless key status fields also changed.
- Hash-only changes should be avoided in normal alerts; if an alert cannot explain the field-level difference, inspect `state/case-history.json` and `state/scheduler.log`.

## Commands

Default management uses the original Terminal-launched daemon (`./uscis.sh`). This is the stable path for SMS/iMessage OTP because it inherits the Full Disk Access permissions of the terminal/app that started it.

| Command | Description |
|---------|-------------|
| `./uscis.sh start` | Start scheduler as a background daemon |
| `./uscis.sh stop` | Stop the scheduler |
| `./uscis.sh status` | Check if scheduler is running |
| `./uscis.sh restart` | Restart the scheduler |
| `./uscis.sh logs [N]` | Show scheduler logs |
| `./uscis.sh follow` | Tail logs in real time |

Additional npm scripts for development/debugging:

| Command | Description |
|---------|-------------|
| `npm run login` | Log in to myUSCIS and save session |
| `npm run check-all-cases` | Check all cases using saved session |
| `npm run scheduled-check` | Run a single scheduled check |
| `npm run start/status/restart/logs/follow` | Convenience wrappers around `uscis.sh` |
| `npm run launchd:*` | Optional LaunchAgent commands; not the default SMS OTP path |

## Usage

### First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Create and edit config
cp config.example.json config.local.json

# 3. Login (opens browser, handles OTP automatically)
npm run login

# 4. Verify it works
npm run check-all-cases
```

### Start the scheduler

```bash
./uscis.sh start
```

This starts the scheduler as a background daemon.

- PID: `state/scheduler.pid`
- Logs: `state/scheduler.log`
- Schedule: daily 9 AM–9 PM ET, every `scheduler.intervalHours` (default 3 hours), including a final 9 PM run

The scheduler automatically:
1. Checks if current time is within schedule
2. Fetches case data via the USCIS API
3. Compares results against history and sends Discord notifications
4. If the session expired, attempts reauth and retries the check
5. Sleeps until the next scheduled run

### Full Disk Access

Grant Full Disk Access to the terminal/app used to start the daemon:

- Terminal, VS Code, or Codex

The optional LaunchAgent path (`uscis_launchd.sh`) is not the default for SMS OTP because macOS TCC may block launchd-started processes from reading `~/Library/Messages/chat.db`.

If automatic reauth is temporarily disabled with `scheduler.autoReauth: false`, scheduled checks write `state/reauth-required.json` and wait until manual login succeeds. Manual login clears that marker automatically:

```bash
npm run login
npm run check-all-cases
```

`scheduler.reauthReminderHours` controls how often Discord reminders are sent while waiting for manual reauth.

### Monitor & manage

```bash
# Is it running?
./uscis.sh status

# Check recent activity
./uscis.sh logs 80

# Restart after config change
./uscis.sh restart

# Stop
./uscis.sh stop
```

### Run a one-off check

```bash
npm run scheduled-check
```

Same logic as the scheduler, but runs once and exits.

## How It Works

```
scheduled-check
  ├── Has auth token?
  │     ├── No + autoReauth=true  → login (browser + OTP)
  │     └── No + autoReauth=false → Discord/manual reauth alert
  │         │
  │        Yes
  │         ↓
  ├── Fetch cases via API
  │         │
  │    Token expired?
  │     ├── Yes + autoReauth=true  → login → retry
  │     ├── Yes + autoReauth=false → Discord/manual reauth alert
  │     └── No  → compare with history
  │                  │
  │           Changes found?
  │            ├── Yes → Discord embed with details
  │            └── No  → Discord: "no changes found"
  │
  └── Save history to state/case-history.json
```

## Data Files

| File | Description |
|------|-------------|
| `state/auth.json` | Saved browser session (cookies) |
| `state/reauth-required.json` | Marker written when scheduled checks need manual reauth |
| `state/case-history.json` | Full case history with change tracking |
| `config.local.json` | Your configuration (gitignored) |

## License

MIT — see [LICENSE](LICENSE) for details.
