# Security Policy

Thanks for taking the time to look. This document explains how to report a vulnerability, what counts as one in Fetchpier's threat model, and what you can expect after you report.

## Reporting a vulnerability

**Do not open a public issue for security reports.** Use one of these private channels instead:

- **GitHub Security Advisories** (preferred): open a private report at `Security → Advisories → Report a vulnerability` on the repository. This keeps the conversation, the fix, and the eventual CVE in one place.
- **Email**: `info@sincrum.com`. Use this if you can't use GHSA, or if you'd rather start the conversation off-platform. If the report is sensitive, mention that in the first line and we'll move the conversation to a private GitHub Security Advisory before details are exchanged.

A useful report includes:

- A short description of the issue and the impact you believe it has.
- The Fetchpier version (`Help → About` or `package.json`), the OS, and any relevant environment details (proxy, custom CAs, etc.).
- Steps to reproduce, or a minimal proof of concept. A failing test case is the gold standard but not required.
- Whether the report has been or will be shared with anyone else.

You don't need to have a fix in hand. A clear reproduction is more useful than a half-finished patch.

## What to expect

- **Acknowledgement within 72 hours.** If you don't hear back in that window, please ping again — mail filters happen.
- **Triage within 7 days.** That means a written assessment of whether we consider the report a vulnerability, the severity we'd assign, and a rough timeline. If the triage is going to take longer (complex issue, need to reproduce on multiple platforms), we'll say so explicitly rather than go quiet.
- **Fix and disclosure.** Once a fix is ready, we coordinate disclosure with you: release date, advisory text, CVE request (when applicable). You set the pace if you have a publication deadline; otherwise we default to publishing the advisory the same day the patched release ships.

If we disagree about whether something is a vulnerability, we'll explain why in writing rather than just close the report. You're welcome to publish your analysis publicly after that — we won't ask you to keep silent about findings we've declined to fix.

## Supported versions

Fetchpier is pre-1.0 and moves quickly. We don't maintain parallel release branches today, and we don't commit to a fixed support window. In practice:

- Security fixes ship on the **next regular release** of the latest line.
- For severe issues we ship an **out-of-band patch release** without waiting for the regular cadence.
- Backports to older versions are decided **case by case**, depending on severity, how widely the older version is in use, and how invasive the backport is. If you're stuck on an older version and need a backport, say so in the report and we'll discuss it.

Once Fetchpier hits 1.0 this section will be revisited with an explicit support window.

## Recognition

If you report a vulnerability that leads to a fix, we're happy to credit you publicly — your name (or handle), and optionally a link — in the GitHub Security Advisory and the release notes for the patched version. The credit is **opt-in**: by default we don't name reporters unless they ask. Some researchers prefer anonymity, and that's the safe default.

There is no monetary bug bounty program. If that changes in the future, this section will say so.

## Scope

The summary below describes what counts as a security issue for the purposes of this policy.

### In scope

Reports against the current `main` branch or the latest published release, in any of these areas:

- **Sandbox isolation.** Anything that lets a pre-request or post-response script reach beyond the documented `fp.*` surface — for example, obtaining a reference to `process`, `require`, `Buffer`, the host `Function` constructor, or any other Node built-in; observing asynchronous behaviour (`Promise`, `setTimeout`, microtasks); compiling WebAssembly; using `eval` or `new Function`; or breaking out of the `vm` context through prototype chains, `.constructor` walks, or host-realm object identity. The sandbox is contractually synchronous and isolated; any escape is in scope.
- **IPC and process boundaries.** Anything that lets the renderer reach Node APIs directly, bypasses the typed `window.api.*` bridge, or convinces a main-process handler to read or write outside the active workspace. Path-traversal in any filesystem-touching handler, identifier injection (a workspace, environment, or collection name that resolves to a different on-disk path than the user expects), or violations of `contextIsolation`/`nodeIntegration` are all in scope.
- **TLS and credential handling.** Authorization headers leaking across hosts on redirect when the user has not opted in; client certificates attached to the wrong host; CA bundle composition that silently fails open; passphrases logged or persisted in clear when they shouldn't be; certificate files written outside the canonical scope directory.
- **Cookie jar.** Cookies attached to the wrong request (cross-origin leaks), persisted past their expiry as live cookies, sent over plain HTTP when marked `Secure`, or otherwise diverging from RFC 6265 §5.4 in a way that has a privacy impact.
- **Build and supply chain.** Compromised dependency that ships in the released binary, codegen drift that produces a binary that doesn't match the source tree, or any other defect that makes the published artifact different from what `main` says it should be.
- **Schema importers.** A malicious schema file (OpenAPI, Swagger, GraphQL, WSDL, Postman collection) that causes anything more serious than a parse error — file writes outside the target collection, denial of service through unbounded expansion, or code execution.
- **External entity attacks** on the XML parser used by `fp.response.xml2Json()` (DTD expansion, billion-laughs, external entity references). These are considered defended against; if you find one that gets through, it's in scope.

### Out of scope

These are intentional design choices or known limitations:

- **Malicious `.http` files authored by the workspace owner.** Scripts in Fetchpier are authored by the user who owns the workspace, the same trust model as Postman, Bruno, JetBrains HTTP Client, or VS Code REST Client. The sandbox protects against _accidental_ surface leaks and keeps the exposed API auditable; it is **not** a security boundary against deliberately malicious scripts. Node itself documents `node:vm` as unsafe for running untrusted code, and we don't claim otherwise. Treat a `.http` file from an unfamiliar source the same way you'd treat a shell script from one.
- **CPU-based denial of service inside a script.** Scripts get a 5-second wall-clock budget enforced by `vm.runInContext`. Within that budget a script can do whatever CPU-bound work it wants. Reports of "a tight loop hangs my tab for 5 seconds" are working as designed.
- **Body parsers refusing inputs over 10 MB.** `fp.response.json()` and `fp.response.xml2Json()` cap input at 10 MB by design because they run in host code outside the vm timeout. Reports that a 12 MB JSON response throws are working as designed.
- **OS trust store not consulted.** Fetchpier deliberately does not consult the macOS Keychain, Windows Cert Store, or Linux system trust store. Corporate CAs must be imported explicitly. This is a feature, not a bug.
- **Cleartext storage of workspace data.** Workspace files (`.http` requests, environment variables, cookies, history) are stored as plain text/JSON on disk. Encrypting them at rest is the host OS's job (FileVault, BitLocker, LUKS), not Fetchpier's. Reports that "my environment variables are readable by anyone with filesystem access" are out of scope.
- **Self-XSS in the response viewer for users who paste hostile responses into themselves.** The response viewer renders bodies as text with syntax highlighting; it does not execute response HTML. If you find a case where it does, that's in scope and very much wanted.
- **Vulnerabilities in third-party dependencies that don't have a reachable code path in Fetchpier.** `npm audit` results we've assessed as unreachable are tracked internally; if you believe one of them _is_ reachable, please report it as a vulnerability rather than as an audit finding.
- **Social engineering, phishing, physical access to an unlocked machine.** Out of scope, as in any desktop application.

### Sincrum projects

Fetchpier is a [Sincrum](https://sincrum.com) project. This policy covers only Fetchpier; each Sincrum-maintained project publishes its own `SECURITY.md`.

## Public disclosure

We coordinate disclosure with reporters and aim to publish the advisory at the same time the patched release ships. If you need to publish on a specific date (academic deadline, conference talk, employer policy), tell us in the initial report and we'll align with it. If 90 days pass from the initial report without a fix or a written explanation from us of why we're declining to fix, you are free to publish without further coordination — we'd rather you do that than feel stuck.

Once an advisory is published, it lives in the GitHub Security Advisories page of the repository, and is referenced from the release notes of the patched version.
