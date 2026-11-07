# Changelog

All notable changes to Fetchpier are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Colour palettes, separately for Light and Dark.** Settings → Appearance
  offers Original, the presets Paper, Graphite, Ocean and Forest, and a Custom
  palette generated from four controls — Hue, Intensity, Surface tint and
  Brightness/Darkness — that always keeps text, borders and focus indicators
  legible. Changes apply to the whole window as you make them and are saved as
  you go; **Revert changes** returns to how things were when Settings opened.
  The palette is in force from the first frame of every window, and a System
  mode swaps between your Light and Dark palettes as the operating system does.
  The appearance mode can now also be chosen in Settings.

- **Palettes per workspace.** Workspace Settings → Appearance lets each mode of
  a workspace inherit your own palette (the default) or use its own — Original,
  a preset or Custom. The choice is yours alone: it is kept in the workspace's
  personal, gitignored state, never in the files the team shares. Opening,
  switching or closing a workspace switches palettes, from the first frame at
  launch too; the appearance mode stays a single choice across workspaces.
  While a workspace overrides a mode, Settings → Appearance says so and shows
  your own palette while you edit it.

- **`--tls-config <file>` (or `FETCHPIER_TLS_CONFIG`) for certificates you do not
  want to share.** The command line can use a client certificate or a CA that
  belongs to the machine or the pipeline instead of the workspace: name a JSON
  file in the same format as the workspace's TLS settings, with the certificate
  files next to it. Nothing is copied into the workspace. When a workspace
  certificate matches the same host just as specifically, the one given for the
  run is used. Certificates kept in the workspace keep working as before, and are
  shared with the workspace.

### Changed

- **The built-in palettes now meet accessibility contrast minimums.** Input and
  control borders, some status and HTTP-method colours, `{{variable}}`
  highlighting, primary-button text and error and warning messages were below
  the minimum on some surfaces; each was adjusted only as much as needed,
  keeping its hue. Control borders are the most visible change in Dark. Dark
  also gains a real depth step between the app background and the sidebar and
  cards, and clearly distinct secondary, muted and soft text. The selected
  folder in the collection tree no longer looks like a hovered row, the focus
  ring stays visible on every surface, and scrollbars are easier to see.

### Security

- **An unusable proxy URL no longer prints its credentials.** When `--proxy`,
  `HTTPS_PROXY` or `HTTP_PROXY` cannot be used, the error names the flag or
  variable it came from but not the URL, so a username and password in it stay
  out of the CI log. Credentials with an invalid percent escape now stop the run
  the same way (exit code 3) instead of crashing with exit code 255.
- **A token a script stores as a secret no longer shows in the response it came
  from.** When a login's post-response script saves the token it receives under a
  secret variable's name (or a pre-request script writes one the server echoes),
  the response now shows it as `{secret:<name>}` — body and headers — in the
  terminal, every report, the run history and the desktop activity log. It used
  to be masked only in the script output, so the token stayed readable in the
  login's own response.
- **New app setting: Hide secrets in responses** (on by default). Turn it off to
  see the response exactly as the server sent it in the response viewer; the
  activity log keeps the masked copy either way.
- **`--show-secrets` also shows each response as received**, secret values
  included, in the terminal and every report. The request and script output keep
  `{secret:<name>}`, and `--save-history` stays masked. _(Behavior change)_
- **A redirect no longer hands your client certificate to another host.** Each
  hop of a redirect chain presents the certificate configured for its own host,
  or none. It used to present the one chosen for the first host, and a redirect
  from plain HTTP to HTTPS presented none.
- **The proxy never receives your client certificate.** Only the trust settings
  (CAs, certificate verification) are used for the connection to the proxy.
- **`NO_PROXY` is applied again on every redirect hop** (command line). A host that
  bypasses the proxy and redirects outside the bypass list now goes through the
  proxy, and the reverse; the first hop's decision used to apply to the whole
  chain.
- **"Follow Authorization header on redirect" now works.** With the setting on,
  the header was still dropped on a redirect to another origin (scheme, host or
  port). With it off, nothing changes: `Authorization` is stripped on every
  change of origin, as in Postman. Also as in Postman, the setting covers
  `Authorization` only: an API key header follows every redirect, as before.

## [0.9.6] - 2026-11-04

The command-line interface becomes reliable in continuous integration, and the
desktop app gains the engine changes that make that possible. Several of these
change behavior on purpose; they are marked **Behavior change**.

### Fixed

- **Settings and Workspace Settings no longer change size from tab to tab.**
  Each dialog keeps one size, so the title, the tabs and the buttons stay where
  they are when you switch tabs; only the tab's content scrolls. In a small
  window the dialog now fits and scrolls instead of running off the screen.
  Inside Appearance, switching Light / Dark or pressing Customize no longer
  moves the palette cards. The Settings tabs now work with the arrow keys and
  screen readers, and Workspace Settings offers _Reset to defaults_ only on its
  HTTP tab, the one it resets.

- **Values set by a script now reach the next request of a run.** A token a login
  request stores with `fp.environment.set` is used by the authenticated call that
  follows; `fp.environment.remove` is carried the same way. It was dropped, so the
  call failed with a 401.
- **Secrets no longer leak through scripts.** What a script logs, a test's name,
  a failed assertion's message and a script error now show a secret as
  `{secret:<name>}` in the terminal, every report, the run history and the
  desktop's script console — including a value a script itself writes under a
  secret variable's name.
- **Binary request bodies are sent by the command line.** A request whose body
  is an attached file used to go out with an empty body. A missing file, or a
  reference in the request file that is not valid, now fails that request as
  "not run" instead of sending it empty. _(Behavior change)_
- **Compressed responses are decoded** (`gzip`, `deflate`, `br`) on both the
  desktop and the command line, so assertions and the viewer read the real
  body. A body that cannot be decoded is kept as received, with a warning, and
  `fp.response.json()` fails with that cause. The activity log records a decoded
  compressed text response as text.
- **Runs that did nothing no longer pass.** A target folder with no request
  stops the run with exit code `19` _(Behavior change)_.
- **Values the command line could not honour are refused.** `--timeout` and
  `--delay` accept whole numbers from `0` to `2147483647`; anything else is a
  usage error (exit `3`) instead of being ignored. _(Behavior change)_
- **Unreadable configuration stops the run.** An unparseable
  `.fetchpier/settings.json`, or an unparseable `config.json` for the selected
  environment, exits with code `4` naming the file, instead of running with
  defaults (which dropped the TLS settings) or reporting the environment as
  missing. `fp env list` warns about unreadable environments. An environment
  file that parses but lacks a `name` or `id` (or whose `variables` is not an
  object) counts as unreadable too: it used to crash every `fp run` and
  `fp env list` in the workspace with an internal error, even when another
  environment was selected. _(Behavior change)_
- The terminal shows the environment by its folder name instead of its internal
  identifier, `-v` / `-vv` / `-vvv` now add detail, and script output (`fp.log`)
  is shown in runs of several files.
- An expired timeout is reported as `timed out after <limit>` on both surfaces,
  not as a cancellation.
- No internal diagnostic lines (`[execute] …`, `[parser] …`) reach the output;
  they are warnings, also in the JSON report with a stable code.
- The default `User-Agent` no longer advertises version 0.1.0.
- The "Did you mean …?" hint for a missing path is correct when the current
  directory or the workspace is reached through a symbolic link (as macOS's
  temporary folders are); it used to suggest a path climbing to the root.

### Added

- **Proxy support for the command line:** `HTTPS_PROXY` / `HTTP_PROXY` /
  `NO_PROXY`, `--proxy <url>` and `--no-proxy`. The header names the proxy and
  the exclusion list; at `-v` each request says whether it went through the
  proxy or directly. An unusable proxy URL stops the run (exit `3`).
- **`--persist-env`** saves script variable changes to the local values exactly
  as the desktop does. Without it a run writes nothing to the workspace.
- **Redaction of credentials and cookies** in the command line's terminal output
  and reports: the API-key auth credential (query or header) and `Cookie` /
  `Set-Cookie` values, in addition to `Authorization`. `--show-secrets` reveals
  them. The run history (`--save-history`) is unchanged.
- A warning when a variable a request uses comes from a `{{$env.NAME}}` that is
  not defined anywhere, so it was sent empty.
- Advisories that used to be log lines are now shown: a cookie jar or TLS
  material that could not be used, an HTTP/2 downgrade, a replaced multipart
  `Content-Type`, a script write that could not be saved — in the command line's
  warnings and, on the desktop, in a dismissible notice above the response.
- The JSON report gains optional fields: `environmentName`, and per response
  `compressedBytes`, `decompressedBytes` and `decodingStatus`; per request
  `notRun` and `via`. Its version stays `1.0`. Scripts gain
  `fp.response.decodingStatus`.
- The response viewer shows both the received and the decoded size of a
  compressed response, and flags a body that could not be decoded.

### Changed

- **Default per-request timeout of 30 seconds** on the command line (the
  desktop's default). `--timeout 0` is the only way to disable it. _(Behavior change)_
- **`Accept-Encoding: gzip, deflate, br` is sent by default** on both surfaces
  when a request does not set it. _(Behavior change)_
- **Default `User-Agent`:** `Fetchpier/<app version>` from the desktop and
  `Fetchpier-CLI/<CLI version>` from the command line, applied at send time and
  never written into request files; both defaults show in the headers editor as
  read-only rows. A value already saved in a file is still sent as written.
  _(Behavior change)_
- A request that got no response reads `no response: <reason>` when a send was
  attempted and `not run: <reason>` when it was not; the JUnit test case is
  renamed from `request not sent` accordingly. _(Behavior change)_
- A value a script sets wins over `--env-var` from that point on.
- The CLI reference documents TLS configuration, missing-variable behavior, the
  limits of secret masking, that the history keeps cookie values, and that the
  CLI may align an environment's display name with its folder.

## [0.9.5] - 2026-11-04

Command-line interface fixes and publication readiness for `@fetchpier/cli`.

### Fixed

- `fp run` with no path now runs every request under the workspace's
  `requests/` folder from any directory — a subfolder of the workspace, or
  from outside it with `--workspace` or `FETCHPIER_WORKSPACE`. It used to work
  only from the workspace root and otherwise failed with "Path not found".
- The command `fp init` suggests at the end (`fp run --workspace <name>`, or
  `fp run` when initializing the current folder) now works as printed; the
  previous suggestion failed when copied from the same directory.
- `--bail` now also stops after a request that got no response (unreachable
  host, refused connection, timeout, TLS failure), not only after a failed
  test or script error — the same rule the exit code already applied.
- The npm package is always built from the sources being packed or published,
  instead of shipping whatever the last local build left in place.

### Added

- When a path given to `fp run` does not exist in the current directory but
  does inside the workspace, the error suggests the path to type instead.
- The npm package ships the license notices of the third-party code bundled
  into it.

### Changed

- The CLI reference (the package README) was rewritten to match the tool: the
  real Node.js minimum (22.19), which commands need a workspace, every flag and
  exit code, the environment variables it reads, using secrets in CI, and CI
  examples that work as written. The CLI examples in the project README were
  corrected to match.

## [0.9.4] - 2026-11-02

First public release. The 0.9.x line was developed privately, so this entry
describes what Fetchpier does today rather than what changed against a version
nobody could install.

### Requests and collections

- Requests are plain `.http` files and collections are folders on disk — the
  same format VS Code REST Client and JetBrains HTTP Client read. Nothing to
  export in order to leave.
- Full HTTP support: methods, headers, query and path parameters, and raw, JSON,
  urlencoded, binary and `multipart/form-data` bodies.
- Round-trip fidelity: a request read and written back produces the same file,
  so Fetchpier is safe to point at a collection kept under version control.
- Request instances — several saved parameter sets for one request, without
  duplicating the file.
- Preview tabs, session restore, and real-time file watching: edit a request in
  any editor and the app follows along.

### Environments and variables

- `{{var}}` substitution with autocomplete, inline highlighting and dynamic
  variables for values generated per run.
- Secret variables encrypted at rest with XChaCha20-Poly1305, with the workspace
  key held in the operating system keyring — never in the workspace folder.
- Local and unshared values: the variables that must not travel with the
  repository stay on the machine that defined them.

### Authentication and TLS

- Bearer, Basic and API key, with the selected scheme persisted in the `.http`
  file and restored when the request is reopened.
- Dual certificate scoping: a workspace scope that travels with Git, and a
  global app scope. The bundled CA set deliberately ignores the OS trust store,
  so corporate CAs are imported explicitly and MITM proxy environments behave
  predictably.
- Authorization headers are stripped on cross-host redirects by default.
- Cookie jar per environment, conformant with RFC 6265.

### Scripting

- Pre-request and post-response scripts against a small, auditable `fp.*` API,
  running in an isolated synchronous sandbox with a wall-clock budget.
- Typed access to the parsed response body, with editor diagnostics and
  autocompletion driven by the same types.

### Schema import

- OpenAPI 2.x and 3.x including Swagger, in JSON and YAML.
- GraphQL SDL and introspection.
- WSDL / SOAP, with a ready-to-edit envelope generated from the schema.
- Postman collections v2.0 and v2.1.

### Command-line interface

- `fp`, a Node CLI that runs requests and inspects environments of a Fetchpier
  workspace from the terminal, sharing the same engine as the desktop app.

### Application

- Windows, macOS and Linux, with installers for each.
- Light and dark themes, English and Spanish, command palette and keyboard
  navigation across the tree and tabs.
- Detachable Activity panel — history and run output in its own window.
- On-demand version check that reports a newer release and links to the project's
  GitHub Releases page; it never downloads or installs anything on its own.

### Security posture

- The UI process runs inside the operating system renderer sandbox, with no Node
  runtime. Privileged work happens in the main process behind validated IPC.
- Declared network egress: apart from the version check you trigger yourself,
  every connection originates from your request configuration. No telemetry, no
  background traffic, no remote content in the UI.

[0.9.6]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.6
[0.9.5]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.5
[0.9.4]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.4
