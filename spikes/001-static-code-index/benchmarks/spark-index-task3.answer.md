- **Collector download asset identity must be single-source-consistent**  
  - The canonical artifact filename is declared in packaging as `downloads/Elistly-Windows-Device-Intake-v1.0.0.zip` and is not abstracted elsewhere. Evidence: `[scripts/package-windows-collector.sh](/home/campbell/Projects/Elistly-spike-static-index/scripts/package-windows-collector.sh:7)`; `archive=...`.  
  - The UI download anchor must match that exact filename/path for the user-facing link: `[app.js](/home/campbell/Projects/Elistly-spike-static-index/app.js:7248)`.  
  - Candidate documentation states the same archive path/name and should be updated in lockstep when generating a new candidate: `[collector/windows/CANDIDATE.md](/home/campbell/Projects/Elistly-spike-static-index/collector/windows/CANDIDATE.md:3)`.

- **Package contents must remain aligned between build recipe and candidate record**  
  - Build script includes only these two files when creating the zip: `Collect-ElistlyDevice.ps1` and `README.txt` (`zip ... Collect-ElistlyDevice.ps1 README.txt`). `[scripts/package-windows-collector.sh](/home/campbell/Projects/Elistly-spike-static-index/scripts/package-windows-collector.sh:11)`  
  - Candidate doc repeats the intended contents: `[collector/windows/CANDIDATE.md](/home/campbell/Projects/Elistly-spike-static-index/collector/windows/CANDIDATE.md:5)`.

- **Checksum contract is documented but not code-enforced**  
  - Candidate publishes expected SHA-256 in docs: `[collector/windows/CANDIDATE.md](/home/campbell/Projects/Elistly-spike-static-index/collector/windows/CANDIDATE.md:4)`.  
  - Build process computes SHA-256 for the produced archive at packaging time: `[scripts/package-windows-collector.sh](/home/campbell/Projects/Elistly-spike-static-index/scripts/package-windows-collector.sh:12)`.  
  - No browser/worker code path was found in the inspected files that verifies this hash.

- **Visible download labels and flow hooks for the collector**  
  - Modal title and CTA are set in the device-intake UI builder: `"Windows Device Intake"` and `"Download Windows collector"`. `[app.js](/home/campbell/Projects/Elistly-spike-static-index/app.js:7242)`, `[app.js](/home/campbell/Projects/Elistly-spike-static-index/app.js:7249)`.  
  - The same candidate versioned artifact is linked via `href`/`download` on that button: `[app.js](/home/campbell/Projects/Elistly-spike-static-index/app.js:7248)`.

- **Browser + service-worker references that must stay coherent**  
  - PWA manifest and SW registration are wired from app entry page: manifest link in app shell and SW bootstrap script include. `[app.html](/home/campbell/Projects/Elistly-spike-static-index/app.html:11)`, `[app.html](/home/campbell/Projects/Elistly-spike-static-index/app.html:153)`.  
  - SW register call targets `./sw.js`: `[pwa-register.js](/home/campbell/Projects/Elistly-spike-static-index/pwa-register.js:9)`.  
  - SW pre-cache manifest lists versioned assets that must be kept aligned with the loaded shell (e.g., `styles.css?v=17`, `app.js?v=16`, `device-intake.js?v=1`, `manifest.webmanifest`, etc.). `[sw.js](/home/campbell/Projects/Elistly-spike-static-index/sw.js:4)`-`[sw.js](/home/campbell/Projects/Elistly-spike-static-index/sw.js:29)`.  
  - App shell also loads those versioned static assets (`styles.css?v=17`, `device-intake.js?v=1`, `app.js?v=16`): `[app.html](/home/campbell/Projects/Elistly-spike-static-index/app.html:38)`, `[app.html](/home/campbell/Projects/Elistly-spike-static-index/app.html:150)`, `[app.html](/home/campbell/Projects/Elistly-spike-static-index/app.html:151)`.

- **Tests that enforce consistency**  
  - Browser-level regression checks the `#deviceCollectorDownload` `download` filename exactly equals `Elistly-Windows-Device-Intake-v1.0.0.zip`. `[tests/device-intake-browser.test.js](/home/campbell/Projects/Elistly-spike-static-index/tests/device-intake-browser.test.js:37)`.

- **Uncertainty (explicit)**  
  - I did **not** find tests asserting: the Windows ZIP exists on disk at `/downloads`, checksum pinning in code, collector version coupling between candidate docs and this test fixture, or service-worker cache entry updates tied to collector release updates. Only the `download` filename is currently covered by test assertion.
