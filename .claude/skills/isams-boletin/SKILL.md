---
name: isams-boletin
description: Generates the school report card — grades and averages per student, subject and term, pulled live from iSAMS as HTML or Markdown. Use when asked for a student's grades, averages or report card.
metadata:
  source: https://github.com/killfill/isams
  provenance: cli/BUILD.json
  cli: cli/cli.js
---

# iSAMS grade report

You are producing a student's grade report from the school's iSAMS parent
portal, and reporting what it says.

The deliverable is a grade matrix: every subject the guardian account can see,
against every term, with the individual assessments behind each average, the
per-term average and the final. A CLI does the extraction and the arithmetic; it
ships compiled inside this skill and runs with plain `node`, no `npm install`.
Your work is choosing how to run it and reading the result honestly.

The averages in the report are recomputed from the individual assessments rather
than copied from the platform, because iSAMS publishes a distorted figure in one
known case: in the weighted model, a block that carries weight but has no grades
yet is weighted as **zero** instead of excluded, which sinks the term. The CLI
detects that and renormalises over the blocks that do have grades.

**This is plumbing. Treat the numbers in the report as simply the grades, and
report them as such.** The correction is why they can be trusted, not a finding.
A parent asked what their child is getting, not how the pipeline works — the
marks in the file exist so you can read it correctly, not so you can narrate it
back.

The data is thinner than it looks, and that shapes what you may claim from it.
The API exposes no assessment dates — column order is the only hint of sequence,
and it is not a timeline. Subject and term names are opaque labels: "Nota Parcial
2" is not the second grade, it is a name. Everything you can defend saying comes
from the grades and their weights, nothing from when they happened.

## Instructions

- **Report the grade, never the arithmetic behind it**—quote the figure the
  report gives and stop there. The `⚠️ pub.` value is the platform's broken
  number; it is not a second opinion worth mentioning.
- **Lead with what the parent asked**—the overall average, the subject they named,
  anything below the pass mark. Rank by what affects the student, not by what
  the pipeline found interesting.
- **Say when a grade will still move**—a term marked `(est)` is in progress and
  estimated from the grades entered so far. That changes how a parent should
  read a low mark, so it is worth a clause.
- **Match the format to who reads the output, not to what is convenient**—HTML
  is unreadable as text and Markdown is ugly to a person; picking wrong wastes
  the run.
- **Treat a non-zero mismatch count as a refusal to report**—it means a term
  could not be reproduced by any known model, so the number has no backing. Name
  the affected subjects and say the figure is unreliable rather than passing it
  along. This is the one pipeline fact worth surfacing, and only when it happens.

Do not produce:

- **Any mention of corrections, distortion, published-versus-computed values, or
  how many terms were reproduced**—it is internal quality control for a bug in
  someone else's API. Saying "none of these averages were distorted" is as
  irrelevant to a parent as saying the JSON parsed cleanly.
- **Any claim about trend, progress or improvement over time**—there are no
  assessment dates, so "grades are improving" is unfalsifiable from this data no
  matter how the columns are ordered.
- **The HTML markup in the conversation**—it is a file for a person to open, and
  pasting it buries the answer.
- **Advice about what to do with the school**, unless asked. Report what the
  grades say; the parent decides what it means.
- **A token, in any form, anywhere in the conversation.** Credentials move from
  clipboard to file, or from the project knowledge base to a file, and never
  through a message.

## Workflow

`BOLETIN` below is `node .claude/skills/isams-boletin/cli/cli.js` from a project
root, or the absolute path to this skill's `cli/cli.js` from anywhere else. Run
`BOLETIN --help` for the full flag list.

**Pick the mode first, from where the credentials live:**

| Credentials live in | Mode | Why |
|---|---|---|
| The filesystem | **Localhost** | The file is the store of record. One invocation does everything. |
| The project knowledge base | **Managed** | The container filesystem is scratch. The KB is the store of record and only you can reach it. |

### Variables / Inputs

- CREDENTIALS: absolute path to the credentials file. Localhost default:
  `credenciales.json`. Managed: `/home/claude/work/credenciales.json`. If there
  are none, run the bootstrap below — it needs the user, so ask before doing
  anything else.
- FORMAT: `html` or `md`. If undefined: derive it from the reader, per step 2.
- OUTPUT: path for the report file. Always set one.

### Steps

1. Check that CREDENTIALS exists. If not, walk the user through the bootstrap
   below and stop until they have saved the file.
   → a usable credentials file
2. Decide who reads the output and pick the format from it.

   | Reader | Format | Why |
   |---|---|---|
   | A person — the user wants to *see* the grades | `html` | Full matrix, one column per assessment, with colour, weight shading and hover tooltips. Not readable as text. |
   | A model — you need to read, evaluate or reason over the results | `md` | The same data as data-tables: the subject × term matrix, then per-subject tables with every assessment, its block, its weight and its grade. |

   → the `--format` value
3. Run the CLI, per the mode you picked.

   **Localhost** — one invocation. Renewal is lazy and persists locally before
   the data API is touched, so there are no courier steps:

   ```bash
   BOLETIN --format html --token-file /abs/path/credenciales.json --output notas.html
   ```

   **Managed (scheduled task)** — five steps, because the store of record is
   unreachable from inside the container:

   ```
   1. project_read  claude/credenciales.json
      → write it to /home/claude/work/credenciales.json with a bash heredoc

   2. BOLETIN auth refresh --token-file /home/claude/work/credenciales.json \
        --trigger scheduled

   3. if the output says "rotated: yes"
      → cat /home/claude/work/credenciales.json
      → project_write claude/credenciales.json
      retry on 5xx; if it still fails, ABORT

   4. BOLETIN --format md --no-refresh \
        --token-file /home/claude/work/credenciales.json \
        --output /home/claude/work/notas.md

   5. cat /home/claude/work/credenciales.journal.jsonl
      → project_write claude/credenciales.journal.jsonl   (best-effort)
   ```

   Four rules govern those steps:

   - **Step 3 is exactly one write of one complete document.** Never build the
     document up across multiple writes — an intermediate state is a
     valid-looking credentials document with wrong contents.
   - **If step 3 fails after retries, abort. Do not run step 4.** Losing the
     report is cheap. Running extraction on a token whose successor exists only
     in a container about to vanish loses the chain and costs the user a manual
     browser bootstrap. This is the entire reason the refresh is a separate step.
   - **Step 4 must pass `--no-refresh`.** Extraction must not be able to rotate a
     token that will never reach the KB. Step 2 already guaranteed a fresh one.
   - **Step 5 is best-effort.** A journal sync failure is logged, never fatal,
     and never a reason to skip or repeat anything above it.

   `rotated: no` in step 2 means the access token was still good and nothing was
   consumed — skip step 3 entirely rather than rewriting an unchanged document.

   → the report file
4. Read the file back — not stdout, which also carries progress lines. Take the
   quality-control line at the top and check one number in it: **mismatches**.
   Then read the grades themselves.
   → the figures to report, and a stop signal if any term is unbacked
5. Report per the Output contract below.
   → the answer, or an explicit statement of what cannot be trusted

### Output

*For:* the guardian who asked, or the model that will reason over the grades.
Parents know their child's subjects and the 1–7 scale, and nothing about how the
report is built. Write to someone who wants to know how their kid is doing.

*Chat:* For `html`, the file path and a two-or-three line summary — the overall
average, anything below the pass mark, and whether those marks are still moving.
For `md`, answer the question that was asked, grounded in the tables you read.
Either way, only the grades: no commentary on the extraction, the arithmetic or
the state of the source data.

*File:* the OUTPUT path.

*Validate:* before reporting a single number, confirm the mismatch count is
zero. If it is not, name the affected subjects and withhold their figures. Then
re-read your draft and cut every sentence that is about the report rather than
about the student.

### Marks in the output

These decode the tables so you can read them. Only `(est)` and `🔴` are worth
passing on to the reader; the rest are internal.

`⚠️ pub. X` the figure is corrected, X is the platform's broken one · `(est)`
term in progress, estimated from the grades so far and will move · `🔴` below
the pass mark · `▲` the block that weighs most · `🚩` absence.

## Credentials

Use `--token-file`, always with an absolute path outside interactive use. The
CLI rewrites that file as tokens rotate, so it has to stay writable; it creates
any missing directories on the way. Renewal is lazy — it happens only when the
access token is dead or close to it.

Never pass a token as `--token`: it lands in shell history and is visible in
`ps`. `ISAMS_TOKEN` as an environment variable is acceptable for a one-off run
with a freshly copied access token, which lasts an hour and does not renew.

### Diagnosis

`BOLETIN auth status --token-file <abs>` reads the credentials file and the
journal and prints the state of the chain. It makes no network call, consumes
nothing and rotates nothing, so it is always safe to run — including while you
are trying to work out why something else failed.

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | — |
| 2 | bad arguments | fix the invocation |
| 3 | credentials broken or absent | manual bootstrap required. **Do not retry.** |
| 4 | unexpected error | read the message |
| 5 | indeterminate — the chain may or may not be alive | **Do not retry automatically.** One deliberate re-run is safe; a second failure means bootstrap. |

### Bootstrap, when there is no credentials file

Login is interactive and cannot be automated: the portal is an OIDC public
client with no registrable redirect URI. A person has to do it, once.

**The CLI prints the steps itself.** Any exit 3 that a browser bootstrap would
actually fix — no credentials file, or a chain the server has declared dead —
ends with the full instructions: the console snippet, and the save destination
with the path you passed already substituted in. To get them without waiting for
a failure:

```bash
BOLETIN auth bootstrap --token-file <the absolute path you will use>
```

**Relay that output verbatim. Never reconstruct the snippet from memory and
never paraphrase it.** Its step order is load-bearing — clipboard first, then
clear storage, then alert, then navigate away — and an approximate version
leaves the portal silently renewing in the background, which takes the token
chain back and breaks the next run. If you need the snippet and it is not in
front of you, run the command.

Two points worth reinforcing when you pass it on, because users read them as
optional and they are not:

- **The tab going blank is the point, not a side effect.** It destroys the
  page's JS context and with it the OIDC silent-renew timer. If the user reopens
  the portal afterwards, that session takes the chain back.
- **Do not log out.** Logging out revokes the chain and invalidates what was
  just copied.

The token goes clipboard → file, or clipboard → file → project document. It
never passes through the conversation.

## Gotchas

- **Only one consumer may hold the chain.** Refresh tokens are one-time-use:
  every renewal invalidates the previous handle, so two consumers rotating the
  same chain destroy it for each other. The bootstrap snippet enforces single
  ownership by blanking the portal tab. **If the user re-opens the portal
  afterwards, that session takes the chain back and the next run fails.** This
  is the mechanism, not a guess — and it is the most likely cause of a surprise
  failure.
- **`invalid_grant` is terminal.** Never retry it and never add backoff. The
  server no longer recognises the token; only a fresh browser bootstrap fixes it.
- **Exit 5 means the state is unknown, not broken.** The refresh may have
  succeeded with the response lost in transit. One deliberate re-run is safe; a
  second failure means bootstrap. The CLI marks the file `suspect` and says so
  on the next run.
- **Do not run the skill manually while a scheduled task may fire.**
  `project_write` is delete-and-recreate with no compare-and-swap, so two
  overlapping runs are a silent lost update — and on a rotating credential, a
  lost update is a dead chain and a manual bootstrap. Nothing in the code
  prevents this; the journal's `runId` only makes the collision legible
  afterwards.
- **Nothing here asserts how long a chain lives.** Access tokens last an hour;
  the refresh chain's real sliding or absolute lifetime is unmeasured. The
  journal's `chainAgeSec` accumulates the evidence. Until it says otherwise, do
  not repeat a number for it.
