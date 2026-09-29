# Starwave local Paperclip service on WSL

This machine runs the maintained Paperclip checkout at
`/home/dains/Documents/paperclip` with instance `default` on loopback port
3100. WSL uses `/init` rather than systemd, so a foreground `paperclipai run`
attached to a terminal or API execution session is not a persistent service.

## Runtime ownership

`scripts/paperclip-starwave-service.sh start` creates a detached tmux session
named `paperclip-starwave`. The session runs `scripts/run-starwave-local.sh`
under a single-instance `flock`. If Paperclip exits, the supervisor records
the exit and restarts it with bounded backoff. A live manually started API is
left alone until it exits. The server uses Node 24 and the existing instance
config/database; the supervisor does not install another Paperclip instance.

Commands from this checkout:

```sh
rtk proxy scripts/paperclip-starwave-service.sh start
rtk proxy scripts/paperclip-starwave-service.sh status
rtk proxy curl -fsS http://127.0.0.1:3100/api/health
```

`stop` sends an interrupt to the supervisor and its child. Drain active Agent
runs through `/api/instance/task-drain` before using it. Do not send Ctrl-C to
an interactive parent and assume active child runs were handed off: on this
machine that previously produced a `missing_shutdown_snapshot` hot-restart
report and an interrupted run requiring explicit reconciliation.

The supervisor socket, lock, and logs live under
`~/.paperclip/instances/default/`. Both logs are mode 0600. The supervised
server defaults to warning-level logs so routine workspace scans do not grow
the log rapidly. Inspect:

```sh
rtk proxy tail -n 40 /home/dains/.paperclip/instances/default/logs/paperclip-starwave-supervisor.log
rtk proxy tail -n 40 /home/dains/.paperclip/instances/default/logs/paperclip-starwave-server.log
```

## Windows login startup

The current Windows user has
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PaperclipStarwave.cmd`.
It runs:

```bat
"C:\Windows\System32\wsl.exe" -d Ubuntu -u dains --exec /home/dains/Documents/paperclip/scripts/paperclip-starwave-service.sh start
```

The control script is idempotent, so both a login launch and a manual `start`
are safe. Windows Task Scheduler registration was denied for this user; the
Startup folder requires no administrator permission. A deliberate `wsl
--shutdown` during an existing Windows login stops tmux and requires a manual
`start`; a later Windows login runs the Startup entry again.

Verify from Windows as well as WSL:

```powershell
curl.exe --noproxy '*' http://localhost:3100/api/health
curl.exe --noproxy '*' http://localhost:3100/SOU/dashboard
```

## Diagnosis

On 2026-09-29, WSL uptime continued, embedded PostgreSQL stayed listening,
port 3100 had no listener, and the former server log ended without an
application fatal error. The old service was attached to an interactive PTY
with no service manager; its execution session had ended. The persistent tmux
supervisor addresses that observed process-lifetime failure. If the API is
unreachable while the tmux session and Paperclip child both remain alive,
inspect the server log and run diagnostics before restarting or killing active
Agent runs.
