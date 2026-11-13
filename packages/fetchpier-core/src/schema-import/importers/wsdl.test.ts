import { describe, it, expect } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { importWsdl } from './wsdl'

/**
 * A document/literal WSDL whose single operation `Op` sends the global element
 * `Req`. `schemas` is the raw content of `<wsdl:types>` (one or more schemas).
 */
function docLiteralWsdl(schemas: string, wsdlTns = 'http://example.org/'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="${wsdlTns}"
                  targetNamespace="${wsdlTns}">
  <wsdl:types>${schemas}</wsdl:types>
  <wsdl:message name="OpIn"><wsdl:part name="parameters" element="tns:Req"/></wsdl:message>
  <wsdl:portType name="PT"><wsdl:operation name="Op"><wsdl:input message="tns:OpIn"/></wsdl:operation></wsdl:portType>
  <wsdl:binding name="B" type="tns:PT">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Op"><soap:operation soapAction="urn:op"/><wsdl:input><soap:body use="literal"/></wsdl:input></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="S"><wsdl:port name="P" binding="tns:B"><soap:address location="http://localhost/svc"/></wsdl:port></wsdl:service>
</wsdl:definitions>`
}

/** Body of the single imported operation, asserted to be well-formed XML. */
function importedEnvelope(wsdl: string): string {
  const body = importWsdl(wsdl).schema.operations[0]?.editorState.body ?? ''
  expect(XMLValidator.validate(body)).toBe(true)
  return body
}

/** Element tags (`tns:x`, `x`) opened in the body, in document order, excluding the envelope. */
function openedTags(body: string): string[] {
  return [...body.matchAll(/<([A-Za-z][\w.-]*(?::[\w.-]+)?)>/g)]
    .map((m) => m[1])
    .filter((t) => !t.startsWith('soapenv:'))
}

// Minimal WSDL with no <types>/<message>/<portType>: the body cannot be derived
// from a schema, so the importer falls back to an empty wrapper.
const CALCULATOR_WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:tns="http://example.com/calculator"
                  targetNamespace="http://example.com/calculator"
                  name="CalculatorService">
  <wsdl:binding name="CalculatorSoap" type="tns:CalculatorPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add">
      <soap:operation soapAction="http://example.com/calculator/Add"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
    <wsdl:operation name="Subtract">
      <soap:operation soapAction="http://example.com/calculator/Subtract"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="CalculatorService">
    <wsdl:port name="CalculatorSoapPort" binding="tns:CalculatorSoap">
      <soap:address location="https://example.com/calc/endpoint"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`

// Document/literal WSDL with an embedded XSD schema (ASMX style).
const TYPED_WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="http://tempuri.org/"
                  targetNamespace="http://tempuri.org/"
                  name="CalcService">
  <wsdl:types>
    <xsd:schema targetNamespace="http://tempuri.org/" elementFormDefault="qualified">
      <xsd:element name="Add">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="a" type="xsd:int"/>
            <xsd:element name="b" type="xsd:int"/>
            <xsd:element name="label" type="xsd:string"/>
            <xsd:element name="when" type="xsd:dateTime"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>
  <wsdl:message name="AddSoapIn">
    <wsdl:part name="parameters" element="tns:Add"/>
  </wsdl:message>
  <wsdl:portType name="CalcPortType">
    <wsdl:operation name="Add">
      <wsdl:input message="tns:AddSoapIn"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="CalcSoap" type="tns:CalcPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add">
      <soap:operation soapAction="http://tempuri.org/Add"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="CalcService">
    <wsdl:port name="CalcSoapPort" binding="tns:CalcSoap">
      <soap:address location="http://localhost/calc.asmx"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`

// Two SOAP bindings (1.1 + 1.2) exposing the same operation.
const MULTI_BINDING_WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:tns="http://tempuri.org/"
                  targetNamespace="http://tempuri.org/"
                  name="DualService">
  <wsdl:portType name="DualPortType">
    <wsdl:operation name="Ping"><wsdl:input message="tns:PingIn"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:message name="PingIn"/>
  <wsdl:binding name="DualSoap" type="tns:DualPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Ping">
      <soap:operation soapAction="http://tempuri.org/Ping"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="DualSoap12" type="tns:DualPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Ping">
      <soap:operation soapAction="http://tempuri.org/Ping"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="DualService">
    <wsdl:port name="DualSoapPort" binding="tns:DualSoap">
      <soap:address location="http://localhost/dual.asmx"/>
    </wsdl:port>
    <wsdl:port name="DualSoap12Port" binding="tns:DualSoap12">
      <soap:address location="http://localhost/dual.asmx"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`

// Trimmed copy of the public CountryInfoService WSDL
// (http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL):
// the WSDL namespace is the DEFAULT namespace (elements are unprefixed), and two
// bindings (SOAP 1.1 + SOAP 1.2) implement the SAME portType.
const COUNTRYINFO_WSDL = `<?xml version="1.0" encoding="utf-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
             xmlns:tns="http://www.oorsprong.org/websamples.countryinfo"
             targetNamespace="http://www.oorsprong.org/websamples.countryinfo">
  <portType name="CountryInfoServiceSoapType">
    <operation name="CapitalCity"><input message="tns:CapitalCityRequest"/></operation>
    <operation name="CountryName"><input message="tns:CountryNameRequest"/></operation>
  </portType>
  <binding name="CountryInfoServiceSoapBinding" type="tns:CountryInfoServiceSoapType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="CapitalCity"><soap:operation soapAction=""/><input><soap:body use="literal"/></input></operation>
    <operation name="CountryName"><soap:operation soapAction=""/><input><soap:body use="literal"/></input></operation>
  </binding>
  <binding name="CountryInfoServiceSoapBinding12" type="tns:CountryInfoServiceSoapType">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="CapitalCity"><soap12:operation soapAction=""/><input><soap12:body use="literal"/></input></operation>
    <operation name="CountryName"><soap12:operation soapAction=""/><input><soap12:body use="literal"/></input></operation>
  </binding>
  <service name="CountryInfoService">
    <port name="CountryInfoServiceSoap" binding="tns:CountryInfoServiceSoapBinding">
      <soap:address location="http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso"/>
    </port>
    <port name="CountryInfoServiceSoap12" binding="tns:CountryInfoServiceSoapBinding12">
      <soap12:address location="http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso"/>
    </port>
  </service>
</definitions>`

// Synthetic ASMX-style WSDL reproducing the user's exact symptom: the same op
// "Execute" exposed under SOAP 1.1, SOAP 1.2, HTTP GET and HTTP POST bindings, with
// the SOAP 1.1 binding named EXACTLY like the service (caused the duplicate nested
// folder). The two SOAP bindings share the SOAP portType.
const ASMX_WSDL = `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
                  xmlns:http="http://schemas.xmlsoap.org/wsdl/http/"
                  xmlns:tns="http://tempuri.org/"
                  targetNamespace="http://tempuri.org/"
                  name="Svc_ShipmentSync">
  <wsdl:portType name="Svc_ShipmentSyncSoap">
    <wsdl:operation name="Execute"><wsdl:input message="tns:ExecuteIn"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:portType name="Svc_ShipmentSyncHttpGet">
    <wsdl:operation name="Execute"><wsdl:input message="tns:ExecuteHttpGetIn"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:portType name="Svc_ShipmentSyncHttpPost">
    <wsdl:operation name="Execute"><wsdl:input message="tns:ExecuteHttpPostIn"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:message name="ExecuteIn"/>
  <wsdl:binding name="Svc_ShipmentSync" type="tns:Svc_ShipmentSyncSoap">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Execute"><soap:operation soapAction="http://tempuri.org/Execute"/><wsdl:input><soap:body use="literal"/></wsdl:input></wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="Svc_ShipmentSyncSoap12" type="tns:Svc_ShipmentSyncSoap">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Execute"><soap12:operation soapAction="http://tempuri.org/Execute"/><wsdl:input><soap12:body use="literal"/></wsdl:input></wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="Svc_ShipmentSyncHttpGet" type="tns:Svc_ShipmentSyncHttpGet">
    <http:binding verb="GET"/>
    <wsdl:operation name="Execute"><http:operation location="/Execute"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="Svc_ShipmentSyncHttpPost" type="tns:Svc_ShipmentSyncHttpPost">
    <http:binding verb="POST"/>
    <wsdl:operation name="Execute"><http:operation location="/Execute"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Svc_ShipmentSync">
    <wsdl:port name="Svc_ShipmentSyncSoap" binding="tns:Svc_ShipmentSync">
      <soap:address location="http://localhost/demo/svc_shipmentsync.aspx"/>
    </wsdl:port>
    <wsdl:port name="Svc_ShipmentSyncSoap12" binding="tns:Svc_ShipmentSyncSoap12">
      <soap12:address location="http://localhost/demo/svc_shipmentsync.aspx"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`

describe('importWsdl', () => {
  it('extracts operations with SOAPAction and endpoint', () => {
    const { schema } = importWsdl(CALCULATOR_WSDL)
    expect(schema.format).toBe('wsdl')
    expect(schema.baseUrl).toBe('https://example.com/calc/endpoint')
    expect(schema.operations).toHaveLength(2)

    const add = schema.operations.find((o) => o.name === 'Add')
    expect(add?.editorState.method).toBe('POST')
    expect(
      add?.editorState.headers.some(
        (h) => h.key === 'SOAPAction' && h.value === 'http://example.com/calculator/Add'
      )
    ).toBe(true)
    expect(add?.editorState.body).toContain('<soapenv:Envelope')
    expect(add?.editorState.body).not.toContain('TODO')
    expect(add?.editorState.bodyType).toBe('raw')
    expect(add?.editorState.rawSubtype).toBe('xml')
  })

  it('flattens the binding folder when a single binding carries the operations', () => {
    const { schema } = importWsdl(CALCULATOR_WSDL)
    for (const op of schema.operations) {
      expect(op.folderPath).toEqual([])
    }
  })

  it('builds a real request body from the embedded XSD schema', () => {
    const { schema, warnings } = importWsdl(TYPED_WSDL)
    const add = schema.operations.find((o) => o.name === 'Add')
    const body = add?.editorState.body ?? ''

    expect(body).not.toContain('TODO')
    expect(body).toContain('<tns:Add>')
    expect(body).toContain('<tns:a>0</tns:a>')
    expect(body).toContain('<tns:b>0</tns:b>')
    expect(body).toContain('<tns:label>string</tns:label>')
    expect(body).toContain('<tns:when>2026-01-01T00:00:00Z</tns:when>')
    // tns is bound to the schema target namespace.
    expect(body).toContain('xmlns:tns="http://tempuri.org/"')
    // A fully resolved body emits no "could not derive" warning.
    expect(warnings.some((w) => /derive a request body/.test(w.message))).toBe(false)
  })

  it('collapses an operation exposed by several SOAP bindings into one flat request', () => {
    const { schema, warnings } = importWsdl(MULTI_BINDING_WSDL)
    // Ping is exposed by DualSoap + DualSoap12 → a single flat request, not two folders.
    expect(schema.operations).toHaveLength(1)
    const ping = schema.operations[0]
    expect(ping.displayName).toBe('Ping')
    expect(ping.folderPath).toEqual([])
    expect(ping.sourceBindings).toEqual(['DualSoap', 'DualSoap12'])
    // The collapse is recorded, not silent.
    expect(
      warnings.some(
        (w) => /exposed by 2 SOAP bindings/.test(w.message) && /DualSoap/.test(w.message)
      )
    ).toBe(true)
  })

  it('imports the public CountryInfoService (default WSDL ns, SOAP 1.1 + 1.2) without duplication', () => {
    const { schema, warnings } = importWsdl(COUNTRYINFO_WSDL)
    // Two operations, each once — NOT four (would be 2 ops × 2 bindings before the fix).
    expect(schema.operations).toHaveLength(2)
    const names = schema.operations.map((o) => o.displayName).sort()
    expect(names).toEqual(['CapitalCity', 'CountryName'])
    for (const op of schema.operations) {
      expect(op.folderPath).toEqual([])
      expect(op.sourceBindings).toEqual([
        'CountryInfoServiceSoapBinding',
        'CountryInfoServiceSoapBinding12'
      ])
    }
    expect(warnings.filter((w) => /exposed by 2 SOAP bindings/.test(w.message))).toHaveLength(2)
  })

  it('flattens ASMX bindings, ignores HTTP GET/POST, and never nests under the service name', () => {
    const { schema, warnings } = importWsdl(ASMX_WSDL)
    expect(schema.operations).toHaveLength(1)
    const execute = schema.operations[0]
    expect(execute.displayName).toBe('Execute')
    // No subfolder at all — in particular none named like the collection/service.
    expect(execute.folderPath).toEqual([])
    expect(execute.sourceBindings).toEqual(['Svc_ShipmentSync', 'Svc_ShipmentSyncSoap12'])
    // SOAP collapse recorded.
    expect(warnings.some((w) => /exposed by 2 SOAP bindings/.test(w.message))).toBe(true)
    // Both non-SOAP HTTP bindings ignored with a warning each.
    const httpWarnings = warnings.filter((w) => /Ignored HTTP (GET|POST) binding/.test(w.message))
    expect(httpWarnings).toHaveLength(2)
    expect(httpWarnings.map((w) => w.location).sort()).toEqual([
      'Svc_ShipmentSyncHttpGet',
      'Svc_ShipmentSyncHttpPost'
    ])
  })
})

describe('importWsdl — example envelope is well-formed XML', () => {
  it('escapes enumeration sample values holding & < > and quotes', () => {
    const body = importedEnvelope(
      docLiteralWsdl(`
    <xs:schema targetNamespace="http://example.org/" elementFormDefault="qualified">
      <xs:element name="Req"><xs:complexType><xs:sequence>
        <xs:element name="mode"><xs:simpleType><xs:restriction base="xs:string">
          <xs:enumeration value="A&amp;B"/><xs:enumeration value="C"/>
        </xs:restriction></xs:simpleType></xs:element>
        <xs:element name="cmp" type="tns:Cmp"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:simpleType name="Cmp"><xs:restriction base="xs:string">
        <xs:enumeration value="&lt;=&gt;&quot;"/>
      </xs:restriction></xs:simpleType>
    </xs:schema>`)
    )
    expect(body).toContain('<tns:mode>A&amp;B</tns:mode>')
    expect(body).toContain('<tns:cmp>&lt;=&gt;&quot;</tns:cmp>')
  })

  it('escapes the target namespace bound to tns', () => {
    const body = importedEnvelope(
      docLiteralWsdl(`
    <xs:schema targetNamespace="http://ex.com/a?x=1&amp;y=&quot;2&quot;">
      <xs:element name="Req" type="xs:string"/>
    </xs:schema>`)
    )
    expect(body).toContain('xmlns:tns="http://ex.com/a?x=1&amp;y=&quot;2&quot;"')
  })

  it('escapes the WSDL target namespace used as the fallback binding', () => {
    const wsdl = docLiteralWsdl('', 'http://ex.com/w?a=1&amp;b=2')
    const body = importedEnvelope(wsdl)
    expect(body).toContain('xmlns:tns="http://ex.com/w?a=1&amp;b=2"')
  })
})

describe('importWsdl — elements referenced with ref=', () => {
  it('qualifies a referenced global element even when the schema is unqualified', () => {
    const body = importedEnvelope(
      docLiteralWsdl(`
    <xs:schema targetNamespace="http://example.org/">
      <xs:element name="Customer"><xs:complexType><xs:sequence>
        <xs:element name="id" type="xs:int"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="Req"><xs:complexType><xs:sequence>
        <xs:element ref="tns:Customer"/>
        <xs:element name="note" type="xs:string"/>
      </xs:sequence></xs:complexType></xs:element>
    </xs:schema>`)
    )
    expect(openedTags(body)).toEqual(['tns:Req', 'tns:Customer', 'id', 'note'])
  })

  it('binds a prefix to the namespace of a global element from another schema', () => {
    const body = importedEnvelope(
      docLiteralWsdl(`
    <xs:schema targetNamespace="http://other.org/" elementFormDefault="qualified">
      <xs:element name="Address"><xs:complexType><xs:sequence>
        <xs:element name="city" type="xs:string"/>
      </xs:sequence></xs:complexType></xs:element>
    </xs:schema>
    <xs:schema targetNamespace="http://example.org/" xmlns:o="http://other.org/">
      <xs:element name="Req"><xs:complexType><xs:sequence>
        <xs:element ref="o:Address"/>
        <xs:element name="note" type="xs:string"/>
      </xs:sequence></xs:complexType></xs:element>
    </xs:schema>`)
    )
    expect(body).toContain('xmlns:tns="http://example.org/"')
    expect(body).toContain('xmlns:ns1="http://other.org/"')
    // The referenced element and its locals follow the declaring schema (qualified).
    expect(openedTags(body)).toEqual(['tns:Req', 'ns1:Address', 'ns1:city', 'note'])
  })

  it('leaves a referenced element of a no-namespace schema unqualified', () => {
    const body = importedEnvelope(
      docLiteralWsdl(`
    <xs:schema>
      <xs:element name="Plain" type="xs:string"/>
    </xs:schema>
    <xs:schema targetNamespace="http://example.org/" elementFormDefault="qualified">
      <xs:element name="Req"><xs:complexType><xs:sequence>
        <xs:element ref="Plain"/>
      </xs:sequence></xs:complexType></xs:element>
    </xs:schema>`)
    )
    expect(openedTags(body)).toEqual(['tns:Req', 'Plain'])
  })
})

describe('importWsdl — particles keep their declared order', () => {
  const schema = (particles: string, extra = ''): string => `
    <xs:schema targetNamespace="http://example.org/">
      <xs:element name="Req"><xs:complexType>${particles}</xs:complexType></xs:element>${extra}
    </xs:schema>`

  it('keeps a choice in place inside a sequence (first branch)', () => {
    const body = importedEnvelope(
      docLiteralWsdl(
        schema(`<xs:sequence>
          <xs:element name="first" type="xs:string"/>
          <xs:choice><xs:element name="byId" type="xs:int"/><xs:element name="byName" type="xs:string"/></xs:choice>
          <xs:element name="last" type="xs:string"/>
        </xs:sequence>`)
      )
    )
    expect(openedTags(body)).toEqual(['tns:Req', 'first', 'byId', 'last'])
  })

  it('expands every choice when a sequence holds several', () => {
    const body = importedEnvelope(
      docLiteralWsdl(
        schema(`<xs:sequence>
          <xs:element name="first" type="xs:string"/>
          <xs:choice><xs:element name="a1" type="xs:int"/><xs:element name="a2" type="xs:int"/></xs:choice>
          <xs:element name="mid" type="xs:string"/>
          <xs:choice><xs:element name="b1" type="xs:int"/><xs:element name="b2" type="xs:int"/></xs:choice>
          <xs:element name="last" type="xs:string"/>
        </xs:sequence>`)
      )
    )
    expect(openedTags(body)).toEqual(['tns:Req', 'first', 'a1', 'mid', 'b1', 'last'])
  })

  it('expands nested sequences, a choice whose first branch is a sequence, and group refs in place', () => {
    const body = importedEnvelope(
      docLiteralWsdl(
        schema(
          `<xs:sequence>
          <xs:element name="first" type="xs:string"/>
          <xs:sequence><xs:element name="n1" type="xs:string"/><xs:element name="n2" type="xs:string"/></xs:sequence>
          <xs:choice>
            <xs:annotation><xs:documentation>pick one</xs:documentation></xs:annotation>
            <xs:sequence><xs:element name="c1" type="xs:string"/><xs:element name="c2" type="xs:string"/></xs:sequence>
            <xs:element name="other" type="xs:string"/>
          </xs:choice>
          <xs:group ref="tns:Tail"/>
        </xs:sequence>`,
          `
      <xs:group name="Tail"><xs:sequence>
        <xs:element name="g1" type="xs:string"/>
        <xs:element name="g2" type="xs:string"/>
      </xs:sequence></xs:group>`
        )
      )
    )
    expect(openedTags(body)).toEqual(['tns:Req', 'first', 'n1', 'n2', 'c1', 'c2', 'g1', 'g2'])
  })

  it('expands a complexType whose content model is a group ref or a top-level choice', () => {
    const viaGroup = importedEnvelope(
      docLiteralWsdl(
        schema(
          `<xs:group ref="tns:G"/>`,
          `
      <xs:group name="G"><xs:choice><xs:element name="x" type="xs:int"/><xs:element name="y" type="xs:int"/></xs:choice></xs:group>`
        )
      )
    )
    expect(openedTags(viaGroup)).toEqual(['tns:Req', 'x'])

    const viaChoice = importedEnvelope(
      docLiteralWsdl(
        schema(
          `<xs:choice><xs:element name="p" type="xs:int"/><xs:element name="q" type="xs:int"/></xs:choice>`
        )
      )
    )
    expect(openedTags(viaChoice)).toEqual(['tns:Req', 'p'])
  })

  it('keeps declared order in a base type extended through complexContent', () => {
    const body = importedEnvelope(
      docLiteralWsdl(`
    <xs:schema targetNamespace="http://example.org/">
      <xs:complexType name="Base"><xs:sequence>
        <xs:element name="b1" type="xs:string"/>
        <xs:choice><xs:element name="bc" type="xs:int"/></xs:choice>
        <xs:element name="b2" type="xs:string"/>
      </xs:sequence></xs:complexType>
      <xs:element name="Req"><xs:complexType><xs:complexContent>
        <xs:extension base="tns:Base"><xs:sequence>
          <xs:element name="own" type="xs:string"/>
        </xs:sequence></xs:extension>
      </xs:complexContent></xs:complexType></xs:element>
    </xs:schema>`)
    )
    expect(openedTags(body)).toEqual(['tns:Req', 'b1', 'bc', 'b2', 'own'])
  })
})
