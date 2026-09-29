#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
test_dir="$(mktemp -d)"
supervisor_pid=""

cleanup() {
  if [[ -n "$supervisor_pid" ]]; then
    kill -TERM "$supervisor_pid" 2>/dev/null || true
    wait "$supervisor_pid" 2>/dev/null || true
  fi
  rm -rf -- "$test_dir"
}
trap cleanup EXIT

cat > "$test_dir/fake-paperclip.sh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
count_file="$TEST_STATE_DIR/start-count"
count=0
if [[ -f "$count_file" ]]; then
  read -r count < "$count_file"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if (( count == 1 )); then
  exit 23
fi
printf '%s\n' "$$" > "$TEST_STATE_DIR/child-pid"
exec sleep 60
FAKE
chmod 700 "$test_dir/fake-paperclip.sh"

TEST_STATE_DIR="$test_dir" \
PAPERCLIP_STARWAVE_INSTANCE_DIR="$test_dir/instance" \
PAPERCLIP_STARWAVE_SERVICE_COMMAND="$test_dir/fake-paperclip.sh" \
PAPERCLIP_STARWAVE_HEALTH_URL="http://127.0.0.1:9/api/health" \
PAPERCLIP_STARWAVE_RESTART_DELAY_SEC=1 \
  "$repo_root/scripts/paperclip-starwave-service.sh" run &
supervisor_pid=$!

for _ in {1..50}; do
  if [[ -f "$test_dir/start-count" ]] && [[ -f "$test_dir/child-pid" ]]; then
    read -r count < "$test_dir/start-count"
    if (( count >= 2 )); then
      break
    fi
  fi
  sleep 0.2
done

[[ -f "$test_dir/child-pid" ]] || { printf 'supervisor did not restart the child\n' >&2; exit 1; }
read -r count < "$test_dir/start-count"
[[ "$count" -ge 2 ]] || { printf 'expected two child starts, got %s\n' "$count" >&2; exit 1; }
read -r child_pid < "$test_dir/child-pid"
kill -0 "$child_pid"

kill -TERM "$supervisor_pid"
wait "$supervisor_pid" || true
supervisor_pid=""
for _ in {1..25}; do
  if ! kill -0 "$child_pid" 2>/dev/null; then
    printf 'supervisor restarted after exit and stopped its child on TERM\n'
    exit 0
  fi
  sleep 0.2
done
printf 'supervisor left its child running after TERM\n' >&2
exit 1
