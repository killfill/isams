---
name: isams-boletin
description: Generates the school report card — grades and averages per student, subject and term, pulled live from iSAMS as HTML or Markdown. Use when asked for a student's grades, averages or report card.
metadata:
  source: isams-boletin
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

## Workflow

Resolve credentials, choose the format from the reader, run the CLI, then read
the quality-control line before saying anything about the numbers.

### Variables / Inputs

- CREDENTIALS: path to the credentials file. Default: `credenciales.json`. If
  absent: run the bootstrap below — it needs the user, so ask before doing
  anything else.
- FORMAT: `html` or `md`. If undefined: derive it from the reader, per step 2.
- OUTPUT: path for the report file. Always set one.

### Steps

1. Check that CREDENTIALS exists. If not, walk the user through the bootstrap
   below and stop until they have pasted the file.
   → a usable credentials file
2. Decide who reads the output and pick the format from it.

   | Reader | Format | Why |
   |---|---|---|
   | A person — the user wants to *see* the grades | `html` | Full matrix, one column per assessment, with colour, weight shading and hover tooltips. Not readable as text. |
   | A model — you need to read, evaluate or reason over the results | `md` | The same data as data-tables: the subject × term matrix, then per-subject tables with every assessment, its block, its weight and its grade. |

   → the `--format` value
3. Run the CLI. `BOLETIN` below is
   `node .claude/skills/isams-boletin/cli/cli.js` from the project root, or the
   absolute path to this skill's `cli/cli.js` from anywhere else. Run
   `BOLETIN --help` for flags beyond these three.

   ```bash
   BOLETIN --format html --token-file credenciales.json --output notas.html
   BOLETIN --format md   --token-file credenciales.json --output notas.md
   ```
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

Use `--token-file credenciales.json`. The CLI rewrites it on every run as tokens
rotate, so it has to stay writable. Renewal is automatic. `ISAMS_TOKEN` as an
environment variable works for a one-off run with a freshly copied access token,
which lasts an hour and does not renew. Avoid passing tokens as `--token`: they
land in shell history and are visible in `ps`.

### Bootstrap, when there is no credentials file

Login is interactive and cannot be automated. Ask the user to do it, and give
them these steps verbatim:

1. Open an **incognito window** — if the portal stays open in their normal
   session, its silent renewal competes for the same token chain and
   intermittently invalidates the CLI's copy.
2. Log in to the parent portal at `{tenant}.parents.isams.cloud`, open the
   browser console and run:

   ```js
   copy(JSON.stringify(
     (o => ({ accessToken: o.access_token, refreshToken: o.refresh_token, tenant: location.hostname.split('.')[0] }))
     (JSON.parse(sessionStorage[Object.keys(sessionStorage).find(k => k.startsWith('oidc.user'))]))
   , null, 2))
   ```

3. Paste the clipboard into `credenciales.json`.
4. **Close the window without logging out.** Logging out revokes the token chain
   and invalidates what they just copied.

## Gotchas

- **`invalid_grant` is terminal, not transient.** Do not retry and do not add
  backoff — the token chain is broken and the user has to redo the bootstrap.
  Retrying only wastes time.
- **One token chain, one consumer.** If the user has the portal open in a
  browser while the CLI runs, both rotate the token and invalidate each other.
  The symptom is `invalid_grant` appearing at random with no pattern. Ask
  whether the portal is open before diagnosing anything else.
- **Exit 3 is credentials or API, exit 2 is bad arguments.** A run that exits 3
  on the first attempt of the day usually means the chain is gone, not that the
  flags are wrong.
