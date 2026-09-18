# MFA architecture correction receipt

Date: 2026-09-19 (Europe/Stockholm)
Starting revision: `c5f4a62`
Result: **Architecture review committed; MFA restoration remains blocked on account-preservation evidence.**

## Product outcome

The authoritative roadmap now treats missing application-user MFA as a Supabase migration defect, not optional polish or a completed capability-disabling task. Self-hosted Better Auth in the existing Worker with Neon Postgres remains the recommended single-authority architecture. Current provider documentation confirms managed Neon MFA is still coming soon. The review defines enrollment, recovery, factor removal, live server assurance, session invalidation, ownership preservation and finite implementation gates.

A safe current cutover was not established. No runtime replacement, speculative import or fake MFA control was added. No production schema, secret, account, inventory or reporting data was changed; no deployment, push or email send occurred. No password hash, TOTP secret, session token, real account ID or email was exported into this receipt or committed documentation.

## Ownership and repository boundary

The existing `flock` holder was verified in this process's ancestor chain; it is the coordinator wrapper launching this exact worker, not a competing writer. A nested nonblocking lock attempt correctly failed because the parent already holds it. The lock file was not removed or replaced.

Initial tracked tree was clean at `c5f4a62`; `.hermes/` contained the coordinator's untracked prompt, lock and ignored live log. Those artifacts were preserved and excluded from the commit. Only this new receipt and the three named documentation files belong to the correction. No subagents or additional mutating owners were started.

## Evidence and external blockers

Read-only Neon queries inspected schema columns, aggregate credential shape, and application-owner joins. Live results:

- Three credential records contain nonempty hex-salt/hex-hash-shaped password fields. This establishes readability/shape only, not import compatibility. No actual hashes were retrieved.
- The managed auth schema has no two-factor table or enabled-factor user column. This cannot prove that no users had factors in the original Supabase provider.
- Two inventory rows, one profile row and one admin row have no matching current auth user. These span two distinct UUID-shaped owner IDs. Device registration/reporting owner joins have no unmatched IDs.
- The unmatched rows' origin is unknown. They must not be classified as fixtures, reassigned, discarded or used to claim preserved ownership without evidence.
- No verified original identity ledger, old-factor export/decryption evidence, or provider-generated known-password migration fixture was found in tracked migration documentation. Neon read-only access is available; this is not a blanket claim of inaccessible credentials or an observed provider export denial.

The exact queries used `information_schema.columns`, counts/regex predicates over `neon_auth.account`, and left joins from `app_data`, `profiles`, `admin_users`, `device_registration_tokens` and `device_reporting_tokens` to `neon_auth.user`. No user rows or payloads were returned. The detailed architecture review links the authoritative Neon, Better Auth and Cloudflare documentation inspected in this run.

**Exact first next action:** David/account owner locates the original Supabase-to-Neon identity ledger or provider backup and securely reconciles the two unmatched owner IDs outside Git. Establish original MFA-factor export/decryption availability, or explicitly authorize a verified recovery/re-enrollment process if the material cannot be recovered. Do not paste secrets into chat. A clarification was requested during this run; no response was available when this receipt was written.

After that, use an owner-authorized isolated provider environment to obtain a synthetic credential export with a known synthetic password and prove verification under the selected pinned Better Auth release. Then implement the one-time ownership-preserving import and atomic runtime replacement described in the review. An authenticated email sender and real-origin browser acceptance are also required before cutover. Production changes remain separately unauthorized.

Why local alternatives are insufficient: a locally generated password hash cannot prove provider portability; matching emails cannot prove immutable ownership; a new TOTP UI cannot enforce API assurance; accepting both providers leaves two authorities; silently resetting accounts/factors violates the explicit preservation requirement. No independent implementation slice can settle the missing historical identity/factor facts.

## Files

- `docs/authentication-architecture-review.md`: review, source map, live aggregate evidence, proposed security contract, missing evidence and finite acceptance sequence.
- `ROADMAP.md`: first auth outcome corrected and concrete owner/evidence resume gate recorded.
- `NEON_MIGRATION.md`: obsolete optional-MFA wording replaced with the active migration defect and review link.
- `.hermes/coordinator-mfa-report.md`: this receipt.

No runtime code was superseded, so none was removed. Existing inventory and installed-reporting contracts remain unchanged.

## Verification actually run

- `node tests/auth-signout.test.js`: **12/12 passed**.
- `node tests/account-capabilities.test.js`: **passed**, headless Chrome. Checks truthful unsupported controls and sign-out request shape; provider calls are intercepted/stubbed. This is existing-flow browser regression evidence, not real MFA acceptance.
- `node tests/signout-privacy.test.js`: **passed**, existing browser lifecycle/privacy suite.
- `npm test` in `worker/`: **4 files, 34/34 tests passed** through the Cloudflare Vitest runtime/build integration, including account/API boundaries and device registration/reporting tests.
- `node --check worker/src/index.js`, `node --check lib/db.js`, `node --check app.js`: **passed**.
- Local Markdown target validation: **passed**.
- `node scripts/scan-repository-secrets.js`: **passed** for tracked files and reachable history before staging new docs; new documents were also inspected before commit.
- `git diff --check`: **passed**; staged diff is checked before committing.

This is a documentation-only correction. No behavioral test was invented to manufacture RED/GREEN evidence. No new MFA implementation was built, no real-provider MFA browser flow was exercised, and no Windows physical acceptance is claimed. Existing passing tests do not demonstrate MFA restoration. A deployment build is not required for these documentation changes; the full Worker suite compiled/exercised the unchanged source.

## Resume boundary

Do not repeat this architecture review without new provider or ownership evidence. Keep the MFA defect open in `ROADMAP.md`. Resume with the owner evidence handoff above, validate the credential/factor migration, then replace all runtime callers and remove the superseded managed auth path in one source-complete correction. This receipt completes the authorized review fallback, not the MFA product outcome.
