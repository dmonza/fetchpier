#!/usr/bin/env bash
#
# Make the browser engine's privileged sandbox helper usable, so renderers run
# inside the OS sandbox exactly as they do in a shipped build.
#
# Why this is needed. The package manager installs the helper with mode 4755 but
# owned by the *installing user*, not root — so the setuid bit is inert. The
# engine finds the helper, sees it is not setuid-root, and DISABLES the renderer
# sandbox rather than aborting (the runtime patches that fatal into a warning).
# The app therefore starts normally and every renderer reports no seccomp filter,
# which is indistinguishable from a regression that turned the sandbox off.
#
# Allowing unprivileged user namespaces is NOT sufficient on its own: measured on
# the runner, the kernel restriction went 1 → 0 and the renderer stayed
# unsandboxed, because the engine had already ruled the helper out. Both are kept
# — the kernel setting lives in `.github/actions/setup-e2e-linux` and covers hosts
# that ship no helper at all.
#
# MUST run after dependency installation: the helper does not exist before it.
#
# The harness verifies the outcome (`test/e2e/helpers/host-preconditions.ts`), so
# this script does not need to be the authority — but it fails loudly if the
# helper is missing, because silently doing nothing is what produced a week of
# red runs.
set -euo pipefail

HELPER="${1:-node_modules/electron/dist/chrome-sandbox}"

if [ ! -e "$HELPER" ]; then
  echo "[ci/sandbox] helper not found at '$HELPER' — dependencies not installed yet?" >&2
  exit 1
fi

echo "[ci/sandbox] before: $(stat -c '%U:%G %a' "$HELPER")"
sudo chown root:root "$HELPER"
sudo chmod 4755 "$HELPER"
echo "[ci/sandbox] after:  $(stat -c '%U:%G %a' "$HELPER")"
