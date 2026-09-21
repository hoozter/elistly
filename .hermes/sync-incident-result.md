# Elistly sync incident — data preserved, reconciliation pending

Investigated 2026-09-21 through the supported Chrome extension connected to the existing Elistly tab. Primary checkout HEAD: `9a82279`. No deployment, application-source edits, save retry, reload, navigation, sign-out, storage clearing, or user-data mutation was performed.

## Confirmed diagnosis

- The visible tab reports **Changes are waiting to sync.** `Storage._isDirty` is true and the displayed inventory has 12 entities.
- The active account has one durable outbox entry, dated **2026-09-15T14:16:47.111Z** from its entry ID. Its `expectedUpdatedAt` is null. The active account's cached revision key is absent. A May revision belonging to a different local account key is not this account's base revision.
- The queued payload contains 12 entities. A read-only authenticated `GET /app-data`, using the existing token only inside the tab, returned **HTTP 200** and a server snapshot with 6 entities, revision **2026-09-17 06:11:53.746204+00**. Both snapshots have 9 entity types and 1 workspace. Their entity IDs are disjoint: 12 local-only, 6 server-only, 0 shared. Neither snapshot can safely be substituted for the other without a reviewed reconciliation decision.
- The actual loaded `Storage.getAppDataAsync` returns the last queued payload before fetching server data. It sets the generic pending message. Thus the old queued snapshot masks the newer server snapshot on startup. This is directly established from loaded methods, live state, and a synthetic reproduction; it is not inferred from a health endpoint.
- The actual loaded save method sends the current cached revision, which is null for this account. The checked-in Worker rejects a null-base update when an account row already exists. This predicts a conflict on retry, but **no live PUT was sent**, so no live 409 is claimed.
- The August 13 fix `c4cf0c9` introduced durable queued saves and the same queued-startup behavior. It protects the queued payload from being silently discarded; it does not reconcile divergent account snapshots. The primary checkout still reproduces the masking behavior.

The original cause of the September 15 save remaining queued is **not established**. The extension had no historical error logs. Passive network observation captured only the investigation's successful GET and its preflight; it did not capture a failing save. Current API authentication/read access works. Missing issuer/audience settings reported by the earlier release preflight must not be presented as the cause of this live incident.

## Verified private recovery material

Directory: `/home/campbell/.local/share/elistly-private/recovery/2026-09-21T11-22-05-051Z/`

- `browser-durable.json`: exact original values and key names for five Elistly data keys; one outbox entry; zero matching session-storage keys. Includes legacy/local account caches and revision metadata. SHA-256: `9351fd729c417748956aeac6dfe11251f848eb2c4a853ba8a3eefc11e62dc3f8`.
- `browser-runtime.json`: current cached payload, App inventory and sync status.
- `server-read.json`: successful account API response including payload and full server revision precision. This is an account snapshot, not a complete database backup or backup of separate reporting tables.
- `comparison-private.json`: entity-ID comparison, kept outside the repository.
- `loaded-storage-methods.json`: actual loaded queue/load/save methods and limited diagnostic metadata.
- `served-assets.json`: current public app, service-worker and auth-adapter source responses.
- `manifest.json`: byte counts, SHA-256 hashes and file modes for the six artifacts above.

All six artifacts were read back, hashed, and verified mode **0600**; the recovery directory was created mode **0700**, and the manifest is mode **0600**. No token/cookie storage keys were extracted. No JWT-like credential strings were found in the stored artifacts. IndexedDB database inventory was empty. CacheStorage shell assets were not exported; there is no evidence of an additional inventory store there. Raw inventory and account identifiers were not printed into the report or test fixture.

Durable Elistly data was compared with the initial extraction twice and remained byte-value equivalent. The final UI still displayed the pending state and 12 entities. Network observation was disabled after inspection. The user tab remains open.

## Deployed versus primary source

The live tab loads `app.js?v=37`; primary `app.html` references v40. A separate no-store read of the public assets produced these Git blob hashes:

- app.js: `fc3e69a27ec9b4d434b33d51ec0d3e10c10932aa`
- sw.js: `77061f37c55c4fa2fcf9fb955d81a3cf34cfe3b5`
- lib/db.js: `8d9c32f024b00d49a8d132c9e7cd459dceb72347`

These match the source hashes recorded by the earlier SVK release investigation. Live storage methods lack later account-generation and cross-tab completion guards present in primary. This confirms older deployed source; it does not establish that simply refreshing/deploying would resolve this incident. The primary's queued-startup branch also returns pending data without server comparison.

## Reproduction and checks

Command:

```sh
node .hermes/sync-incident-repro.cjs /home/campbell/.local/share/elistly-private/recovery/2026-09-21T11-22-05-051Z/loaded-storage-methods.json
```

Passed for both loaded production methods and primary source: synthetic queued data is displayed, zero remote reads occur on queued startup, the pending message appears, a synthetic null-base PUT is generated, and a simulated conflict retains the queue. The reproduction contains no real inventory and performs no network calls. This is diagnostic evidence, not a RED/GREEN repair or proof of live write behavior. One serial Node process; CPU temperature was 65.2 C initially and 59.4 C after the probe, below the 80 C stop threshold. No broad test suite or build was needed because no application implementation changed. `git diff --check` and syntax validation are recorded at completion.

## Safe next action and boundary

Keep SVK deployment on hold. Do not retry or rebase this queue, copy the remote revision into local storage, or clear it to make the warning disappear. In particular, changing the local revision to the remote revision could authorize replacement of the six server entities with the unrelated twelve queued entities.

The next recovery step is an offline, private review of the two preserved snapshots to specify which entities and fields should survive. The smallest required user decision is whether the twelve local-only entities contain edits that must be kept, and which of the six server-only entities are authoritative. Preserve both originals throughout. A recovery candidate must be reviewable before any explicit authorization to change live data; no latest-wins rule or inferred deletion is safe here.

A future source correction should make queued-versus-remote divergence visible without replacing either snapshot, and retain the queue's provenance. It should be tested against the synthetic null-base/existing-remote case. That is separate from choosing the user's intended data and from deployment authorization.

Incident **not resolved**: data is preserved and the visible stale-state mechanism is established; original failed-write history and desired reconciliation remain unknown. Existing untracked coordinator/SVK/task artifacts were left untouched. Only this report and the synthetic diagnostic script were added to the checkout.

## Source correction, 2026-09-21

The checked-out frontend now reads the authenticated account endpoint before presenting a pending local snapshot. If it finds different server data, it presents the server copy, retains the local outbox unchanged, blocks further saves and replay, and shows a recovery dialog with a local JSON export. A genuinely offline read continues to show the durable local pending copy. The implementation uses the account endpoint only; no health endpoint is part of the startup decision, so the observed health 404 does not suppress account reconciliation.

Focused browser coverage covers remote bootstrap, offline pending edits, local-only divergence, account-endpoint-only startup and recovery visibility. The full root browser suite and Worker suite pass. Deployment remains blocked: the shell has neither `CLOUDFLARE_API_TOKEN` nor verified `NEON_AUTH_JWT_ISSUER` / `NEON_AUTH_JWT_AUDIENCE`; the installed Wrangler CLI is unavailable. The minimal deployment input is a Cloudflare deployment token plus the exact `iss` and `aud` claims from a verified current access token for this production Auth environment. No production write, schema migration or release was attempted.
