# Adapter fixture and bundled skill verification

Owned isolated worktree: delivery-adapters-20261004, branch fix/delivery-adapters-20261004, exact frozen Root d2a17bf011724ee0e1713f67dbebaa2bb38a24bd. Offline frozen ignore-scripts dependency install with explicit Node24.13 PATH; no main dependency symlink. Tests use fresh /tmp PAPERCLIP_HOME/config and unset DB/provider credential variables. No production config/service/database, real model, business message or copied credential was used.

## Source versus fixture causes

Fresh isolated three-file baseline reproduced exactly11 failures/93 tests43.28s. Five intended-resume Claude fixtures supplied null persisted model identity, while existing44988fa43 intentionally rotates legacy/mismatched sessions. They now supply modelIdentity/cwd matching their explicit selected fake-CLI model, preserving the actual guard. Two added negative controls prove absent/mismatched identity still starts fresh and retains model choice. Claude/Codex usage equality now asserts totalTokens2 alongside input1/cache0/output1. Codex managed-config fixtures retain the same model and assert shell policy inherit=all, ignore_default_excludes=true and all six PAPERCLIP identity/API vars plus CODEX_HOME. Model, guard, accounting and immutable scope production code are unchanged.

The three managed-AI runtime fixtures omitted cwd; project-auth scanning therefore read the actual worktree's ancestor .claude settings and correctly rejected its auth overrides. Their configured cwd now points to their own empty temporary fixture home. Provider defaults, personal/shared access, encryption and project-auth production guards are unchanged.

Fresh AgentMail integration reproduced2 failures/26 tests38.95s: applyConnectorSkills selected an existing ancestor .claude/skills directory missing agentmail/SKILL.md before its valid supplied bundled root. This is a production bootstrap defect, not an email service or credential defect. The resolver now accepts an optional required runtime skill name, rejects unsafe path segments, and checks each candidate's actual named SKILL.md. Existing two-argument callers retain their ordering and behavior. Connector bootstrap passes its trusted connector skill name. No email-service mutation or host configuration copy.

The synthetic resolver RED2/2 proved incomplete-root selection and missing traversal validation. Its first temporary fixture used insufficient directory depth, so its candidate resolved to /tmp/skills; the fixture was immediately corrected to keep every path under its own mkdtemp root and rerun RED2/2 before the production fix. Final fixture cleanup removes only its own root; no protected Paperclip service/data/config path was involved.

## Verification

Six-file owned gate240/240, zero skipped85.01s: full adapter/AIconnection93, email26, resolver2, existing server-utils119 (/tmp/paperclip-adapters-full-owned-green-20261004.log). After adding the two model-identity negative controls, Claude+resolver33/33 passed9.61s (/tmp/paperclip-adapters-negative-controls-green-20261004.log). Adapter-utils typecheck passed (/tmp/paperclip-adapters-utility-types-20261004.log). No timeout, threshold, skip or model was changed.

Only production changes: packages/adapter-utils/src/server-utils.ts resolvePaperclipSkillsDir optional requiredSkillName validation/candidate lookup; server/src/services/connector-runtime.ts passes connector.skillName. Other changes are scoped fixtures, resolver regression and this evidence. Root combined full suites/source freeze/real application remain separate qualification. Subsequent hire/catalog failures are being diagnosed under a separate scoped follow-up.
