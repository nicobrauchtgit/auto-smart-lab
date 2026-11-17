# Course cloud datasets → repository tasks, 2026-11-16

Verified recursively against the authenticated course WebDAV share: 26 files,
forming 13 dataset groups with training/test archives. No dataset was downloaded.
Receipt: `runs/diagnostics/course-share-inventory-20261116.json`.
Task mapping uses current spam metadata (older archived spam IDs disagree with
current corrected ordering) and archived course titles/URLs for other tasks.
Mapping identifies tasks; it does not imply every task is staged or registered.

| Cloud location / archive stem | Repository task ID | Task |
| --- | --- | --- |
| `01-spam/spam1-*` | `spam1` | Spam detection with machine learning |
| `01-spam/spam2-*` | `spam2` | Spam detection in practice |
| `01-spam/webspam-*` | `spam3` | Webspam bonus |
| `02-maldoc/docx-*` | `documents1` | DOCX detection |
| `02-maldoc/pdf-*` | `documents2` | PDF detection |
| `02-maldoc/rtf-*` | `documents3` | RTF detection |
| `02-maldoc/mix-*` | `documents4` | Mixed-document bonus |
| `03-clust/android-*` | `code1` | Android malware clustering |
| `03-clust/php-*` | `code2` | Web-server malware clustering |
| `03-clust/win-*` | `code3` | Windows malware clustering |
| `04-tor/1-closed-world/{train,test}.tar.gz` | Not registered | Closed-world Tor fingerprinting |
| `04-tor/2-open-world/{train_benign,test}.tar.gz` | Not registered | Open-world Tor fingerprinting |
| `05-anomaly/adv-*` | `attacks1` | Adversarial-example detection |

`*` covers the training/test filename and extension. Spam1, webspam and adv
use plain ZIP; spam2, all documents and all clustering pairs use ZIP/GZIP/GPG.
Tor uses tar/gzip. Labels/family annotations, where applicable, require inspection
inside the archives; separate label files are not listed.

Numbering differs between the share and current course: the uploaded Moodle
index marks Tor fingerprinting cancelled and calls Detection of Unknown Attacks
Unit4. Therefore `05-anomaly` maps to Unit4/attacks1, not Unit5 offense. Tor data
exists in nested directories despite that cancelled course status; no active
Tor task IDs are currently registered here.

No datasets are listed for `attacks2` (Network Intrusion Detection), `offense1`,
`offense2`, or `defense1`. Offense/defense historically used VM services.
The mixed training ciphertext is only346 bytes: inspect it and the intended
training protocol before claiming usable mixed-task training data.

Existing minimal DOCX/PDF continuation results are complete and backed up.
RTF is staged with validated archive integrity and exact training-label coverage;
both-arm setup checks passed, with explicit reconstruction provenance for its
course task description. Later dataset groups still need task-specific preparation.

## Task numbering

Task IDs follow the share's ordering (user decision, 2026-11-16): `android`,
`php`, `win` under `03-clust` are `code1`, `code2`, `code3`, and `adv` under
`05-anomaly` is `attacks1`; Network Intrusion Detection is `attacks2`. The
October live lab and the course page order differ (web servers `code1`,
Android `code2`, Windows `code3`; network intrusion `attacks1`, adversarial
`attacks2`). Map task text by title or task path, never by ID alone. The
original October task pages are preserved in
`runs/incoming/langfuse-read-challenge-task-pages-2026-11-16.json` with both
IDs.
