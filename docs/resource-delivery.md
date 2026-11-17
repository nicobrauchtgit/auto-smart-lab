# How course resources reach agents

Selection is by the resolved task's unit. The runtime reads the selected
`resources/<unit>/manifest.json`; `resources/tasks.json` is the human/runner
index of the same unit-level assignments, not a separate prompt loader.
Manifest entries reference checksummed files in the canonical `_assets/` store.
Missing, changed, linked or invalid inputs fail the shared course-resources
preflight before agents run. Files get stable, readable names in run snapshots.

| Consumer | Discovery and purpose |
| --- | --- |
| Minimal solver | Its existing instructions tell it to call `read_challenge`. The reply includes `course_resources`: read-only local paths, titles, media types, sizes, pages and SHA-256 hashes. It chooses what to read while building its solver. |
| Finetuned lead | The opening message lists absolute paths/titles of the staged course files, alongside task/data context. It can read them and receives data/ideas scout findings; it chooses the final pipeline. |
| Data scout | Its system prompt lists relative `resources/…` paths and titles. Course context accompanies the task, profile and development/test inputs while it investigates factual properties of the data. |
| Ideas scout | Its system prompt explicitly lists the same files. It reads course material and cites sources when proposing ideas for the lead. This is the primary course-material reader. |
| Validation scout | It receives measured source/trial/check context, without a course-material reading list. Staged files remain technically readable in the shared workspace, but its assigned work is reviewing the measured candidate. |
| Deterministic training/refit | These execute the chosen code and measurements; they do not interpret course PDFs or select a model from them. |

The finetuned files are staged under the shared solutions tree at
`scratch/scouts/<task>/resources/`. Scouts use relative paths from their scout
working directory; the lead's message uses absolute paths because its working
directory differs. A nested read-only mount protects course files even when the
surrounding solutions repository is writable. Minimal uses its existing
read-only resource snapshot. No other arm's code, results or state is exposed.

Models receive path/title lists; file content is read through their tools.
PDF text assets retain page markers. Link assets contain the original course
activity title and URL; importing does not fetch external pages or provide
credentials for Moodle. Usage must be established from file-read calls in the
trace, rather than inferred from a file being available.

The resource integration corrected an existing empty `resources` value in the
lead opening-message input and records staged resource paths/hashes through the
pipeline input reporter. This is factual input metadata using the existing
prompt templates, without adding authored solver/modeling instructions.

Scope/deferred-unit/run-order instructions belong to experiment runners and
reports. They are not imported resource text or pipeline instructions. The
uploaded offense/defense source attachments have catalogue associations but no
active manifests in the current dataset-backed task set.
