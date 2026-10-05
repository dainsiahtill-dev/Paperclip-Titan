# Local compiled UI startup

The WSL local launcher `scripts/run-starwave-local.sh` defaults to compiled UI.
It verifies `ui/dist/paperclip-build.json`, explicitly disables Vite middleware,
enables UI serving (`SERVE_UI=true`), and selects this checkout's `ui/dist` through
`PAPERCLIP_UI_DIST_PATH`. `NODE_ENV=production` alone does not select static serving.

Build the interface with the installed Node 24 environment before a managed
restart. Build and deployment remain separate operations:

```sh
rtk proxy env NODE_ENV=production pnpm --filter @paperclipai/ui build
rtk proxy node scripts/ui-build-identity.mjs verify
```

The UI build writes fingerprints of runtime UI source, public files, build
configuration, and directly referenced workspace package source/output, plus all
compiled assets. Static startup refuses missing identity, changed source, or
changed output and names the rebuild command. Git HEAD is not the freshness gate:
document-only commits do not invalidate the UI, and uncommitted runtime changes do.
The verifier reads files; it neither builds nor changes instance data or credentials.

Normal local startup uses the existing instance/config and ownership procedure.
Do not run a second server on an occupied port. The launcher does not rebuild the
native runner or invoke a repository-wide build on restart. Existing CLI doctor
checks still apply. A doctor failure remains a startup failure; do not copy host
credentials or install metadata into an isolated instance to hide it.

Source development remains explicit:

```sh
rtk proxy env PAPERCLIP_LOCAL_UI_MODE=dev bash scripts/run-starwave-local.sh
```

`PAPERCLIP_LOCAL_UI_MODE=static` is the default; unknown mode values fail. The
source CLI outside this launcher retains its convenient Vite default. An explicit
`PAPERCLIP_UI_DEV_MIDDLEWARE=false` remains necessary for direct source CLI static
startup. Direct static server consumers can set `PAPERCLIP_UI_DIST_PATH`; a missing
explicit directory fails instead of silently serving another build. Without an
explicit path, source servers prefer checkout `ui/dist`, then bundled assets;
published servers prefer bundled `server/ui-dist`, then checkout assets.

After startup, verify `/api/health`, the actual listening PID/config identity, SPA
HTML with hashed `/assets/` URLs and no `/src/` or `/@vite/client`, and entry asset
bytes against the selected build. Hashed assets retain immutable caching; HTML
and service worker retain revalidation. API health alone does not prove employee
content or interaction readiness.

## Loading and navigation

The HTML entry shows loading feedback before React loads, with reload recovery
for entry network failure or an early dependency exception. Entry recovery is
limited to the initial placeholder; later failures stay with React boundaries. Existing application and route error boundaries remain. Route
modules and the unselected layout load on navigation. Employee route metadata
lives outside the page module so importing route names does not load the page.
Closed new-entity dialogs and onboarding do not load editor/configuration modules;
once requested, dialogs stay mounted after closing so drafts and exit/focus effects
survive. Hierarchy loading and request failure have visible feedback and retry. Failed
company-list bootstrap has its own retry gate inside the existing access gate;
a genuine empty company list retains existing onboarding behavior.

## Reproducible private browser verification

Use the same public employee fixture, browser version, viewport, locale, and UI
settings for compiled and source modes. Record source/build fingerprints and the
loaded backend version separately. A read-only proxy may project the current
canonical UUID `urlKey` on a copied public roster; label that projection and retain
all other public fields. It does not verify deployment of the new backend.

Keep navigation 30 seconds, employee readiness 90 seconds, and screenshot 15
seconds. Run five fresh browser/profile samples per mode, each followed by reload
in that same context. Validate all exact employee names, list/org controls, actual
hierarchy, and the real stable-ID employee link/detail. Record every failed sample;
collect HAR, trace, screenshot, request category/bytes, timing and page/HTTP errors.
Fresh browser cache does not establish a process-cold Vite server or cold filesystem.

Block all non-GET/HEAD and off-origin requests before sending; block service
workers. Use a fresh owned browser profile with process-start/PID proof; tear down
only that profile and verify remaining processes. Retain baseline failures and
redact headers, cookies, tokens and response bodies in shared HARs. Private UI
screenshots/traces need their own artifact disposition. No provider/model calls or
live instance mutations are required for these checks.

Author's private startup proof used a new empty instance and direct source server
entry under explicit static flags; the isolated local CLI doctor rejected missing
private installation metadata. That is static server/asset proof, not full managed
launcher qualification. Final managed startup and real forms acceptance belong to
the reviewed deployment step.
