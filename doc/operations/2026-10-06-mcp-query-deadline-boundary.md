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
