# Private attachment frontend follow-up

This follows the independently qualified navigation/local-picker change in PR109.
The backend is owned by PR108; this branch changes no backend implementation.

## Capability and transport

The client enables sending only when the authenticated owner response explicitly
contains `attachments_enabled: true`. This additive signal is pending coordination
with the backend companion; absent/false retains the honest local-preview gate.
Public chat stays text-only. No credential, scope, storage service or schedule is
introduced. Only `/jarvis*` gains `blob:` in `img-src` for authenticated raster
previews; other modules' CSP and styles are unchanged.

The draft reserves its message UUID before upload. Up to four files of at most
1 MiB use the exact PR108 staging route and MIME allowlist. Browser-empty MIME
values can be inferred from supported extensions; the server still checks actual
bytes. The frontend validates each receipt's identity, MIME, size and SHA-256.
Upload progress is indeterminate unless actual progress is supplied; selecting a
file never implies acceptance. Uploads begin only on Send.

Once message submission begins, file selection is locked. An unconfirmed send
retries its original UUID, body and ordered attachment IDs. An edited text draft
survives confirmation of that original send. Removing a file during staging
aborts it and attempts draft disposal; message submission is suppressed if the
selection changed. Unconfirmed disposal is labeled, with server-side 24-hour
expiry as fallback. Auth loss clears in-memory file drafts.

Attachment-only messages are allowed when the capability is enabled. The
existing private job parser accepts an empty original message body for that
case while retaining identity, provenance, state and completion validation.
Explicit work-request forms retain their existing text/scope validation; files
are sent through private messages.

## Linked content

Private message metadata renders inert file names and download controls. Raster
previews require an explicit click. Content is fetched with the existing bearer
header, bounded by expected size and verified against its MIME and SHA-256.
Tokens never enter URLs. PDF and text documents are downloads, never inline
frames or executable markup. Object URLs are revoked when previews close, their
view unmounts, owner access is lost, or downloads have started. Delayed reads
cannot recreate a removed view.

## Validation boundaries

`relay-attachment-transport.test.js` checks the frontend contract and controller
retry/cancellation behavior independently. Existing owner/chat/navigation tests
must continue to pass against the old backend with attachments gated.

`relay-attachment-delivery-browser.test.js` requires the companion backend file.
On a frontend-only branch it explicitly skips; on a paired head it requires a
real capability signal and exercises real Worker routes and SQLite, actual
private bytes/downloads, immutable retries, cancellation and view cleanup. Do
not report those skips as end-to-end qualification. No network service or live
owner data is used.

The initial diagnostic combined checkout used backend e3f4c1a and temporarily
supplied the pending capability field and normalized ArrayBuffer bindings for
Node SQLite. Those diagnostics are not production or paired-head qualification.
Final exact commits, checks and blockers belong in the follow-up PR description.
