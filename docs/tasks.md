# Tasks: what exists, what is ready

Inventory of the course datasets on the shared drive, taken on 2026-11-10
(read-only WebDAV listing; total 13.8 GB). `units/` is not in git: task files
are staged locally from the share.

## The share

`https://cloud.mlsec.tu-berlin.de/s/wD5GSTRbeS8reZH`, password-protected. The
password is never written to a file here; ask for it through the secret prompt.

Files ending in `.gpg` are symmetrically encrypted because virus scanners flag
the real malware inside, not for secrecy. The lab's passphrase for them is known
to the user. `gpg` is not installed on this machine; it runs without installing
through `nix shell nixpkgs#gnupg -c gpg --batch --pinentry-mode loopback
--passphrase-fd 0 -o <out> -d <file>`, followed by `gunzip`.

| Folder | Files | Size | Encrypted |
| --- | --- | --- | --- |
| `01-spam` | spam1 train and test, webspam train and test | 27 to 77 MB each | no |
| `01-spam` | spam2 train and test | 69 and 38 MB | yes |
| `02-maldoc` | pdf, docx, rtf, mix: train and test (the mix training file is empty) | 0.1 to 1.2 GB each, 4.2 GB in all | yes |
| `03-clust` | php train and test | 9 MB each | yes |
| `03-clust` | win train and test | 377 and 288 MB | yes |
| `03-clust` | android train and test | 3.0 and 1.7 GB | yes |
| `04-tor` | closed world: train, test | 803 and 404 MB | no |
| `04-tor` | open world: benign train, test | 1.5 and 1.2 GB | no |
| `05-anomaly` | adversarial examples: train, test | 15 and 7 MB | no |

The network intrusion task (FTP sessions) of the anomaly unit is not on the
share.

## Task instructions

The lab server is gone. Full task pages were saved only for the spam unit
(`units/01-spam/*/prompt.md`). For every other unit, `units/_vm-archive/` holds
the unit description with a one-paragraph summary per task, and empty task
pages. Prompts for those tasks are therefore reconstructed from the unit
description and say so in their first line. The prediction format is assumed to
be the spam unit's (`<path>;<prediction>`); the official score of each task is
not recorded.

## Status per task

| Task ID | Task | Kind | Staged locally | Harness support today |
| --- | --- | --- | --- | --- |
| `spam1` | Spam detection (prepared emails) | binary classification, text | yes | yes |
| `spam2` | Spam detection in practice (raw emails) | binary classification, text | yes | yes |
| `spam3` | Webspam (imbalanced web pages) | binary classification, HTML | yes | yes |
| `code2` | Malicious code for web servers (PHP, Perl) | clustering, families known for training only | yes, 2026-11-10 | clustering kind exists; not run yet |
| `attacks1` | Adversarial example detection (PNG images) | anomaly detection, no labels | yes, 2026-11-10 | no hand-over for label-free tasks yet |
| maldoc: pdf, docx, rtf, mix | Malicious code in documents | binary classification, documents | no (4.2 GB, encrypted) | kind exists; not run |
| clust: win, android | Malicious code for Windows, Android | clustering, binaries | no (0.7 and 4.7 GB) | kind exists; not run |
| tor: closed, open world | Website fingerprinting | many classes; open-world detection | no (1.2 and 2.7 GB) | multi-class is not a supported kind |

Free disk on 2026-11-10: about 9.7 GB, so not all tasks fit at once.

## Hidden ground truth

The share's `adv-train.zip` contains every training image twice: once without a
label (`.x`) and once with its true label as the file extension (0 normal,
1 to 3 attack kinds; 127 of 2,990 are attacks). The staged `adv-train.zip`
contains only the unlabelled copies, as the task intends. The labels are kept in
`units/_truth/attacks1-train.labels` for scoring our own runs. Folders whose
name starts with `_` are not task material: neither arm may mount or copy them
into an agent's workspace.

## Use in the redesign

`spam1` is the quick check (see [redesign-plan.md](redesign-plan.md)). `code2`
(clustering of scripts) and `attacks1` (label-free images) are the checks that
the design is not fitted to spam.
