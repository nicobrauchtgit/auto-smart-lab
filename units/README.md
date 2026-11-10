# Task data

Downloaded unit contents stay local and are ignored by Git. Both experiment arms
read this one directory; the minimal arm gets read-only links to the unit
folders, without `_vm-archive/` or this README.

```
units/
├── index.json                     # task id -> lab task URL
├── <unit>/
│   ├── .data-hash.json            # aggregate hash of the unit's data
│   ├── unit-intro.md
│   └── <task>/
│       ├── prompt.md              # task instructions
│       ├── meta.json
│       └── data/                  # training and test archives, labels
└── _vm-archive/                   # prompts and metadata of the old lab VM units; not task material
```

`./dev bun run fetch-unit -- <unit>` downloads a unit while the lab exists (see
`agent/setup/README.md`). The tracked `unit-data-hashes.json` at the repository
root holds one aggregate hash per unit. Compare it with `units/<unit>/.data-hash.json`
to confirm that two machines use the same data.
