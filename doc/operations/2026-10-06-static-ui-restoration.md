# Default3100 static UI restoration — 2026-10-06

The employee execution maintenance wrapper had explicitly selected
`PAPERCLIP_LOCAL_UI_MODE=dev`, overriding the previously qualified static default.
Actual `/POL/issues` HTML contained Vite and `/src/` references. This left the
delivered cold-loading improvement inactive in the current deployment.

The existing supervisor command now selects `static`. The original instance,
configuration, database and code checkout are retained. Before the controlled
restart, current UI source/assets identity verification passed; no rebuild or
new dependency was necessary. Formal hot-restart preflight found no active or
pending work. API and the exact verified default PostgreSQL process were stopped,
then the same supervisor restarted with the original config and `--no-repair`.
No business run was interrupted or dispatched.

Live SPA HTML contains hashed assets and no Vite/source-module references. Served
entry JS/CSS bytes match `ui/dist`. Identity:

- Source: `fc79f257123abe871fd2033a64c664ae9da23b4ed19424a81eea74a35b5a750d`
- Assets: `35f674c2d957c4686292913832cca2d96adbf038f48b862c485e8e3712af7c0e`

Five owned Windows Edge 154.0.4258.53 fresh-profile samples, each followed by a
same-context reload, were measured before and after. Both modes used the same
26 exact employee names, viewport, locale and 30/90/15-second navigation/readiness/
screenshot limits. Every sample passed with no HTTP/page errors; non-GET/HEAD and
off-origin requests were blocked. All owned browser profiles have empty remaining
process receipts. This is browser-cold evidence, not filesystem/server-cache-cold.

| Actual mode | Cold median | Reload median | Request evidence |
| --- | --- | --- | --- |
| Vite before restoration | 5.078 s | 4.067 s | About 600 responses; 330 source modules plus Vite/dependency traffic |
| Verified static | 1.620 s | 0.960 s | About 238 cold responses; 205 built assets; zero source/Vite traffic |

Company identities, all Polaris employee roles/model/runtime/permissions/budgets/
statuses, current task assignments/descriptions/policies and config bytes matched
the pre-restart snapshot. Backend health and startup recovery are ready. The
existing source protection and disabled wake settings remain effective. No model,
provider, Polaris source/test or product effects were invoked by this acceptance.

Actual employee-list, organization toggle and POL-6 original-task navigation passed
with 26 employees/cards and no page errors. One POST attempt was blocked by the
read-only test guard; no mutating request was sent. Browser teardown again proved
no owned processes remained. Sanitized [measurement evidence](evidence/2026-10-06-postboot-execution-repair/actual-qualification/static-ui-restoration.json)
includes all ten samples per mode, asset proofs, identity and state preservation.
Original HAR/trace/screenshots remain in protected operator diagnostics at
`/home/dains/.paperclip/diagnostics/postboot-execution-20261006/goal-continuation/static-ui-restoration/`.

The overall goal is incomplete. POL-6's known lexical proposal defect remains in
human review pending the unified strategy discussion; this UI restoration does
not establish Polaris repair, effects/settlement, TS5110 or fresh Bench acceptance.
