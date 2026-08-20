# PRD — `isams-boletin` auth layer hardening

Implementation brief for Claude Code. Self-contained.

---

## 1. Context

`isams-boletin` is a Claude skill that produces a student's grade report from a
school's iSAMS parent portal. It ships a compiled CLI (`cli/cli.js`, plain ESM,
runs under `node`, no `npm install`) plus a `SKILL.md` that tells the model how
to run it and how to read the result.

Pipeline — three pure stages with JSON-serialisable boundaries:

```
iSAMS API ──[extract.js]──> RawExtract ──[interpret.js]──> ReportModel ──[render/*]──> html | md | csv
```

| File               | Role                                              |
| ------------------ | ------------------------------------------------- |
| `cli/cli.js`       | arg parsing, credential resolution, orchestration |
| `cli/auth.js`      | JWT inspection, `refreshAccessToken()`            |
| `cli/store.js`     | `InlineStore`, `FileStore`, `HttpStore`           |
| `cli/extract.js`   | ~26 authenticated GETs, PII minimisation          |
| `cli/interpret.js` | grade model detection, averages, QC warnings      |
| `cli/render/*`     | html / markdown / csv renderers                   |
| `cli/profiles/*`   | per-school scale, pass mark, copy                 |

### How auth works today

The iSAMS parent portal is an OIDC SPA using a **public client**
(`iSAMS.Portal.Cloud.Parents`, no client secret) against Duende IdentityServer
at `https://{tenant}.isams.cloud/auth`. There is no registrable redirect URI, so
login cannot be automated. Bootstrap is manual: the user logs into the portal,
runs a console snippet that reads the `oidc.user*` entry from `sessionStorage`,
and saves `{accessToken, refreshToken, tenant}` as a credentials file.

Access tokens live **1 hour**. The refresh token is opaque and the server uses
**one-time-use rotation** — every successful refresh invalidates the previous
handle. `cli.js:resolveAccessToken()` refreshes lazily (only when the access
token is dead or near expiry) and persists the rotated token via `store.save()`
_before_ touching the data API. Lazy refresh is intentional and stays.

### The failure being fixed

Bootstrap at 01:45 with 41 minutes left on the access token, so the refresh
token was never used. Next run at 12:38: access token 612 minutes expired,
refresh attempted, `HTTP 400 invalid_grant`. The credentials file still held the
original, unmodified refresh token — the CLI had not consumed it. The chain was
consumed **outside** the CLI.

The access token's `auth_time` was ~7.5h before its `iat`: the portal SPA had
been silently renewing for hours before the snapshot was taken. The copied
refresh token belonged to a chain the browser tab was still rotating. Because
rotation is one-time-use, only one consumer can hold a chain — and the browser
held it.

Everything below follows from that: make the CLI the sole consumer, and make the
next failure diagnosable from recorded facts rather than reconstructed by
inference.

---

## 2. Two execution modes, one CLI

The skill must run in both. **The CLI has no mode awareness whatsoever.** It
reads and writes one local file, always. The difference lives entirely in
`SKILL.md` as two workflows over the same binary.

### Localhost mode

The user runs the CLI on their own machine. The local credentials file **is** the
store of record. One invocation, lazy refresh, done.

### Managed mode (Claude web scheduled task)

The container filesystem is scratch and must be treated as non-durable. The
store of record is a **project knowledge base document**, reachable only through
the assistant's `project_read` / `project_write` tool calls, which execute
outside the container. No process inside the container can reach the KB.

Established by testing:

- `project_read` on a missing path returns a document catalogue
  (`No doc or file at "…". Available: …`), not a filesystem error. The KB is not
  a mounted filesystem.
- Cross-run durability through the KB works: a document written by one scheduled
  run was read back intact by a later one.
- `doc_uuid` changes on every write, with `replaced: true`. Writes are
  delete-and-recreate; there is no ETag, version, or `If-Match`, therefore **no
  compare-and-swap** (see §6).
- Writes can fail with transient 5xx from the Projects API.

So in managed mode the local file is a **working copy**, and the assistant
couriers it with `cat` and a heredoc: KB → local → CLI → local → KB.

**Total CLI surface required for dual-mode support: absolute-path handling (W2)
and `auth refresh` (W5).** Nothing else.

---

## 3. Goals / non-goals

**Goals**

- The portal SPA stops competing for the token chain, enforced at bootstrap.
- The same CLI serves both modes with no mode flag and no mode-specific code.
- In managed mode, a rotated refresh token reaches the KB before extraction runs.
- Refresh failures are classified, recorded, and mapped to exit codes the calling
  assistant can act on without guessing.
- No secret ever passes through the conversation.

**Non-goals**

- No background or periodic warm-refresh job. Lazy refresh only.
- No advisory locking.
- No KB client, HTTP client, or courier subcommands inside the CLI. The KB is
  unreachable from the container and the CLI must not pretend otherwise.
- No third-party auth infrastructure or new runtime dependencies. `node --test`
  and stdlib only.
- No changes to extraction, interpretation, rendering, or profiles (see §8).

---

## 4. Work items

### W1 · Bootstrap: kill the SPA's token chain — `SKILL.md`

**Priority: highest.** This is the fix for the observed failure.

Replace the bootstrap snippet with one that destroys the SPA's ability to renew,
rather than asking the user to close the window and hoping.

```js
;(() => {
  const k = Object.keys(sessionStorage).find(k => k.startsWith("oidc.user"))
  if (!k) {
    alert("No se encontró la sesión OIDC. ¿Iniciaste sesión en el portal?")
    return
  }
  const o = JSON.parse(sessionStorage[k])
  copy(
    JSON.stringify(
      {
        accessToken: o.access_token,
        refreshToken: o.refresh_token,
        tenant: location.hostname.split(".")[0],
      },
      null,
      2
    )
  )
  sessionStorage.removeItem(k)
  alert(
    "Credenciales copiadas al portapapeles.\n\n" +
      "Al cerrar este aviso la pestaña quedará en blanco. Es a propósito: " +
      "evita que el portal siga renovando el token y te lo invalide.\n\n" +
      "Guarda el portapapeles como archivo de credenciales (NO lo pegues en el chat)."
  )
  location.replace("about:blank")
})()
```

Implementation notes:

- **Order is load-bearing.** `copy()` first — the clipboard survives navigation.
  Then clear the storage key, then `alert()` so the message is read, then
  navigate.
- **Do not add `window.close()`.** Chrome only permits it for script-opened
  windows; a manually-opened tab ignores it silently. `location.replace` is the
  working equivalent — it destroys the page's JS context and every timer in it,
  including the OIDC silent-renew timer. `replace` rather than `href` so Back
  cannot resurrect the SPA.
- `sessionStorage.removeItem` alone is insufficient — oidc-client-ts also holds
  the user in memory, so an already-scheduled renew could still fire. Both steps
  are required.

**Destination, by mode.** Same clipboard, two landing places — in neither does
the token pass through the conversation:

- **Localhost:** `pbpaste > /abs/path/credenciales.json` (macOS) or
  `Get-Clipboard > credenciales.json` (PowerShell).
- **Managed:** save the clipboard to a local file and attach it to the project as
  the KB document `claude/credenciales.json`.

Keep the incognito recommendation. Keep "do not log out" (logout revokes the
chain), attached to the window rather than to a manual close step.

**Acceptance:** running the snippet leaves a blank tab, no `oidc.user*` key, and
valid JSON on the clipboard. Pressing Back afterwards does not restore a working
portal session. `SKILL.md` nowhere instructs anyone to paste a token into the
conversation.

### W2 · Credential path handling — `store.js`, `cli.js`

`FileStore` remains the only store implementation and serves both modes
unchanged. This is the whole of the CLI's dual-mode support.

- `--token-file <path>` accepts absolute or relative. Resolve with
  `path.resolve()` and use the absolute form everywhere thereafter, including in
  log lines and error messages.
- Before any write in `FileStore.save()`:
  `mkdirSync(dirname(absPath), { recursive: true })`. Idempotent.
- `FileStore.load()` on a missing file returns `{}` as today; a missing
  _directory_ is likewise not an error at load time.
- Keep the default `credenciales.json` (relative to cwd) for interactive use.

**Acceptance:** `--token-file /home/claude/work/creds/credenciales.json` succeeds
where neither `work/` nor `creds/` exists, creating both, file mode `0600`.

### W3 · Refresh margin 300s → 900s — `cli.js`

`RENEW_BEFORE_SEC = 900`. Extraction is ~26 sequential HTTP requests and five
minutes of headroom is thin if the API is slow or `--delay` is raised; a token
expiring mid-extraction wastes both the run and a refresh.

Adjust the associated log line (`aviso: al token le quedan N min…`) so its
thresholds still read sensibly against the new value.

**Acceptance:** a token with 12 minutes remaining triggers a refresh; one with 20
minutes does not.

### W4 · Refresh outcome taxonomy and exit codes — `auth.js`, `cli.js`

Today every non-2xx from the token endpoint becomes a `TokenError` and exit 3,
conflating states with opposite remedies.

Classify every refresh attempt into exactly one outcome:

| Outcome         | Trigger                                                                       | Meaning                                                                          | Store action                             | Exit |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ---- |
| `ok`            | 2xx carrying `refresh_token`                                                  | rotated; we hold the chain                                                       | persist new credentials, clear `suspect` | —    |
| `dead`          | HTTP 400 with `error: invalid_grant`                                          | server definitively refused; the handle no longer exists                         | leave the file untouched                 | `3`  |
| `indeterminate` | network error, timeout, 5xx, unparseable body, or 2xx missing `refresh_token` | no answer received — the server may already have rotated and the result was lost | set `suspect: true`                      | `5`  |

`indeterminate` is currently invisible: if `fetch` throws after the server
rotated, the stale token stays on disk looking healthy while being dead, and the
next run misattributes the resulting `invalid_grant`.

When `suspect: true` is set, the next run must say so before doing anything else:

> La corrida anterior no pudo confirmar si la renovación se completó. Si esta
> falla con `invalid_grant`, la causa es esa.

Clear the flag on any `ok`.

**Exit codes:**

```
0  ok
2  bad arguments
3  credentials broken or absent — manual bootstrap required, do NOT retry
4  unexpected error
5  indeterminate credential state — chain may or may not be alive, do NOT retry
```

Absent credentials share exit 3 with a dead chain: the remedy is identical, and
the CLI has no mode awareness with which to tailor the message. Print both
remedies unconditionally, naming the resolved path it actually looked at:

```
error: no hay credenciales utilizables.
  ruta: /home/claude/work/credenciales.json  (no existe)

Abre el portal en incógnito, ejecuta el snippet de bootstrap (ver SKILL.md) y
guarda el JSON del portapapeles:
  · Modo local:       pbpaste > /ruta/credenciales.json
  · Tarea programada: adjunta el archivo al proyecto como claude/credenciales.json
```

**Acceptance:** a stubbed network failure mid-refresh exits 5 and sets
`suspect: true`; a real `invalid_grant` exits 3 and leaves the credentials file
byte-identical; a missing file exits 3 with no network call and prints the
resolved path.

### W5 · `boletin auth refresh` — `cli.js`

Standalone subcommand: rotate if needed, persist locally, print one
machine-readable line to stdout.

```
rotated: yes · rtTail: 8f2a1c · expiresAt: 2026-08-20T13:38:04Z
rotated: no  · rtTail: 8f2a1c · expiresAt: 2026-08-20T13:12:04Z
```

Roughly fifteen lines reusing `resolveAccessToken` and `store.save`. Exit codes
per W4.

Two uses. In managed mode it is what lets the workflow get the rotated token
durable in the KB **before** it is spent on extraction — and `rotated: no` tells
the assistant it can skip the KB write entirely, cutting churn. In localhost mode
it is a diagnosis tool.

**Acceptance:** two consecutive calls within the margin produce `rotated: no` the
second time and leave the file byte-identical.

### W6 · Chain journal — new `cli/journal.js`

Append-only JSONL, mode `0600`, written to the same directory as the credentials
file — same absolute-path resolution and `mkdir -p` treatment as W2.

- Default path: sibling of the token file with `.journal.jsonl`
  (`/home/claude/work/credenciales.json` →
  `/home/claude/work/credenciales.journal.jsonl`).
- Overridable with `--journal <path>`, also resolved and `mkdir -p`'d.

One line per token-endpoint interaction and per detected credential change:

```json
{
  "ts": "2026-08-20T12:38:04.221Z",
  "event": "refresh",
  "outcome": "dead",
  "tenant": "britishroyal",
  "runId": "a3f9c1",
  "trigger": "scheduled",
  "oldRtTail": "8f2a1c",
  "newRtTail": null,
  "httpStatus": 400,
  "error": "invalid_grant",
  "errorDescription": null,
  "bodySnippet": "{\"error\":\"invalid_grant\"}",
  "accessTokenExp": "2026-08-20T02:26:41Z",
  "accessTokenIat": "2026-08-20T01:26:41Z",
  "authTime": "2026-08-19T18:02:11Z",
  "chainAgeSec": 66353
}
```

Rules:

- **Never write a full token.** `oldRtTail` / `newRtTail` are the last 6
  characters only.
- `chainAgeSec` = now − `authTime` from the most recent access token. Accumulated
  over weeks this yields the chain's real lifetime, which is currently unknown
  and must not be asserted anywhere until measured.
- `trigger`: `manual` | `scheduled`, from a `--trigger` flag defaulting to
  `manual`.
- `runId`: short random per-process id, so interleaved entries from overlapping
  runs stay distinguishable — the only signal that will make a KB lost update
  (§6) legible after the fact.
- `event`: `bootstrap` (a credentials file with a previously unseen refresh-token
  tail is loaded), `refresh`, `reuse` (access token still valid, no refresh
  needed).
- **Rotate at 200 lines.** The file is synced to the KB as a document, so keep it
  small.
- **Journal writes must never fail the run.** Wrap in try/catch, warn to stderr,
  continue.

**Acceptance:** a full cycle (bootstrap → reuse → refresh → dead) produces four
correlatable lines, and no full token appears anywhere in the file.

### W7 · Capture `error_description` and raw body — `auth.js`

`refreshAccessToken()` currently throws a hardcoded string on
`400 + invalid_grant` and discards the response body — on the one error that
matters most. Duende often suppresses `error_description`, but not always, and
when present it is the most informative string in the failure.

- Parse the body as JSON when possible. Retain `error`, `error_description`, and
  a 200-character raw snippet.
- Surface `error_description` in the user-facing message when non-empty.
- Pass all three to the journal on every outcome.
- Replace the current message, which asserts three possible causes as if
  enumerated from evidence, with what is known plus the remedy:

  > `invalid_grant`: el servidor ya no reconoce este refresh token. No es
  > transitorio y no sirve reintentar: hace falta un bootstrap nuevo desde el
  > navegador.

  Append the journal path as a pointer for anyone wanting history.

**Acceptance:** a token endpoint returning
`{"error":"invalid_grant","error_description":"Refresh token has expired"}` shows
that description to the user and records it in the journal.

### W8 · Store cleanup — `store.js`, `cli.js`

- **Delete `HttpStore`**, `--token-endpoint`, `--token-api-key`,
  `--token-header`, and the `ISAMS_TOKEN_API_KEY` env var. `--token-api-key`
  carried the same shell-history and `ps` exposure as `--token` without the
  warning; removing it is simpler than documenting it.
- Prune the corresponding validation in `parseArgs` — the `fuentes` count, the
  "elige una sola vía" branch, the endpoint-requires-key check — plus `--help`.
- **Keep the `CredentialStore` interface** (`load()`, `save(creds)`, `name`,
  `writable`) and `buildStore()` as the single dispatch point.
- Keep `InlineStore` and its existing warning about rotation stranding the token.
  No new guard flag.
- Make the temp filename in `FileStore.save()` collision-proof: currently
  `.${Date.now()}.tmp`, which two processes in the same millisecond share. Append
  `runId` or `process.pid`.
- Store `refreshTokenPrevious` as a **6-character tail only**, so a suspect
  rotation is diagnosable from the file alone.

**Acceptance:** `--help` lists only `--token`, `--refresh-token`, `--token-file`,
`--journal`, `--trigger`, `--tenant`, `--no-refresh` among credential flags. No
dead code paths remain.

### W9 · `boletin auth status` — `cli.js`

A read-only subcommand that consumes nothing and rotates nothing. This is what
the assistant runs when the user asks why something failed, and what makes the
3-vs-5 distinction actionable.

```
$ boletin auth status --token-file /home/claude/work/credenciales.json
tenant             britishroyal
access token       vence en 34 min (2026-08-20T13:12:04Z)
auth_time          2026-08-19T18:02:11Z  (edad de la cadena: 18h 36m)
refresh token      …8f2a1c
estado             ok
última renovación  2026-08-20T12:38:04Z  (ok)
renovaciones       14 ok · 0 muertas · 1 indeterminada  (últimos 30 días)
```

Reads the credentials file and the journal. Decodes the access token locally via
the existing `inspectToken()` — **no network call, no refresh.** Prints nothing
secret beyond 6-character tails. Surfaces `suspect: true` prominently.

**Acceptance:** running it twice produces identical output and leaves the
credentials file byte-identical.

### W10 · Packaging

**W10a — shebang.** `cli/cli.js` line 1 is `#!/usr/bin/env -S npx tsx` while
`SKILL.md` states the CLI runs with plain `node` and no `npm install`. The file is
plain ESM and does run under node, but anyone who `chmod +x`es it triggers a
`tsx` fetch. Change to `#!/usr/bin/env node`.

**W10b — source provenance.** `cli/BUILD.json` carries `srcHash` for a TypeScript
source tree that is not shipped (`cli/types.js` is a bare `export {}`). Add a
`source` field with repo URL and commit, and reference it from `SKILL.md`
metadata.

**W10c — tests.** `node --test`, no framework, no dependencies. Add `cli/test/`:

- `inspectToken` — valid, expired, wrong audience, missing scope, malformed.
- Refresh outcome classification (W4) — one fixture per outcome with `fetch`
  stubbed; assert exit code and store mutation for each.
- `FileStore` — round-trip, `mkdir -p` on a missing nested directory (W2), mode
  `0600`.
- `auth refresh` (W5) — `rotated: yes` then `rotated: no`, file unchanged on the
  second call.
- **Journal redaction** — assert no full token appears in journal output for any
  fixture. This test must never be skipped.

**Acceptance:** `node --test cli/test/` passes; `./cli/cli.js --help` works from a
bare shell with no network.

---

## 5. `SKILL.md` workflows

Document both, with the mode-selection rule stated up front: **if the credentials
live in the project KB, use managed; if they live on the filesystem, use
localhost.**

### Localhost

```bash
boletin --format html --token-file /abs/path/credenciales.json --output notas.html
```

One invocation. Lazy refresh handles rotation and persists locally before the
data API is touched. No courier steps.

### Managed (Claude web scheduled task)

```
1. project_read  claude/credenciales.json
   → write to /home/claude/work/credenciales.json via bash heredoc

2. boletin auth refresh --token-file /home/claude/work/credenciales.json --trigger scheduled

3. if "rotated: yes" → cat the file → project_write claude/credenciales.json
   retry on 5xx; if it still fails, ABORT

4. boletin --format md --no-refresh --token-file <abs> --output <abs>

5. cat the journal → project_write claude/credenciales.journal.jsonl
   best-effort
```

Three rules, stated in `SKILL.md` as rules rather than description:

- **Step 3 is exactly one write of one complete document.** Never build a
  document up across multiple writes — an intermediate state is a valid-looking
  credentials document with wrong contents.
- **If step 3 fails after retries, abort. Do not run step 4.** Losing the report
  is cheap. Running extraction on a token whose successor exists only in a
  container about to vanish loses the chain and costs a manual browser bootstrap.
  This is the entire reason the refresh is a separate step.
- **Step 4 must pass `--no-refresh`.** Extraction must not be able to rotate a
  token that will never reach the KB. Step 2 already guaranteed a fresh one.
- **Step 5 is best-effort.** A journal sync failure is logged, never fatal, and
  never a reason to skip or repeat anything above it.

### Gotchas section — rewrite

The current text asserts causes it cannot establish ("hay otra sesión
compitiendo… el síntoma es `invalid_grant` apareciendo al azar"). Replace with:

- `invalid_grant` is terminal. Never retry, never add backoff.
- Exit 5 means the state is unknown; one manual re-run is safe, a second failure
  means bootstrap.
- Only one consumer may hold the chain. The bootstrap snippet enforces this by
  blanking the portal tab. **If the user re-opens the portal afterwards, that
  session takes the chain back and the next run will fail.** State this as the
  mechanism it is, not as a diagnostic guess — it is the most likely cause of a
  surprise failure.
- Do not run the skill manually while a scheduled task may fire (§6).
- Remove every reference to a chain lifetime measured in hours; it is unverified.

---

## 6. Known gap: no compare-and-swap on the KB

`project_write` is delete-and-recreate — `doc_uuid` changes on every write and
`replaced: true` reports what happened rather than gating on a precondition.
There is no ETag, version, or `If-Match` in the request shape.

Therefore a manual run overlapping a scheduled one is a **silent lost update**,
and on a rotating credential a lost update is a dead chain requiring a manual
browser bootstrap.

Nothing in this design closes that. Mitigation is procedural — do not run the
skill manually while a scheduled task may fire — plus the journal's `runId`,
which makes the collision legible afterwards. Document it in `SKILL.md`; do not
attempt to solve it in code.

---

## 7. Invariants

- No full token in stdout, stderr, the journal, log lines, error messages, or any
  file other than the credentials file itself.
- The credentials file is written atomically (temp + rename) and never left
  truncated by a normal code path.
- The rotated refresh token is persisted locally **before** the data API is
  touched.
- No code path retries a `dead` or `indeterminate` refresh automatically.
- The CLI makes no KB call and holds no KB awareness of any kind.
- No prompt, no interactive input: every run must complete or fail unattended.

---

## 8. Out of scope

Known, judged acceptable, deliberately untouched — changing them here widens the
blast radius of an auth change:

- `parentsPath` defaulting to an observed value (`'1,9,8,4,7,6'`).
- Absence of retry/backoff on the ~26 extraction GETs.
- Alphabetical period sorting in `interpret.js`.
- Aggregator period matching via digit substring.
- `buildSubject` reporting `periods[0].model` as the subject-level model.
- `--save-raw` help text describing output as "sin datos personales".
- Any renderer, profile, or grading-model logic.
- `fsync` before rename in `FileStore.save()`.
- Advisory locking between concurrent runs.
- A checksum field on the stored refresh token. Worth adding only if the journal
  ever shows evidence of a credential corrupted in transit through the KB.

---

## 9. Ordering

1. **W1** — the fix, and the largest secret-handling improvement.
2. **W2** — absolute paths; both modes depend on it.
3. **W4, W7** — outcome taxonomy, exit codes, `error_description`. Everything
   downstream depends on failures being classified.
4. **W5** — `auth refresh`; makes the managed workflow possible.
5. **W6** — journal; depends on W4's outcomes.
6. **W3, W8** — margin and store cleanup; small and independent.
7. **W9** — `auth status`; depends on W6.
8. **W10** — packaging and tests.
9. **§5** — `SKILL.md` workflows, last, once the command surface is settled.

---

## 10. Open questions

1. **Can a scheduled run `project_write` a document that was created outside the
   task** — one the user attached to the project by hand? Testing confirms a
   scheduled run can create and then update its own documents, but the bootstrap
   path (user attaches, task reads and later overwrites) has not been exercised.
   Verify before relying on it; if writes to user-created documents are refused,
   the bootstrap must invert — the task creates the document and the user edits
   it.
2. **The chain's real sliding/absolute lifetime is unknown.** Nothing in the code,
   docs, or any error message may assert a number for it. W6's journal answers it
   empirically after a few weeks of `chainAgeSec` values.
