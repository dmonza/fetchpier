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

Requires Node.js 20+.

## Quick start

```bash
# From inside a workspace (a folder containing .fetchpier/)
fp run auth/login.http

# Point at a workspace explicitly and pick an environment
fp run ./tests --workspace ~/projects/my-api --env staging

# Create a new workspace
fp init my-api
```

## Commands

| Command                            | Description                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `fp run [paths...]`                | Alias for `fp request run`.                                                                  |
| `fp request run [paths...]`        | Run one or more `.http` files or folders. With no path, runs the workspace `requests/` tree. |
| `fp env list`                      | List the environment ids in the workspace.                                                   |
| `fp env current`                   | Print the environment a run would use (`--env` > `FETCHPIER_ENV` > `default`).               |
| `fp init [name]`                   | Create a new workspace (optionally in a new folder).                                         |
| `fp --help`, `fp <command> --help` | Help for the program or a command.                                                           |

> `fp env switch` is **not** part of this release. The desktop persists the
> active environment in its own user-data store (outside the workspace), which
> the CLI cannot write to. `fp env current` reflects the CLI's own CI-friendly
> resolution, never the desktop's last UI selection.

## `fp run` flags

| Flag                      | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| `-w, --workspace <path>`  | Workspace folder. Default: discovered by walking up from the cwd. |
| `-e, --env <name>`        | Environment id. Default: `FETCHPIER_ENV` or `default`.            |
| `--env-var KEY=VALUE`     | Override a variable (repeatable).                                 |
| `--bail`                  | Stop on the first request with a failure.                         |
| `--delay <ms>`            | Wait between requests.                                            |
| `--timeout <ms>`          | Per-request timeout.                                              |
| `--insecure`              | Do not verify TLS certificates for this run.                      |
| `--reporter-json <file>`  | Write a JSON report (`-` for stdout — silences the CLI reporter). |
| `--reporter-json-no-body` | Omit response bodies from the JSON report.                        |
| `--reporter-junit <file>` | Write a JUnit XML report.                                         |
| `--reporter-html <file>`  | Write a standalone HTML report.                                   |
| `--save-history`          | Persist each run to `<workspace>/requests/.runs/`.                |
| `--suppress-exit-code`    | Always exit 0 (still nonzero on fatal errors).                    |
| `--show-secrets`          | Do not redact `Authorization` headers in reports.                 |
| `--ascii`                 | Use ASCII glyphs instead of Unicode.                              |
| `--no-color`              | Disable ANSI colors (also honors `NO_COLOR` / `FORCE_COLOR`).     |
| `--silent`                | Suppress stdout (errors still go to stderr).                      |
| `-v`, `-vv`, `-vvv`       | Increase verbosity.                                               |

## Context resolution

- **Workspace:** `--workspace` > `FETCHPIER_WORKSPACE` > upward discovery of a
  `.fetchpier/` folder from the current directory (Git-style).
- **Environment:** `--env` > `FETCHPIER_ENV` > the literal `default`. The CLI
  never reads the desktop's active-environment preference — predictable in CI.

## Exit codes

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 0    | Success.                                            |
| 1    | A test failed or a script errored.                  |
| 2    | Reporter output target invalid (directory missing). |
| 4    | Workspace not found or invalid.                     |
| 5    | An input path does not exist.                       |
| 6    | Environment not found.                              |
| 7    | Malformed `--env-var` (expected `KEY=VALUE`).       |
| 8    | Parse error in a `.http` file.                      |
| 9    | Unknown reporter.                                   |
| 130  | Aborted by Ctrl-C / SIGTERM.                        |
| 255  | Internal error (a bug — please file an issue).      |

## Programmatic API

The same engine, callable from your own Node scripts (CommonJS and ESM):

```ts
import { run, init, listEnvironments, currentEnvironment } from '@fetchpier/cli'

const summary = await run({ paths: ['auth/login.http'], workspace: '/path/to/ws' })
console.log(summary.summary.tests) // { total, passed, failed }
```

`run` returns the structured `RunSummary` (the JSON reporter's schema) and never
calls `process.exit` — your code decides what to do with the result.

## Sandbox threat model

Pre/post-request scripts run in a `node:vm` sandbox with the `fp.*` API, exactly
as in the desktop. **The sandbox prevents accidental mistakes in scripts; it is
not a defense against an adversary who has placed malicious code in your
workspace.** If you run untrusted collections in CI, run `fp` inside a container
or another isolation boundary. Fetchpier does not promise to contain hostile
script code.

## CI examples

GitHub Actions:

```yaml
- run: npm install -g @fetchpier/cli
- run: mkdir -p reports && fp run ./tests --env ci --reporter-junit reports/fp.xml
  env:
    FETCHPIER_WORKSPACE: ${{ github.workspace }}/api
- if: always()
  uses: actions/upload-artifact@v7
  with: { name: fetchpier-report, path: reports/fp.xml }
```

GitLab CI:

```yaml
api-tests:
  script:
    - npm install -g @fetchpier/cli
    - fp run ./tests --reporter-junit report.xml
  artifacts:
    reports:
      junit: report.xml
```
