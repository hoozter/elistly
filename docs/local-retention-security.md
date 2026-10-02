# Account cache, saving, and local privacy

## Current account-data contract

The server owns saved account data. A browser keeps an account-scoped, disposable **server-confirmed read cache** so a returning account can load quickly without waiting for Neon. Background refresh checks the latest server copy. The cache is not an upload source, an offline write queue, or proof that an unacknowledged edit was saved.

`elistlyData:confirmed:v1:<account-id>` contains a `server-ack-v1` envelope with the confirmed payload and its revision. Only verified GET responses or acknowledged conditional saves update this envelope. Unmarked historical payloads are never promoted into confirmed cache data. Cached startup remains read-only until the account read succeeds. A failed refresh visibly reports the failure rather than inventing an empty account or saving defaults.

Each account PUT supplies exactly one server precondition: `If-Match` with its current strong ETag, or `If-None-Match: *` for a new account without a row. The database condition atomically rejects a stale revision. The client checks the returned payload, revision, and ETag before treating the write as saved. Normal edits serialize in memory so rapid edits cannot silently overwrite one another or be falsely acknowledged. That sequencing is not persistent and is not an offline synchronization engine.

An older or out-of-order GET cannot replace an open draft or undo a newer save acknowledgment. An editor may veto refresh adoption; a veto does not advance its write revision. Account-generation checks prevent delayed reads, saves, imports, and startup callbacks from restoring account data after sign-out or a session change.

## Failed saves and conflicts

A failed save leaves the latest unsaved draft in memory and shows **Download unsaved draft**, **Retry save**, and **Discard draft and load latest**. Reading the account while that draft is open returns the draft, not the older persisted cache. Subsequent edits remain unsaved until the user retries; there is no automatic upload after a failure.

Retry first reads the account. If its payload exactly matches the draft, the client verifies the previously lost acknowledgment without another PUT. If the revision is unchanged, retry uses that revision for a guarded save. If another browser has saved a newer revision, retry refuses to rebase or overwrite it: the user can export their draft and explicitly discard it to load the latest account copy. Discarding a draft requires an in-app decision dialog.

**Unsaved drafts are not durable.** Reloading or closing the browser may lose them; the browser's unload warning is a best-effort safeguard, not a recovery guarantee. Download a draft before leaving if saving cannot be completed. Only server-confirmed account data is available from the persistent cache after a reload.

## Historical browser copies

Older `elistlyData:outbox:<account-id>` and `elistlyData:recovery:<account-id>` records are preserved for export, never replayed or used to hydrate current account data. They do not produce a recurring current-save-failure banner. An account can read and save current data independently of these older records.

The account menu provides an older-copy download when applicable. Sign-out presents **Download a copy**, **Cancel**, and **Discard local copies and sign out** if an open draft or historical unsaved copy exists. Cancel leaves the copies and login intact. Downloading does not imply consent to delete. Discard consent binds to the exact historical keys and values displayed; a copy changed in another tab requires a new decision instead of being silently deleted.

After consent, normal sign-out clears browser account caches, old account-revision keys, historical records, and account memory. Local-only inventories are separate and are not account sign-out targets. If local cleanup fails, sign-out reports the failure instead of claiming browser privacy was achieved. If remote session sign-out fails after cleanup, account content is still removed from the current view and the remote failure is reported truthfully. A token change or removal in another tab invalidates account memory and rendered content there as well.

## Security boundary

Account IDs and revisions in browser storage are identifiers, not secrets. Inventory payloads and historical exports can contain sensitive data. Browser storage and downloaded JSON copies are not encrypted by Elistly; protect the browser profile and exported files. Sharing an operating-system login or browser profile does not isolate inventories from someone with access to that profile. Normal sign-out reduces residual account data, but is not secure erasure of disk, browser backups, or already-downloaded exports.

Application cache data cannot authorize server access. Worker authentication and account scoping determine which row a request may read or update. Conditional writes prevent silent stale overwrites; they are not a substitute for authorization. Explicit imports additionally bind their preview to the account, access token, and expected revision, refusing a changed account or an unsaved draft.

## Verification

The current checks exercise confirmed cached startup, failed refresh, conditional writes, rapid edits, delayed GET/save races, failed-draft reopen/retry, lost acknowledgments, stale concurrent browsers/tabs, import, historical export/consent, account switching, failed cleanup, delayed callbacks after sign-out, responsive decision dialogs, and warm/cold onboarding. Browser integration tests use isolated Chrome contexts and the real Worker with PGlite where database behavior matters. Synthetic failure injection is identified in the tests and does not replace a live release check.
