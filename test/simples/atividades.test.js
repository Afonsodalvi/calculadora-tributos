// Official vectors of the Simples Nacional activity catalog (GET /api/calculadora/simples-nacional/atividades):
//  - HTTP vectors (AtividadeSimplesControllerTest) through the real server;
//  - unit vectors of AtividadeSimplesService (mocked repositories) and DerivacaoAnexosSimples.derivar;
//  - response headers of the Simples routes and GET /api/versao, against the oracle's values.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { subir, caminho } from '../lib/servidor.js';
import { check } from '../lib/jsonpath.js';
import { derivar, criarAtividadeSimplesService, ResponseStatusException, IllegalStateException } from '../../src/simples/rtc/atividades.js';

const { vectors } = JSON.parse(readFileSync(new URL('../fixtures/simples/official-vectors.json', import.meta.url)));
const s = await subir();
after(() => s.fechar());

/** check() plus the '[*]' convention "applies to every element" for scalar expectations. */
function verificar(status, json, chave, esperado) {
  if (chave.includes('[*]') && !esperado.startsWith('[') && !esperado.startsWith('<contains')) {
    const [antes] = chave.split('[*]');
    const n = (antes === '$' ? json : antes.replace(/^\$\.?/, '').split('.').reduce((o, k) => o?.[k], json))?.length ?? 0;
    if (n === 0) return `${chave}: lista vazia`;
    const falhas = [];
    for (let i = 0; i < n; i++) {
      const f = check(status, json, chave.replace('[*]', `[${i}]`), esperado);
      if (f) falhas.push(f);
    }
    return falhas.length ? falhas.join('; ') : null;
  }
  return check(status, json, chave, esperado);
}

for (const v of vectors.filter((x) => x.endpoint === 'atividades')) {
  test(`${v.id} via HTTP`, async () => {
    const r = await s.chamar(caminho(v.input.path, v.input.query), { method: v.input.method });
    const falhas = Object.entries(v.expected).map(([k, e]) => verificar(r.status, r.json, k, e)).filter(Boolean);
    assert.deepEqual(falhas, [], r.texto.slice(0, 800));
  });
}

// ── unit: AtividadeSimplesService (Teste_AtividadeSimplesService) ──
/** Builds the mocked collaborators described by a vector; counts calls for the "never called" checks. */
function servicoMock(mocks) {
  const chamadas = { contarTiposDfePorTipo: 0, classificacaoBuscarVigentes: 0 };
  const catalogo = (mocks['repository.buscarVigentes(2027-03-15)'] ?? []).map((a) => ({ anexoComFatorR: null, ...a }));
  const conhecidos = [55, 65, 91, 57]; // "1 if tpDoc in {55,65,91,57} else 0"
  const classif = Object.entries(mocks).filter(([k]) => k.startsWith('classificacaoRepository.buscarVigentes('));
  const efeitos = Object.entries(mocks).filter(([k]) => k.startsWith('parametroService.buscarTipoReceitaBruta('));
  const servico = criarAtividadeSimplesService({
    atividadeRepository: {
      buscarVigentes: () => catalogo,
      buscarVinculosTpDocVigentes: () => (mocks['repository.buscarVinculosTpDocVigentes(2027-03-15)'] ?? []).map(([atividadeId, tpDoc]) => ({ atividadeId, tpDoc })),
      contarTiposDfePorTipo: (tpDoc) => { chamadas.contarTiposDfePorTipo++; return conhecidos.includes(tpDoc) ? 1 : 0; },
    },
    classificacaoTributariaRepository: {
      buscarVigentes: (codigo) => { chamadas.classificacaoBuscarVigentes++; return classif.find(([k]) => k.includes(`'${codigo}'`))?.[1] ?? []; },
    },
    parametroService: {
      buscarTipoReceitaBruta: (tpRBSN) => {
        const e = efeitos.find(([k]) => k.startsWith(`parametroService.buscarTipoReceitaBruta(${tpRBSN},`))?.[1];
        return e == null || e === 'Optional.empty()' ? null : e;
      },
    },
  });
  return { servico, chamadas };
}
const texto = (v) => (v == null ? '<null>' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const valorEm = (o, caminhoChave) => caminhoChave.replace(/^\[(\d+)\]\.?/, '$1.').split('.').filter(Boolean).reduce((x, k) => x?.[k], o);

for (const v of vectors.filter((x) => x.endpoint === 'unit:AtividadeSimplesService.listar' || x.endpoint === 'unit:AtividadeSimplesService.buscarPorCodigo')) {
  test(v.id, () => {
    const i = v.input;
    const { servico, chamadas } = servicoMock(i.mocks ?? {});
    const data = { ano: 2027, mes: 3, dia: 15 };
    const anexos = i.anexosConfigurados == null ? null : new Set(i.anexosConfigurados);
    let resultado, erro;
    try {
      resultado = v.endpoint.endsWith('buscarPorCodigo')
        ? servico.buscarPorCodigo(i.codigo, data, i.tpDoc, i.cClassTrib)
        : servico.listar(data, anexos, i.tpDoc, i.cClassTrib);
    } catch (e) { erro = e; }
    const falhas = [];
    for (const [k, e] of Object.entries(v.expected)) {
      if (k === 'throws') { if (!(erro instanceof ResponseStatusException) || e !== 'ResponseStatusException') falhas.push(`throws ${erro?.constructor?.name}`); continue; }
      if (k === 'status') { if (String(erro?.status) !== e) falhas.push(`status ${erro?.status}`); continue; }
      if (k === 'calls') {
        if (/contarTiposDfePorTipo never called/.test(e) && chamadas.contarTiposDfePorTipo) falhas.push('contarTiposDfePorTipo called');
        if (/classificacaoRepository.buscarVigentes never called/.test(e) && chamadas.classificacaoBuscarVigentes) falhas.push('buscarVigentes called');
        continue;
      }
      const atual = texto(valorEm(resultado, k));
      if (atual !== e) falhas.push(`${k}: ${atual} != ${e}`);
    }
    assert.deepEqual(falhas, [], erro ? String(erro) : '');
  });
}

// ── unit: DerivacaoAnexosSimples.derivar ──
for (const v of vectors.filter((x) => x.endpoint === 'unit:DerivacaoAnexosSimples.derivar')) {
  test(v.id, () => {
    const i = v.input;
    if (v.expected.throws) {
      assert.throws(() => derivar(i.anexoSemFatorR, i.anexoComFatorR, i.anexosConfigurados), IllegalStateException);
      return;
    }
    const d = derivar(i.anexoSemFatorR, i.anexoComFatorR, i.anexosConfigurados == null ? null : new Set(i.anexosConfigurados));
    for (const [k, e] of Object.entries(v.expected)) assert.equal(texto(d[k]), e, k);
  });
}

// ── headers and /api/versao (values observed on the oracle, api-simples-nacional 1.0.2 offline) ──
const SPRING = { 'x-content-type-options': 'nosniff', 'x-xss-protection': '0', 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate', pragma: 'no-cache', expires: '0', 'x-frame-options': 'SAMEORIGIN' };
const VARY_200 = 'origin,access-control-request-method,access-control-request-headers,accept-encoding';
const VARY_ERRO = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'; // three headers, joined by the client

test('atividades 200: Spring security headers, versão e content-type', async () => {
  const r = await s.chamar('/api/calculadora/simples-nacional/atividades/09?data=2027-01-01');
  assert.equal(r.status, 200);
  for (const [k, v] of Object.entries(SPRING)) assert.equal(r.headers[k], v, k);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.vary, VARY_200);
  assert.equal(r.headers['x-calc-app-version'], '1.0.2');
  assert.match(r.headers['x-calc-db-version'], /^V\d{4}$/);
  assert.equal(r.texto, '{"codigo":"09","ordem":9,"descricao":"Prestação de serviços — Sujeitos ao Fator \\"R\\"","anexoSemFatorR":"V","anexoComFatorR":"III","sujeitaFatorR":true,"rotuloAnexo":"III ou V","rotuloCurtoAnexo":"III ou V","disponivel":true,"anexosFaltantes":[],"modoFatorR":"OPCIONAL","tpDocsAdmissiveis":["91"]}');
});

test('erros 200 sem headers de versão; 404 sem corpo; 400 sem codigo', async () => {
  const ok = await s.chamar('/api/calculadora/observabilidade/simples-nacional/erros?codigo=VSN-001');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-calc-app-version'], undefined);
  assert.equal(ok.headers.vary, VARY_200);
  const nf = await s.chamar('/api/calculadora/observabilidade/simples-nacional/erros?codigo=vsn-001');
  assert.equal(nf.status, 404);
  assert.equal(nf.texto, '');
  assert.equal(nf.headers.vary, VARY_ERRO);
  const sem = await s.chamar('/api/calculadora/observabilidade/simples-nacional/erros');
  assert.equal(sem.status, 400);
  assert.equal(sem.headers['content-type'], 'application/problem+json');
  assert.equal(sem.json.type, 'http://localhost/errors/parametro-obrigatorio-ausente');
  assert.deepEqual(sem.json.errors, [{ title: 'Parâmetro obrigatório ausente', pointer: '#/codigo', detail: "O parâmetro obrigatório 'codigo' (String) não foi informado." }]);
});

test('GET /api/versao (VersaoController) e Accept incompatível → 406', async () => {
  const r = await s.chamar('/api/versao');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-calc-app-version'], '1.0.2');
  assert.deepEqual(Object.keys(r.json), ['versaoApp', 'versaoDb', 'descricaoVersaoDb', 'dataVersaoDb', 'arquivoDb', 'ambiente']);
  assert.equal(r.json.ambiente, 'offline');
  assert.match(r.json.dataVersaoDb, /^\d{4}-\d{2}-\d{2}$/);
  const x = await s.chamar('/api/versao', { headers: { accept: 'application/xml' } });
  assert.equal(x.status, 406);
  assert.equal(x.texto, '{"type":"about:blank","title":"Not Acceptable","status":406,"detail":"Acceptable representations: [application/json].","instance":"/api/versao"}');
});

test('POST oficial: 415, corpo ausente, JSON malformado e tipo incompatível como o Spring/Jackson', async () => {
  const P = '/api/calculadora/observabilidade/simples-nacional';
  const t415 = await s.chamar(P, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(t415.status, 415);
  assert.equal(t415.headers.accept, 'application/json');
  assert.equal(t415.json.detail, "Content-Type 'text/plain' is not supported.");
  const vazio = await s.chamar(P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' });
  assert.equal(vazio.status, 400);
  assert.match(vazio.json.detail, /^Required request body is missing: public org\.springframework\.http\.ResponseEntity/);
  const mal = await s.chamar(P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1,}' });
  assert.equal(mal.status, 400);
  assert.equal(mal.json.title, 'Mensagem incompreensível');
  assert.equal(mal.json.detail, "JSON parse error: Unexpected character ('}' (code 125)): was expecting double-quote to start property name");
  const tipo = await s.chamar(P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"itens":[{"numero":"abc"}]}' });
  assert.equal(tipo.json.detail, 'JSON parse error: Cannot deserialize value of type `java.lang.Integer` from String "abc": not a valid `java.lang.Integer` value');
  const resto = await s.chamar(P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{} x' });
  assert.equal(resto.status, 422); // Jackson ignores trailing tokens
});
