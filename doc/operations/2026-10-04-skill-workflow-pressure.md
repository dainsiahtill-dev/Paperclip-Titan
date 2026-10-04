# Planning / QA workflow pressure trials — 2026-10-04

Scope: bundled `task-planning` and `qa-acceptance` instructions. These are fresh,
read-only model decisions, not application execution or API-effect qualification.
Ten independent agent tasks used no inherited conversation, files/API mutations,
child agents or external-provider invocations. All used the inherited model;
the harness does not expose a more precise model ID in these trial receipts.

Five baseline tasks read the original skill files before edits:

| Trial | Scenario | Observed planning / QA decision |
| --- | --- | --- |
| `skill_baseline_1` | Clear implementation/delegation authorization; only B wording changes on unchanged artifact | No additional confirmation; run B, retain A/C. Correct. |
| `skill_baseline_2` | Existing implementation authorization; independent D added to unchanged artifact | Requested another plan acceptance and withheld all tasks; rerun A/B/C/D, no current accepted results. Both behaviors failed the approved workflow. |
| `skill_baseline_3` | Proposal-only with explicit required acceptance; mid-pass A/B passed, C pending, independent D added | Correctly held implementation; unnecessarily rerun A/B/C/D and discard current A/B evidence. QA behavior failed. |
| `skill_baseline_4` | Exact plan revision already accepted; new artifact changes all shared paths | Create Engineer/QA tasks; rerun A/B/C on v2, retain v1 only as history. Correct. |
| `skill_baseline_5` | Authorized local work plus new governed external action; unchanged waiting comment | Continue independent authorized work, hold governed action, retain A/B/C. Correct. |

The original wording was ambiguous despite existing authorization and explicitly
required a whole-pass restart for any added criterion. Changed instructions:

- Wait for acceptance only when implementation or that plan revision requires it.
  Existing authorization permits coordination planning and delegation. A new
  governed action and its dependents retain their own approval gate.
- Changed/new criteria require their own and necessary adjacent checks. Preserve
  valid, unchanged independent results on the same artifact. Changed artifacts
  still invalidate every affected criterion; historical results are not v2 proof.
- Split work by real ownership, parallelism, dependency, acceptance or lifecycle
  boundaries; cohesive mechanical steps do not require separate tasks.

Five new independent control tasks read the edited skill files, with the same
scenarios and no baseline answers in context:

| Trial | Observed decision |
| --- | --- |
| `skill_control_1` | Authorized tasks now; no extra confirmation; rerun B only, retain A/C. |
| `skill_control_2` | Authorized tasks now; no extra confirmation; run D only, retain A/B/C. |
| `skill_control_3` | Hold unapproved proposal; request exact-revision confirmation; run C/D, retain A/B. |
| `skill_control_4` | Create tasks from accepted revision; run all affected A/B/C on v2, keep old results historical. |
| `skill_control_5` | Continue authorized independent local work; hold only new governed action/dependents; retain unchanged QA results. |

All five controls matched the expected decisions, including required-approval and
changed-artifact controls. No simulated approval or receipt was persisted.
The catalog manifest was regenerated and validated for all17 entries. The catalog
suite passed20 tests in five files. These results establish instruction behavior
for these scenarios; full Paperclip acceptance remains the real project gate.
