// Fixture builders used by benchmarks. Kept cheap so startup noise is small.

export function buildHttpFile(numRequests: number, headersPerReq = 8): string {
  const parts: string[] = [`# @id 11111111-2222-3333-4444-555555555555`, '']
  for (let i = 0; i < numRequests; i++) {
    parts.push(`### request ${i}`)
    parts.push(`# @pre-request-script`)
    parts.push(`# fp.environment.set("token_${i}", "abc{{seed}}")`)
    parts.push(`# fp.variables.set("idx", ${i})`)
    parts.push(`# @end-script`)
    parts.push(`# @post-response-script`)
    parts.push(`# fp.test("ok ${i}", () => fp.expect(fp.response.status).toBe(200))`)
    parts.push(`# @end-script`)
    parts.push(`# @settings`)
    parts.push(`# httpVersion: auto`)
    parts.push(`# followRedirects: true`)
    parts.push(`# maxRedirects: 5`)
    parts.push(`# @end-settings`)
    parts.push(`POST {{baseUrl}}/users/${i}?token={{token_${i}}} HTTP/1.1`)
    for (let h = 0; h < headersPerReq; h++) {
      parts.push(`X-Header-${h}: value-${h}-{{env_${h}}}`)
    }
    parts.push(`Content-Type: application/json`)
    parts.push('')
    parts.push(`# @rawSubtype: json`)
    parts.push(`{"id": ${i}, "name": "user-${i}", "token": "{{token_${i}}}"}`)
    parts.push('')
  }
  return parts.join('\n')
}

export function buildLargeJsonBody(items: number): string {
  const arr: unknown[] = []
  for (let i = 0; i < items; i++) {
    arr.push({
      id: i,
      name: `item-${i}`,
      tags: ['a', 'b', 'c'],
      meta: { createdAt: new Date(0).toISOString(), score: i * 1.5 }
    })
  }
  return JSON.stringify(arr)
}

export function buildXml(numItems: number): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`,
    `  <Body>`,
    `    <Items>`
  ]
  for (let i = 0; i < numItems; i++) {
    lines.push(`      <Item id="${i}" kind="sample">`)
    lines.push(`        <Name>Item ${i}</Name>`)
    lines.push(`        <Value>${i * 3.14}</Value>`)
    lines.push(`        <Tags><Tag>a</Tag><Tag>b</Tag><Tag>c</Tag></Tags>`)
    lines.push(
      `        <Description>Lorem ipsum dolor sit amet, consectetur adipiscing elit. ${i}</Description>`
    )
    lines.push(`      </Item>`)
  }
  lines.push(`    </Items>`, `  </Body>`, `</Envelope>`)
  return lines.join('\n')
}

export function buildEnvironment(vars: number): Record<string, string> {
  const env: Record<string, string> = { baseUrl: 'https://api.example.com', seed: 'xyz' }
  for (let i = 0; i < vars; i++) env[`env_${i}`] = `value_${i}`
  for (let i = 0; i < vars; i++) env[`token_${i}`] = `tok_${i}`
  return env
}

export function buildCookieList(count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.push(
      `sid${i}=value${i}; Domain=example.com; Path=/api/${i % 5}; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`
    )
  }
  return out
}
