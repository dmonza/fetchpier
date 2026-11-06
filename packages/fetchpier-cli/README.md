# @fetchpier/cli

`fp` — run the requests and inspect the environments of a [Fetchpier](https://fetchpier.com)
workspace from your terminal and CI. It is a thin shell over `@fetchpier/core`,
the same engine the desktop app uses, so a request behaves identically whether
you send it from the UI or from `fp run`.

No Electron, no database — just your Git-friendly workspace folder.

## Install

```bash
npm install -g @fetchpier/cli
```

Requires Node.js 22.19 or newer. On an older runtime `fp` stops immediately
with a message naming both versions (exit code 18).

## Quick start

```bash
# Create a workspace and run its starter request
fp init my-api
fp run --workspace my-api

# From anywhere inside a workspace: run every request under requests/
cd my-api
fp run

# Run one request, or one folder, against an environment
fp run requests/auth/login.http --env staging
fp run requests/auth
```

A workspace is a folder containing `.fetchpier/settings.json`. Requests are the
`.http` files under its `requests/` folder; environments are the folders under
`environments/`.

## Commands

| Command                        | Description                                                                            | Needs a workspace |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------- |
| `fp run [paths...]`            | Alias for `fp request run`.                                                            | Yes               |
| `fp request run [paths...]`    | Run `.http` files and/or folders. With no path, runs the workspace's `requests/`.      | Yes               |
| `fp env list`                  | Print each environment's folder name, one per line.                                    | Yes               |
| `fp env current`               | Print the environment a run would select (`--env` > `FETCHPIER_ENV` > `default`).      | Yes               |
| `fp init [name]`               | Create a new workspace in `./<name>`, or in the current folder when `name` is omitted. | No                |
| `fp --help`, `fp <cmd> --help` | Help for the program or a command.                                                     | No                |
| `fp -V`, `fp --version`        | Print the version and copyright notice.                                                | No                |

When a command needs a workspace and none is found, it exits with code 4.

### `fp run` / `fp request run`

**Which files run.**

- **No path:** every `.http` file under the workspace's `requests/` folder,
  recursively — the same set from any directory, inside or outside the workspace.
- **Explicit paths** (files or folders, as many as you like) are relative to the
  **current directory**, like any other command-line tool, so shell completion
  always produces a valid argument. If a path is missing from the current
  directory but exists inside the workspace, the error suggests the path to type:

  ```
  $ fp run requests/auth/login.http --workspace my-api
  Error: Path not found: requests/auth/login.http
    Did you mean my-api/requests/auth/login.http? Paths are relative to the current directory.
  ```

- Folders are walked in name order; `.runs/`, `.fetchpier/` and `.git/` are skipped.
- A `.http` file may hold several requests (`###` separators); only the **first**
  is executed, with a notice naming the file.

**Flags.**

| Flag                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-w, --workspace <path>`        | Workspace folder. Default: `FETCHPIER_WORKSPACE`, then upward discovery from the current directory.                                                                                                                                                                                                                                                                                                                         |
| `-e, --env <name>`              | Environment folder name (case-insensitive). Default: `FETCHPIER_ENV`, then `default`.                                                                                                                                                                                                                                                                                                                                       |
| `--env-var <KEY=VALUE>`         | Override a variable for this run (repeatable). A script that later sets the same variable wins from then on.                                                                                                                                                                                                                                                                                                                |
| `--persist-env`                 | Save script variable changes (`fp.environment.set` / `remove`) to the local values, exactly as the desktop does. Default: they apply to the rest of the run only.                                                                                                                                                                                                                                                           |
| `--bail`                        | Stop after the first failed request — failed test, script error, file with no request, or a request that got no response.                                                                                                                                                                                                                                                                                                   |
| `--delay <ms>`                  | Wait between requests (whole number, 0 or more).                                                                                                                                                                                                                                                                                                                                                                            |
| `--timeout <ms>`                | Per-request timeout (whole number). Default `30000` (30 s, like the desktop). `0` disables it — the only way to.                                                                                                                                                                                                                                                                                                            |
| `--proxy <url>`                 | Send every request through this proxy (`http://user:pass@host:port`). Wins over `HTTPS_PROXY` / `HTTP_PROXY`.                                                                                                                                                                                                                                                                                                               |
| `--no-proxy`                    | Ignore `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` for this run. Cannot be combined with `--proxy`.                                                                                                                                                                                                                                                                                                                           |
| `--insecure`                    | Do not verify TLS certificates for this run.                                                                                                                                                                                                                                                                                                                                                                                |
| `--tls-config <file>`           | Client certificates and CAs for this run only, from a JSON file in the workspace's TLS format (see **TLS** below). Wins over `FETCHPIER_TLS_CONFIG`.                                                                                                                                                                                                                                                                        |
| `--reporter-json <file>`        | Write a JSON report. `-` writes it to stdout and silences the terminal reporter.                                                                                                                                                                                                                                                                                                                                            |
| `--reporter-json-no-body`       | Omit response bodies from the JSON report.                                                                                                                                                                                                                                                                                                                                                                                  |
| `--reporter-junit <file>`       | Write a JUnit XML report.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--reporter-html <file>`        | Write a standalone HTML report.                                                                                                                                                                                                                                                                                                                                                                                             |
| `--reporter-html-only-failures` | Open the HTML report with its "only failures" filter on.                                                                                                                                                                                                                                                                                                                                                                    |
| `--save-history`                | Record each request that got a response in the workspace history (`requests/.runs/`), exactly like the desktop activity log — a local debugging record, git-ignored by default. Like the activity log it hides `Authorization` but keeps API keys and cookie values as sent: do not upload it as a CI artifact (the reports are the CI artifact, and they redact them).                                                     |
| `--suppress-exit-code`          | Exit 0 even when requests failed (fatal errors still exit non-zero).                                                                                                                                                                                                                                                                                                                                                        |
| `--show-secrets`                | Do not redact credentials and cookies in the output: `Authorization` / `Proxy-Authorization`, the API-key auth credential (query or header), `Cookie` and `Set-Cookie` values; and show each response as received, secret values included. This applies to the terminal and every report, report files included. The request and script output still print secrets as `{secret:<name>}`, and `--save-history` stays masked. |
| `--ascii`                       | Use ASCII glyphs instead of Unicode.                                                                                                                                                                                                                                                                                                                                                                                        |
| `--no-color`                    | Disable ANSI colors.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--silent`                      | Suppress stdout (errors still go to stderr).                                                                                                                                                                                                                                                                                                                                                                                |
| `-v, --verbose`                 | More detail, repeatable — see below.                                                                                                                                                                                                                                                                                                                                                                                        |

Only the JSON reporter accepts `-`; a report path whose directory does not exist
is rejected (exit code 2). Several reporters can be combined in one run. A
single-value option given twice keeps its last value (the usual command-line
convention) — two `--reporter-json` write only the last one.

`--timeout` and `--delay` accept whole numbers from `0` to `2147483647` (the
runtime's timer limit, about 24.8 days); anything else is a usage error (exit 3).

**Verbosity.** Levels add up, and are the same for one or many requests:

| Level   | Adds                                                                                  |
| ------- | ------------------------------------------------------------------------------------- |
| default | The request and response lines, and every script's `fp.log` / `warn` / `error` output |
| `-v`    | Each request's test list, and the full URL instead of its path                        |
| `-vv`   | Request and response headers                                                          |
| `-vvv`  | Request and response bodies, each cut at 64 KB (the JSON report has the full body)    |

Redaction and secret masking apply at every level. A binary body is never
dumped to the terminal: `-vvv` prints one line with its size and type instead
(a compressed response that was decoded is judged by its decoded content). Other
text is printed as received. A request that got no response reads
`no response: <reason>` (unreachable, TLS, timeout, proxy); one that was never
attempted reads `not run: <reason>` (a file with no request, a pre-request
script that failed, a binary file that is missing or whose reference is invalid).

**Missing variables.** A `{{var}}` with no value in the chosen environment is
sent literally, and a `{{$env.NAME}}` that neither `.env` nor the process
environment defines is sent empty; each prints a warning (also in the JSON
report, with a stable `code`) for the request that uses it. Neither fails the
run — check the warnings, or assert on the response, to make a missing
credential fail a pipeline. A name defined with an empty value is intended and
produces no warning.

**Secrets in scripts.** Only the secrets a request references (in its URL,
headers, body or auth) are decrypted for it, so a script that reads a secret
its own request does not use gets `undefined`. Reference it in the request, or
pass it through a plain variable.

**Masking limits.** Secrets are masked by exact match, like CI log masking: a
server that echoes a secret back escaped (inside JSON, URL-encoded) or a script
that transforms it (hashes, encodes, slices it) is not recognized, and a very
short secret can mask unrelated text that contains it. Prefer secrets of a
realistic length.

**Variables between requests.** A value a script sets with `fp.environment.set`
(or removes with `fp.environment.remove`) applies to every later request of the
same run — a login's token reaches the next call. A value set under a secret
variable's name stays masked as `{secret:<name>}` everywhere, including in the
response it came from (the login's own body and headers); only `--show-secrets`
shows that response as received, and never in `--save-history`. Without
`--persist-env` nothing is written to the workspace.

**`--persist-env` after a key rotation.** If a teammate rotated the workspace
key and you pulled it, your local values stay encrypted with the previous key
until you open the workspace in the desktop app with the new key (it
re-encrypts them). Until then, `fp run --persist-env`:

- does not save script writes to **secret** variables;
- prints a warning naming the cause and the fix (open the workspace in the
  desktop app with the new key);
- keeps using the value in memory for the rest of the run;
- saves writes to plain variables normally.

A CI checkout has no local values, so this only happens on a developer machine.

**Proxy.** `HTTPS_PROXY` applies to https targets and `HTTP_PROXY` to http
targets (lowercase forms too); `NO_PROXY` excludes hosts, domain suffixes,
`host:port` entries, or everything (`*`). `--proxy` overrides both variables;
`--no-proxy` ignores all three. The active proxy is shown in the header without
credentials, followed by the `NO_PROXY` list when there is one; at `-v` and above
each request says whether it went `via proxy` or `direct`. An unusable proxy URL
stops the run before anything is sent (exit code 3), with an error that names
the flag or variable it came from but never the URL, so its credentials stay
out of the log; a proxy that does not answer fails the request in the report.

**TLS.** The runner applies the workspace's TLS configuration exactly like the
desktop: the CA certificates and client certificates listed in the `tls` block
of `.fetchpier/settings.json`, whose files live under `.fetchpier/certs/` (both
are managed from the desktop's workspace settings and travel with the
workspace, so anything there is shared with whoever gets the workspace). A
client certificate is presented to the hosts it is configured for; a passphrase
that references a secret variable is decrypted with `FETCHPIER_WORKSPACE_KEY`.
Certificates configured only in the desktop's own app settings are not visible
to the runner. `--insecure` turns off certificate verification for a run.

A certificate that must not be shared — a CI identity, a personal key — is given
for one run instead, with `--tls-config <file>` or `FETCHPIER_TLS_CONFIG=<file>`.
The file uses the same format as the workspace's `tls` block, and the
certificate files it names sit next to it:

```json
{
  "clientCertificates": [
    {
      "host": "api.example.com",
      "type": "pem",
      "certFile": "client.crt",
      "keyFile": "client.key",
      "passphrase": "{{certPassphrase}}"
    }
  ],
  "caCertificates": [{ "file": "corp-root.pem" }]
}
```

`port` (default any), `id` and `disabled` are optional; `type` is `pem` (with
`certFile` and `keyFile`) or `pfx` (with `pfxFile`). A passphrase is a literal or
a `{{variable}}` — a secret, or one given with `--env-var` — like in the
workspace. When a workspace certificate matches the same host just as
specifically, the one from `--tls-config` is used. Nothing is copied into the
workspace. A file that cannot be read, is not valid JSON or is not a valid TLS
block stops the run before anything is sent (exit code 3); the error names the
file but never quotes it.

**Binary bodies.** A request whose body is a file attached in the desktop
(staged under `requests/.files/`) is sent with exactly that file's bytes, and
with the `Content-Type` of its file type unless the request sets one.

**Default headers.** When a request does not set them, the CLI sends
`User-Agent: Fetchpier-CLI/<version>` and `Accept-Encoding: gzip, deflate, br`.
Compressed responses (`gzip`, `deflate`, `br`) are decoded; the JSON report
carries `compressedBytes`, `decompressedBytes` and `decodingStatus`. A body
that cannot be decoded is kept as received, with a warning, and
`fp.response.json()` fails with the real cause.

A request that received any response — including a 4xx or 5xx — passes unless
one of its tests fails.

### `fp env list` / `fp env current`

| Flag                     | Applies to        | Effect                                       |
| ------------------------ | ----------------- | -------------------------------------------- |
| `-w, --workspace <path>` | `list`, `current` | Workspace folder (same resolution as `run`). |
| `-e, --env <name>`       | `current`         | Environment to report as current.            |

`fp env list` prints folder names — exactly the strings `--env` accepts — and a
warning for any environment folder whose `config.json` cannot be read. `fp env
current` prints the name a run would select without checking that it exists; a
run with an unknown environment exits with code 6 and lists the available ones,
and one whose `config.json` cannot be read exits with code 4 naming the file.

Like the desktop, `fp run` and `fp env list` keep an environment's display name
in step with its folder: if the `name` in `config.json` does not match the folder
(for example after renaming the folder by hand), they rewrite that one field.

`fp env switch` is **not** part of this release. The desktop persists the
active environment in its own user-data store (outside the workspace), which
the CLI cannot write to. `fp env current` reflects the CLI's own CI-friendly
resolution, never the desktop's last UI selection.

### `fp init [name]`

| Flag                | Effect                                          |
| ------------------- | ----------------------------------------------- |
| `--template <kind>` | Starter request: `rest` (default) or `graphql`. |

Creates `.fetchpier/`, a `default` environment with a `baseUrl` variable,
`requests/example.http`, and a `.gitignore` (only if none exists). Existing
files are never overwritten. Fails with exit code 4 if the target already is a
workspace. It ends by printing the command to run next (`fp run --workspace
my-api`, or `fp run` when initializing the current folder), which works as
printed from the same directory.

## Context resolution

- **Workspace:** `--workspace` > `FETCHPIER_WORKSPACE` > upward discovery of a
  folder containing `.fetchpier/settings.json`, starting at the current
  directory and stopping above your home directory.
- **Environment:** `--env` > `FETCHPIER_ENV` > `default`, matched
  case-insensitively against the environment's folder name. The CLI never reads
  the desktop's active-environment preference — predictable in CI.
- **Variables:** environment values, then per-machine local values, then
  `--env-var` overrides, then whatever earlier scripts of the run set.
  `{{$env.NAME}}` references resolve from a `.env` file at the workspace root,
  then from the process environment.

## Environment variables

| Variable                     | Purpose                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `FETCHPIER_WORKSPACE`        | Workspace folder, when `--workspace` is not given.                                      |
| `FETCHPIER_ENV`              | Environment folder name, when `--env` is not given.                                     |
| `FETCHPIER_WORKSPACE_KEY`    | Workspace key (`FPK1-…`) used to decrypt secret variables. See below.                   |
| `FETCHPIER_TLS_CONFIG`       | Path to TLS material for the run, when `--tls-config` is not given (see **TLS** above). |
| `HTTPS_PROXY` / `HTTP_PROXY` | Proxy for https / http targets (see **Proxy** above).                                   |
| `NO_PROXY`                   | Targets that connect directly.                                                          |
| `NO_COLOR`                   | Disable colors (same as `--no-color`).                                                  |
| `FORCE_COLOR`                | Force colors on when stdout is not a terminal (`0` does not force).                     |

## Secrets in CI

Secret environment variables are stored encrypted in the workspace. To use them
in a run, provide the workspace key through `FETCHPIER_WORKSPACE_KEY` — typically
injected from your CI provider's secret store. Resolution is lazy: a run that
touches no secret needs no key. Reports never print decrypted values; they show
`{secret:<name>}` instead — including in what a script logs or a failed
assertion prints (a value a script transforms, e.g. hashes, cannot be
recognized).

A run that needs a secret it cannot resolve stops before sending, with a
dedicated exit code: 14 (key missing), 15 (key invalid for this workspace),
16 (value cannot be decrypted), 17 (secret has no value set).

## Exit codes

| Code  | Meaning                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Success.                                                                                                                                                                                       |
| 1     | A request failed (failed test, script error, no response, or a file with no request), or a usage error (unknown command or option, bare `fp`).                                                 |
| 2     | Report output target invalid (directory missing, or `-` for a reporter other than JSON).                                                                                                       |
| 3     | Invalid flag value (`--timeout`, `--delay`), an unusable proxy URL (flag or variable), or `--proxy` together with `--no-proxy`.                                                                |
| 4     | Workspace not found or invalid — including a `.fetchpier/settings.json` or a selected environment's `config.json` that cannot be parsed; or `fp init` on a folder that already is a workspace. |
| 5     | An input path does not exist or is not a `.http` file/folder; or the workspace has no `requests/` folder.                                                                                      |
| 6     | Environment not found.                                                                                                                                                                         |
| 7     | Malformed `--env-var` (expected `KEY=VALUE`).                                                                                                                                                  |
| 8     | Reserved for fatal parse errors. A file that cannot be parsed into a request is reported as a failed request (exit 1).                                                                         |
| 9     | Unknown reporter (reachable only through the programmatic API).                                                                                                                                |
| 10–13 | Reserved for multipart errors. Today a multipart problem is reported as a failed request with its reason (exit 1).                                                                             |
| 14    | A referenced secret needs the workspace key, and `FETCHPIER_WORKSPACE_KEY` is not set.                                                                                                         |
| 15    | The workspace key is malformed or does not belong to this workspace.                                                                                                                           |
| 16    | A referenced secret value cannot be decrypted.                                                                                                                                                 |
| 17    | A referenced secret has no value set.                                                                                                                                                          |
| 18    | Node.js is older than the supported minimum.                                                                                                                                                   |
| 19    | Nothing to run: a target folder (or the workspace's `requests/`) holds no `.http` file. Not masked by `--suppress-exit-code`.                                                                  |
| 130   | Aborted by Ctrl-C / SIGTERM (partial reports are still written).                                                                                                                               |
| 255   | Internal error (a bug — please file an issue).                                                                                                                                                 |

## Programmatic API

The same engine, callable from your own Node scripts (CommonJS and ESM):

```ts
import { run, init, listEnvironments, currentEnvironment } from '@fetchpier/cli'

// No paths: the workspace's requests/ tree, from any working directory.
const summary = await run({ paths: [], workspace: '/path/to/ws', silent: true })
console.log(summary.summary.requests) // { total, passed, failed }
console.log(summary.summary.tests) // { total, passed, failed }
```

`run` returns the structured `RunSummary` (the JSON reporter's schema) and never
calls `process.exit` — your code decides what to do with the result. Explicit
`paths` are relative to the process's current directory. By default `run` also
prints the terminal report to stdout; pass `silent: true` or your own
`reporters` to avoid it. Fatal conditions (workspace, path, environment,
secrets) reject the promise instead of returning a summary; a `CliError`
carries its exit code in `exitCode`.

## Sandbox threat model

Pre/post-request scripts run in a `node:vm` sandbox with the `fp.*` API, exactly
as in the desktop. **The sandbox prevents accidental mistakes in scripts; it is
not a defense against an adversary who has placed malicious code in your
workspace.** If you run untrusted collections in CI, run `fp` inside a container
or another isolation boundary. Fetchpier does not promise to contain hostile
script code.

## CI examples

GitHub Actions — workspace in the `api/` folder of the repository:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm install -g @fetchpier/cli
- run: mkdir -p reports && fp run --env ci --reporter-junit reports/fp.xml
  env:
    FETCHPIER_WORKSPACE: ${{ github.workspace }}/api
    FETCHPIER_WORKSPACE_KEY: ${{ secrets.FETCHPIER_WORKSPACE_KEY }}
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: fetchpier-report, path: reports/fp.xml }
```

GitLab CI — workspace at the repository root:

```yaml
api-tests:
  image: node:22
  script:
    - npm install -g @fetchpier/cli
    - fp run --reporter-junit report.xml
  artifacts:
    when: always
    reports:
      junit: report.xml
```

To run a subset, pass a path relative to the job's working directory, e.g.
`fp run api/requests/smoke`.
