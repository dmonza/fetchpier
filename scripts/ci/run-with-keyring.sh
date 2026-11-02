#!/usr/bin/env bash
#
# Start an OS keyring on the current session bus, then exec the given command
# inside it. Usage (must already be inside `dbus-run-session`):
#
#   xvfb-run -a dbus-run-session -- scripts/ci/run-with-keyring.sh npm run test:e2e
#
# The workspace-key specs need a real keyring: without one the secrets subsystem
# correctly holds keys in memory and never writes the keystore, leaving those
# specs asserting against a file that was never created.
#
# What the previous inline incantation got wrong. It ran the daemon and dropped
# its output on the floor:
#
#   echo -n "" | gnome-keyring-daemon --unlock --components=secrets
#
# Two problems. The daemon prints the environment it wants the session to adopt
# (`GNOME_KEYRING_CONTROL`, …) on stdout — unexported, the child never sees it.
# And `--unlock` expects a keyring directory to exist; on a freshly provisioned
# runner there is none, so the daemon has nothing to unlock and exits without
# registering the secrets service. It exits 0 either way, so the step went green
# and the failure only surfaced much later, as five specs that looked unrelated.
#
# Diagnostics are printed rather than asserted: the harness's host precondition
# is the authority on whether the keyring is usable (one authority, not two).
# What this script owes the reader is enough detail to tell "the daemon never
# started" from "it started and the service is still not on the bus".
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "[ci/keyring] usage: run-with-keyring.sh <command> [args...]" >&2
  exit 2
fi

# `--unlock` unlocks an existing keyring; the directory has to be there first.
mkdir -p "${HOME}/.local/share/keyrings"

# Adopt the daemon's environment instead of discarding it. Empty password: the
# keyring holds nothing beyond this job's throwaway keys.
# `--unlock` is documented to create the login keyring when none exists, but it
# reads a password *line* from stdin: closing with zero bytes (`printf ''`, or
# the equivalent `echo -n ""`) gives it EOF before any line and it creates
# nothing, silently. An empty LINE is the difference.
eval "$(echo '' | gnome-keyring-daemon --unlock --components=secrets || true)"
export GNOME_KEYRING_CONTROL

echo "[ci/keyring] GNOME_KEYRING_CONTROL=${GNOME_KEYRING_CONTROL:-<unset>}"
echo "[ci/keyring] keyring files: $(ls -A "${HOME}/.local/share/keyrings" 2>/dev/null | tr '\n' ' ')"

if busctl --user list --no-pager 2>/dev/null | grep -q 'org.freedesktop.secrets'; then
  echo '[ci/keyring] org.freedesktop.secrets is registered on the session bus'
else
  echo '[ci/keyring] WARNING: org.freedesktop.secrets is NOT on the session bus' >&2
fi

# A running secret service is NOT enough, and this is the part that actually
# blocked the suite: the engine picks its password store from the *detected
# desktop environment*, and falls back to a hardcoded plaintext key
# (`basic_text`, which the product correctly reports as `session-only`) when it
# recognises none. A headless runner has no desktop environment, so the backend
# stayed memory-only even with the keyring perfectly healthy — the previous run
# logged the secrets service registered on the bus and still resolved to
# `session-only`.
#
# `GNOME` is one of the environments the engine maps to the libsecret backend.
# Setting it here completes the GNOME session this job is already emulating, so
# the app takes exactly the path it takes on a user's Linux desktop.
#
# Deliberately NOT `--password-store=gnome-libsecret`: that flag would force the
# backend from the outside, meaning the suite would exercise a configuration the
# shipped app never receives. Same reason the sandbox assertion is not relaxed.
export XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-GNOME}"
echo "[ci/keyring] XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP}"

exec "$@"
