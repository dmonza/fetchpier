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

| Flag                            | Effect                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `-w, --workspace <path>`        | Workspace folder. Default: `FETCHPIER_WORKSPACE`, then upward discovery from the current directory.                       |
| `-e, --env <name>`              | Environment folder name (case-insensitive). Default: `FETCHPIER_ENV`, then `default`.                                     |
| `--env-var <KEY=VALUE>`         | Override a variable for this run (repeatable; highest precedence).                                                        |
| `--bail`                        | Stop after the first failed request — failed test, script error, file with no request, or a request that got no response. |
| `--delay <ms>`                  | Wait between requests.                                                                                                    |
| `--timeout <ms>`                | Per-request timeout.                                                                                                      |
| `--insecure`                    | Do not verify TLS certificates for this run.                                                                              |
| `--reporter-json <file>`        | Write a JSON report. `-` writes it to stdout and silences the terminal reporter.                                          |
| `--reporter-json-no-body`       | Omit response bodies from the JSON report.                                                                                |
| `--reporter-junit <file>`       | Write a JUnit XML report.                                                                                                 |
| `--reporter-html <file>`        | Write a standalone HTML report.                                                                                           |
| `--reporter-html-only-failures` | Open the HTML report with its "only failures" filter on.                                                                  |
| `--save-history`                | Record each request that got a response in the workspace history (`requests/.runs/`), like the desktop does.              |
| `--suppress-exit-code`          | Exit 0 even when requests failed (fatal errors still exit non-zero).                                                      |
| `--show-secrets`                | Do not redact `Authorization` / `Proxy-Authorization` headers in reports.                                                 |
| `--ascii`                       | Use ASCII glyphs instead of Unicode.                                                                                      |
| `--no-color`                    | Disable ANSI colors.                                                                                                      |
| `--silent`                      | Suppress stdout (errors still go to stderr).                                                                              |
| `-v, --verbose`                 | Increase verbosity; repeatable (`-v`, `-vv`, `-vvv`).                                                                     |

Only the JSON reporter accepts `-`; a report path whose directory does not exist
is rejected (exit code 2). Several reporters can be combined in one run.

A request that received any response — including a 4xx or 5xx — passes unless
one of its tests fails.

### `fp env list` / `fp env current`

| Flag                     | Applies to        | Effect                                       |
| ------------------------ | ----------------- | -------------------------------------------- |
| `-w, --workspace <path>` | `list`, `current` | Workspace folder (same resolution as `run`). |
| `-e, --env <name>`       | `current`         | Environment to report as current.            |

`fp env list` prints folder names — exactly the strings `--env` accepts. `fp env
current` prints the name a run would select without checking that it exists; a
run with an unknown environment exits with code 6 and lists the available ones.

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
  `--env-var` overrides. `{{$env.NAME}}` references resolve from a `.env` file at
  the workspace root, then from the process environment.

## Environment variables

| Variable                  | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `FETCHPIER_WORKSPACE`     | Workspace folder, when `--workspace` is not given.                    |
| `FETCHPIER_ENV`           | Environment folder name, when `--env` is not given.                   |
| `FETCHPIER_WORKSPACE_KEY` | Workspace key (`FPK1-…`) used to decrypt secret variables. See below. |
| `NO_COLOR`                | Disable colors (same as `--no-color`).                                |
| `FORCE_COLOR`             | Force colors on when stdout is not a terminal (`0` does not force).   |

## Secrets in CI

Secret environment variables are stored encrypted in the workspace. To use them
in a run, provide the workspace key through `FETCHPIER_WORKSPACE_KEY` — typically
injected from your CI provider's secret store. Resolution is lazy: a run that
touches no secret needs no key. Reports never print decrypted values; they show
`{secret:<name>}` instead.

A run that needs a secret it cannot resolve stops before sending, with a
dedicated exit code: 14 (key missing), 15 (key invalid for this workspace),
16 (value cannot be decrypted), 17 (secret has no value set).

## Exit codes

| Code  | Meaning                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Success.                                                                                                                                       |
| 1     | A request failed (failed test, script error, no response, or a file with no request), or a usage error (unknown command or option, bare `fp`). |
| 2     | Report output target invalid (directory missing, or `-` for a reporter other than JSON).                                                       |
| 3     | Reserved for usage errors.                                                                                                                     |
| 4     | Workspace not found or invalid; or `fp init` on a folder that already is a workspace.                                                          |
| 5     | An input path does not exist or is not a `.http` file/folder; or the workspace has no `requests/` folder.                                      |
| 6     | Environment not found.                                                                                                                         |
| 7     | Malformed `--env-var` (expected `KEY=VALUE`).                                                                                                  |
| 8     | Reserved for fatal parse errors. A file that cannot be parsed into a request is reported as a failed request (exit 1).                         |
| 9     | Unknown reporter (reachable only through the programmatic API).                                                                                |
| 10–13 | Reserved for multipart errors. Today a multipart problem is reported as a failed request with its reason (exit 1).                             |
| 14    | A referenced secret needs the workspace key, and `FETCHPIER_WORKSPACE_KEY` is not set.                                                         |
| 15    | The workspace key is malformed or does not belong to this workspace.                                                                           |
| 16    | A referenced secret value cannot be decrypted.                                                                                                 |
| 17    | A referenced secret has no value set.                                                                                                          |
| 18    | Node.js is older than the supported minimum.                                                                                                   |
| 130   | Aborted by Ctrl-C / SIGTERM (partial reports are still written).                                                                               |
| 255   | Internal error (a bug — please file an issue).                                                                                                 |

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
