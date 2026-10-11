# Safe extension-owned key migration: candidate, not release approval

This patch is based on `feat/extension-side-encryption` at
`6b2e1a6b2aaabdcf2df217fa821b900d09b81492` (draft PR #5). This candidate is
prepared for separate testing against that feature branch. It has not been
merged or deployed. No real Workflowy account or real secret was used in validation.

## What changes

- WebCrypto and all saved keys live in trusted extension contexts. Local extension
  storage access is restricted to `TRUSTED_CONTEXTS` before handling requests
  ([Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)).
  The isolated content script can import a legacy page key through one narrow RPC;
  it cannot read extension keys or change settings. The MAIN-world script receives
  only opaque key IDs, ciphertext, plaintext, fixed status and public resources.
- Existing ciphertext stays `_` + base64(16-byte salt, 12-byte IV, AES-GCM output
  including its tag). The derivation remains PBKDF2/SHA-256, 250,000 iterations,
  AES-256-GCM. Empty decrypted text is a valid value.
- A complete keyring is stored as one `keyRecord` item. Writes are serialized,
  read back and verified using a fresh cryptographic probe. A retry after an
  interrupted/lost acknowledgement is idempotent. A different source key causes
  a visible conflict instead of replacing either key.
- Key changes happen only in the extension options page, after explicit
  confirmation and an optimistic key-ID check. Earlier keys remain in the
  keyring, allowing old ciphertext to be decrypted after a change or restart.
  Stale tabs cannot make new encrypted writes under a newly selected key.
- Derived keys are non-extractable and cached only in worker memory, scoped by
  key identity. Legacy persistent recovery caches are not consumed or automatically
  destroyed. Clear Cache clears only the in-memory cache.
- The fetch hook is declared in MAIN world at `document_start`. The separate
  isolated-world script performs migration ([Chrome content scripts](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)). Minimum Chrome version is 111.
- Protected encryption failures never return the original plaintext as a fallback.
  Decryption failures preserve the complete original ciphertext, including `_`.
  Missing/conflicting keys, malformed encrypted text, unknown ancestry, unsupported
  operations and ambiguous write failures pause writes visibly. Read-only polling
  and tree reads remain possible. Preserve unsaved edits before reloading.
- Relevant request/response processing is serialized to prevent parent/child lock
  races. Relevant network work has a 30-second timeout. This is deliberately
  conservative and must be measured against Workflowy's real polling behavior.

## Migration stages and cleanup preconditions

1. Opening Workflowy reads the legacy page `lockSecret` only in the isolated world.
2. The background worker stores the exact key, reads the new record back and
   decrypts a verification probe derived from the persisted bytes. Existing
   differing keys stop migration; no source key is removed.
3. The extension can use the verified copy, but the page key remains. A visible
   banner says **cleanup pending**. This is not security-complete migration.
4. In extension settings, the user must explicitly approve finishing migration.
   They must have an independent recovery-key backup, close other Workflowy tabs,
   and reload the remaining tab so old extension scripts cannot keep writing the
   legacy key. Without an independent backup, leave cleanup pending.
5. Approval is short-lived and bound to the active key ID, tab ID, Chrome document
   ID and exact origin. Approval is lost safely on service-worker restart. The
   background checks that only that Workflowy tab remains, then checks again when
   the content script requests cleanup. Missing document identity refuses cleanup.
6. The isolated script repeats durable verification, compares the exact source
   value, removes the old page cache first, compares again, and removes the key
   last. It checks removal before reporting completion. Read/remove failures remain
   visible and retryable. Any observed replacement key is preserved.

`localStorage` does **not** provide an atomic compare-and-delete across agent
clusters ([HTML Web Storage standard](https://html.spec.whatwg.org/multipage/webstorage.html#introduction-16)). The final cleanup guarantee assumes no concurrently writing old tab or
other writer, as explicitly confirmed by the user. A tab-count check alone is not
an atomic guarantee. This patch does not claim safety against a hostile page
rewriting storage during finalization. If those preconditions cannot be established,
leave cleanup pending. No software migration can promise protection against disk
loss, profile deletion or an already-compromised browser. Keep independent backups.

A probe proves that the persisted key is usable and matches the imported value;
it does not prove that every old node was originally encrypted with that value.
Wrong-key or malformed-ciphertext failures preserve data and block uncertain writes.

## Recovery behavior

- Failed write/readback, lost response or worker restart: keep page key; retry.
- Key conflict: preserve both sources; do not clear site/extension storage. Resolve
  the key choice from the trusted options page using an independently saved key.
- Wrong key: original ciphertext stays intact; earlier archived keys are tried.
  A page that has already failed decryption requires reload after resolving it.
- Old `optionsAction` containing a migration key: archive its exact value in
  extension-owned `legacyOptionsActions`, verify that archive, then clear/replace
  the action. Never return the secret argument to the page or options action API.
- An orphan page `lockCache` without `lockSecret`: retain it and show a distinct
  recovery warning. A valid unrelated extension key is not authority to erase it.
  There is no automatic orphan-cache recovery or deletion UI in this candidate.
- Old extension `lockSecret`: convert only after verified readback; conflicting
  extension records stop rather than overwrite. Old raw derived caches are retained
  for deliberate recovery and are never used for routine encryption.
- Failed or ambiguous network writes: stop further writes and keep the caller's
  original request intact. Workflowy's own unsaved-edit/queue behavior must be
  verified in a real test account before rollout. Do not automatically reload.

## Security boundaries and remaining limitations

The legacy key was already accessible to Workflowy before migration. Moving it
cannot undo earlier exposure. The new key is not sent into the page. Decrypted
node text necessarily is: Workflowy renders and edits it. A hostile page can read
that plaintext or bypass a MAIN-world fetch hook. This change is key isolation,
not a claim of end-to-end protection against a malicious editor.

Browser-profile malware, devtools access, extension compromise, storage/profile
loss, or OS compromise remain outside this protection. Keys are saved in the local
extension profile, not hardware-protected storage, and not synced by this patch.

This is still a third-party integration that understands selected Workflowy fetch
endpoints and operation shapes. Unknown ancestry/operation shapes fail closed.
Alternative transports (XHR, WebSocket, service workers), cached initial trees,
account changes, lazy/partial descendants, cross-tab remote edits and all current
Workflowy schema variants have not been validated in a real browser/account here.
In particular, complete descendant coverage when changing a `#private` tag or
moving a branch remains a release-gating integration check. Do not claim every
Workflowy operation is supported or that a mocked test suite proves production
availability. Descendant helper requests currently require HTTP success; their
application-level acknowledgements and partial-commit recovery are another release
gate. Existing deployments should not receive this candidate until that checklist
is complete.

## Automated checks

Run with Node 20+ (no dependencies):

```
npm run check
```

Tests use synthetic keys, mocked Chrome storage/messaging/DOM and real Node
WebCrypto. They exercise production source rather than a second implementation.
The background cases include read/write faults before and after durable commit,
restarts, concurrent imports, conflicting keys, malformed records/ciphertext,
legacy-format independent fixtures, empty strings, archived key replacement,
wrong keys, trust boundaries and cleanup grant scope. Content cases interrupt
source reads/removals, lose acknowledgements and change the source before cleanup.
Options cases cover error/timeout handling, duplicate clicks, stale confirmations,
navigation and explicit cleanup approval. MAIN cases cover plaintext containment,
whole-request barriers, original request preservation, headers/abort/transport,
missing ancestry and operation validation.

These are not real Chrome service-worker termination, isolated-world, quota,
loading, extension-update, permission or Workflowy-account tests.

## Release-gating manual checklist (synthetic account/profile only)

1. Load unpacked on supported Chrome and confirm document-start ordering, MAIN and
   isolated-world execution, sender URL/frame/document IDs, and restricted storage
   access. Browser smoke tests were not performed in this environment.
2. New install, existing store-version upgrade and PR #5 upgrade; single tab,
   multiple tabs/windows, old unreloaded tabs, navigation, back/forward cache,
   account switch and signed-out page; never display a key in MAIN/DOM/URLs/logs.
3. Use only disposable test notes and keys. Compare server-bound network bodies,
   including undo fields, empty fields, new nodes, tag transitions, moves, bulk
   creates, lazy descendants, remote concurrent changes and all share types.
4. Kill/restart worker before and after every storage step; inject quota/readback
   failures; disconnect messaging; verify source remains unless verified cleanup
   has explicit current approval. Restore and retry without data conversion.
5. Change a legacy key from an old tab; cleanup must refuse until all old writers
   are closed/reloaded and source conflicts are resolved. Test grant expiry,
   document changes and worker restart between approval and cleanup.
6. Simulate offline/timeout/HTTP errors and lost replies for both outer and helper
   writes. Preserve unsaved edits, prevent plaintext fallback, and verify recovery
   without duplicated or omitted operations. Check polling latency under the queue.
7. Restart browser after cleanup, decrypt all disposable legacy fixtures, switch
   keys, verify prior-key recovery and stale-tab refusal. Inspect both page and
   extension storage; retain only intentional extension recovery data.
8. Test the rollback plan below and independently retain a copy of every test key.

## Rollback

Before cleanup, the legacy source remains available. Nevertheless, old page-side
versions expose it and are not the preferred rollback. After cleanup, **do not**
roll back to a version that expects the key in page localStorage, and do not copy
extension secrets back into the page. Use the patched extension or a forward fix
that reads the versioned keyring. The patch never re-encrypts existing server data
merely to migrate a key. Preserve the browser profile and independent keys before
changing extension versions. An unpacked extension with a different ID has a
separate storage area; test installation identity carefully.
