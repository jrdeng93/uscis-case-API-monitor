#!/bin/bash
# USCIS Case Monitor - macOS LaunchAgent management

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="${LAUNCHD_LABEL:-com.example.uscis-monitor}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
APP_DIR="$HOME/Applications/USCISMonitor.app"
APP_EXEC="$APP_DIR/Contents/MacOS/USCISMonitor"
RUNTIME_DIR="$HOME/Library/Application Support/USCISMonitor/runtime"
LOG_FILE="$RUNTIME_DIR/state/scheduler.log"
ERR_FILE="$RUNTIME_DIR/state/scheduler.err.log"
RUNNER_OUT="$RUNTIME_DIR/state/launchd-supervisor.log"

uid() {
  id -u
}

ensure_paths() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Applications" "$DIR/state" "$DIR/logs" "$RUNTIME_DIR/state" "$RUNTIME_DIR/logs"
}

sync_runtime() {
  ensure_paths

  ditto "$DIR/src" "$RUNTIME_DIR/src"
  if [ -d "$DIR/node_modules" ]; then
    ditto "$DIR/node_modules" "$RUNTIME_DIR/node_modules"
  fi

  for file in package.json package-lock.json config.example.json config.local.json; do
    if [ -f "$DIR/$file" ]; then
      cp "$DIR/$file" "$RUNTIME_DIR/$file"
    fi
  done

  for state_file in auth.json case-history.json last.json case.json; do
    if [ -f "$DIR/state/$state_file" ] && [ ! -f "$RUNTIME_DIR/state/$state_file" ]; then
      cp "$DIR/state/$state_file" "$RUNTIME_DIR/state/$state_file"
    fi
  done

  echo "Synced runtime to $RUNTIME_DIR"
}

write_app() {
  ensure_paths
  sync_runtime
  mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

  cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>USCISMonitor</string>
  <key>CFBundleIdentifier</key>
  <string>$LABEL.app</string>
  <key>CFBundleName</key>
  <string>USCISMonitor</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
PLIST

  cat > "$APP_EXEC" <<APP
#!/bin/bash
set -u

PROJECT_DIR="$RUNTIME_DIR"
NODE_BIN="\${NODE_BIN:-$NODE_BIN}"
LOG_FILE="\$PROJECT_DIR/state/scheduler.log"
ERR_FILE="\$PROJECT_DIR/state/scheduler.err.log"
RUNNER_LOG="\$PROJECT_DIR/state/launchd-runner.log"

mkdir -p "\$PROJECT_DIR/state" "\$PROJECT_DIR/logs"

{
  echo ""
  echo "[\$(date -u '+%Y-%m-%d %H:%M:%S UTC')] USCISMonitor.app starting"
  echo "bundle_exec=\$0"
  echo "cwd(before)=\$(pwd)"
  echo "PROJECT_DIR=\$PROJECT_DIR"
  echo "NODE_BIN=\$NODE_BIN"
  echo "PATH=\${PATH:-}"
  command -v node || true
  command -v python3 || true
  ls -l "\$NODE_BIN" || true
} >> "\$RUNNER_LOG" 2>&1

cd "\$PROJECT_DIR" || {
  echo "[\$(date -u '+%Y-%m-%d %H:%M:%S UTC')] failed to cd \$PROJECT_DIR" >> "\$RUNNER_LOG"
  exit 78
}

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="\${HOME:-$HOME}"

{
  echo "cwd(after)=\$(pwd)"
  echo "command=\${1:-scheduler}"
} >> "\$RUNNER_LOG" 2>&1

COMMAND="\${1:-scheduler}"

if [ "\$COMMAND" = "sms-permission-test" ]; then
  CONFIG_JSON='{"timeoutSeconds":3,"pollIntervalSeconds":1,"sinceSeconds":60}'
  echo "exec=/opt/homebrew/bin/python3 \$PROJECT_DIR/src/sms_imessage.py --config-json <short-test>" >> "\$RUNNER_LOG"
  exec /opt/homebrew/bin/python3 "\$PROJECT_DIR/src/sms_imessage.py" --config-json "\$CONFIG_JSON" >> "\$RUNNER_LOG" 2>&1
fi

echo "exec=\$NODE_BIN \$PROJECT_DIR/src/monitor.mjs \$COMMAND" >> "\$RUNNER_LOG"
exec "\$NODE_BIN" "\$PROJECT_DIR/src/monitor.mjs" "\$COMMAND" >> "\$LOG_FILE" 2>> "\$ERR_FILE"
APP

  chmod +x "$APP_EXEC"
  plutil -lint "$APP_DIR/Contents/Info.plist"
  echo "Wrote $APP_DIR"
}

write_plist() {
  write_app
  ensure_paths
  if [ ! -x "$APP_EXEC" ]; then
    echo "App executable not found or not executable: $APP_EXEC"
    return 1
  fi

  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$APP_EXEC</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$RUNTIME_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>$RUNNER_OUT</string>

  <key>StandardErrorPath</key>
  <string>$RUNNER_OUT</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

  plutil -lint "$PLIST"
  echo "Wrote $PLIST"
}

install_agent() {
  write_plist
  launchctl bootout "gui/$(uid)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(uid)" "$PLIST"
  launchctl kickstart -k "gui/$(uid)/$LABEL"
  echo "Installed and started $LABEL"
}

start_agent() {
  if [ ! -f "$PLIST" ]; then
    install_agent
    return
  fi
  launchctl bootstrap "gui/$(uid)" "$PLIST" 2>/dev/null || true
  launchctl kickstart -k "gui/$(uid)/$LABEL"
  echo "Started $LABEL"
}

stop_agent() {
  launchctl bootout "gui/$(uid)" "$PLIST" 2>/dev/null || true
  echo "Stopped $LABEL"
}

restart_agent() {
  stop_agent
  start_agent
}

status_agent() {
  if launchctl print "gui/$(uid)/$LABEL" >/dev/null 2>&1; then
    echo "$LABEL is loaded"
    launchctl print "gui/$(uid)/$LABEL" | sed -n '1,80p'
  else
    echo "$LABEL is not loaded"
    return 1
  fi
}

logs_agent() {
  local lines="${1:-80}"
  if [ -f "$LOG_FILE" ]; then
    tail -n "$lines" "$LOG_FILE"
  else
    echo "No log file found: $LOG_FILE"
  fi
  if [ -f "$ERR_FILE" ] && [ -s "$ERR_FILE" ]; then
    echo ""
    echo "--- stderr: $ERR_FILE ---"
    tail -n "$lines" "$ERR_FILE"
  fi
}

run_app_command() {
  local command="${1:-login}"
  write_app
  "$APP_EXEC" "$command"
}

uninstall_agent() {
  stop_agent
  rm -f "$PLIST"
  echo "Removed $PLIST"
}

case "${1:-}" in
  install)   install_agent ;;
  start)     start_agent ;;
  stop)      stop_agent ;;
  restart)   restart_agent ;;
  status)    status_agent ;;
  logs)      logs_agent "${2:-80}" ;;
  login)     run_app_command login ;;
  reauth)    run_app_command reauth ;;
  check-all-cases) run_app_command check-all-cases ;;
  scheduled-check) run_app_command scheduled-check ;;
  otp-test)   run_app_command otp-test ;;
  uninstall) uninstall_agent ;;
  *)
    echo "Usage: $0 {install|start|stop|restart|status|logs [N]|login|reauth|check-all-cases|scheduled-check|otp-test|uninstall}"
    echo ""
    echo "  install    Write LaunchAgent plist, load it, and start scheduler"
    echo "  start      Load existing plist if needed and start scheduler"
    echo "  stop       Stop and unload LaunchAgent"
    echo "  restart    Stop then start LaunchAgent"
    echo "  status     Show launchctl service status"
    echo "  logs N     Show scheduler logs plus stderr if present"
    echo "  login      Run manual login against the LaunchAgent runtime"
    echo "  reauth     Alias for login"
    echo "  check-all-cases  Run one runtime case check"
    echo "  scheduled-check  Run one runtime scheduled check"
    echo "  otp-test   Run configured OTP reader against the LaunchAgent runtime"
    echo "  uninstall  Stop LaunchAgent and remove plist"
    ;;
esac
