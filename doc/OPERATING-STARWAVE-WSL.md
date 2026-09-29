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

## Agent throughput and worktree policy

The Starwave instance keeps its primary project checkout at
`/home/dains/Documents/starwave-ai-bot`. Its execution-workspace policy is
enabled with a shared default and serialized shared-workspace runs. Isolated
workspaces are enabled for explicit issue overrides; the instance-wide
isolated-by-default flag stays off. This preserves active shared-tree work
while giving new independent coding tasks a separate branch and worktree.

The Starwave checkout tracks roughly 67 GB under `backend/runtime`. A normal
`git worktree add` began copying it and had already consumed 12 GB at 23%.
Never use Paperclip's automatic full-worktree creation for this repository.
For a new issue whose inputs are committed, create a sparse worktree first:

```sh
rtk proxy /home/dains/.nvm/versions/node/v24.13.0/bin/node /home/dains/Documents/paperclip/scripts/create-starwave-sparse-worktree.mjs \
  --repo /home/dains/Documents/starwave-ai-bot \
  --parent /home/dains/Documents/starwave-agent-worktrees \
  --issue SOU-159 --profile backend --max-mb 1536
```

Profiles are `backend`, `frontend`, `data`, and `qa`. The helper estimates
the sparse content size before creating a branch, then checks actual size.
It refuses an occupied branch/path and removes a newly created worktree if
the size check fails. The backend smoke profile materialized 385 MB and a
clean checkout; it omitted tracked `backend/runtime` data. After the helper
returns a branch and path, bind that **existing** branch to the issue:

```json
{
  "executionWorkspaceSettings": {
    "mode": "isolated_workspace",
    "workspaceStrategy": {
      "type": "git_worktree",
      "existingBranch": "paperclip-SOU-159",
      "worktreeParentDir": "/home/dains/Documents/starwave-agent-worktrees"
    }
  }
}
```

Use the real issue identifier in both commands. Do not enable an isolated
issue setting before its sparse worktree exists. Current shared tasks stay
on their existing checkout. The task owner records the branch, commit, tree and test evidence. The
engineering manager integrates one candidate into `main` only after resolving
shared-file ownership. QA receives the exact integrated commit/tree and runs
one independent check for that candidate. A changed candidate needs a new QA
identity. Keep holdout/gold outside developer worktrees and preserve
`trainingReady=false` until its separate gates pass.

Use an existing implementation issue for routine coordination, QA assignment,
verdict receipt and repair. Create a child issue when a different assignee has
an independently executable deliverable. A blocked issue with a live
`blockedByIssueIds` relation, pending interaction or approval should not also
carry a self-owned `unblockDescriptor` for the same wait. The server rejects
stale dependency wakes before provider invocation; explicit human comments
and valid newly ready dependencies remain wake paths.

The dashboard's Work evidence panel distinguishes run attempts, registered
work products and reviewed work products over 14 days. These are platform
records, not an automatic judgment that code or customer service is accepted.
Verify the project's frozen candidate, independent QA report and real
business evidence separately.

Before changing an active service, read its running issue/run IDs. After a
tested fork is integrated, use the existing task-drain/hot-restart procedure,
then verify `/api/health`, the dashboard API, and a real dependency wake. A
pre-change Starwave Agent/project/issue snapshot is stored under
`~/.paperclip/backups/agent-throughput-20260929/` for rollback and audit.
