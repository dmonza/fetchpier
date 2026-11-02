# Changelog

All notable changes to Fetchpier are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.9.4]: https://github.com/dmonza/fetchpier/releases/tag/v0.9.4
