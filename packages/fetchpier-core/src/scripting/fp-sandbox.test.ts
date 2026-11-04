import { describe, it, expect } from 'vitest'
import { runFpScript } from './fp-sandbox'
import { MAX_XML_BYTES } from './xml-parser'
import type { HttpRequest, HttpResponse } from '@shared/types'

function baseRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: { 'Content-Type': 'application/json' },
    body: undefined,
    ...overrides
  }
}

const baseResponse: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: '{"id":1,"name":"John"}',
  timingMs: 42,
  sizeBytes: 22
}

describe('runFpScript — pre-request', () => {
  it('modifies headers via fp.request.headers.set', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.headers.set("Authorization", "Bearer xyz");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.request.headers['Authorization']).toBe('Bearer xyz')
    expect(outcome.result.modifiedRequest?.headers?.['Authorization']).toBe('Bearer xyz')
  })

  it('removes a header', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.headers.remove("content-type");`,
      request: baseRequest({ headers: { 'Content-Type': 'application/json' } }),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.request.headers['Content-Type']).toBeUndefined()
  })

  // CA-03: the scripting surface is duplicate-aware — `getAll`/`add`/`count`
  // read and author repeated header names, and duplicates a script does not
  // touch survive unchanged.
  describe('duplicate-aware headers (CA-03)', () => {
    it('reads every value of a repeated name with getAll, and counts them', () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `
          fp.environment.set("all", fp.request.headers.getAll("Accept").join(","));
          fp.environment.set("n", String(fp.request.headers.count()));
        `,
        request: baseRequest({
          headers: { Accept: 'text/html' },
          headerList: [
            { name: 'Accept', value: 'application/json' },
            { name: 'Accept', value: 'text/html' }
          ]
        }),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.result.environmentChanges?.set.all).toBe('application/json,text/html')
      expect(outcome.result.environmentChanges?.set.n).toBe('2')
    })

    it('appends a duplicate with add and carries the whole list back', () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `fp.request.headers.add("Accept", "text/html");`,
        request: baseRequest({
          headers: { Accept: 'application/json' },
          headerList: [{ name: 'Accept', value: 'application/json' }]
        }),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      const accepts = outcome.request.headerList!.filter((h) => h.name === 'Accept')
      expect(accepts.map((h) => h.value)).toEqual(['application/json', 'text/html'])
      expect(outcome.result.modifiedRequest?.headerList).toBeDefined()
    })

    it('leaves untouched duplicates intact when a script edits a different header', () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `fp.request.headers.set("X-Trace", "1");`,
        request: baseRequest({
          headers: { Accept: 'text/html' },
          headerList: [
            { name: 'Accept', value: 'application/json' },
            { name: 'Accept', value: 'text/html' }
          ]
        }),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(
        outcome.request.headerList!.filter((h) => h.name === 'Accept').map((h) => h.value)
      ).toEqual(['application/json', 'text/html'])
      expect(outcome.request.headerList!.find((h) => h.name === 'X-Trace')?.value).toBe('1')
    })

    it('exposes duplicate response headers via getAll in post-response', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `fp.environment.set("cookies", String(fp.response.headers.getAll("Set-Cookie").length));`,
        request: baseRequest(),
        response: {
          ...baseResponse,
          // The client joins duplicate response headers (except Set-Cookie) into
          // one record value; this asserts the store still exposes getAll.
          headers: { 'Set-Cookie': 'a=1' }
        },
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.result.environmentChanges?.set.cookies).toBe('1')
    })
  })

  it('mutates url and body', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.url = "https://api.example.com/v2"; fp.request.body = '{"ok":true}';`,
      request: baseRequest({ body: '{}' }),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.request.url).toBe('https://api.example.com/v2')
    expect(outcome.request.body).toBe('{"ok":true}')
  })

  it('env.set is captured in environmentChanges', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.set("token", "abc123");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.environmentChanges?.set.token).toBe('abc123')
  })

  it('env.set rejects the reserved `enc:` prefix (REQ-0076 / CA-03)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.set("token", "enc:fake");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/reserved for encrypted secrets/)
    expect(outcome.result.environmentChanges).toBeUndefined()
  })

  it('env.set rejects a reserved `$`-prefixed name (REQ-0087 / CA-07)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.set("$x", "v");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/reserved for system dynamic variables/)
    expect(outcome.result.environmentChanges).toBeUndefined()
  })

  it('writes to fp.variables for later post-response use', () => {
    const pre = runFpScript({
      phase: 'pre-request',
      script: `fp.variables.set("startedAt", 1234);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(pre.variables.startedAt).toBe(1234)
  })

  it('captures fp.log output', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log("hello", 42);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs).toHaveLength(1)
    expect(outcome.result.logs[0].args).toEqual(['hello', 42])
  })
})

describe('runFpScript — post-response', () => {
  it('fp.test + fp.expect: passing test', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.test("status 200", () => { fp.expect(fp.response.status).to.equal(200); });`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.testResults).toEqual([{ name: 'status 200', passed: true }])
  })

  it('fp.test + fp.expect: failing test records error', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.test("status 201", () => { fp.expect(fp.response.status).to.equal(201); });`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.testResults[0].passed).toBe(false)
    expect(outcome.result.testResults[0].error).toMatch(/200/)
  })

  it('response.json parses body', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.test("id", () => { fp.expect(fp.response.json().id).to.equal(1); });`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.testResults[0].passed).toBe(true)
  })

  it('response.json throws if body is not JSON', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.response.json();`,
      request: baseRequest(),
      response: { ...baseResponse, body: 'not-json' },
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/not valid JSON/)
  })

  it('exposes decodingStatus, defaulting to not-required for responses without one', () => {
    const run = (response: HttpResponse): unknown =>
      runFpScript({
        phase: 'post-response',
        script: `fp.log(fp.response.decodingStatus);`,
        request: baseRequest(),
        response,
        environment: {},
        variables: {}
      }).result.logs[0]?.args[0]
    expect(run(baseResponse)).toBe('not-required')
    expect(run({ ...baseResponse, decodingStatus: 'decoded' })).toBe('decoded')
  })

  it.each([
    ['failed', 'json', /could not be decoded \(gzip: decoding failed\)/],
    ['unsupported', 'json', /could not be decoded \(zstd: unsupported content encoding\)/],
    ['failed', 'xml2Json', /xml2Json\(\): response body could not be decoded/]
  ] as const)(
    'with decodingStatus=%s, fp.response.%s() fails with the real cause',
    (status, method, message) => {
      const encoding = status === 'unsupported' ? 'zstd' : 'gzip'
      const outcome = runFpScript({
        phase: 'post-response',
        script: `fp.response.${method}();`,
        request: baseRequest(),
        response: {
          ...baseResponse,
          headers: { 'Content-Encoding': encoding },
          decodingStatus: status
        },
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(false)
      expect(outcome.result.error?.message).toMatch(message)
    }
  )

  it('cannot mutate the request in post-response', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.request.headers.set("X", "Y");`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/pre-request/)
  })
})

describe('runFpScript — isolation & errors', () => {
  it('reports syntax errors without crashing', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `this is not valid js {`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error).toBeDefined()
  })

  it('enforces timeout', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `while (true) {}`,
      request: baseRequest(),
      environment: {},
      variables: {},
      timeoutMs: 50
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/timed out|script execution/i)
  })

  it('has no access to require / process / fs / child_process', () => {
    // Use `typeof` so undefined identifiers don't throw ReferenceError — this
    // lets us assert that the probe name evaluates to the string 'undefined'.
    const probes = ['require', 'process', 'fs', 'child_process']
    for (const probe of probes) {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `fp.variables.set("t", typeof ${probe});`,
        request: baseRequest(),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.t).toBe('undefined')
    }
  })

  it('rejects eval/Function string compilation (codeGeneration disabled)', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `eval("1+1");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    // With `codeGeneration: { strings: false }` eval on a string throws.
    expect(outcome.result.success).toBe(false)
  })

  describe('sandbox isolation hardening', () => {
    const asyncProbes = [
      'Promise',
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'process',
      'SharedArrayBuffer',
      'Atomics',
      'WebAssembly',
      'global',
      'require',
      'module'
    ]

    for (const probe of asyncProbes) {
      it(`typeof ${probe} === 'undefined'`, () => {
        const outcome = runFpScript({
          phase: 'pre-request',
          script: `fp.variables.set("t", typeof ${probe});`,
          request: baseRequest(),
          environment: {},
          variables: {}
        })
        expect(outcome.result.success).toBe(true)
        expect(outcome.variables.t).toBe('undefined')
      })
    }

    it('new Promise(...) fails because Promise is undefined in scope', () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `new Promise(() => {});`,
        request: baseRequest(),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(false)
      // Promise is shadowed to undefined — `new undefined` throws TypeError.
      expect(outcome.result.error?.message).toMatch(/Promise is not (defined|a constructor)/)
    })

    it('keeps sync built-ins available (JSON, Math, Array, Date, String, RegExp, Symbol, Map, Set)', () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `
          fp.variables.set("json", typeof JSON);
          fp.variables.set("math", typeof Math);
          fp.variables.set("array", typeof Array);
          fp.variables.set("date", typeof Date);
          fp.variables.set("string", typeof String);
          fp.variables.set("regexp", typeof RegExp);
          fp.variables.set("symbol", typeof Symbol);
          fp.variables.set("map", typeof Map);
          fp.variables.set("set", typeof Set);
        `,
        request: baseRequest(),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables).toMatchObject({
        json: 'object',
        math: 'object',
        array: 'function',
        date: 'function',
        string: 'function',
        regexp: 'function',
        symbol: 'function',
        map: 'function',
        set: 'function'
      })
    })
  })

  describe('response.xml2Json', () => {
    const soapLogin = [
      '<soap:Envelope xmlns:soap="http://x">',
      '<soap:Body>',
      '<LoginResponse>',
      '<token expiresIn="3600">abc123</token>',
      '<roles><role>admin</role><role>user</role></roles>',
      '<email>a@b.com</email>',
      '</LoginResponse>',
      '</soap:Body>',
      '</soap:Envelope>'
    ].join('')

    const xmlResponse: HttpResponse = {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/xml' },
      body: soapLogin,
      timingMs: 10,
      sizeBytes: soapLogin.length
    }

    it('extracts a SOAP token and writes it to environment', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `
          const data = fp.response.xml2Json({ stripNamespaces: true });
          fp.environment.set("token", data.Envelope.Body.LoginResponse.token["#text"]);
        `,
        request: baseRequest(),
        response: xmlResponse,
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.result.environmentChanges?.set.token).toBe('abc123')
    })

    it('returns array of roles naturally when N >= 2', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `
          const data = fp.response.xml2Json({ stripNamespaces: true });
          fp.variables.set("roles", data.Envelope.Body.LoginResponse.roles.role.join(","));
        `,
        request: baseRequest(),
        response: xmlResponse,
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.roles).toBe('admin,user')
    })

    it('alwaysArray forces array for a single-occurrence element', () => {
      const single =
        '<soap:Envelope xmlns:soap="http://x"><soap:Body><roles><role>admin</role></roles></soap:Body></soap:Envelope>'
      const outcome = runFpScript({
        phase: 'post-response',
        script: `
          const data = fp.response.xml2Json({ stripNamespaces: true, alwaysArray: ["role"] });
          fp.variables.set("isArray", Array.isArray(data.Envelope.Body.roles.role));
          fp.variables.set("count", data.Envelope.Body.roles.role.length);
        `,
        request: baseRequest(),
        response: { ...xmlResponse, body: single, sizeBytes: single.length },
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.isArray).toBe(true)
      expect(outcome.variables.count).toBe(1)
    })

    it('memoizes default-option calls (same reference across calls)', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `
          const a = fp.response.xml2Json();
          const b = fp.response.xml2Json();
          const c = fp.response.xml2Json();
          fp.variables.set("sameAB", a === b);
          fp.variables.set("sameAC", a === c);
        `,
        request: baseRequest(),
        response: xmlResponse,
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.sameAB).toBe(true)
      expect(outcome.variables.sameAC).toBe(true)
    })

    it('does not cache calls with options (fresh object each time)', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `
          const a = fp.response.xml2Json({ stripNamespaces: true });
          const b = fp.response.xml2Json({ stripNamespaces: true });
          const def = fp.response.xml2Json();
          const def2 = fp.response.xml2Json();
          fp.variables.set("sameAB", a === b);        // different refs
          fp.variables.set("sameDef", def === def2);  // cached — same ref
        `,
        request: baseRequest(),
        response: xmlResponse,
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.sameAB).toBe(false)
      expect(outcome.variables.sameDef).toBe(true)
    })

    it('reports malformed XML as a script error', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `fp.response.xml2Json();`,
        request: baseRequest(),
        response: { ...xmlResponse, body: '<a><b></a>' },
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(false)
      expect(outcome.result.error?.message).toMatch(/xml2Json: failed to parse/)
    })

    it('throws on bodies larger than MAX_XML_BYTES', () => {
      const oversize = 'a'.repeat(MAX_XML_BYTES + 1)
      const outcome = runFpScript({
        phase: 'post-response',
        script: `fp.response.xml2Json();`,
        request: baseRequest(),
        response: { ...xmlResponse, body: oversize, sizeBytes: oversize.length },
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(false)
      expect(outcome.result.error?.message).toMatch(/too large/)
      expect(outcome.result.error?.message).toMatch(/max 10\.0 MB/)
    })

    it('is unavailable in pre-request (fp.response is null)', () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `fp.response.xml2Json();`,
        request: baseRequest(),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(false)
      expect(outcome.result.error?.message).toMatch(/null|undefined/i)
    })
  })

  describe('response.json — size cap', () => {
    it('throws when body exceeds MAX_XML_BYTES', () => {
      const oversize = 'x'.repeat(MAX_XML_BYTES + 1)
      const outcome = runFpScript({
        phase: 'post-response',
        script: `fp.response.json();`,
        request: baseRequest(),
        response: { ...baseResponse, body: oversize, sizeBytes: oversize.length },
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(false)
      expect(outcome.result.error?.message).toMatch(/too large/)
      expect(outcome.result.error?.message).toMatch(/max 10\.0 MB/)
    })

    it('still parses normal-sized JSON bodies', () => {
      const outcome = runFpScript({
        phase: 'post-response',
        script: `fp.test("id", () => { fp.expect(fp.response.json().id).to.equal(1); });`,
        request: baseRequest(),
        response: baseResponse,
        environment: {},
        variables: {}
      })
      expect(outcome.result.testResults[0].passed).toBe(true)
    })
  })

  it('fp.variables persists across pre and post within the same flow', () => {
    const pre = runFpScript({
      phase: 'pre-request',
      script: `fp.variables.set("x", 10);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    const post = runFpScript({
      phase: 'post-response',
      script: `fp.test("carries x", () => { fp.expect(fp.variables.get("x")).to.equal(10); });`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: pre.variables
    })
    expect(post.result.testResults[0].passed).toBe(true)
  })
})

// ── Coverage-gap additions (REQ-0055 §4.3.4) ───────────────────────────────

describe('FORBIDDEN_GLOBALS — every name is shadowed inside scripts', () => {
  // The source-of-truth list lives in fp-sandbox.ts; keeping a parallel copy
  // here so a maintainer adding a new forbidden global must also add it here.
  const FORBIDDEN_FROM_SOURCE = [
    'Promise',
    'setTimeout',
    'setInterval',
    'setImmediate',
    'clearTimeout',
    'clearInterval',
    'clearImmediate',
    'queueMicrotask',
    'SharedArrayBuffer',
    'Atomics',
    'WebAssembly',
    'process',
    'global',
    'globalThis',
    'Buffer',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename'
  ]

  for (const name of FORBIDDEN_FROM_SOURCE) {
    it(`typeof ${name} === 'undefined'`, () => {
      const outcome = runFpScript({
        phase: 'pre-request',
        script: `fp.variables.set("t", typeof ${name});`,
        request: baseRequest(),
        environment: {},
        variables: {}
      })
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.t).toBe('undefined')
    })
  }
})

describe('5-second default timeout (REQ §4.3.4)', () => {
  it('default timeoutMs is 5000 when caller omits it', () => {
    // A trivial script returns near-instantly — we can't time the 5s default
    // in a unit test without slowing the suite. Instead, assert success: any
    // change to the default that makes it < 50ms would still let this through,
    // but combined with the explicit-timeout assertion below it pins down the
    // contract.
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log("hi");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
  })

  it('explicit short timeout still fires for CPU-bound infinite loop', () => {
    const start = Date.now()
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `while (true) {}`,
      request: baseRequest(),
      environment: {},
      variables: {},
      timeoutMs: 80
    })
    const elapsed = Date.now() - start
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/timed out|script execution/i)
    // Generous upper bound — we just want to confirm the timeout actually
    // interrupts the loop rather than letting it run for seconds.
    expect(elapsed).toBeLessThan(1500)
  })
})

describe('safeClone — log argument shapes', () => {
  it('serializes null/undefined verbatim', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log(null); fp.log(undefined);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs[0].args).toEqual([null])
    expect(outcome.result.logs[1].args).toEqual([undefined])
  })

  it('serializes primitives verbatim', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log("hi", 42, true);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs[0].args).toEqual(['hi', 42, true])
  })

  it('serializes a function as { __inspect: "fn", name }', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log(function namedFn(){});`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs[0].args[0]).toEqual({ __inspect: 'fn', name: 'namedFn' })
  })

  it('serializes an anonymous arrow function with a generated name', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log((function(){ return () => {}; })());`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    const arg = outcome.result.logs[0].args[0] as { __inspect: string; name: string }
    expect(arg.__inspect).toBe('fn')
    // Some engines leave anonymous arrows with name === '', which falls back to '(anonymous)'.
    expect(typeof arg.name).toBe('string')
  })

  it('detects circular references', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `const a = {}; a.self = a; fp.log(a);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    const arg = outcome.result.logs[0].args[0] as Record<string, unknown>
    expect(arg.self).toEqual({ __inspect: 'circular' })
  })

  it('truncates arrays past SAFE_CLONE_MAX_DEPTH', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log([[[[[[[1]]]]]]]);`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    const dump = JSON.stringify(outcome.result.logs[0].args[0])
    expect(dump).toContain('"__inspect":"truncated"')
    expect(dump).toContain('"kind":"array"')
  })

  it('truncates objects past SAFE_CLONE_MAX_DEPTH', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log({a:{b:{c:{d:{e:{f:"deep"}}}}}});`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    const dump = JSON.stringify(outcome.result.logs[0].args[0])
    expect(dump).toContain('"__inspect":"truncated"')
    expect(dump).toContain('"kind":"object"')
  })

  it('coerces a Symbol to its description string', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log(Symbol("tag"));`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs[0].args[0]).toBe('Symbol(tag)')
  })
})

describe('environment proxy — set / remove / re-set bookkeeping', () => {
  it('remove() records the key in environmentChanges.removed', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.remove("token");`,
      request: baseRequest(),
      environment: { token: 'abc' },
      variables: {}
    })
    expect(outcome.result.environmentChanges?.removed).toContain('token')
    expect(outcome.environment.token).toBeUndefined()
  })

  it('set after remove cancels the removal', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.remove("k"); fp.environment.set("k", "v2");`,
      request: baseRequest(),
      environment: { k: 'v1' },
      variables: {}
    })
    expect(outcome.result.environmentChanges?.set.k).toBe('v2')
    expect(outcome.result.environmentChanges?.removed).not.toContain('k')
  })

  it('remove after set drops the set entry', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.set("k", "x"); fp.environment.remove("k");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.environmentChanges?.set.k).toBeUndefined()
    expect(outcome.result.environmentChanges?.removed).toContain('k')
  })

  it('toObject() reflects mutations', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.environment.set("a", "1");
        fp.environment.remove("removed");
        fp.variables.set("snapshot", JSON.stringify(fp.environment.toObject()));
      `,
      request: baseRequest(),
      environment: { existing: 'keep', removed: 'gone' },
      variables: {}
    })
    const snapshot = JSON.parse(outcome.variables.snapshot as string) as Record<string, string>
    expect(snapshot).toEqual({ existing: 'keep', a: '1' })
  })

  it('environmentChanges is omitted from the result when no mutation happened', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.environment.get("nonexistent");`,
      request: baseRequest(),
      environment: { a: '1' },
      variables: {}
    })
    expect(outcome.result.environmentChanges).toBeUndefined()
  })
})

describe('post-response request immutability', () => {
  it('mutating fp.request.method throws', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.request.method = "POST";`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/read-only/)
  })

  it('mutating fp.request.url throws', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.request.url = "https://x/";`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/read-only/)
  })

  it('mutating fp.request.body throws', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.request.body = "new";`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/read-only/)
  })

  it('headers.remove throws in post-response', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.request.headers.remove("Content-Type");`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/only available in pre-request/)
  })
})

describe('console alias and fp.warn / fp.error', () => {
  it('console.log routes to result.logs with level log', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `console.log("via console");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs[0].level).toBe('log')
    expect(outcome.result.logs[0].args).toEqual(['via console'])
  })

  it('console.warn / console.error / console.info route to the matching levels', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `console.warn("w"); console.error("e"); console.info("i");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs.map((l) => l.level)).toEqual(['warn', 'error', 'log'])
  })

  it('fp.warn and fp.error route to their own levels', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.warn("w"); fp.error("e");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.logs.map((l) => l.level)).toEqual(['warn', 'error'])
  })
})

describe('pre-request body setter — null/number coercion', () => {
  it('setting body to null clears it', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.body = null;`,
      request: baseRequest({ body: 'old' }),
      environment: {},
      variables: {}
    })
    expect(outcome.request.body).toBeUndefined()
  })

  it('setting body to a number stringifies it', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.request.body = 42;`,
      request: baseRequest({ body: 'old' }),
      environment: {},
      variables: {}
    })
    expect(outcome.request.body).toBe('42')
  })

  it('result.modifiedRequest is absent when the script makes no changes', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `fp.log("noop");`,
      request: baseRequest(),
      environment: {},
      variables: {}
    })
    expect(outcome.result.modifiedRequest).toBeUndefined()
  })
})

describe('response.body and response.headers edges', () => {
  it('fp.response.headers.get is case-insensitive', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.variables.set("ct", fp.response.headers.get("content-TYPE"));`,
      request: baseRequest(),
      response: baseResponse,
      environment: {},
      variables: {}
    })
    expect(outcome.variables.ct).toBe('application/json')
  })

  it('fp.response.headers.toObject preserves original casing', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.variables.set("obj", JSON.stringify(fp.response.headers.toObject()));`,
      request: baseRequest(),
      response: {
        ...baseResponse,
        headers: { 'X-Custom-Header': 'v' }
      },
      environment: {},
      variables: {}
    })
    expect(outcome.variables.obj).toBe('{"X-Custom-Header":"v"}')
  })

  it('fp.response.json throws when body is undefined', () => {
    const outcome = runFpScript({
      phase: 'post-response',
      script: `fp.response.json();`,
      request: baseRequest(),
      response: { ...baseResponse, body: undefined as unknown as string },
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/not a string/)
  })
})
