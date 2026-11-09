# Exact tool contracts

This document separates three things that are easy to conflate:

- the one-line snippet placed in the system prompt;
- the function description and JSON Schema sent in the provider's `tools`
  array; and
- the execution/result behavior after the model calls the tool.

PI's interactive renderer is not model context. For example, `ls` may show only
20 lines in a collapsed terminal component, while the model receives up to 500
entries/50 KiB.

## Shared behavior

Relative paths resolve against the session working directory. PI also accepts
absolute paths and expands `~`; the built-in tools are not workspace-sandboxed.
This is intentional coding-agent behavior and differs from the current Python
prototype's `_within()` restriction.

Read/search/list results retain the **head**. Bash retains the **tail**. The
shared byte ceiling is 50 KiB and the general line ceiling is 2,000. Error
exceptions are converted by the agent loop to textual error tool results with
`isError=true`.

None of the built-in tools declares `executionMode="sequential"`.

## `read`

- System snippet: `Read file contents`
- System guideline: `Use read to examine files instead of cat or sed.`
- Required: `path: string`
- Optional: `offset: number` (1-indexed), `limit: number`

Provider description:

> Read the contents of a file. Supports text files and images (jpg, png, gif,
> webp, bmp). Images are sent as attachments. For text files, output is
> truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for
> large files. When you need the full file, continue with offset until complete.

Text is decoded as UTF-8. It is returned verbatim, without line-number prefixes.
If truncated, PI adds a continuation instruction with the next 1-indexed
offset. If a user-supplied `limit` stops before EOF, it adds the number of
remaining lines and next offset. A first line over 50 KiB yields an instruction
to use Bash with `sed` and `head -c`.

Supported images are processed and returned as a short text note plus an image
content block. PI notes when the model does not support images.

## `bash`

- System snippet: `Execute bash commands (ls, grep, find, etc.)`
- Conditional system guideline: the model may inspect `PI_*` session variables
- Required: `command: string`
- Optional: `timeout: number` seconds; there is no default timeout

Provider description:

> Execute a bash command in the current working directory. Returns stdout and
> stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit
> first). If truncated, full output is saved to a temp file. Optionally provide
> a timeout in seconds.

The command is passed unchanged to Bash (`/bin/bash -c` on this host). Standard
output and standard error are merged in arrival order. The process is detached
into a process group so abort/timeout can kill its process tree. A supplied
timeout must be positive and below the platform timer maximum.

Output is accumulated incrementally. Once it grows beyond the limit, full raw
output is copied to a randomly named file under the OS temporary directory. The
model receives the last 2,000 lines or 50 KiB plus a notice containing the full
output path. `(no output)` represents successful empty output. Non-zero exit,
abort, and timeout become error tool results and include captured output plus a
status line.

PI does not inspect or constrain the command. In particular, `ls -la`, Python,
redirection, pipelines, `rm`, and commands outside the repository are all
available with the permissions of the PI process.

## `write`

- System snippet: `Create or overwrite files`
- System guideline: `Use write only for new files or complete rewrites.`
- Required: `path: string`, `content: string`

The provider description states that the tool creates or overwrites a file and
automatically creates parents. It writes UTF-8 and serializes mutations to the
same absolute file through a per-file queue. Its success string is
`Successfully wrote N bytes to <path>`, although `N` is JavaScript string
length, not a true UTF-8 byte count for all Unicode content.

## `edit`

- System snippet: precise exact-text replacement, including multiple disjoint
  edits in one call
- Required: `path: string`
- Required: `edits: array` of `{ oldText: string, newText: string }`

The description and four prompt guidelines tell the model to use one call for
multiple separate locations, keep each old block minimal but unique, match all
edits against the original file, and avoid overlapping/nested edits.

Execution is richer than the phrase “exact replacement” suggests:

- legacy single `oldText`/`newText` arguments are normalized into `edits`;
- a JSON string accidentally supplied for `edits` is parsed when possible;
- CRLF/CR are normalized for matching and original line-ending style is
  restored;
- a UTF-8 BOM is preserved;
- exact matching is attempted first;
- fallback matching applies Unicode NFKC, strips trailing whitespace, maps smart
  quotes/dashes to ASCII, and maps special spaces to ordinary spaces;
- every old block must still be unique in the normalized original;
- overlaps are rejected; and
- unchanged line blocks retain their original bytes when fuzzy matching is used.

Success text reports the number of replaced blocks. A diff, unified patch, and
first changed line are placed in `details` for UI/session consumers; those
details are not independently serialized into the next provider request.

## `grep`

- System snippet: `Search file contents for patterns (respects .gitignore)`
- Required: `pattern: string`
- Optional: `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`
- Defaults: current directory, case-sensitive regex, zero context, 100 matches

PI ensures `rg` is available, then invokes it with JSON output, line numbers,
hidden-file traversal, and normal ignore rules. `--fixed-strings`,
`--ignore-case`, and `--glob` are added from arguments. It stops the child at
the effective match limit.

The result format is `relative/path:line: text`; context lines use hyphen
separators. Individual lines are clipped to 500 characters. The total retains
the head up to 50 KiB. Notices recommend a larger `limit`, a refined pattern,
or `read` for a clipped source line. No match returns `No matches found` and is
not an error.

## `find`

- System snippet: `Find files by glob pattern (respects .gitignore)`
- Required: `pattern: string` glob
- Optional: `path`, `limit`
- Defaults: current directory and 1,000 results

The default backend is `fd --glob --color=never --hidden`. Outside a Git
repository PI adds `--no-require-git`; inside one it preserves Git-aware ignore
boundaries. Patterns containing `/` use full-path matching and are adjusted so a
relative nested pattern matches an absolute candidate path.

Paths are returned relative to the search root with POSIX separators. The
result retains the head up to 1,000 paths/50 KiB and includes continuation or
refinement notices. No match returns `No files found matching pattern`.

## `ls`

- System snippet: `List directory contents`
- Optional: `path`, `limit`
- Defaults: current directory and 500 entries

PI reads one directory, sorts case-insensitively, includes dotfiles, stats every
entry, and appends `/` to directories. Unstatable entries are skipped. Output
retains the head up to 500 entries/50 KiB. A limit notice recommends doubling
the limit. An empty directory returns `(empty directory)`.

## Project `web_search`

This is not upstream PI; it is the project's extension in
`agent/tools/web_search.ts`. PI transports it exactly like any other registered
tool.

- System snippet: `Search the web for ML approaches`
- Required: `query: string`
- Optional: `max_results: integer`, default 5
- Provider description: search for information relevant to the current ML
  challenge, including approaches, standard-library implementations, and
  adversarial ML techniques

It POSTs to Tavily with `search_depth="basic"` and `include_answer=false`, using
a 30-second socket timeout. The model receives pretty-printed JSON with
`title`, `url`, and `snippet`. Network/API errors are returned as JSON text but
are not marked `isError=true` because the extension returns normally. Abort
returns `Cancelled`.

Its prompt guidelines are highly solution-specific and were included in the PI
system prompt whenever `web_search` was active. That is another difference from
the current LangChain version, whose web tool has a shorter docstring and no
equivalent trigger guidelines.

## JSON Schema details

PI passes TypeBox schemas directly as OpenAI function `parameters`. The schemas
contain `type`, `required`, `properties`, and property descriptions. They do not
set `additionalProperties: false`. PI nevertheless includes `strict: false` for
the inspected SAIA compatibility profile.

## Sources

- [Tools directory](https://github.com/earendil-works/pi/tree/v0.84.1/packages/coding-agent/src/core/tools)
- [`read.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/tools/read.ts)
- [`bash.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/tools/bash.ts)
- [`edit.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/tools/edit.ts)
- [`grep.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/tools/grep.ts)
- [`find.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/tools/find.ts)
- [`ls.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/tools/ls.ts)
