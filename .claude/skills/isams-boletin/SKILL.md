---
name: isams-boletin
description: Generates the school report card — the matrix of grades and averages per student, subject and term — pulled live from iSAMS as HTML or Markdown. Use when asked for a student's grades, averages, report card or academic standing.
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

The one thing that makes this report worth generating: **the averages are
recomputed, not copied.** In the weighted model, when a block that carries
weight has no grades yet, iSAMS weights it as **zero** instead of excluding it. A
term with a 30% block at 4,9 and a 70% block still empty is published as **1,5**
— a failing mark for a student who is actually at 4,9, and the final average
inherits it. So every term is reproduced from its assessments: if the published
value checks out it is used as-is, and if it is distorted the weights are
renormalised over the blocks that do have grades. The parent reading the portal
sees the distorted number. You are holding the corrected one, and the gap
between them is usually the most important thing in the report.

The data is thinner than it looks, and that shapes what you may claim from it.
The API exposes no assessment dates — column order is the only hint of sequence,
and it is not a timeline. Subject and term names are opaque labels: "Nota Parcial
2" is not the second grade, it is a name. Everything you can defend saying comes
from the grades and their weights, nothing from when they happened.

## Instructions

- **Never quote the platform's published average as fact**—it is wrong in a
  specific, predictable way, and repeating it tells a parent their child is
  failing a subject they are passing.
- **Where an average was corrected, give both numbers and say which is which**—a
  parent who sees only your corrected figure cannot reconcile it with the portal
  in front of them, and will assume one of you is broken.
- **Match the format to who reads the output, not to what is convenient**—HTML
  is unreadable as text and Markdown is ugly to a person; picking wrong wastes
  the run.
- **Treat a non-zero mismatch count as a refusal to report**—it means a term
  could not be reproduced by any known model, so the number on screen has no
  backing. Name the affected subjects and say the figure is unreliable instead
  of passing it along.
- **Let the warnings drive what you surface first**—a corrected average or a
  failing final matters more than the overall mean, and the report already
  ranks that for you.

Do not produce:

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
   quality-control line at the top: terms checked, reproduced, corrected,
   estimated, **mismatches**. Then read the warnings.
   → a trust assessment, and the list of corrections worth naming
5. Report per the Output contract below.
   → the answer, or an explicit statement of what cannot be trusted

### Output

*For:* the guardian who asked, or the model that will reason over the grades.
Parents know their child's subjects and the 1–7 scale; they do not know what a
weighted block is, so explain a correction in terms of the grade, not the model.

*Chat:* For `html`, the file path and a two-or-three line summary — overall
average, anything below the pass mark, and any corrected average with both
figures. For `md`, answer the question that was asked, grounded in the tables
you just read.

*File:* the OUTPUT path.

*Validate:* before reporting a single number, confirm the mismatch count is
zero. If it is not, name the affected subjects and withhold their figures. Check
that every average you quote as corrected carries its published counterpart.

### Marks in the output

`⚠️ pub. X` corrected here, X is what the platform publishes · `(est)` term in
progress, estimated from the grades so far and will move · `🔴` below the pass
mark · `▲` the block that weighs most · `🚩` absence.

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
