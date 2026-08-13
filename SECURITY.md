# Security and Local Repository Hygiene

Elistly is publicly hosted and its source repository is public. Treat every tracked filename and every reachable Git revision as public information.

## Never store private material in the project directory

Prefer operating-system or user configuration directories for local credentials, private notes, exports, database connection strings, and account-specific deployment material. Do not create project-specific ignore entries for personal filenames; move those files outside the repository instead.

The repository `.gitignore` contains only generic development categories and the generated browser `config.js` path required by the documented local workflow. An ignored file is still local material—not a safe secrets manager.

## Configuration boundaries

- Browser `config.js` may contain only public frontend endpoints such as the Elistly Worker URL and Neon Auth URL.
- Database URLs, API tokens, signing keys, and administrative credentials must never be written into browser assets.
- Cloudflare Worker secrets belong in Cloudflare encrypted secrets or an equivalent secret store, not `wrangler.toml` or local notes inside this repository.
- Local `.env*`, Wrangler `.dev.vars*`, key files, and `secrets/` are ignored as a final guard, not as permission to keep long-lived credentials beside source code.
- Git remote URLs must not embed personal access tokens. Use a credential helper, SSH agent, or short-lived authenticated tooling.

## Before committing

1. Review the exact staged boundary with `git diff --cached` and `git status`.
2. Confirm no generated configuration, local exports, test databases, account identifiers, or dependency directories are staged.
3. Run `node scripts/scan-repository-secrets.js`. It scans tracked files and every reachable commit for strong credential signatures, prints only commit/path/line/pattern-class locations, and never prints matched values.
4. Run the repository checks documented in `README.md` and the Worker tests once the P0 test harness lands.
5. If a credential may have been visible to a tool, agent, terminal log, or remote service, rotate it; deleting it locally is not sufficient.

## Current known hardening work

The published application is undergoing a security and data-integrity baseline. Known work is tracked in [`ROADMAP.md`](ROADMAP.md), including:

- explicit credentialed-CORS origins;
- removal/protection of debug environment output;
- safe internal-error responses;
- deterministic Worker authorization tests;
- revision-aware persistence and durable failed-write handling;
- truthful offline/PWA behavior;
- bounded, privacy-preserving Windows Device Intake.

Do not represent an unchecked roadmap security item as complete merely because the public application appears to run normally.

## Suspected exposure

If a secret enters a commit or may have been observed by an external agent:

1. revoke or rotate the credential first;
2. determine whether it reached a remote repository, build log, deployment system, or agent transcript;
3. remove it from current files;
4. rewrite public Git history only when necessary and with an explicit coordination plan;
5. verify the replacement credential is not stored in the repository.

History rewriting does not invalidate a credential and cached copies may remain.
