import { describe, it, expect } from 'vitest'
import { importWsdl } from './wsdl'

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
