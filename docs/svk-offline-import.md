# SVK offline inventory import

Sign in to Elistly, open **Settings → Data → Import inventory from folder** (also available in a new Computer form), and choose a workspace with a Computer entity type. Choose the USB inventory folder or use the multiple-file picker. Review the preview, then choose **Import all eligible reports**.

Deployment only collects files into DEPLOYDATA. Elistly does not run a collector, issue enrollment credentials, launch a browser on the target, schedule reporting, or change files on the USB.

The final results contain two lists of relative filenames:

- **Safe to archive/delete:** the source report and its receipt were committed and their contents read back from the database, or an identical existing receipt was read and verified. You can manually archive these files.
- **Needs attention:** every rejected, incomplete, unsupported, skipped, or unconfirmed file, with a reason. Keep these files. A failed network request can follow a successful database commit; select the same files and retry to confirm the result. `.pending` means incomplete, never safe.

Download the receipt before closing if you need a local record of the lists. Preview does not save reports or make files safe. Closing during import can interrupt the remaining files; reselect and retry to recover authoritative results. The tool never deletes or moves a source file.

## Accepted observations

Only `svk.device-inventory.v1` with `svk.windows-installation-snapshot.v1` is accepted. Local-file reports may record service observations (`collection.context: "service"`) without claiming that Windows installation or provisioning was verified. Stable hardware identities are checked against the hash of the trimmed, case-preserved UUID and serial. UUID-less reports must have a null hardware identity and require operator choice. Field bounds, UTC collection timestamps (including seven fractional digits), envelope/snapshot consistency, future timestamps, and contradictory equal-time observations are checked.

Selection limits are 100 files, 4 MiB total, 64 KiB per report, 512 filename characters and 8 path components. Server requests accept at most 10 reports and 1 MiB; the browser sends one file at a time to preserve partial outcomes. Arrays, strings and object depth are bounded independently.

A report ID is unique within its owner's workspace. Whitespace and object-key ordering do not change content identity. Reusing an ID with changed content is a conflict. Reports with matching unambiguous hardware identity append observations to the same Computer. Reports without that identity require an explicit target choice and will not silently merge on hostname. A manually entered Computer can be linked only after the operator confirms it is the same machine and selects any incoming fields to accept. Saved values stay unchanged by default, including on retries. Conflicting verified identities, ambiguous verified matches, and contradictory observations still need attention. Person is never inferred.

Reports with `identityStatus: "stable"`, a valid snapshot device UUID, a non-generic serial number and a matching `hardwareIdentity` hash retain automatic hardware matching. Reports with null UUID and hash can be imported as unconfirmed observations, including bounded `factoryEvidence`; factory parts are preserved as source evidence, not claimed as live Windows facts. Preview offers hostname/serial suggestions plus all existing Computers. If there is no suggested match, **Create new Computer** is selected; otherwise review the suggestions and choose to create new or link an existing Computer. Linking requires explicit confirmation that it is the same physical computer; any saved fields to replace must be selected individually. Hostnames and serials without a UUID are suggestions, never automatic merge authority. Never change a report to invent a UUID or hardware hash.

New and restored Computers use the ordinary Computer naming settings and fill every compatible, already-configured Windows field from the report. This includes hostname, manufacturer/model, processor, memory, graphics, Windows version details and serial number when those facts and fields are available. The importer does not create fields or infer a Person. Subsequent reports preserve all editable fields, including name, hostname, assignments, location and notes. Open **Saved offline observations** on a Computer to inspect the reports, with **Last inventoried**, source collection time, and server import time. Newer reports do not rewrite manual fields; older reports and null fields remain explicit history. This is unverified source observation, not proof of ownership, completed provisioning, or compliance.

## Persistence and deployment

`inventory_import_reports` in `neon/schema.sql` owns immutable source reports and idempotency receipts, outside mutable `app_data.payload`. Each receipt belongs to the authenticated account and selected workspace. The account's revision update and receipt insertion are one atomic PostgreSQL statement. Revision conflicts are rechecked with bounded retries. Only a separate authoritative receipt readback can produce a safe result.

Ordinary saves, Computer deletion, workspace edits, and JSON backup restoration do not delete these reports. Explicitly importing an identical receipt or a later unambiguous report for a deleted Computer restores that same historical Computer ID, after preview labels it **Restore deleted device**. A live serial, UUID, or identity collision still requires review; the importer never guesses or creates a duplicate. Account deletion cascades to the report table. Existing full-account JSON backups contain editable inventory, **not** this separate report ledger; keep your source files/receipts and include the table in database backups. History is available in pages of 20 observations.

Apply the additive `inventory_import_reports` table and indexes before publishing the API and frontend. Follow `DEPLOY.md` and `CLOUDFLARE_DEPLOY.md`: verify the current issuer/audience secrets, publish the reviewed commit through configured Git integration, and verify the deployed revision and served assets. Do not release a frontend ahead of its API. Existing installed Windows reporters keep their current protocol.

## Local verification

Install Worker development dependencies with `cd worker && npm ci`. From the repository root:

```
node --test tests/svk-inventory.test.mjs
node tests/svk-sql-integration.mjs
node tests/svk-browser.test.mjs
```

The SQL test executes production queries against isolated PGlite PostgreSQL. The browser test uses a loopback server, the real Worker handler, that isolated database, synthetic account authentication and Chrome (`CHROME_BIN` can override `/usr/bin/google-chrome`). It exercises real folder/file inputs and persisted results, not a fake successful import response. It never connects to a production account or runs the PowerShell producer. Set `SVK_SCREENSHOT` to capture the isolated browser page.

Live Neon Auth acceptance and the Windows/USB producer require their own environment evidence; local synthetic authentication does not prove either.
