# Authentication replacement review

Reviewed 2026-09-19 against source commit `c5f4a62`, current authoritative documentation, and read-only Neon metadata/aggregate queries. No production mutations, credential exports, account sign-ins, or email sends were performed.

## Outcome

Application-user MFA was lost during the Supabase migration. This is an unresolved migration defect under David's no-loss-of-security-or-features requirement. Hiding unsupported controls is truthful UI, not completion of that requirement.

Self-hosted Better Auth in the existing Worker, retaining Neon Postgres, is the recommended replacement architecture. **An account-preserving cutover is not yet established.** Do not replace the runtime until the ownership and credential/factor gates below have evidence. No second auth authority, MFA simulation, new application framework, or automatic account recreation is approved by this review.

## Evidence and constraints

- [Neon's current roadmap](https://neon.com/docs/auth/roadmap) still lists MFA as coming soon. [Its overview](https://neon.com/docs/auth/overview) names managed Better Auth 1.4.18 and recommends self-hosting for unsupported plugins/hooks. Adding a client plugin cannot add the missing managed server capability.
- [Better Auth's TOTP plugin](https://better-auth.com/docs/plugins/2fa) supports verified enrollment, sign-in challenges and single-use backup codes. Credential sign-in waits for the second factor; passwordless methods are not challenged by default. These are library capabilities, not Elistly acceptance evidence.
- [PostgreSQL support](https://better-auth.com/docs/adapters/postgresql) allows retaining Neon. [Schema generation](https://better-auth.com/docs/concepts/database) does not establish that a managed provider's credentials, encrypted factors, or account identifiers can be copied safely. Pin and test an exact maintained release before implementation; do not derive schema from unversioned examples.
- [Session management](https://better-auth.com/docs/concepts/session-management) supports server-side session lookup and revocation. Cookie caching introduces a revocation delay; the proposed authority must use live database sessions for protected requests.
- [Email/password documentation](https://better-auth.com/docs/authentication/email-password) requires application delivery callbacks for verification and recovery email. Elistly currently delegates email to Neon and has no replacement sender implementation. An authenticated sender and isolated delivery acceptance remain cutover prerequisites.
- [Cloudflare's runtime documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) require checking runtime compatibility, request-scoped database access and secret handling. The current Worker has a 2024 compatibility date and no `nodejs_compat`; Better Auth has not been built or exercised in this configuration. This is an implementation gate, not evidence that Workers cannot host it.

## Actual Elistly boundary

| Responsibility | Current owner | Required replacement |
| --- | --- | --- |
| Browser authentication | `lib/db.js`: direct Neon sign-in/sign-up/get-session/sign-out; JWT in local storage | One Worker-hosted Better Auth handler and cookie session; update all callers and lifecycle handling |
| Protected API identity | `worker/src/index.js`: Ed25519 JWT signature, expiry, exact issuer/audience | Live server session and server-verified assurance; reject old managed JWTs after cutover |
| MFA | Adapter capability false; Worker MFA operations return 501 | Real enrollment, challenge, recovery and removal backed by the same authority |
| Account ownership | Text user IDs in application tables; UUID IDs in `neon_auth.user` | Preserve immutable IDs and every owner reference; no email-based implicit relinking |
| Admin and deletion | Worker joins/deletes `neon_auth.user`; first-user/email bootstrap | Update to the new authority atomically, preserve admin membership, enforce fresh assurance |
| Inventory lifecycle | `app.js`, `lib/db.js`: revisions, outbox, cross-tab invalidation | Preserve behavior and unsynced data across challenge, expiry, revocation and logout |
| Unattended reporting | Device token routes before account authentication | Preserve `dr_`/`dc_`/`dp_`, owner/workspace/device IDs, endpoint and payload contract |

The current JWT verifier does not query current session revocation or MFA assurance. A valid signature is not proof that a second factor was completed. Changing only Profile UI or adding a TOTP endpoint would leave the API bypassable.

Read-only queries against the project's default database established:

- The managed schema exposes `user`, `account`, `session`, `verification` and other provider tables. There is no current two-factor table or `twoFactorEnabled` user column.
- All three credential records have nonempty password fields matching a hex-salt/hex-hash shape. No password/hash value was retrieved. Shape alone does **not** prove algorithm parameters, normalization, export compatibility or successful verification by the replacement.
- Owner joins to `neon_auth.user` found **two unmatched inventory owners**, **one unmatched profile owner** and **one unmatched admin owner**. These represent **two distinct UUID-shaped identities** across the checked tables. Registration and reporting owner joins had zero unmatched identities.
- These counts do not establish whether rows belong to real users, deleted accounts, test fixtures or the earlier migration. No owner IDs, emails, inventory payloads, credential values or private URLs are included here.
- The tracked migration notes contain no verified Supabase-to-Neon identity ledger, factor export or credential-verification fixture. Available Neon access proves metadata and aggregate readability; it is not a claim that all provider material is inaccessible. Original Supabase factor availability and disposition remain unknown.

## Proposed security contract, pending migration evidence

Use Better Auth as the **only** application-user authority in the existing Worker. Keep Neon as the database. Do not let managed and self-hosted auth mutate the same auth tables concurrently. A reviewed one-time import into application-owned auth tables should preserve user IDs and immutable ownership, then switch all browser/API callers atomically and invalidate old sessions. Retain rollback data securely under owner control; do not retain a runtime fallback accepting the old issuer.

Use HttpOnly, Secure cookies with an explicit trusted-origin/CSRF policy. Prove the real frontend/API origin arrangement in a browser; prefer same-origin routing rather than assuming third-party cookies work. Do not add a bearer-token bridge merely to keep the old client interface.

Enrollment must require recent primary authentication, keep the factor pending until a correct authenticator code, and show recovery codes once. Store TOTP secrets encrypted and recovery codes hashed; keep encryption keys outside source control. Apply persistent rate limits. Do not enable trusted-device bypass or passwordless entry points without an independently proven assurance contract.

Protected inventory, profile, admin and account-management routes must reject incomplete MFA sign-ins. Enabling MFA must invalidate pre-enrollment sessions, including other browsers; a user-level `twoFactorEnabled` flag alone is not session assurance. Sensitive operations (factor removal/replacement, recovery-code regeneration, credential changes and account deletion) require recent primary authentication and a recently verified factor or unused recovery code. Recovery codes must be consumed atomically, resist replay/concurrent use, and establish a bounded recovery session. Password reset must not clear MFA or silently produce an assured session. With neither factor nor recovery code, stop at an explicit owner recovery process rather than an email-only downgrade.

Existing accounts whose prior MFA status cannot be established must not be silently classified as unprotected. Factor export requires proven decryptability and compatible semantics; otherwise an owner-approved identity-proof and re-enrollment process is needed. Do not promise preservation of existing authenticator registrations without that evidence.

## Exact missing evidence and first next action

**First next action belongs to David/account owner:** locate the prior Supabase-to-Neon identity migration record or provider backup, and reconcile the two unmatched owner identities through a secure local record outside Git. Identify their legitimate owner or documented fixture/deletion provenance; do not delete or reassign them based on these counts. In the same evidence handoff, establish whether old Supabase MFA factors can be exported/decrypted, or explicitly approve a verified recovery/re-enrollment process if they cannot. Never paste credential material into chat or commit it.

Then obtain a disposable provider-created credential fixture with a known synthetic password through an owner-authorized isolated environment. Export only that synthetic record securely and verify it using the exact selected Better Auth release. A locally generated hash proves only the local implementation, not provider portability. If portability fails, the owner must approve a secure reset/migration method that retains IDs and does not bypass required MFA. Real-user passwords must not be requested.

This review cannot infer these identity facts or authorize weaker recovery. Generating a speculative import, ignoring unmatched owners, recreating accounts, or retaining the old provider as a fallback would not meet acceptance. Local runtime work is held at this explicit review boundary; the remaining gap is not a request for generic architecture approval. No production deployment is authorized.

## Finite implementation and acceptance after the gate

1. Pin Better Auth and its Postgres adapter; generate/review application-owned auth schema. Build under the Worker runtime and test the verified one-time ID-preserving import, including rollback, collisions, missing owners and refusal of unsupported credential/factor material.
2. Replace the authoritative browser and Worker auth path, account/admin callers, config and docs together. Remove Neon JWT/cookie proxies, unsupported MFA stubs, superseded settings and tests. Add real enrollment/challenge/recovery/removal UI using existing presentation patterns.
3. Use RED/GREEN tests for pre-challenge API denial, invalid/expired/replayed factors, concurrent recovery, old-session invalidation, password-reset non-bypass, factor removal, cross-account access, CSRF and logout. Exercise real Postgres behavior and a synthetic two-browser flow; mocks alone are insufficient.
4. Run all relevant browser/lifecycle and Worker suites, syntax/build and diff/secret checks. Re-run the existing installed-reporting contract from `docs/windows-device-reporting-handoff.md` with synthetic credentials. Record enrollment, refresh, recovery, sensitive-action denial and inventory persistence browser evidence. Keep physical Windows evidence separately labelled.
5. Only after source acceptance and a verified migration rehearsal, seek the separately required production cutover authorization. Verify deployed revision and rollback readiness at that later gate.

## Verification of this review

Documentation-only correction. No behavior or visible flow was changed, so no new RED/GREEN test or MFA browser acceptance is claimed. Existing auth, account-capability, lifecycle and Worker checks are recorded in `.hermes/coordinator-mfa-report.md`. MFA restoration remains incomplete.
