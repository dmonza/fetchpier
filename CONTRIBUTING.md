# Contributing to Fetchpier

Thanks for your interest in Fetchpier. This document explains how to help during the current phase of the project.

## Current contribution policy

**Fetchpier is not accepting external pull requests at this time.**

The project is in an active stabilization phase. The current priority is hardening the core product, polishing existing features, and resolving known issues — work that benefits from staying tightly scoped and reviewed by the maintainer.

This is a temporary decision based on capacity, not on principle. As the project matures and the contribution process can be properly supported (review bandwidth, automated checks, contributor onboarding), the policy will be revised. There is no fixed date for that change. It will be announced clearly when it happens.

In the meantime, the best way to help is described below.

## How to help right now

### Report bugs

Bug reports are very welcome. Open an issue using the [bug report template](https://github.com/dmonza/fetchpier/issues/new?template=bug_report.yml).

Before opening a new issue:

1. Search [existing issues](https://github.com/dmonza/fetchpier/issues) to avoid duplicates.
2. Verify the bug reproduces on the latest version.
3. Include your operating system, app version, and exact reproduction steps.
4. Include screenshots or a short screencast when relevant.

Bug reports without reproduction steps are usually closed with a request for more information.

### Suggest features

Feature ideas are welcome through [discussions](https://github.com/dmonza/fetchpier/discussions). Describe the use case, the problem you are trying to solve, and any alternatives you considered.

The current roadmap and explicitly out-of-scope items are documented in the [README](README.md#roadmap). Suggestions that contradict an out-of-scope decision (for example, cloud sync between devices) will receive a polite decline with an explanation.

Suggestions accepted into the roadmap may be implemented at any point, in priority order. There are no guaranteed timelines.

### Report documentation issues

If you find a typo, broken link, unclear explanation, or outdated information in the README or any other document, please open an issue describing the problem. Documentation fixes are appreciated and will be addressed by the maintainer.

### Report security vulnerabilities

Do **not** open a public issue for security vulnerabilities. Follow the process described in [`SECURITY.md`](SECURITY.md).

## Running the tests

The test suites are part of this repository and released under the same license. After `npm install`:

```bash
npm test               # unit and integration tests
npm run build          # required once before the end-to-end tests
npm run test:e2e       # end-to-end tests against the built application
```

`npm run post-req` runs the full verification gate: type checking, linting, formatting, the test suite with coverage, and a smoke test of the application. [`test/README.md`](test/README.md) covers the end-to-end setup.

### Test policy

Major new functionality must be added together with automated tests that exercise it, and a bug fix should come with a test that fails without the fix. Coverage is not allowed to regress: the verification gate compares every change against a committed baseline, and continuous integration runs the gate on every push. This policy applies to the maintainer today and will apply to any external contribution in the future.

## What happens with external pull requests

External pull requests opened during this phase will be closed with a comment linking to this document. This is not a judgment of the work or the contributor — it is a consistent policy applied to every PR equally.

If you have invested time in a change you believe should be incorporated, please open an issue describing what you did and why. If the change makes sense for the project, it will be considered as a normal item on the roadmap.

## Code of conduct

All interactions in this project's spaces — issues, discussions, and any future contribution channels — follow the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful, assume good intent, prefer technical arguments over personal ones.

## License of future contributions

When external contributions are opened in the future, all submissions will be licensed under the same [MIT License](LICENSE) that covers the project. This document will be updated with the full contribution process when that phase begins.

## Trademarks

Even though external code contributions are not being accepted, the project's name, logos, and branding remain reserved as described in [`TRADEMARKS.md`](TRADEMARKS.md).

## Questions

If something about the current policy is unclear, or you want to discuss a non-trivial idea before opening an issue, [start a discussion](https://github.com/dmonza/fetchpier/discussions) or contact the maintainer through the channels listed at [sincrum.com](https://sincrum.com).
