# Employee basic toolchain checks

The employee configuration page has a **Basic toolchain check**, separate from
its existing model/connection test. Save the employee first, open **Required tools
and expected settings**, apply the requirements to the draft, save, then run the
basic check. The board-only endpoint is `POST /api/agents/:id/basic-preflight`
with an empty JSON object. Request-body launch settings and credentials are rejected.

Declare requirements in `runtimeConfig.readinessRequirements`, for example:

```json
{
  "interpreters": ["python3", "git"],
  "skills": [{ "workspacePath": ".agents/skills/review/SKILL.md" }],
  "mcp": [{
    "connectionId": "11111111-1111-4111-8111-111111111111",
    "requiredTools": ["codegraph_explore"]
  }],
  "expected": {
    "cwd": "/absolute/existing/project",
    "target": "local",
    "sandbox": "read-only",
    "model": "gpt-6.1-sol",
    "effort": "high"
  }
}
```

The connection ID must name an existing company-approved stdio connection,
installed for the employee/company and allowed by its current tool profile and
grant. Register the already-installed executable through the existing approved
stdio template and Apps connection workflow. The reference does not authorize
commands, environment values, provider routing, credentials or new tool access.
Managed AI raw `-c`/configuration/auth override restrictions remain in force.

Supported probes use the employee's existing local cwd. They run fixed
interpreter `--version` probes or MCP `initialize`, `notifications/initialized`
and `tools/list`, under Linux Bubblewrap with read-only source, a disposable
private HOME, a separate PID namespace and denied network. They do not call a
model, create the project cwd, install packages, provision a remote target,
copy host credentials, or write connection-health records. Package launchers,
credential-bearing stdio and unsupported confinement/remote targets are reported
as unverified. No host fallback occurs for a remote selection.

Required skills are actual readable SKILL.md sources, either workspace-relative
paths or selected company skill keys whose files already exist under managed
storage or known company workspaces. Symlink escapes, absent/unreadable sources
and unmaterialized versions do not count as available. Source readability is
separate from delivery to a future employee home. A same-named MCP tool never
satisfies a skill requirement.

Results distinguish configured metadata, resolved commands/cwd, readable skill
sources, actually connected MCP servers, errors and unverified checks. They include
a timestamp, safe effective profile and evidence fingerprint. Model/effort checks
compare configuration only; they do not establish model entitlement or a successful
paid task. A check with no toolchain requirements is configuration-only/unverified.
The existing model test remains separate and may invoke the provider.

Local stdio runtime calls now require a host-produced run profile bound to the
company, employee, project and resolved workspace. Calls in the audit/read-only
profile use the same source-read-only process boundary; tool `readOnlyHint`
metadata cannot confer filesystem safety. Missing snapshots and remote/native
profiles without that binding fail closed. Existing board Test-tab calls bind to
the selected employee's saved local cwd rather than the control-plane cwd.
Ordinary non-read-only profiles retain their existing tool authorization and
filesystem behavior. This check does not qualify shared-writer lifetime ownership
or replace project delivery acceptance.
