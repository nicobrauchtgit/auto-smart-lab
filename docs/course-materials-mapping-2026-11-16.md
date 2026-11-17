# Installed course-material mapping, 2026-11-16

The supplied Moodle ZIP is `runs/incoming/course-materials.zip` (59,533,001bytes,
57 entries). ZIP CRC checks passed. Archive SHA-256:
`4f1ae1cd055de60a2500e6526e1d2f2c1679e9a96718cee306d7dd9bda4a02ef`.
Member inventory: `runs/incoming/course-materials-inventory.json`.

The canonical catalogue is `resources/catalog.json`:36 unique assets comprising
12 unique PDFs,12 page-labelled text versions,10 original non-video URL records,
one Python template and one original robustness ZIP. Duplicate PDFs from the
export share one identity and one stored file. The original spam PDF/text
identities remain unchanged. No videos were imported and no source code executed.

| Dataset-backed tasks | Shared course resources |
| --- | --- |
| spam1–3 | Spam basics, performance measures, ML/features/IDS background PDFs and their text |
| documents1–4 | PDFiD, PDF Parser and XML ElementTree links |
| code1–3 | pefile, PEiD, Drebin and PE-analysis links |
| attacks1 | Unknown-attacks/IDS slides and text; novelty/outlier-detection link |

Assignments follow the exported course's unit-level grouping, shared by the
unit's tasks, as in the prior spam workflow. `resources/tasks.json` lists the
11 task IDs and their resource identities. Per-unit manifests contain references
into `resources/_assets/`, not duplicate PDFs or text files. Both arms use the
same declared resource inputs. Minimal snapshots use readable filenames and
share identical contents by hard link within each run, with an independent
first copy to preserve the original input if the source catalogue later changes.

The remaining offense/defense papers and source templates retain their course
unit associations in the catalogue but have no manifests for this task set.
This includes FGSM/BIM/CW/MAZE papers, defense slides, adversarial training,
`template.py` and `robustness.zip`. The two FGSM filenames in the upload share one
PDF identity; the two IDS-background copies also share one identity. The nested
source ZIP is preserved intact rather than expanded into duplicate code trees.

The URL activity exports contain only their original Moodle URL and title, not
the external website behind the activity, and that URL is behind the course
login. The user supplied eight destinations on 2026-11-16 (scikit-learn outlier
detection, pdfid, XML ElementTree, pefile, the Drebin paper, the arXiv
2010.09569 PDF for the PE-analysis item, the packing-box PEiD repository and the
py-pdf-parser overview page); the importer writes them into those link records.
Links without a supplied destination (the NumPy and scikit-learn tutorials) are
not imported. Linked pages are not fetched by the importer.
Video activity HTML and the general Moodle course page are not runtime resources.
The export does not supply full original individual SmartLab task descriptions;
the RTF reconstruction retains its separate provenance limitation.

Catalogue/importer documentation is in `resources/README.md`. The import is
repeatable through `./dev python resources/import_course_materials.py
runs/incoming/course-materials.zip`. Runner scheduling scope and the user's Tor
deferral live only in `docs/experiments/dataset-backed-scope-2026-11-16.md` and
AGENTS.md. They are not resource content or pipeline instructions.

Validation: actual catalogue hashes,zero duplicate canonical contents,all11 task
mappings,24 manifest references and original spam PDF/text identities passed.
Focused resource/preflight/sandbox/continuation checks:28 tests passed. Broader
fast-suite, typecheck and production RTF setup results are recorded in the
resource-mapping validation receipt and experiment report after completion.

Final verification:76 focused integration tests,22 snapshot-refresh checks, and the fast suite (622 passed,3 platform/data skips,zero failures) passed. Typecheck, whitespace checks and both production RTF setup checks passed. Repeat import was byte-identical. Receipt: runs/incoming/resource-mapping-validation.json. The lead now gets the actual staged file list; course inputs are recorded through pipeline telemetry and protected by a nested read-only mount for every finetuned role. See docs/resource-delivery.md for role-specific discovery and access. No authored prompt template or minimal solver instruction changed.
