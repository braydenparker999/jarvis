# Preparation candidate independent review

A separate reviewer inspected the actual helper, fixtures and synthetic model.
One medium defect was reproduced: a caught preparation exception could retain
failed media in its traceback after the pool freed the slot. Fixed by dropping
all audio/metadata/cover/extension/artifact references before admission resumes
and raising sanitized exceptions after leaving the original exception context.
The regression retains the exception and inspects helper traceback locals.
Cancelled and stale results also drop payload references before freeing slots.

Independent final run: 145 Python R2 tests (14 preparation and 26 checkpoint),
plus 14 native server tests passed, zero failures/skips/cancellations. No further
substantiated defect was found. Primary-agent final runs agree; prep-specific
verbose log and synthetic schedule data are adjacent to this report.

Bounds require one global coordinator, bounded local callbacks and disciplined
consumer-reference release. They are not a process-RSS guarantee. Hung callbacks
cannot be reclaimed by age; explicit termination/join and resource enforcement
need real-wrapper integration. No network/provider concurrency is implemented or
increased here. No real throughput, target-filesystem or process-transition
qualification is claimed. The draft is for review; live activation is blocked.
