#!/bin/bash
# USCIS Case Monitor - Daemon Management Script

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/state/scheduler.pid"
LOG_FILE="$DIR/state/scheduler.log"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
SCREEN_SESSION="uscis-monitor"

screen_running() {
  command -v screen >/dev/null 2>&1 && screen -list | grep -q "[.]$SCREEN_SESSION[[:space:]]"
}

scheduler_node_pids() {
  local pid command
  for pid in $(pgrep -f "src/monitor.mjs scheduler" 2>/dev/null); do
    command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if echo "$command" | grep -Eq '^([^[:space:]]*/)?node[[:space:]]+src/monitor[.]mjs[[:space:]]+scheduler([[:space:]]|$)'; then
      echo "$pid"
    fi
  done
}

start() {
  if screen_running; then
    echo "⚠️  Scheduler already running in screen session $SCREEN_SESSION"
    return 1
  fi

  local existing_pids
  existing_pids=$(scheduler_node_pids | xargs)
  if [ -n "$existing_pids" ]; then
    echo "⚠️  Scheduler already running (Node PID(s): $existing_pids)"
    return 1
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  Scheduler already running (PID $(cat "$PID_FILE"))"
    return 1
  fi

  echo "🚀 Starting USCIS scheduler in background..."
  if command -v screen >/dev/null 2>&1; then
    screen -dmS "$SCREEN_SESSION" /bin/zsh -lc "cd \"$DIR\" && export PATH=\"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\" && exec \"$NODE_BIN\" src/monitor.mjs scheduler >> \"$LOG_FILE\" 2>&1"
    rm -f "$PID_FILE"
    echo "✅ Scheduler started in screen session $SCREEN_SESSION"
  else
    cd "$DIR"
    export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    nohup "$NODE_BIN" src/monitor.mjs scheduler >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    echo "✅ Scheduler started (PID $pid)"
  fi
  echo "   Log: $LOG_FILE"
}

stop() {
  if screen_running; then
    screen -S "$SCREEN_SESSION" -X quit
    rm -f "$PID_FILE"
    echo "🛑 Scheduler stopped (screen session $SCREEN_SESSION)"
  fi

  local node_pids
  node_pids=$(scheduler_node_pids | xargs)
  if [ -n "$node_pids" ]; then
    for pid in $node_pids; do
      kill "$pid" 2>/dev/null || true
    done
    echo "🛑 Scheduler stopped (Node PID(s): $node_pids)"
    rm -f "$PID_FILE"
    return
  fi

  if [ ! -f "$PID_FILE" ]; then
    echo "⚠️  No PID file found. Scheduler not running?"
    return 1
  fi

  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    rm -f "$PID_FILE"
    echo "🛑 Scheduler stopped (PID $pid)"
  else
    rm -f "$PID_FILE"
    echo "⚠️  Process $pid not found. Cleaned up stale PID file."
  fi
}

status() {
  local node_pids
  node_pids=$(scheduler_node_pids | xargs)

  if screen_running; then
    if [ -n "$node_pids" ]; then
      local count
      count=$(echo "$node_pids" | wc -w | xargs)
      if [ "$count" -gt 1 ]; then
        echo "⚠️  Scheduler screen is running, but duplicate Node schedulers exist (PID(s): $node_pids)"
      else
        echo "✅ Scheduler is running in screen session $SCREEN_SESSION (Node PID $node_pids)"
      fi
    else
      echo "⚠️  Scheduler screen exists, but no Node scheduler process was found"
    fi
    return
  fi

  if [ -n "$node_pids" ]; then
    echo "⚠️  Scheduler is running outside screen (Node PID(s): $node_pids)"
    return
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    local pid
    pid=$(cat "$PID_FILE")
    local uptime
    uptime=$(ps -p "$pid" -o etime= 2>/dev/null | xargs)
    echo "✅ Scheduler is running (PID $pid, uptime $uptime)"
  else
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
    echo "❌ Scheduler is not running"
  fi
}

logs() {
  local lines="${1:-50}"
  if [ -f "$LOG_FILE" ]; then
    tail -n "$lines" "$LOG_FILE"
  else
    echo "No log file found."
  fi
}

follow() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    echo "No log file found."
  fi
}

restart() {
  stop 2>/dev/null
  sleep 1
  start
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  status)  status ;;
  logs)    logs "$2" ;;
  follow)  follow ;;
  restart) restart ;;
  *)
    echo "Usage: $0 {start|stop|status|restart|logs [N]|follow}"
    echo ""
    echo "  start    Start scheduler in background"
    echo "  stop     Stop scheduler"
    echo "  status   Check if scheduler is running"
    echo "  restart  Stop and restart scheduler"
    echo "  logs N   Show last N lines of log (default 50)"
    echo "  follow   Tail log in real time (Ctrl+C to stop)"
    ;;
esac
