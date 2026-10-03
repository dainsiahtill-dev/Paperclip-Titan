# Dependency scheduling tests: current ready-state inputs

## Evidence and scope

The completed server suite contains 37 failed tests. A focused seven-test dependency scheduling run reproduces two failures: the intended successful wakes are cancelled before provider work. This document covers those two failures only; the complete suite is not green.

A diagnostic read of the first run reports `issue_dependency_wake_stale` / `children_not_terminal`. Its fixture has no children or blocker edges and uses `native-parent:<issue>` rather than a current ready-state key. The second fixture resolves a blocker but sends no ready-state key. The current claim gate intentionally rejects both inputs. The native status committer already emits the shared child/blocker ready-state keys.

## Change

Update the test inputs to exercise genuine readiness: a terminal child and resolved blocker edge for the coalescing case, and the shared current blocker-state key for the resolution case. Keep all success, coalescing, and concurrency assertions. Drain tracked wakeups and follow-up executions before teardown mutates the test database; draining only the original run IDs leaves a late event-insert window. Do not change runtime admission, edge checks, source identity, state-key checks, or operator permissions.

## Verification and limits

Run the focused dependency scheduling suite again and the existing issue liveness escalation suite, which covers stale/reopened dependencies and superseded child wakes. This establishes current valid wake success while retaining stale-wake rejection. No production database, running agent, controller restart, or Starwave evaluation service changes are needed. Other full-suite failures require separate attribution.

Verified with Node 24: both suites pass, **33 tests passed**, including current blocker resolution/coalescing and stale/reopened dependency rejection. The first focused run had two failed success assertions; after correcting fixtures a combined run exposed teardown foreign-key races, resolved by the existing complete execution-drain API. Final saved output: `/tmp/paperclip-dependency-ready-state-final-20261003.log` (90.05 seconds). This result does not replace the earlier 37-failure full-suite result or claim that its remaining failures are fixed.
