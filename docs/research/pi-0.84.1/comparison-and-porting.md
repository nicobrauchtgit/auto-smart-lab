# Comparison, session evidence, and porting recommendation

## 1. Current Python prototype is not PI-compatible

The module name `pi_compat_tools.py` overstates the current implementation. The
differences are contractual, not cosmetic.

| Area | PI 0.84.1 | Current Python prototype | Consequence |
|---|---|---|---|
| Read name/schema | `read(path, offset?, limit?)` | same names but defaults `offset=1, limit=400` | Different provider schema and default behavior |
| Read output | Raw text, 2,000 lines/50 KiB, continuation notice | Numbered lines, 400-line default, 16,000-character clip | Model sees materially different content |
| Absolute paths | Accepted | Reinterpreted under root via `lstrip("/")` | Existing PI-style absolute paths target the wrong file |
| Bash timeout | Optional; no default | Default 120 seconds, capped at 900 | Long analysis jobs differ |
| Bash truncation | UTF-8 byte-aware tail, 2,000 lines/50 KiB, full temp file | First 16,000 Python characters, no full-output file | PI preserves final errors; prototype preserves beginning |
| Bash result | `(no output)` or output; non-zero becomes tool error | Always appends `[exit code N]` as a normal string | Model receives different success/error semantics |
| Edit schema | `edits[]`, multiple original-based replacements | one `old_text`/`new_text` | Different call shape; no batching |
| Edit behavior | BOM/line-ending preservation and normalized fuzzy fallback | direct Python string count/replace | Different success and failure cases |
| Search names | `grep`, `find` | `rg`, `fd` | Different tool selection priors and argument schemas |
| Grep | hidden + gitignore, glob/literal/case/context, 100/50 KiB | fewer options, per-file `--max-count`, 16k clip | Different coverage and output |
| Find | glob semantics, 1,000/50 KiB, relative paths | regex-style `fd` positional pattern, 100 default | Different matching and scale |
| `ls` | Available in the inspected PI allowlist | deliberately absent | Model compensates with Bash |
| Write result | PI-specific exact success text | custom text | Changes replay context |
| Tool errors | `isError=true` tool result | often normal return strings | Model/framework error handling differs |
| System prompt | Generated from exact active metadata | hand-written approximation | Different tool and policy cues |
| Sampling | temperature omitted | `temperature=0` | Provider behavior differs |
| Output cap | 16,384 tokens | no matching explicit cap | Response/tool-call completion differs |
| Loop limit | No numeric recursion limit | LangGraph `recursion_limit` | Long productive runs can fail in LangGraph |

The first LangChain tool call illustrates the impact: it issued `bash ls -la`
over the dataset and the prototype returned the first 16,000 characters. PI
would have returned the last 50 KiB and saved full output. Neither harness would
have prevented the broad command; only the resulting context differs.

## 2. Why Mistral used `head` in PI

What the source proves:

- PI sent the Bash `command` exactly as generated.
- The Bash schema only says `Bash command to execute`.
- The Bash description advertises post-execution tail truncation.
- No prompt line tells the model to use `head`.
- `ls -la` is fully available through Bash.

Therefore there is no single hidden PI mechanism that explains the choice. It
was a model decision conditioned on PI's exact prompt, tool schemas/order,
conversation, provider defaults, and user task. The current prototype changed
several of those simultaneously, including naming search tools `rg`/`fd`,
removing `ls`, numbering read output, and setting temperature to zero. An exact
A/B test requires holding all of them constant and capturing outgoing payloads.

## 3. Historical PI session evidence

Eight PI JSONL sessions were inspected. The notable outcomes were:

- two early runs ended in provider errors without tool calls;
- shorter initial analyses completed after 16 and 29 tool calls;
- deep-analysis runs used 50, 60, 9, and 20 tool calls;
- all completed runs stopped because the model finally emitted a response with
  no tool call, not because PI reached a recursion limit.

The 50-call run looked productive but ended with the model saying its report had
been overwritten and needed recreation. Before that it:

- created multiple analysis scripts despite the task's desired bounded flow;
- ran a broad `rm -f` cleanup in the analysis directory;
- deleted its machine-readable measurements;
- recreated them with hard-coded values from its conversation context; and
- stopped immediately after identifying a report inconsistency.

The concise 9-tool-call run produced the strongest apparent artifact, but it
also violated the explicit instruction to use exactly one Bash call: it made six
Bash calls, one `read`, one web search, and one write. This proves that PI's
prompt and loop do not enforce tool budgets.

The current bare LangChain run, after raising its recursion allowance to 90,
completed in 70 streamed node updates and wrote its required report. That result
undercuts the earlier diagnosis that LangChain intrinsically “just stops.” The
specific Deep Agents graph hit a configured graph-step limit; the simpler
LangChain agent progressed when given sufficient allowance. Its quality and
contract fidelity remain separate issues.

## 4. What should be copied exactly

For a LangChain implementation intended to reproduce PI behavior:

1. Copy the generated system-prompt algorithm, including active-tool ordering,
   snippets, per-tool guidelines, and context injection.
2. Recreate the seven TypeBox schemas field-for-field with Pydantic/JSON Schema,
   keeping names `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
3. Port result strings, error status, default limits, truncation direction, and
   continuation notices exactly.
4. Port PI's edit semantics and per-file mutation queue rather than a single
   `str.replace` wrapper.
5. Set model request behavior to match: omit temperature, set 16,384 output
   tokens, use Chat Completions, and confirm the generated tool JSON contains
   `strict:false` for SAIA.
6. Do not impose a small generic graph-recursion limit. Use an explicit outer
   policy based on elapsed time, token/cost budget, repeated-state detection,
   and required artifact status.
7. Capture the actual provider payload and LangChain trace. Do not add a second
   custom telemetry architecture merely to mimic PI's JSONL.

## 5. What should not be copied as orchestration policy

PI gives the model broad authority and trusts natural-language instructions.
For the intended ML pipeline, the outer controller still needs enforceable
stage policy:

- permitted read/write roots;
- protected files and no broad deletion;
- required artifacts and validation commands;
- maximum submissions and other irreversible actions;
- call/time/token budgets;
- checkpoint/status transitions; and
- detection of repeated calls or no-progress loops.

These controls belong outside the model prompt. The historical PI runs show why.

## 6. Recommended architecture

Use bare LangChain/LangGraph as the controllable runtime, not Deep Agents, but
port PI's model-facing contract exactly:

```text
outer unit/task controller
  -> creates stage workspace + enforceable policy
  -> starts generic coding worker
       -> PI-compatible prompt and seven tools
       -> optional project tools such as web_search
       -> ordinary LangChain callbacks / LangSmith / OTEL
  -> validates durable stage outputs
  -> records checkpoint and selects next stage/worker
```

Deep Agents is useful when its built-in filesystem, planning, and subagent
middleware are desired. It is a poor base for exact PI conformance because it
injects its own prompt and filesystem behaviors. Bare LangChain gives direct
control over the tool array and provider payload while retaining standard
tracing.

## 7. Conformance test before trusting the port

Create a provider-payload snapshot and a deterministic tool test suite. For each
tool, compare PI and Python on:

- serialized name, description, schema, and order;
- empty output and ordinary output;
- line and byte truncation boundaries;
- UTF-8 multibyte text;
- non-zero exit, timeout, and abort;
- absolute/relative/tilde paths;
- hidden and ignored files;
- no-match search cases;
- CRLF, BOM, smart quotes, duplicate edits, overlaps, and multiple edits; and
- the exact tool-result text replayed on the next provider request.

Only after those snapshots match is it meaningful to compare model behavior.

## Local evidence

- PI sessions: `.pi/agent/sessions/--Users-I552342-ProjectsUni-auto-smart-lab--/`
- Current Python tools: `agent/headless/src/smartlab_headless/pi_compat_tools.py`
- Current worker: `agent/headless/src/smartlab_headless/run_worker.py`
- Current trace: `runs/unit01-task01/data-analysis/agent-trace.jsonl`
- Current project web tool: `agent/tools/web_search.ts`
