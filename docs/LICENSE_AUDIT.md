# License audit

## Scope

Source tree, browser CDN imports, vendored QR generator, and the production dependency graph in `worker/package-lock.json`. `THIRD_PARTY_NOTICES.html` is self-contained, publicly linked from both entry pages, and deploys with the root static site. It preserves upstream license texts and copyright notices rather than applying Elistly’s license to dependencies. No mandatory copyleft source-sharing dependency was identified in this production graph.

## Maintenance

Run `node --test tests/license-notices.test.js` after dependency changes. Update the notice page from the exact dependency package license files; its lock hash deliberately makes a stale inventory fail. Browser font URLs are upstream-managed, so review their licensing when updating typography. Worker build-tool dependencies are not represented as shipped runtime code. The Windows collector uses operating-system APIs rather than redistributing PowerShell or Windows.

## Unresolved evidence

The repository does not establish external provenance/author permissions for all product logos, screenshots, and historical icon variants in `img/`; owner confirmation or original design records are still required. This audit does not certify historical deployments or prove rights in branding merely from a project copyright statement. Confirm the live deployment serves the notice page after publication.
