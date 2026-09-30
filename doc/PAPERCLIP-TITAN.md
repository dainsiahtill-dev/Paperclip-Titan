# Paperclip-Titan maintenance notes

This repository keeps the upstream Paperclip source and its MIT license while
maintaining the local extensions below.

## Models and local accounts

- Codex exposes GPT-6.1-Sol, GPT-6 Astra/Sol/Luna and existing model choices.
  GPT-6.1-Sol uses its exact `gpt-6.1-sol` ID, supports low/medium/high/xhigh/max/ultra
  reasoning and Fast mode, and selects the CLI engine in auto mode.
- GPT-6 Luna starts at xhigh on this deployment. Explicit engine choices remain
  authoritative.
- Claude supports custom model IDs for providers configured by CC-Switch.
  Choose the CLI engine for a local Claude/CC-Switch provider and configure its
  permission controls in the Agent settings.
- Account credentials and company configuration belong to the local Paperclip
  instance. They are configured during deployment.

## Capacity and recovery

Settings → General → Agent concurrency supports an optional instance maximum
and shared subscription groups. For a MiniMax subscription with six sessions,
create `minimax` with limit 6 and select that group on the relevant Agents.

The maintained scheduler reconciles released capacity, runs retention scans in
the background without overlapping passes, distinguishes subscription quota
from transient provider failures, and reports a permanent continuation ancestry
limit instead of leaving an unclaimable task queued.

## Verification and updates

Use Node 24.11 or newer and pnpm. Follow `doc/DEVELOPING.md` for running and
deploying the service. Inspect active Agent runs before restarting and verify
their continuity or explicit recovery after deployment.

Upstream updates can be fetched from the `upstream` remote. The maintained
version is published at `dainsiahtill-dev/Paperclip-Titan` on `main`.
