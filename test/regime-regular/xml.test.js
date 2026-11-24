// XML area (/api/calculadora/xml/**, XMLController of calculadora-rtc-regime-regular 1.7.2):
// - every official vector of the area through the real HTTP server: 'xml-generate', 'xml-validate',
//   unit:XmlService.gerarXml / validarXml and unit:XmlUtil.getSchema(+validate);
// - byte-exact generation for the 7 document types (SHA-256 of the oracle's bodies) and the edge
//   example of the spec (scientific notation, defaults, escapes, truncated integers);
// - the exact 422 texts the oracle gives for the official invalid examples, error envelopes, and
//   the JDK processing limits (entity expansion bomb, recursion, depth, attributes, external DTD)
//   that keep hostile documents from exhausting the server.
// The full differential (hundreds of thousands of generated requests) runs with
//   node test/regime-regular/diferencial/rodar.mjs --geradores=xml
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { subir } from '../lib/servidor.js';
import { vetoresHttp, vetoresUnitarios, executarVetor } from '../lib/vetores.js';
import { gerarXml } from '../../src/regime-regular/xml/geracao.js';
import { vincularRoc } from '../../src/regime-regular/xml/roc.js';
import { lerJsonTexto } from '../../src/regime-regular/comum/json.js';
import { TIPOS_DOCUMENTO, TIPOS_XML } from '../../src/regime-regular/xml/tipos.js';
import { obterEsquema } from '../../src/regime-regular/xml/validacao/esquema.js';
import { validarDocumento } from '../../src/regime-regular/xml/validacao/index.js';

const s = await subir();
after(() => s.fechar());

const GERAR = '/api/calculadora/xml/generate';
const VALIDAR = '/api/calculadora/xml/validate';
const NS_NFE = 'xmlns="http://www.portalfiscal.inf.br/nfe"';

/** TipoDocumento / TipoXml of a unit vector (enum constant names) → mnemonics. */
const tipoPorConstante = (c) => TIPOS_DOCUMENTO.find((t) => t.constante === c);
const subtipoPorConstante = (c) => TIPOS_XML.find((t) => t.constante === c);
const subtipoParam = (c) => c.toLowerCase();

const validar = (tipo, subtipo, corpo, contentType = 'application/xml') => s.chamar(`${VALIDAR}?tipo=${tipo}&subtipo=${subtipo}`, { method: 'POST', headers: { 'content-type': contentType }, body: corpo });
const gerar = (tipo, roc) => s.chamar(`${GERAR}?tipo=${tipo}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: roc });
const sha256 = (texto) => createHash('sha256').update(Buffer.from(texto, 'utf8')).digest('hex');
const semTimestamp = (texto) => texto.replace(/,"timestamp":"[^"]*"/, '');

// ─── Official HTTP vectors ─────────────────────────────────────────────────────────────────────
describe('vetores oficiais xml-generate / xml-validate (servidor HTTP real)', () => {
  for (const item of vetoresHttp({ endpoints: ['xml-generate', 'xml-validate'] })) {
    test(item.vetor.id, async () => {
      const r = await executarVetor(s, item);
      assert.deepEqual(r.falhas, [], r.resumo);
    });
  }
});

// ─── Unit vectors through the server ─────────────────────────────────────────────────────────
describe('unit:XmlService.gerarXml (pelo servidor)', () => {
  for (const v of vetoresUnitarios('validacao', 'XmlService.gerarXml')) {
    test(v.id, async () => {
      const tipo = tipoPorConstante(v.input.tipo);
      const r = await gerar(tipo.mnemonico, JSON.stringify(v.input.roc));
      assert.equal(r.status, 200, r.texto);
      assert.equal(v.expected.result, '<nonblank>');
      assert.ok(r.texto.trim().length > 0);
      // the service function gives the same text the route sends
      assert.equal(gerarXml(vincularRoc(lerJsonTexto(JSON.stringify(v.input.roc))), tipo), r.texto);
    });
  }
});

describe('unit:XmlService.validarXml (pelo servidor)', () => {
  for (const v of vetoresUnitarios('validacao', 'XmlService.validarXml')) {
    test(v.id, async () => {
      const r = await validar(tipoPorConstante(v.input.tipo).mnemonico, subtipoParam(v.input.subtipo), v.input.xml);
      assert.equal(v.expected.result, 'true');
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.texto, 'true');
    });
  }
});

/** Exact 422 details the oracle gives for the official invalid examples (XmlUtilTest mutations). */
const DETALHES_INVALIDOS = {
  'xml-02-01-invalido-NFE-GRUPO': "Erro na validação do XML: Erro na linha 3, coluna 10: cvc-complex-type.2.4.a: Foi detectado um conteúdo inválido começando com o elemento '{\"http://www.portalfiscal.inf.br/nfe\":total}'. Era esperado um dos '{\"http://www.portalfiscal.inf.br/nfe\":ide, \"http://www.portalfiscal.inf.br/nfe\":det}'.",
  'xml-02-02-invalido-NFE-NOTA': "Erro na validação do XML: Erro na linha 22, coluna 25: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-03-invalido-NFCE-GRUPO': "Erro na validação do XML: Erro na linha 3, coluna 10: cvc-complex-type.2.4.a: Foi detectado um conteúdo inválido começando com o elemento '{\"http://www.portalfiscal.inf.br/nfe\":total}'. Era esperado um dos '{\"http://www.portalfiscal.inf.br/nfe\":det}'.",
  'xml-02-04-invalido-NFCE-NOTA': "Erro na validação do XML: Erro na linha 20, coluna 21: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-05-invalido-NFSE-GRUPO': "Erro na validação do XML: Erro na linha 3, coluna 11: cvc-complex-type.2.4.b: O conteúdo do elemento 'infNFSe' não está completo. Era esperado um dos '{\"http://www.sped.fazenda.gov.br/nfse\":IBSCBS}'.",
  'xml-02-06-invalido-NFSE-NOTA': "Erro na validação do XML: Erro na linha 76, coluna 25: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-07-invalido-NFSE-NOTA': "Erro na validação do XML: Erro na linha 40, coluna 25: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-08-invalido-CTE-GRUPO': "Erro na validação do XML: Erro na linha 3, coluna 10: cvc-complex-type.2.4.b: O conteúdo do elemento 'infCte' não está completo. Era esperado um dos '{\"http://www.portalfiscal.inf.br/cte\":ide, \"http://www.portalfiscal.inf.br/cte\":imp}'.",
  'xml-02-09-invalido-CTE-NOTA': "Erro na validação do XML: Erro na linha 17, coluna 21: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-10-invalido-CTE_SIMPLIFICADO-GRUPO': "Erro na validação do XML: Erro na linha 3, coluna 10: cvc-complex-type.2.4.b: O conteúdo do elemento 'infCte' não está completo. Era esperado um dos '{\"http://www.portalfiscal.inf.br/cte\":ide, \"http://www.portalfiscal.inf.br/cte\":imp}'.",
  'xml-02-11-invalido-CTE_SIMPLIFICADO-NOTA': "Erro na validação do XML: Erro na linha 17, coluna 21: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-12-invalido-BPE-GRUPO': "Erro na validação do XML: Erro na linha 4, coluna 10: cvc-complex-type.2.4.b: O conteúdo do elemento 'infBPe' não está completo. Era esperado um dos '{\"http://www.portalfiscal.inf.br/bpe\":ide, \"http://www.portalfiscal.inf.br/bpe\":imp}'.",
  'xml-02-13-invalido-BPE-NOTA': "Erro na validação do XML: Erro na linha 7, coluna 21: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-14-invalido-BPE_TM-GRUPO': "Erro na validação do XML: Erro na linha 4, coluna 9: cvc-complex-type.2.4.a: Foi detectado um conteúdo inválido começando com o elemento '{\"http://www.portalfiscal.inf.br/bpe\":total}'. Era esperado um dos '{\"http://www.portalfiscal.inf.br/bpe\":ide, \"http://www.portalfiscal.inf.br/bpe\":detBPeTM}'.",
  'xml-02-15-invalido-BPE_TM-NOTA': "Erro na validação do XML: Erro na linha 7, coluna 21: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
  'xml-02-16-invalido-NF3E-GRUPO': "Erro na validação do XML: Erro na linha 4, coluna 9: cvc-complex-type.2.4.a: Foi detectado um conteúdo inválido começando com o elemento '{\"http://www.portalfiscal.inf.br/nf3e\":total}'. Era esperado um dos '{\"http://www.portalfiscal.inf.br/nf3e\":ide, \"http://www.portalfiscal.inf.br/nf3e\":NFdet}'.",
  'xml-02-17-invalido-NF3E-NOTA': "Erro na validação do XML: Erro na linha 7, coluna 21: cvc-enumeration-valid: O valor '9' não tem um aspecto válido em relação à enumeração '[1, 2]'. Deve ser um valor da enumeração.",
};

describe('unit:XmlUtil.getSchema+validate (pelo servidor)', () => {
  for (const v of vetoresUnitarios('dados-unit', 'XmlUtil.getSchema+validate')) {
    test(v.id, async () => {
      const r = await validar(tipoPorConstante(v.input.tipoDocumento).mnemonico, subtipoParam(v.input.tipoXml), v.input.xml);
      if (v.expected.throws === '<none>') {
        assert.equal(r.status, 200, r.texto);
        assert.equal(r.texto, 'true');
        return;
      }
      // SAXParseException → ErroXmlException → 422 with the Xerces message of the oracle
      assert.equal(v.expected.throws, 'org.xml.sax.SAXParseException');
      assert.equal(r.status, 422, r.texto);
      assert.equal(r.headers['content-type'], 'application/problem+json');
      const p = JSON.parse(r.texto);
      assert.equal(p.title, 'Erro de validação de XML');
      assert.equal(p.type, 'http://localhost/errors/erro-xml');
      assert.equal(p.detail, DETALHES_INVALIDOS[v.id]);
    });
  }
});

describe('unit:XmlUtil.getSchema (16 combinações compilam)', () => {
  for (const v of vetoresUnitarios('dados-unit', 'XmlUtil.getSchema')) {
    if (v.endpoint !== 'unit:XmlUtil.getSchema') continue;
    test(v.id, async () => {
      const tipo = tipoPorConstante(v.input.tipoDocumento);
      const subtipo = subtipoPorConstante(v.input.tipoXml);
      assert.deepEqual(v.expected, { result: '<present>', 'newValidator()': '<no-throw>' });
      assert.ok(obterEsquema(tipo.mnemonico, subtipo.mnemonico), 'schema compilado');
      // the compiled schema validates through the route (an unknown root is a schema error, not a 500)
      const r = await validar(tipo.mnemonico, subtipoParam(v.input.tipoXml), '<desconhecido/>');
      assert.equal(r.status, 422, r.texto);
      assert.match(JSON.parse(r.texto).detail, /^Erro na validação do XML: Erro na linha 1, coluna 16: cvc-elt\.1\.a: /);
    });
  }
});

// ─── Generation: byte-exact output ───────────────────────────────────────────────────────────
describe('geração byte a byte (oráculo)', () => {
  const entrada = JSON.stringify(vetoresHttp({ endpoints: ['xml-generate'] })[0].vetor.input);
  /** SHA-256 and length of the bodies the oracle answers for entradas/xml/entrada.json. */
  const OURO = {
    nfe: ['7aeaa095225c6d3123558824c11eec88272a50f7a04a66653a6840a250c58600', 4148],
    nfce: ['cca84aff229832587b90c0f83e5745de202d28f430e86184516b484e8e68005b', 3971],
    cte: ['c8eb86db153ffb7d656be50f6c30d06be60210d374dac613c6bd064922d82bfb', 2286],
    'cte-simplificado': ['c8eb86db153ffb7d656be50f6c30d06be60210d374dac613c6bd064922d82bfb', 2286],
    bpe: ['6f981545f68440f3f69c035b6e475a6db6f07bb19ddc7a48a24bb72ec907ca74', 2286],
    'bpe-tm': ['e9a1428b0dd0e7b2ba5ab0fae75745747e0dc8b95350d0295cfc6dcecfbdda4c', 3462],
    nf3e: ['a1bca21c2dcbfd23f6393723fbab65014b5b7fb45cc674fff5c791496408d50c', 3718],
  };
  for (const [tipo, [hash, tamanho]] of Object.entries(OURO)) {
    test(`entrada.json → ${tipo}`, async () => {
      const r = await gerar(tipo, entrada);
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.headers['content-type'], 'application/xml;charset=UTF-8');
      assert.equal(r.headers['x-calc-app-version'], '1.7.2');
      assert.equal(r.headers['x-calc-db-version'], 'V0073');
      assert.equal(Buffer.byteLength(r.texto), tamanho);
      assert.equal(sha256(r.texto), hash);
    });
  }

  test('bordas: notação científica, padrões ZERO, escapes, inteiro truncado, competApur nunca sai', async () => {
    const roc = '{"oper":{"gCompraGov":{"tpEnteGov":4,"tpOperGov":"5"}},"objetos":[{"nObj":7,"tribCalc":{"IBSCBS":{"CST":"a<b&c","cClassTrib":"","indDoacao":1.9,"gIBSCBS":{"vBC":1e3,"gIBSUF":{},"vIBS":0.0000001,"gCBS":{"gDif":{}}},"gIBSCBSMono":{"gMonoPadrao":{}},"gAjusteCompet":{"competApur":"2026-01","vIBS":"1.5"}}}}],"total":{"tribCalc":{}}}';
    const esperado = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<infNFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <ide>
        <gCompraGov>
            <tpEnteGov>4</tpEnteGov>
            <pRedutor>0.00</pRedutor>
            <tpOperGov>5</tpOperGov>
        </gCompraGov>
    </ide>
    <det nItem="7">
        <imposto>
            <IBSCBS>
                <CST>a&lt;b&amp;c</CST>
                <cClassTrib></cClassTrib>
                <indDoacao>1</indDoacao>
                <gIBSCBS>
                    <vBC>1E+3</vBC>
                    <gIBSUF>
                        <pIBSUF>0</pIBSUF>
                        <vIBSUF>0</vIBSUF>
                    </gIBSUF>
                    <vIBS>1E-7</vIBS>
                    <gCBS>
                        <pCBS>0</pCBS>
                        <gDif>
                            <pDif>0</pDif>
                            <vDif>0</vDif>
                        </gDif>
                        <vCBS>0</vCBS>
                    </gCBS>
                </gIBSCBS>
                <gIBSCBSMono>
                    <gMonoPadrao>
                        <qBCMono>0</qBCMono>
                        <adRemIBS>0</adRemIBS>
                        <adRemCBS>0</adRemCBS>
                        <vIBSMono>0</vIBSMono>
                        <vCBSMono>0</vCBSMono>
                    </gMonoPadrao>
                    <vTotIBSMonoItem>0</vTotIBSMonoItem>
                    <vTotCBSMonoItem>0</vTotCBSMonoItem>
                </gIBSCBSMono>
                <gAjusteCompet>
                    <vIBS>1.5</vIBS>
                </gAjusteCompet>
            </IBSCBS>
        </imposto>
    </det>
    <total/>
</infNFe>
`;
    const r = await gerar('nfe', roc);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.texto, esperado);
  });

  test('tipo por equalsIgnoreCase (NF3E) e objeto mínimo', async () => {
    const r = await gerar('NF3E', '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.texto, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<infNF3e xmlns="http://www.portalfiscal.inf.br/nf3e">\n    <NFdet>\n        <det nItem="1">\n            <detItem>\n                <imposto/>\n            </detItem>\n        </det>\n    </NFdet>\n    <total/>\n</infNF3e>\n');
  });
});

// ─── Lists ────────────────────────────────────────────────────────────────────────────────────
describe('listas GET', () => {
  const BASE = '[{"nome":"NFe","mnemonico":"nfe","versaoNotaTecnica":"v1.36"},{"nome":"NFCe","mnemonico":"nfce","versaoNotaTecnica":"v1.36"},';
  const RESTO = '{"nome":"CTe","mnemonico":"cte","versaoNotaTecnica":"v1.14a"},{"nome":"CTe Simplificado","mnemonico":"cte-simplificado","versaoNotaTecnica":"v1.14a"},{"nome":"BPe","mnemonico":"bpe","versaoNotaTecnica":"v1.14a"},{"nome":"BPeTM","mnemonico":"bpe-tm","versaoNotaTecnica":"v1.14a"},{"nome":"NF3E","mnemonico":"nf3e","versaoNotaTecnica":"v1.14a"}]';
  test('GET generate', async () => {
    const r = await s.chamar(GERAR);
    assert.equal(r.status, 200);
    assert.equal(r.texto, BASE + RESTO);
  });
  test('GET validate (com NFSe)', async () => {
    const r = await s.chamar(VALIDAR);
    assert.equal(r.status, 200);
    assert.equal(r.texto, `${BASE}{"nome":"NFSe","mnemonico":"nfse","versaoNotaTecnica":"v1.01.03 - NT004"},${RESTO}`);
  });
});

// ─── Error envelopes (captured from the oracle) ──────────────────────────────────────────────
describe('erros (respostas do oráculo)', () => {
  const ROC = '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}';
  const ERRO_SISTEMA = (detail, caminho = GERAR, status = 500) => `{"detail":${JSON.stringify(detail)},"instance":"${caminho}","status":${status},"title":"Erro de sistema não previsto","type":"http://localhost/errors/erro-de-sistema-nao-previsto"}`;
  const casos = [
    [`${GERAR}?tipo=nfse`, 'application/json', ROC, 500, ERRO_SISTEMA('Tipo de documento não suportado: NFSE')],
    [`${GERAR}?tipo=xx`, 'application/json', ROC, 400, `{"detail":"Parâmetro inválido [tipo: xx] ","instance":"${GERAR}","status":400,"title":"Tipo de argumento inválido","type":"http://localhost/errors/tipo-argumento-invalido"}`],
    [GERAR, 'application/json', ROC, 400, `{"detail":"Required parameter 'tipo' is not present.","instance":"${GERAR}","status":400,"title":"Bad Request"}`],
    [`${GERAR}?tipo=nfe`, 'application/json', '{"objetos":[]}', 500, ERRO_SISTEMA('ROC deve conter ao menos um objeto')],
    [`${GERAR}?tipo=cte`, 'application/json', '{"objetos":[{"nObj":1},{"nObj":2}]}', 500, ERRO_SISTEMA('ROC deve conter um item')],
    [`${GERAR}?tipo=nfe`, 'application/json', '{"objetos":[null],"total":{"tribCalc":{}}}', 500, ERRO_SISTEMA('Cannot invoke "br.gov.serpro.rtc.api.model.roc.ObjetoDomain.getNObj()" because "r" is null')],
    [`${GERAR}?tipo=nfe`, 'application/json', '', 400, ERRO_SISTEMA('Required request body is missing: public org.springframework.http.ResponseEntity<java.lang.String> br.gov.serpro.rtc.api.controller.XMLController.generate(br.gov.serpro.rtc.api.model.roc.ROCDomain,br.gov.serpro.rtc.api.model.xml.enumeration.TipoDocumento)', GERAR, 400)],
    [`${GERAR}?tipo=nfe`, 'text/plain', ROC, 415, `{"detail":"Content-Type 'text/plain' is not supported.","instance":"${GERAR}","status":415,"title":"Unsupported Media Type"}`],
    [`${VALIDAR}?tipo=nfe`, 'application/xml', '<a/>', 400, `{"detail":"Required parameter 'subtipo' is not present.","instance":"${VALIDAR}","status":400,"title":"Bad Request"}`],
    [`${VALIDAR}?tipo=nfe&subtipo=grupo.xsd`, 'application/xml', '<a/>', 400, `{"detail":"Parâmetro inválido [subtipo: grupo.xsd] ","instance":"${VALIDAR}","status":400,"title":"Tipo de argumento inválido","type":"http://localhost/errors/tipo-argumento-invalido"}`],
  ];
  for (const [caminho, ct, corpo, status, esperado] of casos) {
    test(`${caminho} ${ct} ${corpo.slice(0, 40)}`, async () => {
      const r = await s.chamar(caminho, { method: 'POST', headers: { 'content-type': ct }, body: corpo });
      assert.equal(r.status, status, r.texto);
      assert.equal(r.headers['content-type'], 'application/problem+json');
      assert.equal(semTimestamp(r.texto), esperado);
    });
  }
});

// ─── Validation messages and JDK limits (texts of the oracle) ───────────────────────────────
describe('validação: mensagens do Xerces (pt_BR) e limites do JDK', () => {
  const risadas = `<!DOCTYPE infNFe [${Array.from({ length: 10 }, (_, k) => (k ? `<!ENTITY a${k} "${`&a${k - 1};`.repeat(10)}">` : '<!ENTITY a0 "x">')).join('')}]><infNFe ${NS_NFE}><det nItem="&a9;"/></infNFe>`;
  const casos = [
    ['nfe', 'abc', 'Erro na linha 1, coluna 1: O conteúdo não é permitido no prólogo.'],
    ['nfe', '<infNFe><det/></infNFe>', "Erro na linha 1, coluna 9: cvc-elt.1.a: Não foi possível encontrar a declaração do elemento 'infNFe'."],
    ['cte', '<infCte xmlns="http://www.portalfiscal.inf.br/cte"><foo/></infCte>', "Erro na linha 1, coluna 58: cvc-complex-type.2.4.a: Foi detectado um conteúdo inválido começando com o elemento '{\"http://www.portalfiscal.inf.br/cte\":foo}'. Era esperado um dos '{\"http://www.portalfiscal.inf.br/cte\":ide, \"http://www.portalfiscal.inf.br/cte\":imp}'."],
    ['nfe', risadas, 'Erro na linha 1, coluna 1: JAXP00010001: O parser detectou mais de "2500" expansões da entidade neste documento. Este é o limite imposto pelo JDK.'],
    ['nfe', `<!DOCTYPE infNFe [<!ENTITY e "&e;">]><infNFe ${NS_NFE}><det nItem="&e;"/></infNFe>`, 'Erro na linha 1, coluna 4: Referência da entidade recursiva "e". (Caminho de referência: e -> e -> e),'],
    ['nfe', `<?xml version="1.1"?>\n<infNFe ${NS_NFE}>\u0085<det nItem="1"/></infNFe>`, "Erro na linha 3, coluna 17: cvc-complex-type.2.4.b: O conteúdo do elemento 'det' não está completo. Era esperado um dos '{\"http://www.portalfiscal.inf.br/nfe\":imposto}'."],
    ['nfe', `<!DOCTYPE infNFe SYSTEM "http://127.0.0.1:9/x.dtd"><infNFe ${NS_NFE}/>`, "Erro na linha 1, coluna 52: DTD Externo: falha ao ler o DTD 'x.dtd' externo porque o acesso a 'http' não é permitido em decorrência de uma restrição definida pela propriedade accessExternalDTD."],
    ['nfe', `<!DOCTYPE infNFe [<!ENTITY e SYSTEM "file:///etc/passwd">]><infNFe ${NS_NFE}>&e;</infNFe>`, "Erro na linha 1, coluna 114: Entidade Externa: falha ao ler o documento 'passwd' externo porque o acesso a 'file' não é permitido em decorrência de uma restrição definida pela propriedade accessExternalDTD."],
    ['nfe', `<infNFe ${NS_NFE}${Array.from({ length: 201 }, (_, k) => ` a${k}="1"`).join('')}/>`, 'Erro na linha 1, coluna 1741: JAXP00010002: o elemento "infNFe" tem mais de "200" atributos. "200" é o limite imposto pelo JDK.'],
    ['nfe', `<!DOCTYPE infNFe [<!ENTITY e "<det nItem='1'>">]><infNFe ${NS_NFE}>&e;<imposto/></det></infNFe>`, 'Erro na linha 1, coluna 16: As estruturas do documento XML devem começar e terminar com a mesma entidade.'],
  ];
  for (const [tipo, corpo, detalhe] of casos) {
    test(`${tipo} ${corpo.slice(0, 60)}`, async () => {
      const inicio = Date.now();
      const r = await validar(tipo, 'grupo', corpo);
      assert.ok(Date.now() - inicio < 5000, 'responde rápido (sem expandir a bomba de entidades)');
      assert.equal(r.status, 422, r.texto);
      assert.equal(JSON.parse(r.texto).detail, `Erro na validação do XML: ${detalhe}`);
    });
  }

  test('corpo em UTF-16/UTF-32 decodificado como o JDK (BOM, big-endian por padrão)', async () => {
    const doc = `<infNFe ${NS_NFE}><det nItem="ç😀"/></infNFe>`;
    const le = Buffer.from(doc, 'utf16le');
    const be = Buffer.from(le).swap16();
    const utf32le = Buffer.from([...le].flatMap((_, k) => (k % 2 ? [] : [le[k], le[k + 1], 0, 0])));
    const esperado = "Erro na validação do XML: Erro na linha 1, coluna 70: cvc-complex-type.2.4.b: O conteúdo do elemento 'det' não está completo. Era esperado um dos '{\"http://www.portalfiscal.inf.br/nfe\":imposto}'.";
    for (const [charset, corpo] of [['UTF-16', Buffer.concat([Buffer.from([0xfe, 0xff]), be])], ['UTF-16', be], ['UTF-16', Buffer.concat([Buffer.from([0xff, 0xfe]), le])],
      ['UTF-32', Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), utf32le])], ['UTF-16LE', le]]) {
      const r = await validar('nfe', 'grupo', corpo, `application/xml;charset=${charset}`);
      assert.equal(r.status, 422, `${charset}: ${r.texto}`);
      assert.equal(JSON.parse(r.texto).detail, esperado, charset);
    }
  });

  test('profundidade acima de 100 dentro do xs:any skip da CTe (JAXP00010006)', () => {
    const cte = vetoresUnitarios('dados-unit', 'XmlUtil.getSchema+validate').find((v) => v.id === 'xml-01-09-valido-CTE-NOTA').input.xml;
    const aquav = cte.slice(cte.indexOf('<aquav>'), cte.indexOf('</aquav>') + 8);
    const r = validarDocumento(cte.replace(aquav, '<a>'.repeat(96) + '</a>'.repeat(96)), { mnemonico: 'cte' }, { mnemonico: 'nota.xsd' });
    assert.equal(r.mensagem, 'JAXP00010006: o elemento "a" tem uma profundidade de "101" que excede o limite de "100" definido por "jdk.xml.maxElementDepth".');
  });

  test('entidade recursiva em valor de atributo não estoura a memória', () => {
    const r = validarDocumento(`<!DOCTYPE infNFe [<!ENTITY e "a&f;"><!ENTITY f "&e;">]><infNFe ${NS_NFE}><det nItem="&e;"/></infNFe>`, { mnemonico: 'nfe' }, { mnemonico: 'grupo.xsd' });
    assert.match(r.mensagem, /^Referência da entidade recursiva "e"\. \(Caminho de referência: e -> f -> e\),$/);
  });
});
