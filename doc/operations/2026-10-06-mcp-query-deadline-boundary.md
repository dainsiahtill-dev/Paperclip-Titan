# Actual governed MCP query deadline — 2026-10-06

Status: current failure reproduced and localized to request processing; dependency
performance cause remains open. No deadline, sandbox, connection grant, source or
tool version was changed. No model/provider call was made.

The historical POL-11 broad CodeGraph request was repeated once through the public
company-scoped connection Test API using the existing implementation employee and
approved local-stdio connection. It returned an allowed invocation, HTTP200 with a
real `stdio_timeout` error after **10,350 ms**. HTTP200 is not tool success.

A separate confined stage control with the same 10,000 ms budget completed MCP
initialize in **248 ms**, then expired during the query at **10,095 ms**. Its exact
owned process is absent afterward. A distinct exact-symbol positive control through
the same public API completed in **1,938 ms**, with protocol `isError:false` and
9,148 characters of real exploration. These controls classify the boundary; the
successful smaller query does not qualify the original broad query.

The installed CodeGraph 1.5.0 `handleExplore` source performs
`findRelevantContext(searchLimit=8, traversalDepth=3, maxNodes=200)` before applying
`maxFiles` to result ranking/rendering. Thus `maxFiles=1` does not bound graph-search
cost. The current Polaris index reports 6,869 files and a 611.19 MB database. Older
daemon lock/EPIPE logs are not time-correlated with these calls and are not claimed
as their cause. WSL, model admission and the initialize handshake are not established
causes of this reproduced query overrun.

Remaining diagnosis should measure the dependency's actual query phases and
contention under the existing deadline, then choose an owner-scoped performance
or execution-contract correction. Do not globally increase the timeout, upgrade
the tool, edit Polaris, replay completed business work, or call exact-symbol
success a comprehensive fix. Existing successful employee exact queries, source
protection and semantic-error propagation remain valid bounded evidence.

Inspect [sanitized current evidence](evidence/2026-10-06-postboot-execution-repair/actual-qualification/mcp-query-deadline-boundary.json).
Original full responses and stage control are retained at
`/home/dains/.paperclip/diagnostics/postboot-execution-20261006/goal-continuation/mcp-deadline-current/`.

## Confirmed daemon/PID namespace compatibility

A later process-tree/log correlation localizes an additional execution problem.
CodeGraph's isolated proxy had host PID87583 and namespace PID2. Its client hello
publishes `process.pid=2`; the existing host daemon tests that number as a host PID.
The same observation interval logged `Reaping client with dead peer (pid 2)` while
the actual client was alive. The client then performed local fallback work and
reached the unchanged deadline in `folio_wait_bit_common` with additional reads.
The installed proxy source explicitly re-serves in-flight requests locally after
daemon loss. This is confirmed namespace/liveness incompatibility, not a WSL
unsupported diagnosis or an invented old process-group exit proof.

One supported, unpublished `CODEGRAPH_NO_DAEMON=1` control retained all sandbox
settings and avoided any host-daemon activity, but still timed out at10.173seconds.
Its local Node consumed approximately8.01seconds CPU and100MB disk reads by the
last observation. Therefore direct mode alone is not a qualified replacement.
A separate broad control completed8.222seconds; its isolated proxy used little
CPU, consistent with a successful shared-daemon path. That success does not erase
the observed disconnection and failures.

Further correction needs an owner-scoped confined persistent MCP lifetime or
namespace-aware dependency transport/liveness support, with real source-write
denial, Stop/drain and next-dispatch acceptance. Host-daemon PID trust must not be
reintroduced by disabling process isolation. No such runtime/configuration change
has been published. Installed dependency and Polaris source remain unchanged.
See [correlated evidence](evidence/2026-10-06-postboot-execution-repair/actual-qualification/mcp-daemon-namespace-compatibility.json).
