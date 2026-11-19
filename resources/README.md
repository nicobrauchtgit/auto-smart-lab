# Course resources

`catalog.json` inventories the supplied course PDFs, source attachments and
non-video URL activities. Each unique byte sequence lives once under `_assets/`,
named by SHA-256. The original upload and its complete inventory remain under
`runs/incoming/`. Duplicate PDF filenames resolve to the same asset identity.
Source templates and nested ZIPs are preserved without execution or expansion.

`tasks.json` maps task IDs to resource identities. The assignments follow the
course's unit-level grouping, as the existing spam resource assignment did:

| Unit manifest | Tasks | Material |
| --- | --- | --- |
| `01-spam/manifest.json` | spam1–3 | Spam slides, performance measures, the supplied ML/features/IDS background PDFs |
| `02-maldoc/manifest.json` | documents1–4 | PDFiD, PDF Parser and XML ElementTree links |
| `clustering-of-malicious-code/manifest.json` | code1–3 | pefile, PEiD, Drebin and PE-analysis links |
| `detection-of-unknown-attacks/manifest.json` | attacks1 | Anomaly-detection slides, IDS background and novelty/outlier documentation link |

Offense/defense attachments, including the original Python and robustness ZIP
source templates, retain their original course-unit associations in the catalogue.
They are not attached to the task manifests listed above. No video activities or
video links are imported. The export retains only the Moodle activity URL
of each link, not its external destination, and that URL is behind the course
login. Eight destinations were supplied by the user on 2026-11-16
(`LINK_TARGETS` in `import_course_materials.py`) and are written into those link
files. Links without a supplied destination (the NumPy and scikit-learn
tutorials) are not imported; no destination is invented.

The original PDFs are unchanged. Their text assets retain page markers and
extractor identity. Existing spam PDF/text bytes were preserved during migration.
Extraction may lose diagrams, layout and mathematical notation; originals remain
available. Import/check provenance is in `docs/course-materials-mapping-2026-11-16.md`.

## Runtime delivery

Per-unit manifests reference hash-addressed assets. The shared resource reader
validates the selected manifest and every checksum during preflight, then provides
the same declared files to both harnesses. A missing, changed, linked or invalid asset
blocks execution. Runtime paths use readable filenames. Minimal snapshots remain
self-contained and read-only; shared content is hard-linked within a run, while
the first snapshot copy remains independent of later source changes. Finetuned
snapshots retain the existing read-only workspace behavior. Runtime snapshots and
historical run artifacts are measurement records, separate from this canonical
source catalogue.

Only manifest-declared course files enter snapshots. Catalogue/import tooling,
runner guidance, scheduling scope and experiment reports do not enter them. No
solver instruction or modeling advice was added.

## Refresh

Use the existing finetuned Python environment through `./dev`; `pypdf` is already
locked. Import does not fetch external links or execute supplied source files:

```bash
./dev python resources/import_course_materials.py runs/incoming/course-materials.zip
```

The importer preserves existing spam text, checks ZIP/member identities, skips
video activities and writes catalogue/manifests. It rejects unsafe or unknown
attachments and duplicate canonical contents. `extract_slides.py` remains for
legacy manifests with unit-local PDFs; catalogue-backed manifests are refreshed
with the importer so shared identities stay consistent.
