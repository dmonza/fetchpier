// HTTP reason-phrase fill table (REQ-0068 §5.2.3).
//
// When the parser produces a status line without a reason phrase, the
// serializer fills it from this table on re-emit so the `.http` looks like
// a normal status line. Non-standard codes get an empty phrase (no fill).
//
// Source: RFC 7231 §6, plus the additional codes commonly returned by
// services (`409 Conflict`, `422 Unprocessable Entity`, `429 Too Many
// Requests`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway
// Timeout`). The list is deliberately small — anything not here gets `''`.

const TABLE: Readonly<Record<number, string>> = Object.freeze({
  100: 'Continue',
  101: 'Switching Protocols',

  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',

  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',

  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  422: 'Unprocessable Entity',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',

  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported'
})

/**
 * Return the canonical reason phrase for a status code, or empty string when
 * the code is non-standard. Callers serialize `<code> <phrase>` — an empty
 * phrase produces just the code.
 */
export function fillReasonPhrase(status: number): string {
  return TABLE[status] ?? ''
}
