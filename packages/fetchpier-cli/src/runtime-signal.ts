// The binary installs a SIGINT/SIGTERM handler that aborts an `AbortController`;
// command actions read its signal here so an in-flight request can be cancelled.
// Kept in its own module so actions don't import the binary entry point.

let signal: AbortSignal | undefined

export function setRunSignal(s: AbortSignal): void {
  signal = s
}

export function getRunSignal(): AbortSignal | undefined {
  return signal
}
