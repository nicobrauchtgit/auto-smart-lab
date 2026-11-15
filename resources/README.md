# Course resources

`01-spam/` contains the PDFs supplied by the user in this conversation:

| File | Course material | Pages |
| --- | --- | --- |
| `smartlab-spam.pdf` | Konrad Rieck, Intelligent Security Lab: Spam Filtering: Basics | 7 |
| `mlsec-perf-small.pdf` | Konrad Rieck, Machine Learning for Computer Security: Performance Measures | 23 |

The original PDFs are unchanged. Each has a page-labelled `.txt` extraction
for the research agent's text tools. Extraction can lose figures, layout and
mathematical notation; the originals remain available. `manifest.json` records
titles, page counts and SHA-256 hashes of both formats, plus extractor identity.

Finetuned research automatically selects `resources/<unit-slug>/manifest.json`,
checks every declared file before agents start, and snapshots the files into
its workspace's read-only `resources/` directory. `context.json.resources`
lists the supplied files; Langfuse records each input and content hash. Missing
or changed declared files fail setup. Units without a resource directory have
no additional course inputs. Only the selected unit's declared files are supplied.
The snapshot accompanies the brief when it is copied into solve, keeping its
course citations readable there as well.

The research prompt points to the text copies. Briefs can cite
`[resources/smartlab-spam.txt]` or `[resources/mlsec-perf-small.txt]` for course
context and methods; these do not count as measured dataset evidence.

Minimal receives the same declared PDFs and text copies in a read-only snapshot
at `resources/<unit-slug>/`. Its `read_challenge` tool lists their paths, titles,
page counts and hashes alongside the task instructions. Setup checks the source
files and copied snapshot; run conditions and Langfuse metadata record their
identities. Its authored solver instructions contain no additional modeling advice.

To regenerate the text and refresh checksums after an intentional PDF change:

```bash
./dev python resources/extract_slides.py resources/01-spam
```

`pypdf` is declared and locked in the finetuned Python environment. No PDF
extraction or extra executable is required during a pipeline run.
