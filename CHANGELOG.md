# Changelog

All notable changes to Fetchpier are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.8] - 2026-11-23

Every send now reports passive security findings about the exchange it just
made, in the app and, on request, on the command line, and the collection tree
gains a filter. Most of the rest comes from a full review of the product: it
closes ways a save could lose or rewrite part of a request file, the app and the
command line could send different bytes for the same request, a secret could
stay readable, and history, cookies, certificates and imports could show or keep
the wrong thing. Changes that alter behavior on purpose are marked _Behavior
change_. If you set per-request settings in the app, read the first entry under
Fixed.

### Added

- **Security findings for every send.** The response viewer has a new Security
  section, with a shield icon and a count, listing what the exchange already
  shows — nothing extra is ever sent to collect it: a redirect that dropped to
  plain HTTP; legacy TLS versions, weak ciphers, no forward secrecy, a
  certificate that is untrusted, expired, about to expire or has a weak key, or
  verification turned off; missing or weak security headers (HSTS, `nosniff`,
  content-security and framing protection on HTML pages, permissive CORS) and
  version banners; cookies without `Secure` or `HttpOnly`; credentials in the
  query string; and responses a shared cache may keep. Each finding names what it
  is about (never a value), explains it in one line and links to its reference. When nothing fires it says how many rules were applied, never that
  the endpoint is secure.
- **A findings policy per workspace.** Workspace Settings → Security turns
  findings on or off, enables or disables each rule, and sets how many days
  before expiry a certificate is reported (30 by default). The policy lives in
  the workspace settings file, so the team shares it.
- **`--findings`** adds the same findings to the terminal output and to the JSON
  and HTML reports. It never changes a run's outcome or exit code, the JUnit
  report does not carry them, and the JSON report adds them as optional fields
  without changing its version.
- **The address of the server that answered** is shown for each run in the
  activity log (omitted when the request went through a proxy).
- **Filter the collection tree.** A field above the tree keeps the folders,
  requests and instances whose names contain every word typed, in any order,
  and highlights the match. **Filter Sidebar** (`Cmd/Ctrl+Shift+F`, also in the
  View menu) focuses it, showing the sidebar if it was hidden; Escape clears it
  and ↓ moves to the first row. New request and New collection always show their
  name input, clearing the filter or expanding the target folder first.
- **Choose where an import lands.** The import dialog has a Destination selector
  listing the root of the request tree and every folder.

### Changed

- **The tree selection can be cleared.** Escape in the tree clears the
  selection, so New request, New collection and Import go to the root again;
  clicking the selected folder only expands or collapses it. A right-click menu
  no longer clears the selection.
- **OpenAPI and Swagger references are resolved inside the document only.** A
  `$ref` that points to another file or a URL is no longer followed: importing
  never reads your disk or reaches the network on the document's behalf, and the
  reference is listed as an _Unresolved reference_ warning. A reference that
  cannot be resolved now affects only the place that uses it, instead of
  degrading the whole import, and a recursive schema is marked where it recurses.
  _(Behavior change)_
- **Form bodies read the same in the app and on the command line.** When the app
  opens an `x-www-form-urlencoded` body, a `+` is a space and `%2B` is a plus; it
  used to keep `+` as a plus and send it as `%2B`. The command line now encodes
  variable values in a form body as the app does, so a value holding `&`, `=`,
  `+`, `%` or a space reaches the server the same way from both. _(Behavior
  change)_
- **`fp.request.url` includes the query in the app**, as it already did on the
  command line, and a pre-request script that rewrites the URL is sent as
  written. Pre-request scripts in the app can also read a form body as its
  encoded text and rewrite it; the rewritten body is sent. _(Behavior change)_
- **`fp run` on a folder skips every entry whose name starts with a dot**, so
  files attached to requests are no longer run as requests when their name ends
  in `.http`. A path you name explicitly still runs. _(Behavior change)_
- The desktop runtime is updated to Electron 43.8.12, the latest release of its
  line.

### Fixed

- **Per-request settings now apply to sends from the app.** Every override set
  in a request's Settings tab was ignored when sending from the app (the command
  line applied them). Choosing "use the cookie jar" for one request in a
  workspace that disables the jar is now saved, and kept when the file is
  reopened.
- **Saving no longer loses or rewrites parts of a request file.**
  - A `###` line before the first request no longer deletes the metadata above
    it or writes the request twice.
  - A script or settings block without its end line is reported, instead of
    swallowing the request (and, in a file with several requests, moving the
    next one into its place).
  - A request saved with an empty URL reopens as saved; it used to reopen blank,
    and the next save overwrote it.
  - A file that cannot be read is never overwritten, either after Reload or from
    the unsaved-changes prompt.
  - `# @id` after a blank line in the leading comments is kept, and multipart and
    binary file names containing spaces survive a reopen.
  - Auth values keep their leading and trailing spaces, a U+2028 / U+2029
    character no longer adds `# ` on every save, and an unknown body subtype is
    reported instead of being rewritten silently.
- **Editing the URL no longer corrupts the query.** A parameter whose value holds
  `&`, `%`, an escape such as `%20` or `#` (or whose name holds `=`) is kept
  intact while you type elsewhere in the URL. A `#fragment` after the query is no
  longer sent as part of the last parameter.
- **Sending**
  - A body on `GET`, `DELETE`, `OPTIONS` or a custom method is sent with its
    length, and its 301 / 302 / 307 / 308 redirects are followed.
  - Through a proxy, every value of a repeated request header reaches the server.
  - A proxy that refuses the tunnel (407, 403, 502) is reported as such, not as
    "Request cancelled", and a cancel you ask for shows a translated message.
  - A URL without a scheme, which is sent over HTTPS, now also gets the
    certificates, proxy and `NO_PROXY` decision of HTTPS. An HTTPS proxy signed by
    a custom CA is trusted for plain-HTTP targets too, and `NO_PROXY` matches IPv6
    entries.
  - Disabled query parameters, form fields and multipart parts no longer make a
    send fail over a secret they reference.
  - Switching environments while a request is in flight no longer drops or
    misdirects its script's environment changes, and a change that cannot be
    saved is shown instead of only logged.
  - Standard status codes always show their reason phrase, the size of binary
    and non-UTF-8 responses counts the bytes received, and a deflate body over
    the decoding limit reports the limit.
- **Scripts**
  - `fp.response.headers.getAll` and `count` see every value of a repeated
    response header, `Set-Cookie` included; they used to be joined into one.
  - A pre-request script that changes a secret's value sends the new value; the
    old one was sent.
  - Logging a multipart body or `fp.request` no longer aborts the script.
  - `expect(fn).to.throw(/pattern/)` works, a negated `property(name, value)`
    checks the value, multipart parts behave as an array, `xml2Json` decodes
    numeric character references, and a top-level `const` or `let` named like a
    blocked global (`module`, `process`, …) no longer stops the whole script.
  - The command line reports the right line for a script error.
- **Cookies**
  - A `Max-Age` cookie's lifetime counts from when it was received, not from each
    time it is sent, and the Cookies panel shows the same expiry the jar uses.
  - Editing a cookie's expiry no longer shifts it by your time-zone offset.
  - The jar accepts a cookie whose `Domain` is the responding host's own IPv4
    address or single-label name, and an out-of-range `Max-Age` no longer fails
    the send.
  - A send no longer undoes cookies captured by other sends running at the same
    time, or edits made in the Cookies panel meanwhile; an unreadable cookie file
    is no longer replaced by an almost empty one.
  - With the jar off, cookies from the end of a redirect chain are shown for the
    host that sent them.
- **Certificates and workspace settings**
  - An unreadable workspace settings file is never rewritten. Changing a
    workspace setting or certificate is refused with an error naming the file,
    instead of losing its certificates, findings policy and other content.
  - Edits made to the settings file outside the app are picked up before the app
    changes a certificate.
  - Removing a certificate no longer deletes a file another entry still uses, and
    entries without an identifier no longer make toggle, edit or remove act on
    the wrong certificate.
  - The client-certificate preview resolves variables in the request URL.
- **Secrets**
  - Rotating the encryption key is all-or-nothing: if any file cannot be
    rewritten, the files already rewritten are put back, and the new key is
    saved before the first one changes. Rotation no longer skips
    environments it cannot read, and no longer fails with a false "tampering"
    error on local values encrypted under an older key.
  - A double click on Make secret can no longer run the first-time setup twice,
    and names starting with `$` are refused.
  - A value that cannot be shown because its key is missing is reported as such,
    not as "Corrupt", and is no longer offered to be cleared.
  - On Linux without a keyring, switching workspaces keeps the workspace keys
    until the app quits.
- **History and the Activity window**
  - The Requests filter reaches runs older than the newest 50.
  - The detached Activity window refreshes when runs are added or history is
    cleared, follows the workspace that is open, shows and filters by the same
    request chips as the docked panel, and runs Open, Raw, Repeat and Open file
    in the main window. It no longer overwrites the main window's saved tabs.
  - Tabs restored at launch but not yet opened show their history.
  - Repeat and Open keep the query string, Open works on a form run with a
    malformed `%` escape, and the opened run shows the right response size.
  - Renaming or moving a request no longer rewrites the bytes of its recorded
    runs.
- **Workspace and files**
  - File changes are detected when the workspace sits inside a folder whose name
    starts with a dot.
  - Creating or renaming refuses names that are not valid on Windows (a colon, a
    trailing dot, a device name such as `CON`).
  - A rename or move that cannot carry along a request's instances is undone and
    reported, instead of leaving the files half moved.
  - An environment name stays free when, after pulling a teammate's delete or
    rename, its folder holds only this machine's local state.
  - A brief read failure no longer empties the collection tree, and the app keeps
    watching the workspace after a failed recovery.
- **Import**
  - Collection import keeps already-encoded query values as they are and bare
    flags such as `?wsdl` as flags, and imports a form-data body as a multipart
    body with one part per field.
  - GraphQL import generates valid queries for deeply nested types.
  - OpenAPI import keeps unquoted YAML dates as written, accepts
    `openapi: 3.0`, imports Swagger 2 Basic authentication, warns about schemes it
    cannot import, and no longer drops operations whose names differ only in
    case.
  - Importing from a URL follows redirects and uses the configured proxy and
    certificate authorities.
- Closing a tab with the middle mouse button no longer starts autoscroll, the
  first-time secrets setup dialog no longer shows a close button it does not
  honour, and the import dialog's Format selector is labelled for screen readers.

### Security

- **A secret a pre-request script copies into the request is masked** in the
  recorded request — activity log, command-line history and reports. It was
  masked only in the response.
- **A failed pre-request script no longer prints secret values** in its error,
  in the terminal or in any report.
- **The Cookies tab no longer receives the full request URL**, which could carry
  an API key or another secret in the query.
- **A proxy value with credentials but no scheme** no longer puts the username in
  the error message.
- Another path from a script to the host's code constructor is closed. Scripts
  run in a sandbox meant to prevent accidents, not to contain hostile code.

## [0.9.7] - 2026-11-09

Fetchpier can now be recoloured: palettes for Light and Dark, from a preset or
built by you, for all your workspaces or just one. This release also closes
several ways a secret, a cookie or a client certificate could reach the wrong
place, and lets the command line use certificates that are not shared with the
workspace. One change, to `--show-secrets`, alters behavior on purpose and is
marked _Behavior change_. If you used 0.9.4 to 0.9.6 with servers you do not
trust, read the first entry under Security.

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

### Fixed

- **Settings and Workspace Settings no longer change size from tab to tab.**
  Each dialog keeps one size, so the title, the tabs and the buttons stay where
  they are when you switch tabs; only the tab's content scrolls. In a small
  window the dialog now fits and scrolls instead of running off the screen.
  Inside Appearance, switching Light / Dark or pressing Customize no longer
  moves the palette cards. The Settings tabs now work with the arrow keys and
  screen readers, and Workspace Settings offers _Reset to defaults_ only on its
  HTTP tab, the one it resets.

- **A double slash in a URL's path no longer confuses the request.** A base URL
  ending in a slash followed by a path starting with one, as in
  `https://api.example.com//users`, reached the right server, but its cookies
  were chosen as if `users` were the host, and a relative redirect such as
  `/login` left for a host called `users`. The server's own cookies now apply and
  the redirect stays on it. The path is still sent as you wrote it.

### Security

- **A URL path can no longer send your cookies to the wrong server.** A request
  whose path begins with two slashes, such as `https://a.example//b.example/x`,
  goes to `a.example`, but Fetchpier chose its cookies as if it were going to
  `b.example`. A server could exploit this with a redirect to itself, to collect
  another host's cookies from your jar or to store cookies in that host's name.
  Each request now uses the host it really connects to. If you used versions
  0.9.4 to 0.9.6 with servers you do not trust, clear the environment's cookie
  jar and rotate the affected sessions.
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

[0.9.8]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.8
[0.9.7]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.7
[0.9.6]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.6
[0.9.5]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.5
[0.9.4]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.4
