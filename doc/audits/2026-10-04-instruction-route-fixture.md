# Instruction route fixture preparation

The unchanged suite reproduced two failures: the first request test timed out
after 15 seconds, then the external-instructions permission test observed a
`getBundle` call from that previous request. A request-owner trace measured the
first actual router import at 17,584 ms; its `local-board` request reached the
server during the following `company-admin` case. Every company-admin request
still returned 403. The permission check was intact.

Prepare the actual router and middleware in `beforeEach`, after registering
the per-case mocks and defaults. Keep module resets, request timeouts, all
permission assertions and all no-service-call assertions unchanged. This moves
server preparation to its fixture boundary and prevents late prior requests
from observing another case's shared mock state.

Validation: the isolated branch reproduced the original 2 failures / 13 passes
before this fixture change. The complete suite then passed 15/15 in 29.87 seconds
with its original budgets. No production source or permission rule changed.
Separate unchanged checks passed first-admin claim 2/2 and company service 19/19;
their earlier broad failures occurred in database setup hooks.
