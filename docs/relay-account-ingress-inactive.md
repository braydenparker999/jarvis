# Inactive account admission components

This change adds executable refusal boundaries and local preparation/catalog
construction adapters. It changes no production configuration, binding, schedule,
credential, grant, source release pin or activation. Missing admission mode
preserves existing Worker behavior. Setting any mode is not production readiness:
`RELAY_ACCOUNT_ADMISSION_MODE=enforced` deliberately refuses every affected Hub
request until a finite trusted upstream gate and authenticated transport exist.
Unknown mode/authority also refuses. Public headers, principal fields, budgets,
callbacks, approval flags and serialized receipts cannot authorize work.

The Worker boundary precedes Relay/OAuth/owner/MCP/shared/legacy workspace dispatch.
The Hub boundary independently precedes every SQL/KV fetch path; direct public
sync, wake and alarm methods and exported shared operations are also covered.
Requested enforcement bounds actual body bytes/chunks/time before any JSON parse
or admission. Denied alarms return without schema, scheduling or Hub KV access;
they do not rearm a retry loop. An admitted future recovery must separately restore
a pending wake. Non-Hub music/Poweramp, Podcasts, Songsterr, health and discovery
metadata retain their existing behavior. Their platform/provider costs remain
outside this Hub counter proof and need an ordinary-traffic reserve.

The internal preparation adapter accepts only the genuine allocator module engine,
checks its provisioned source/catalog/evidence/scope allocation, binds scope to the
native durable-object ID, snapshots input before awaits, pays and consumes a local
one-use receipt with monotonic elapsed-time and cached issuer-confidence revalidation after awaits, and then uses the existing bounded preflight permit/step. The
allocator's preparation identities cover spent/lost acknowledgements without
refund. Complete native reports receive a private in-memory brand; report JSON
cannot unlock final construction. The final adapter refreshes paid reports,
reserves the full all-scope modeled construction, and rechecks exact checkpoint,
catalog signature and mutation revisions inside each Hub transaction after the
reservation await before applying any missing catalog DDL. A second final grant,
revoked authority, expired receipt/evidence or UTC-day rollover during an await, stale day, forged report, missing scope or changed source fails
closed. A failed/partial construction keeps its spend and cannot enable ordinary
traffic.

Final construction installs schema only. Public/private replay, private feed
backfill, runtime wake recovery and ordinary operation admission are pending;
`schema_constructed` does not mean data migration or activation complete. Per-Hub
transactions do not make all Hubs a single atomic SQL transaction. Native row
metering verifies the reviewed model in fixtures; detecting an overrun after a
statement cannot refund already billed work. Conservative models therefore still
need trustworthy retained bounds and actual live evidence before activation.

The SQL catalog remains the unchanged c4-to-ed7 schema basis (36 application
tables, 20 named indices, 20 change triggers). It is not a claim that this modified
Worker is ed7 bytes. Current-byte coverage now includes the original fourteen
files, admission/ingress implementations and preflight implementation. A separate
runtime manifest hash binds those bytes while a catalog hash binds the schema
basis/definitions. Self-hashing the manifest is avoided. A separately reviewed
immutable artifact identity remains required for eventual transport/activation;
this source coverage hash is not an entire-release seal.

## Remaining engineering and evidence holds

The genuine allocator bounds accepted internal reservations with durable KV
transactions. It cannot give a hard finite bound to repeated unsolicited/cold
coordination reads by itself. A native allocator KV context also cannot be used
from a different Hub request context merely by retaining its JavaScript reference;
serialized cross-DO receipts lose local branding. The required trusted native
client/server transport and local permit factory are not implemented here.
Public/remote allocator access and enforced ordinary work therefore remain
closed, not conditionally enabled by a fixture callback.

The native source-SQL adapter fixture uses the real allocator algorithm over an
explicit fictional external KV model. It is component coverage, not end-to-end
production durable transport proof. Separate allocator tests exercise actual
native dedicated KV transactions/restart. Native ingress tests establish zero
source SQL, Hub storage, namespace or egress access on refusal and preserve
unrelated route behavior. All original assertions are retained.

Unknown actual plan/account usage, UTC-day completeness, retained source bounds,
per-object storage/catalog coverage, final immutable runtime artifact and finite
upstream/restart/denial admission remain blockers. No live account observations,
private values or synthetic live sessions are used by these tests. This patch is
suitable for inactive component review/qualification only, with no full production
admission clearance.
