# Local retention and shared-device security

## Scope

Source-only hardening of the managed-service trust roadmap, using isolated browser profiles and synthetic accounts. No production or family data, authentication provider, RLS design, deployed reporter protocol, schedule, device identity or credential format was changed. Nothing was deployed.

## Storage and retention

- Account inventories, revision timestamps and pending writes live in account-keyed localStorage. The browser bearer token also lives in localStorage. These are not encrypted against other users of the same browser profile or same-origin JavaScript.
- Pending writes have no automatic expiry. Malformed, empty-string or unreadable outboxes are now retained with a visible failure instead of deleted and treated as an empty queue. New saves cannot silently overwrite an unreadable outbox.
- Acknowledging a queued write now removes only that acknowledged entry from the current queue. Edits appended while the request is in flight survive.
- Existing sign-out preparation refuses cleanup when any account has pending or unverifiable writes. Successful cleanup removes durable inventory, revision and outbox keys and clears the storage layer's in-memory cache. Cleanup errors remain visible rather than claiming success.
- Inventory requests started before successful local sign-out cleanup cannot repopulate the cache afterward, including the background refresh path.
- When another tab removes an account cache, revision or outbox key during sign-out, open tabs clear their in-memory inventory. Per-page generation guards prevent stale successful or failed save, retry, queued-save and import completions from restoring cleared account state or issuing a queued remote write.
- The service worker now intercepts only explicitly listed public shell URLs. API, auth, runtime configuration and arbitrary query-bearing URLs bypass Cache Storage. Activation removes prior Elistly shell caches, not unrelated applications' caches. Local script dependencies are explicitly included to preserve the offline shell.

## Authentication lifecycle

Local-token removal errors, remote HTTP failures and network failures are returned to the sign-out UI. Failed remote revocation still attempts local-token removal. The UI warns that sign-out is incomplete and the browser must not yet be shared.

Late session-refresh results cannot restore a removed or replaced token. Concurrent refreshes cannot clear a newer token. Sign-out waits for already-started login, signup and verification response headers before revoking the provider cookie; superseded flows cannot restore a token or report successful authentication. New authentication mutations are refused during revocation. Existing Neon endpoints, request bodies and credentials mode are unchanged.

## Remaining risks and exact decisions

1. This is not a shared-browser isolation guarantee. Open tabs clear storage-layer inventory after cross-tab sign-out, but may retain already-rendered inventory; generation guards are per-page, not cross-tab locks. A future cross-tab lifecycle design must preserve unsynced edits while deciding whether to lock or hide other tabs. Until then, use separate OS/browser profiles for different people and close all application tabs before handing over a device.
2. Failed revocation can leave a provider cookie active. Failed sign-out leaves the current page visible with a warning; it is not a privacy lock screen. Stalled authentication requests can keep sign-out pending. Provider cookie rotation, expiry and revocation need an approved synthetic-account hosted test, not assertions derived from local mocks. No disposable hosted provider environment was available during the 2026-09-18 acceptance run, so real-provider cookie/session cleanup was not exercised.
3. Persistent-login duration, optional session-only storage, auto-lock and cross-tab UX need an explicit product policy. Local inventory and tokens remain readable to same-origin script and anyone with browser-profile access. Encryption with keys in that same profile is not represented as a solution.
4. No age-based purge or quota eviction was introduced. Automatic deletion of unsynced work is not authorized. Recovery/export UX for unreadable queues and limits or expiry for synced inventories require a preservation-first policy. Existing local-only inventory and explicit reset/account-deletion flows were not redesigned.
5. The shell restriction does not control ordinary HTTP caching or provider cookies. Existing installed workers retire old caches only when the replacement activates. Deployment is a separate approval and acceptance boundary.
6. Provider migration/MFA and trusted database identity/RLS remain separate roadmap decisions. Neither was implemented here.

## Verification

Regressions cover unreadable outbox preservation, enqueue-during-save, stale foreground/background inventory completion after cleanup, cross-tab sign-out invalidation and stale save/import completion guards, sign-out failure reporting, token-refresh ordering, pending login/signup/verification ordering, cancellation reporting, private-response cache exclusion and offline shell dependencies. The 2026-09-18 acceptance run passed the repository lifecycle suite with isolated browser fixtures and synthetic fetch responses. It did not exercise a hosted provider cookie or session. Focused regressions, the complete root test suite and worker tests passed; final command outcomes are recorded in the task handoff.
