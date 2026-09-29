#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
script_path="$repo_root/scripts/paperclip-starwave-service.sh"
instance_dir="${PAPERCLIP_STARWAVE_INSTANCE_DIR:-/home/dains/.paperclip/instances/default}"
service_command="${PAPERCLIP_STARWAVE_SERVICE_COMMAND:-$repo_root/scripts/run-starwave-local.sh}"
health_url="${PAPERCLIP_STARWAVE_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
session_name="${PAPERCLIP_STARWAVE_SESSION_NAME:-paperclip-starwave}"
restart_delay="${PAPERCLIP_STARWAVE_RESTART_DELAY_SEC:-5}"
socket_path="$instance_dir/paperclip-starwave.tmux.sock"
supervisor_log="$instance_dir/logs/paperclip-starwave-supervisor.log"
server_log="$instance_dir/logs/paperclip-starwave-server.log"

[[ "$restart_delay" =~ ^[0-9]+$ ]] && (( restart_delay > 0 )) || {
  printf 'PAPERCLIP_STARWAVE_RESTART_DELAY_SEC must be positive\n' >&2
  exit 2
}

mkdir -p -- "$instance_dir/logs"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >> "$supervisor_log"
}

session_exists() {
  tmux -S "$socket_path" has-session -t "=$session_name" 2>/dev/null
}

run_supervisor() {
  exec 9>"$instance_dir/paperclip-starwave.lock"
  if ! flock -n 9; then
    log "another Paperclip supervisor owns the instance lock"
    return 0
  fi

  local child_pid=""
  local stopping=0
  local delay="$restart_delay"
  local started_at finished_at exit_code
  stop_child() {
    stopping=1
    if [[ -n "$child_pid" ]]; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
  }
  trap stop_child INT TERM HUP
  log "supervisor started pid=$$"

  while (( stopping == 0 )); do
    # A manually started Paperclip may already own the API. Adopt service
    # responsibility only after that instance exits; never race port 3100.
    if [[ -z "${PAPERCLIP_STARWAVE_SERVICE_COMMAND:-}" ]] &&
      curl --silent --fail --max-time 2 "$health_url" >/dev/null; then
      sleep 10
      continue
    fi

    started_at="$(date +%s)"
    log "starting Paperclip command=$service_command"
    PAPERCLIP_LOG_LEVEL="${PAPERCLIP_LOG_LEVEL:-warn}" \
      "$service_command" 9>&- >> "$server_log" 2>&1 &
    child_pid=$!
    if wait "$child_pid"; then
      exit_code=0
    else
      exit_code=$?
    fi
    # A signal can interrupt wait before the child fully stops.
    if (( stopping != 0 )); then
      wait "$child_pid" 2>/dev/null || true
      child_pid=""
      break
    fi
    child_pid=""
    finished_at="$(date +%s)"
    log "Paperclip exited code=$exit_code runtimeSec=$((finished_at - started_at)); restart in ${delay}s"
    sleep "$delay"
    if (( finished_at - started_at < 60 )); then
      delay=$((delay * 2))
      (( delay > 60 )) && delay=60
    else
      delay="$restart_delay"
    fi
  done
  log "supervisor stopped"
}

case "${1:-}" in
  start)
    if session_exists; then
      printf 'Paperclip supervisor already running\n'
      exit 0
    fi
    printf -v launch_command 'exec %q run' "$script_path"
    tmux -S "$socket_path" new-session -d -s "$session_name" "$launch_command"
    session_exists || { printf 'Paperclip supervisor did not start\n' >&2; exit 1; }
    printf 'Paperclip supervisor started in tmux session %s\n' "$session_name"
    ;;
  run)
    run_supervisor
    ;;
  status)
    if session_exists; then
      printf 'supervisor=running '
    else
      printf 'supervisor=stopped '
    fi
    printf 'health_http='
    curl --silent --output /dev/null --write-out '%{http_code}\n' --max-time 3 "$health_url" || true
    ;;
  stop)
    if ! session_exists; then
      printf 'Paperclip supervisor is not running\n'
      exit 0
    fi
    tmux -S "$socket_path" send-keys -t "=$session_name" C-c
    for _ in {1..50}; do
      session_exists || { printf 'Paperclip supervisor stopped\n'; exit 0; }
      sleep 0.2
    done
    printf 'Paperclip supervisor has not stopped yet; inspect its active run\n' >&2
    exit 1
    ;;
  *)
    printf 'Usage: %s {start|status|stop}\n' "$0" >&2
    exit 2
    ;;
esac
