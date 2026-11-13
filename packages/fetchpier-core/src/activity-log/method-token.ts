// The request-method token grammar of a `.http` file: a word, optionally
// hyphenated (custom verbs such as `VERSION-CONTROL` included). The `.http`
// separator detection and the run-file readers share it, so a run written for
// any method a `.http` file accepts is read back. It lives here because this
// module is the pure one the renderer bundles.

export const METHOD_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/
