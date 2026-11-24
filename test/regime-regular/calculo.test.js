// Calculation slice of the regime-regular port (POST /calculadora/regime-geral,
// POST /calculadora/observabilidade/regime-geral, GET /calculadora/observabilidade/erros):
//  - every official HTTP vector of these endpoints through the real HTTP server;
//  - the official unit vectors of CalculadoraService, ObservabilidadeService, ProcessamentoItemService,
//    the input model (Jackson binding, getFatoGeradorAplicavel, ajustarNcm, getValor), AvisoDadosSimulados,
//    the totals (IBSCBSTotalDomain, accumulators), ObjetoDomain/TributosDomain helpers, GlobalCollector,
//    the nomenclature services (NcmAplicavel/NbsAplicavel/ValidacaoNomenclatura) and the constructor
//    messages of the pipeline's exceptions;
//  - the Bean Validation messages / request locale (checked against Tomcat 11 + JDK 25 + HV 9.1.5);
//  - a live differential against the official API, opt-in (ORACULO_URL, e.g. http://127.0.0.1:8080),
//    including the Java non-determinism normalized (multiset / set membership) and the rounding batch.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Dec } from '../../src/core/decimal.js';
import { lerJsonTexto, escreverJson, JsonObj, JsonNum } from '../../src/regime-regular/comum/json.js';
import { abrirBanco } from '../../src/core/db.js';
import { fileURLToPath } from 'node:url';
import { verificarChave, lerResposta } from '../lib/jsonpath-regreg.js';
import {
  vincularOperacao, vincularItem, fatoGeradorAplicavel, ajustarNcm, possuiComponentes, valorComponente,
} from '../../src/regime-regular/calculo/entrada.js';
import {
  validar, interpolar, localeDaRequisicao, cadeiaDePacotes, lerAcceptLanguage,
} from '../../src/regime-regular/calculo/validacao.js';
import {
  criarProcessamento, avisoDadosSimulados, ItemCollector, GlobalCollector, compararObjetos, objetosIguais, detalheValidacao,
} from '../../src/regime-regular/calculo/processamento.js';
import {
  rocJson, observabilidadeJson, ibsCbsTotal, objeto,
  CBSTotalAccumulator, IBSUFTotalAccumulator, IBSMunTotalAccumulator, MonofasiaTotalAccumulator, EstornoCreditoAccumulator,
} from '../../src/regime-regular/calculo/roc.js';
import { calcularBaseUnificada, siglaPorNormalizada, criarServicos } from '../../src/regime-regular/calculo/servicos.js';
import * as E from '../../src/regime-regular/calculo/excecoes.js';

const ENDPOINTS = ['regime-geral', 'observabilidade', 'observabilidade-regime-geral', 'erros'];
// opt-in: `npm test` must not depend on whatever happens to listen on :8080
const ORACULO = process.env.ORACULO_URL;

// test/lib/vetores.js and servidor.js load the whole app; a slice still being written by another
// agent must not hide the unit results of this one, so they are imported defensively.
const raiz = fileURLToPath(new URL('../../', import.meta.url));
let libVetores = null;
let erroApp = null;
try { libVetores = await import('../lib/vetores.js'); } catch (e) { erroApp = e; }
const FIXTURES = fileURLToPath(new URL('../fixtures/regime-regular/', import.meta.url));
const ARQUIVOS = { calculo: 'vectors-calculo.json', validacao: 'vectors-validacao.json', 'dados-unit': 'vectors-dados-unit.json' };
const cacheVetores = new Map();
const carregarVetores = (a) => { if (!cacheVetores.has(a)) cacheVetores.set(a, JSON.parse(readFileSync(FIXTURES + ARQUIVOS[a], 'utf8'))); return cacheVetores.get(a); };
const vetoresUnitarios = (arquivo, prefixo) => carregarVetores(arquivo).vectors.filter((v) => String(v.endpoint).startsWith(`unit:${prefixo}`));
const vetoresHttp = ({ endpoints }) => Object.keys(ARQUIVOS).flatMap((a) => carregarVetores(a).vectors.filter((v) => endpoints.includes(v.endpoint)).map((vetor) => ({ arquivo: a, vetor })));

const base = abrirBanco(`${raiz}data/calculadora-pro.db`);
const proc = criarProcessamento(base);
after(() => base.close());

// ─── helpers ───────────────────────────────────────────────────────────────────

/** JSON tree of a unit vector's input (inputRaw keeps number lexemes), optionally a top-level key. */
function noDe(v, chave) {
  const no = lerJsonTexto(v.inputRaw ?? JSON.stringify(v.input ?? {}));
  if (chave && no instanceof JsonObj && no.has(chave)) return no.get(chave);
  return no;
}
const operacaoDe = (v) => vincularOperacao(noDe(v, 'operacao'));
const nomeClasse = (t) => String(t).replace(/^.*\./, '');
const dec = (x) => (x == null ? null : x instanceof Dec ? x : Dec.parse(String(x)));

/** Dotted path over plain domain objects ('gIBS.gIBSUF.vDif', 'itens[0].baseCalculo'). */
function caminho(obj, p) {
  let c = obj;
  for (const parte of p.split('.')) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(parte);
    c = c?.[m[1]];
    for (const [, i] of m[2].matchAll(/\[(\d+)\]/g)) c = c?.[Number(i)];
  }
  return c;
}

/** Compares a domain value with an expected unit-vector string (compareTo for BigDecimal). */
function conferirValor(atual, esperado, rotulo) {
  if (esperado === '<null>') return assert.equal(atual ?? null, null, rotulo);
  if (esperado === '<present>') return assert.ok(atual != null, `${rotulo} ausente`);
  if (esperado === '<nonempty>') return assert.ok(Array.isArray(atual) && atual.length > 0, `${rotulo} vazio`);
  const contem = /^<contains:(.*)>$/s.exec(esperado);
  if (contem) return assert.ok(String(atual).includes(contem[1]), `${rotulo} = ${atual} não contém ${contem[1]}`);
  if (atual instanceof Dec) return assert.equal(atual.compareTo(dec(esperado)), 0, `${rotulo} = ${atual.toJavaString()} != ${esperado}`);
  if (Array.isArray(atual)) return assert.equal(JSON.stringify(atual), esperado, rotulo);
  return assert.equal(String(atual), esperado, rotulo);
}

/** Response-like object over a JSON text, for verificarChave. */
const respostaDe = (texto) => ({ status: 200, headers: {}, texto, json: lerResposta(texto) });

/** The engine's tribCalc serializer (what the routes use). */
const serializador = () => {
  const m = proc.obterMotor();
  return (t) => m.serializarTributos(t);
};

/** Checks the '$…' keys of a unit vector against a serialized domain object. */
function conferirCaminhos(v, texto, falhas) {
  const resp = respostaDe(texto);
  for (const [k, e] of Object.entries(v.expected)) {
    if (!k.startsWith('$')) continue;
    const r = verificarChave(resp, k, e, { regraTexto: 'texto', tipos: v.expectedTypes });
    if (r && typeof r !== 'object') falhas.push(r);
  }
}

// ─── HTTP vectors (real server) ──────────────────────────────────────────────────

describe('vetores HTTP oficiais (regime-geral, observabilidade, erros)', () => {
  let s;
  before(async () => {
    if (erroApp) throw erroApp; // the app (some slice) does not load: every HTTP vector fails with this cause
    const { subir } = await import('../lib/servidor.js');
    s = await subir();
  });
  after(() => s?.fechar());
  const lista = vetoresHttp({ endpoints: ENDPOINTS });
  test('há vetores das quatro famílias', () => {
    assert.ok(lista.length >= 180, `${lista.length} vetores`);
    for (const ep of ENDPOINTS) assert.ok(lista.some((x) => x.vetor.endpoint === ep), ep);
  });
  for (const item of lista) {
    const v = item.vetor;
    test(`${item.arquivo}:${v.id}`, { skip: v.disabled && 'desativado no upstream (@Disabled)' }, async () => {
      const r = await libVetores.executarVetor(s, item);
      assert.deepEqual(r.falhas, [], r.resumo);
    });
  }
});

// ─── CalculadoraService / ObservabilidadeService (unit vectors) ──────────────────────

const unitarios = (prefixo) => ['calculo', 'validacao', 'dados-unit'].flatMap((a) => vetoresUnitarios(a, prefixo).map((v) => ({ arquivo: a, v })));

describe('CalculadoraService.calcularTributos (vetores unitários)', () => {
  for (const { arquivo, v } of unitarios('CalculadoraService.calcularTributos')) {
    if (v.endpoint !== 'unit:CalculadoraService.calcularTributos') continue;
    test(`${arquivo}:${v.id}`, { skip: v.disabled && 'desativado no upstream (@Disabled)' }, async () => {
      const e = v.expected;
      let roc;
      let erro;
      try { roc = await proc.calcularTributos(operacaoDe(v)); } catch (x) { erro = x; }
      if (e.throws) {
        assert.ok(erro, `esperava ${e.throws}`);
        if (!String(e.throws).startsWith('<any')) assert.equal(erro.classeJava, nomeClasse(e.throws), erro.message);
        return;
      }
      if (erro) throw erro;
      if (e.result === '<present>') assert.ok(roc);
      const falhas = [];
      conferirCaminhos(v, escreverJson(rocJson(roc, serializador())), falhas);
      assert.deepEqual(falhas, []);
    });
  }
});

describe('ObservabilidadeService.processarOperacao (vetores unitários)', () => {
  for (const { arquivo, v } of unitarios('ObservabilidadeService.processarOperacao')) {
    test(`${arquivo}:${v.id}`, { skip: v.disabled && 'desativado no upstream (@Disabled)' }, async () => {
      const e = v.expected;
      const no = noDe(v);
      const baseURL = no instanceof JsonObj ? (no.get('baseURL') ?? no.get('baseUrl') ?? 'http://localhost') : 'http://localhost';
      let roc;
      let erro;
      try { roc = await proc.processarOperacao(operacaoDe(v), baseURL); } catch (x) { erro = x; }
      const falhas = [];
      if (e.throws) {
        assert.ok(erro, `esperava ${e.throws}`);
        if (!String(e.throws).startsWith('<any')) assert.equal(erro.classeJava, nomeClasse(e.throws), erro.message);
        if (erro.erros) conferirCaminhos(v, escreverJson({ erros: erro.erros }), falhas);
        return assert.deepEqual(falhas, []);
      }
      if (erro) throw erro;
      conferirCaminhos(v, escreverJson(observabilidadeJson(roc, serializador())), falhas);
      assert.deepEqual(falhas, []);
    });
  }
});

describe('CalculadoraService + serialização não altera números (lote de arredondamento)', () => {
  const [v] = unitarios('CalculadoraService.calcularTributos+serializacao').map((x) => x.v);
  test(v.id, async () => {
    const linhas = readFileSync(new URL(`../fixtures/regime-regular/${v.corpus.file}`, import.meta.url), 'utf8').split('\n').filter(Boolean).slice(0, v.corpus.notas);
    const ser = serializador();
    let comparados = 0;
    const diferencas = [];
    const andar = (dom, json, onde) => {
      if (dom == null || json == null) return;
      if (dom instanceof Dec) {
        const t = json instanceof JsonNum ? json.src : typeof json === 'string' ? json : null;
        if (t == null) return;
        comparados++;
        if (Dec.parse(t).compareTo(dom) !== 0) diferencas.push(`${onde}: ${dom.toJavaString()} → ${t}`);
        return;
      }
      if (Array.isArray(dom)) { if (Array.isArray(json)) dom.forEach((x, i) => andar(x, json[i], `${onde}[${i}]`)); return; }
      if (typeof dom === 'object' && typeof json === 'object' && !Array.isArray(json)) for (const [k, x] of Object.entries(dom)) andar(x, json[k], `${onde}.${k}`);
    };
    for (const l of linhas) {
      const { corpo, indice } = JSON.parse(l);
      const roc = await proc.calcularTributos(vincularOperacao(lerJsonTexto(corpo)));
      andar(roc, lerResposta(escreverJson(rocJson(roc, ser))), `nota ${indice}`);
    }
    assert.ok(comparados > 3000, `${comparados} números comparados`);
    assert.deepEqual(diferencas.slice(0, 10), []);
  });
});

// ─── ProcessamentoItemService (unit vectors) ─────────────────────────────────────────

function conferirExcecao(erro, esperado, mensagem) {
  if (esperado === '<none>' || esperado === undefined) { if (erro) throw erro; return; }
  assert.ok(erro, `esperava ${esperado}`);
  if (!String(esperado).startsWith('<any')) assert.equal(erro.classeJava, nomeClasse(esperado), erro.message);
  if (mensagem) {
    const m = /^<contains:(.*)>$/s.exec(mensagem);
    if (m) assert.ok(String(erro.mensagem).includes(m[1]), erro.mensagem); else assert.equal(erro.mensagem, mensagem);
  }
}

describe('ProcessamentoItemService (vetores unitários)', () => {
  for (const { arquivo, v } of unitarios('ProcessamentoItemService.')) {
    test(`${arquivo}:${v.id}`, () => {
      const e = v.expected;
      let item;
      let erro;
      try {
        if (v.endpoint.endsWith('validarQuantidadeEUnidade')) {
          const i = v.input.item;
          item = { quantidade: dec(i.quantidade), unidade: i.unidade ?? null, impostoSeletivo: i.impostoSeletivo ? { quantidade: dec(i.impostoSeletivo.quantidade), unidade: i.impostoSeletivo.unidade ?? null } : null };
          const a = v.input.aliquota;
          proc.validarQuantidadeEUnidade(item, { aliquotaAdValorem: dec(a.aliquotaAdValorem), aliquotaAdRem: dec(a.aliquotaAdRem), unidadeMedida: a.unidadeMedida ?? null });
        } else if (v.endpoint.endsWith('validarBaseCalculoComComponentes')) {
          const operacao = vincularOperacao(noDe(v, 'operacao'));
          // "<new BaseCalculoUnificadaService().calcular(comp, …).getBaseIS()>": the declared IS base is the service's own exact value
          const entrada = structuredClone(v.input.item);
          const marcador = /^<new BaseCalculoUnificadaService\(\)\.calcular\(comp, (\d+), (\w+), (\d+)\)\.getBase(IS|RG)\(\)>$/.exec(entrada.impostoSeletivo?.baseCalculo ?? '');
          if (marcador) entrada.impostoSeletivo.baseCalculo = null;
          item = vincularItem(lerJsonTexto(JSON.stringify(entrada)));
          if (marcador) {
            const r = calcularBaseUnificada(item.gComponentesBC, Number(marcador[1]), marcador[2], Number(marcador[3]));
            item.impostoSeletivo.baseCalculo = marcador[4] === 'IS' ? r.baseIS : r.baseRG;
          }
          proc.validarBaseCalculoComComponentes(operacao, item, item.gComponentesBC);
        } else {
          item = vincularItem(noDe(v, 'item'));
          proc.validarBaseCalculoLegado(item);
        }
      } catch (x) { erro = x; }
      conferirExcecao(erro, e.throws, e.message);
      for (const [k, esperado] of Object.entries(e)) {
        if (!k.startsWith('item.')) continue;
        conferirValor(caminho({ item }, k.replace(/#\w+$/, '')), esperado, k);
      }
    });
  }
});

// ─── Nomenclature services (NcmAplicavel / NbsAplicavel / ValidacaoNomenclatura, unit vectors) ─────

describe('serviços de nomenclatura do pipeline (vetores unitários)', () => {
  const S = proc.servicos;
  const CHAMADAS = {
    'ncmAplicavelRepository.temNcmAplicavel': (ncm, id, data) => S.consultas.temNcmAplicavel(ncm, id, data),
    'ncmAplicavelRepository.temExcecaoNcmAplicavel': (ncm, id, data) => S.consultas.temExcecaoNcmAplicavel(ncm, id, data),
    'ncmAplicavelRepository.temNcmAplicavelSemExcecao': (ncm, id, data) => S.consultas.temNcmAplicavelSemExcecao(ncm, id, data),
    'ncmAplicavelService.criticarNcmContraAnexo': (ncm, id, codigo, data, tributos) => S.ncmAplicavelService.criticarContraAnexo(ncm, id, codigo, data, tributos),
  };
  /** { result } or { erro } of a call. */
  const executar = (f) => { try { return { result: f() }; } catch (erro) { if (!erro?.classeJava) throw erro; return { erro }; } };
  const conferir = (r, chave, esperado) => {
    if (chave.endsWith('throws')) return assert.equal(r.erro?.classeJava, esperado, `${chave}: ${r.erro?.mensagem ?? 'sem exceção'}`);
    if (chave.endsWith('doesNotThrow')) return assert.equal(r.erro, undefined, `${chave}: ${r.erro?.mensagem}`);
    assert.equal(String(r.result), esperado, chave);
  };
  for (const { v } of unitarios('')) {
    const ep = v.endpoint.slice('unit:'.length);
    if (!/^(NcmAplicavelRepository|NbsAplicavelRepository|NcmAplicavelService\.criticarNcmContraAnexo|ValidacaoNomenclaturaService\.validar)/.test(ep)) continue;
    test(`${ep} ${v.id}`, () => {
      const i = v.input;
      if (ep === 'ValidacaoNomenclaturaService.validar') {
        const r = executar(() => S.validacaoNomenclaturaService.validar(siglaPorNormalizada(i.siglaDfe), i.idClassificacao, i.codigoClassificacao, i.ncm, i.nbs, i.data, i.tributos, i.modo));
        for (const [k, e] of Object.entries(v.expected)) conferir(r, k, e);
      } else if (ep === 'NcmAplicavelService.criticarNcmContraAnexo') {
        const r = executar(() => S.ncmAplicavelService.criticarContraAnexo(i.ncm, i.idClassificacao, i.codigoClassificacao, i.data, i.tributos));
        for (const [k, e] of Object.entries(v.expected)) conferir(r, k, e);
      } else if (ep.endsWith('.tem')) {
        const tem = ep.startsWith('Ncm') ? S.consultas.ncmTem : S.consultas.nbsTem;
        i.calls.forEach((c, n) => conferir(executar(() => tem(c.idClassificacao, c.data)), 'result', v.expected[`calls[${n}].result`]));
      } else {
        const r = i.calls.map((c) => executar(() => CHAMADAS[c.call](...c.args)));
        for (const [k, e] of Object.entries(v.expected)) conferir(r[Number(/^calls\[(\d+)\]/.exec(k)[1])], k, e);
      }
    });
  }
});

describe('NcmService / NcmAplicavelService / NbsAplicavelService do pipeline com repositórios simulados (vetores unitários)', () => {
  for (const { v } of unitarios('')) {
    const ep = v.endpoint.slice('unit:'.length);
    if (!/^(NcmService\.existeNcm|NcmAplicavelService\.validarNcmAplicavel|NbsAplicavelService\.validarNbsAplicavel)$/.test(ep)) continue;
    test(`${ep} ${v.id}`, () => {
      const m = v.input.mocks;
      const chamadas = [];
      const consultas = {
        existeNcm: (ncm, d) => { chamadas.push(`repository.existeNcm('${ncm}', ${d})`); return m['repository.existeNcm']; },
        ncmTem: () => m.tem, temNcmAplicavel: () => m.temNcmAplicavel ?? false, temExcecaoNcmAplicavel: () => m.temExcecaoNcmAplicavel ?? false,
        temNcmAplicavelSemExcecao: () => m.temNcmAplicavelSemExcecao ?? false,
        nbsTem: () => m.tem, temNbsAplicavel: () => m.temNbsAplicavel ?? false, temExcecaoNbsAplicavel: () => m.temExcecaoNbsAplicavel ?? false,
        temNbsAplicavelSemExcecao: () => m.temNbsAplicavelSemExcecao ?? false,
      };
      const S = criarServicos(null, { consultas });
      const i = v.input;
      if (ep === 'NcmService.existeNcm') {
        assert.equal(String(S.ncmService.existeNcm(i.ncm, i.data)), v.expected.result);
        assert.deepEqual(chamadas, [v.expected.calls]);
        return;
      }
      const servico = ep.startsWith('Ncm') ? S.ncmAplicavelService : S.nbsAplicavelService;
      const chamar = () => servico.validar(i.ncm ?? i.nbs ?? null, i.idClassificacaoTributaria, i.codigoClassificacaoTributaria, i.data, i.tributos);
      if (v.expected.throws === '<none>') assert.equal(chamar(), true);
      else assert.throws(chamar, (e) => e.classeJava === v.expected.throws);
    });
  }
});

// ─── Exceptions of the pipeline (constructor messages, unit vectors) ─────────────────────────

describe('exceções do pipeline: mensagens dos construtores (vetores unitários)', () => {
  /** Java constructor → port factory (same argument order as the constructor). The engine's are in motor.test.js. */
  const FABRICAS = {
    NcmNaoVinculadaException: E.ncmNaoVinculada, NbsNaoVinculadaException: E.nbsNaoVinculada,
    AliquotaAdRemNaoEncontradaException: E.aliquotaAdRemNaoEncontrada, SituacaoTributariaNaoEncontradaException: E.situacaoTributariaNaoEncontrada,
    ClassificacaoTributariaNaoEncontradaException: E.classificacaoTributariaNaoEncontrada, NomenclaturaException: E.nomenclatura,
    IncompatibilidadeSuspensaoException: E.incompatibilidadeSuspensao, TratamentoClassificacaoNaoEncontradoException: E.tratamentoClassificacaoNaoEncontrado,
    ImpostoSeletivoNaoInformadoException: E.impostoSeletivoNaoInformado, ImpostoSeletivoInformadoIndevidamenteException: E.impostoSeletivoInformadoIndevidamente,
    ImpostoSeletivoNaoAdmitidoTipoDfeException: E.impostoSeletivoNaoAdmitidoTipoDfe, NcmNaoEncontradaException: E.ncmNaoEncontrada,
    NbsNaoEncontradaException: E.nbsNaoEncontrada, TributacaoRegularNaoInformadaException: E.tributacaoRegularNaoInformada,
    TributacaoRegularInformadaIndevidamenteException: E.tributacaoRegularInformadaIndevidamente, MunicipioNaoPertencenteException: E.municipioNaoPertencente,
    UfNaoEncontradaException: E.ufNaoEncontrada, MunicipioNaoEncontradoException: E.municipioNaoEncontrado, ErroInternoSistemaException: E.erroInternoSistema,
    NcmNbsSimultaneasException: E.ncmNbsSimultaneas, NcmCompletoNaoInformadoException: E.ncmCompletoNaoInformado, NbsCompletoNaoInformadoException: E.nbsCompletoNaoInformado,
    CampoInvalidoException: E.campoInvalido, TipoDfeNaoEncontradoException: E.tipoDfeNaoEncontrado,
    ClassificacaoTributariaNaoVinculadaTipoDfeException: E.classificacaoNaoVinculadaTipoDfe, ClassificacaoTributariaNaoVinculadaSituacaoTributariaException: E.classificacaoNaoVinculadaSituacao,
    NomenclaturaIncompativelTipoDfeException: E.nomenclaturaIncompativelTipoDfe, NomenclaturaNaoPermitidaTipoDfeException: E.nomenclaturaNaoPermitidaTipoDfe,
    NomenclaturaObrigatoriaNaoInformadaException: E.nomenclaturaObrigatoriaNaoInformada,
  };
  const hoje = '2026-11-24';
  const vetores = unitarios('').filter(({ v }) => /<init>$/.test(v.endpoint) && FABRICAS[v.endpoint.slice(5, -7)]);
  test('há vetores para todas as fábricas', () => assert.equal(new Set(vetores.map(({ v }) => v.endpoint)).size, Object.keys(FABRICAS).length));
  for (const { v } of vetores) {
    test(`${v.endpoint.slice(5)} ${v.id}`, () => {
      const classe = v.endpoint.slice(5, -7);
      const e = FABRICAS[classe](...v.input.args.map((x) => (x === '<today>' ? hoje : x)));
      assert.equal(e.classeJava, v.expected.throws);
      assert.equal(e.mensagem, v.expected.derivedMessage.replaceAll('<today>', hoje));
    });
  }
  test('mensagens sem argumentos e com BigDecimal (texto do Java)', () => {
    assert.equal(E.baseCalculoNaoInformada().mensagem, 'A base de cálculo de CBS e IBS deve ser informada quando o grupo do Imposto Seletivo não é informado');
    assert.equal(E.dataFatoGeradorNaoInformada().mensagem, 'A data do fato gerador não foi informada.');
    assert.equal(E.baseCalculoInconsistente(Dec.parse('200.00'), Dec.parse('188.0'), Dec.parse('1E+1')).mensagem,
      'A base de cálculo de CBS e IBS informada 200.00 difere da soma da base de cálculo do Imposto Seletivo 188.0 com o Imposto Seletivo informado 1E+1');
    assert.equal(E.baseCalculoComponentesInconsistente(Dec.parse('950'), Dec.parse('770.125')).mensagem,
      'A base de cálculo declarada (950.00) diverge da base calculada a partir dos componentes informados (770.125)');
  });
});

// ─── Input model ───────────────────────────────────────────────────────────────────

describe('modelo de entrada (vetores unitários)', () => {
  for (const { v } of unitarios('Jackson.readValue(OperacaoInput)')) {
    test(v.id, () => {
      const op = vincularOperacao(noDe(v));
      for (const [k, esperado] of Object.entries(v.expected)) {
        let atual;
        if (k === 'itens.length()') atual = String(op.itens.length);
        else if (k.endsWith('.possuiComponentes()')) atual = String(possuiComponentes(caminho(op, k.slice(0, -'.possuiComponentes()'.length))));
        // Jackson round trip of the item keeps the BigDecimal (written as a number, read back exactly)
        else if (k.startsWith('roundtrip(')) atual = vincularItem(lerJsonTexto(escreverJson(op.itens[0]))).baseCalculo;
        else atual = caminho(op, k);
        conferirValor(atual, esperado, k);
      }
    });
  }
  for (const { v } of unitarios('OperacaoInput.getFatoGeradorAplicavel')) {
    test(v.id, () => {
      const op = { dhFatoGerador: v.input.dhFatoGerador ?? null, dataHoraEmissao: v.input.dataHoraEmissao ?? null };
      let r;
      let erro;
      try { r = fatoGeradorAplicavel(op); } catch (x) { erro = x; }
      if (v.expected.throws) return conferirExcecao(erro, v.expected.throws);
      assert.equal(r, v.expected.result);
    });
  }
  for (const { v } of unitarios('ItemOperacaoInput.ajustarNcm')) {
    test(v.id, () => {
      const item = { ncm: v.input.ncm };
      ajustarNcm(item, v.input.tipoDfe);
      conferirValor(item.ncm, v.expected['item.ncm'], 'item.ncm');
    });
  }
  for (const { v } of unitarios('ComponentesBaseCalculoInput.getValor')) {
    test(v.id, () => {
      const c = vincularOperacao(lerJsonTexto(escreverJson({ id: 'x', itens: [{ gComponentesBC: v.input.componentes }] }))).itens[0].gComponentesBC;
      for (const [k, esperado] of Object.entries(v.expected)) {
        const elemento = k === 'result' ? v.input.elemento : /^getValor\((\w+)\)$/.exec(k)[1];
        conferirValor(valorComponente(c, elemento), esperado, k);
      }
    });
  }
  for (const { v } of unitarios('BaseCalculoUnificadaService.calcular')) {
    if (v.endpoint !== 'unit:BaseCalculoUnificadaService.calcular') continue;
    test(`(auxiliar local) ${v.id}`, () => {
      const c = vincularOperacao(lerJsonTexto(escreverJson({ itens: [{ gComponentesBC: v.input.componentes }] }))).itens[0].gComponentesBC;
      let r;
      let erro;
      try { r = calcularBaseUnificada(c, v.input.ano, v.input.natureza ?? null, v.input.tpDoc ?? null); } catch (x) { erro = x; }
      if (v.expected.throws) return conferirExcecao(erro, v.expected.throws, v.expected.message);
      if (erro) throw erro;
      for (const [k, esperado] of Object.entries(v.expected)) conferirValor(caminho({ result: r }, k), esperado, k);
    });
  }
});

// ─── AvisoDadosSimuladosService ────────────────────────────────────────────────────────

describe('AvisoDadosSimuladosService (vetores unitários)', () => {
  for (const { v } of unitarios('AvisoDadosSimuladosService.getWarningDadosSimulados')) {
    test(v.id, () => {
      const aviso = avisoDadosSimulados(vincularOperacao(noDe(v)));
      if (v.expected.result === '<null>') return assert.equal(aviso, null);
      assert.equal(aviso.nome, v.expected.result);
      assert.equal(String(aviso.valor), v.expected['result.valor']);
    });
  }
});

// ─── Totals, accumulators, domain helpers, GlobalCollector ─────────────────────────────

/** Plain JSON (vector) → domain object with Dec values (text fields kept as strings). */
const TEXTOS = new Set(['CST', 'cClassTrib', 'CSTIS', 'cClassTribIS', 'uTrib', 'memoriaCalculo', 'competApur', 'CSTReg', 'cClassTribReg', 'cbs', 'ibsUF', 'ibsMun']);
function paraDominio(x, chave) {
  if (x == null) return x;
  if (Array.isArray(x)) return x.map((y) => paraDominio(y, chave));
  if (typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, paraDominio(y, k)]));
  if (typeof x === 'string' && !TEXTOS.has(chave) && /^-?\d+(\.\d+)?$/.test(x)) return Dec.parse(x);
  return x;
}

describe('totais e acumuladores (vetores unitários)', () => {
  for (const { v } of unitarios('IBSCBSTotalDomain.create')) {
    test(v.id, () => {
      const total = ibsCbsTotal(paraDominio(v.input.detalhes));
      for (const [k, esperado] of Object.entries(v.expected)) conferirValor(k === 'result' ? total : caminho(total, k), esperado, k);
    });
  }
  const classes = {
    CBSTotalAccumulator: { C: CBSTotalAccumulator, from: (f) => (Array.isArray(f) ? CBSTotalAccumulator.from(null, null) : CBSTotalAccumulator.from(paraDominio(f.cbs), paraDominio(f.cred))) },
    IBSUFTotalAccumulator: { C: IBSUFTotalAccumulator, from: (f) => IBSUFTotalAccumulator.from(Array.isArray(f) ? null : paraDominio(f.ibsUf)) },
    IBSMunTotalAccumulator: { C: IBSMunTotalAccumulator, from: (f) => IBSMunTotalAccumulator.from(Array.isArray(f) ? null : paraDominio(f.ibsMun)) },
    MonofasiaTotalAccumulator: { C: MonofasiaTotalAccumulator, from: (f) => MonofasiaTotalAccumulator.from(Array.isArray(f) ? null : paraDominio(f.m)) },
    EstornoCreditoAccumulator: { C: EstornoCreditoAccumulator, from: (f) => EstornoCreditoAccumulator.from(f == null ? null : paraDominio(f)) },
  };
  for (const [nome, { C, from }] of Object.entries(classes)) {
    for (const { v } of unitarios(nome)) {
      test(`${nome} ${v.id}`, () => {
        const construir = (inp) => ('from' in inp ? from(inp.from) : new C(...(inp.ctor ?? []).map(dec)));
        let acc = construir(v.input);
        if ('add' in v.input) acc = acc.add(v.input.add == null ? null : construir(v.input.add));
        const fim = nome === 'EstornoCreditoAccumulator' ? { total: acc.toEstornoCreditoDomainTotal() } : acc;
        for (const [k, esperado] of Object.entries(v.expected)) conferirValor(caminho(fim, k), esperado, k);
      });
    }
  }

  // ObjetoDomain / TributosDomain: the vectors describe Java builder calls; their equivalent domain trees
  const ZERO = Dec.ZERO;
  const CONSTRUCOES = {
    'ObjetoDomain.builder().nObj(1).build()': { nObj: 1, tribCalc: null },
    'ObjetoDomain.builder().nObj(1).tribCalc(TributosDomain{IS: ImpostoSeletivoDomain{vIS: 50}, IBSCBS: IBSCBSDomain{gIBSCBS: GrupoIBSCBSDomain{gCBS: new CBSDomain()}}}).build()':
      { nObj: 1, tribCalc: { IS: { vIS: Dec.of('50') }, IBSCBS: { gIBSCBS: { gCBS: { pCBS: ZERO, vCBS: ZERO } } } } },
    'TributosDomain.builder().build()': { tribCalc: {} },
    'TributosDomain.builder().IS(ImpostoSeletivoDomain{vIS: 100}).build()': { tribCalc: { IS: { vIS: Dec.of('100') } } },
    'TributosDomain.builder().IBSCBS(IBSCBSDomain{gIBSCBS: GrupoIBSCBSDomain{gCBS, gIBSUF, gIBSMun, gTribRegular}}).build()':
      { tribCalc: { IBSCBS: { gIBSCBS: { gCBS: { pCBS: ZERO, vCBS: ZERO }, gIBSUF: { pIBSUF: ZERO, vIBSUF: ZERO }, gIBSMun: { pIBSMun: ZERO, vIBSMun: ZERO }, gTribRegular: {} } } } },
    'TributosDomain.builder().IBSCBS(IBSCBSDomain{gIBSCBSMono: MonofasiaDomain.builder().build()}).build()': { tribCalc: { IBSCBS: { gIBSCBSMono: { vTotIBSMonoItem: ZERO, vTotCBSMonoItem: ZERO } } } },
    'TributosDomain.builder().IBSCBS(IBSCBSDomain{gEstornoCred: new EstornoCreditoDomain()}).build()': { tribCalc: { IBSCBS: { gEstornoCred: {} } } },
  };
  for (const nome of ['ObjetoDomain', 'TributosDomain']) {
    for (const { v } of unitarios(nome)) {
      if (v.endpoint !== `unit:${nome}`) continue;
      test(`${nome} ${v.id}`, () => {
        const o = CONSTRUCOES[v.input.build];
        assert.ok(o, `construção não mapeada: ${v.input.build}`);
        for (const [k, esperado] of Object.entries(v.expected)) {
          const metodo = k.replace(/\(\)$/, '');
          const atual = metodo === 'getImpostoSeletivo' ? (o.tribCalc?.IS ?? null) : objeto[metodo](o);
          conferirValor(atual, esperado, k);
        }
      });
    }
  }
  for (const { v } of unitarios('ObjetoDomain.compareTo')) {
    test(v.id, () => {
      const objs = v.input;
      for (const k of Object.keys(v.expected)) {
        const m = /^(\w+) ([<>]) (\w+)$/.exec(k) ?? /^(\w+)\.compareTo\((\w+)\) == 0$/.exec(k);
        if (m[3]) assert.equal(Math.sign(compararObjetos(objs[m[1]], objs[m[3]])), m[2] === '<' ? -1 : 1, k);
        else assert.equal(compararObjetos(objs[m[1]], objs[m[2]]), 0, k);
      }
    });
  }

  for (const { v } of unitarios('ObjetoDomain.equals')) {
    test(v.id, () => {
      const [o1, o2] = [v.input.obj1, { ...v.input.obj2, tribCalc: {} }];
      assert.equal(String(objetosIguais(o1, o2)), v.expected['obj1.equals(obj2)']);
      assert.equal(String(objetosIguais(o1, o2)), v.expected['obj1.hashCode() == obj2.hashCode()']); // hashCode of nObj only
      assert.equal(objetosIguais(o1, { nObj: 2 }), false);
    });
  }

  for (const { v } of unitarios('GlobalCollector')) {
    test(`GlobalCollector ${v.id}`, () => {
      const g = new GlobalCollector();
      let erro;
      try {
        for (const [op, ...args] of v.input.ops) {
          if (op === 'addErroGlobal') g.addErroGlobal(...args);
          else if (op === 'addItemCollector') g.addItemCollector(new ItemCollector(args[0], args[1]));
          else if (op === 'getErrosGlobais().add') g.getErrosGlobais().push({});
          else if (op === 'getItemCollectors().add') g.getItemCollectors().push({});
        }
      } catch (x) { erro = x; }
      for (const [k, esperado] of Object.entries(v.expected)) {
        if (k === 'throws') { assert.ok(erro instanceof TypeError, 'lista imutável'); assert.equal(esperado, 'UnsupportedOperationException'); continue; }
        if (k === 'hasErrosGlobais()') assert.equal(String(g.hasErrosGlobais()), esperado);
        else if (k === 'getErrosGlobais()') assert.equal(JSON.stringify(g.getErrosGlobais()), esperado);
        else if (k === 'getItemCollectors()') assert.equal(JSON.stringify(g.getItemCollectors()), esperado);
        else if (k === 'getErrosGlobais().length()') assert.equal(String(g.getErrosGlobais().length), esperado);
        else if (k === 'getItemCollectors().length()') assert.equal(String(g.getItemCollectors().length), esperado);
        else if (k === 'getErrosGlobais()[*].code') assert.equal(JSON.stringify(g.getErrosGlobais().map((x) => x.code)), esperado);
        else if (k.startsWith('erro[0].')) assert.equal(g.getErrosGlobais()[0][k.slice(8)], esperado);
        else assert.fail(`chave não tratada ${k}`);
      }
    });
  }
});

// ─── Bean Validation, messages and request locale ─────────────────────────────────────

describe('Bean Validation e locale (paridade com Tomcat 11 / JDK 25 / Hibernate Validator 9.1.5)', () => {
  // [Accept-Language, ResourceBundle chosen by the JDK for the Tomcat locale] — captured with jshell
  // (tomcat-embed-core 11.0.27 AcceptLanguage2 + ResourceBundle.getBundle, -Duser.language=pt -Duser.country=BR)
  const TABELA = [
    [undefined, 'pt_BR'], ['', 'pt_BR'], ['en', 'en'], ['en-US,en;q=0.9', 'en'], ['pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', 'pt_BR'],
    ['pt_BR', ''], ['*', ''], ['i-klingon', ''], ['x-klingon', ''], ['zh-Hant', 'zh'], ['zh-Hant-TW', 'zh_TW'], ['zh-HK', 'zh'],
    ['zh-CN', 'zh_CN'], ['en;q=0', 'pt_BR'], ['fr;q=1.5', 'pt_BR'], ['fr;q=0.5', 'fr'], ['mn', 'pt_BR'], ['mn-MN', 'mn_MN'],
    ['pt-PT', 'pt_PT'], ['de-CH-1996', 'de'], ['sr-Latn-RS', 'pt_BR'], ['en;q=0.5,pt;q=0.5', 'en'], ['*;q=0.5, fr', 'fr'],
  ];
  for (const [al, pacote] of TABELA) {
    test(`Accept-Language ${JSON.stringify(al)} → ValidationMessages${pacote ? `_${pacote}` : ''}`, () => {
      assert.equal(cadeiaDePacotes(localeDaRequisicao(al))[0], pacote);
    });
  }
  test('Tomcat AcceptLanguage2: qualidade, entradas inválidas e locales legados', () => {
    assert.deepEqual(lerAcceptLanguage('en;q=0.5, *;q=0.9 , zh-Hant-TW;q=0'), [
      { locale: { language: 'en', country: '', variant: '' }, qualidade: 0.5 },
      { locale: { language: '', country: '', variant: '' }, qualidade: 0.9 },
    ]);
    assert.deepEqual(lerAcceptLanguage('sr-Latn-RS')[0].locale, { language: 'sr', country: 'RS', variant: 'LATN' });
  });

  const msg = (classe, campo, bean, locale) => validar(bean, classe).filter((v) => v.caminho === campo).map((v) => interpolar(v.restricao, locale));
  const PT_BR = localeDaRequisicao(undefined);
  test('mensagens pt_BR / en / az como o oráculo', () => {
    assert.deepEqual(msg('ItemOperacaoInput', 'numero', { numero: 0 }, PT_BR), ['deve ser maior que ou igual à 1']);
    assert.deepEqual(msg('ItemOperacaoInput', 'numero', { numero: 0 }, localeDaRequisicao('pt')), ['deve ser maior que ou igual a 1']);
    assert.deepEqual(msg('OperacaoInput', 'municipio', { municipio: -1 }, localeDaRequisicao('az')), ['0-dan böyük bərabər olmalıdır']);
    assert.deepEqual(msg('OperacaoInput', 'municipio', { municipio: 1e7 }, localeDaRequisicao('az')), ['9999999-dan kiçik bərabər olmalıdır']);
    assert.deepEqual(msg('AliquotasNominaisInput', 'cbs', { cbs: Dec.of('100.00001') }, localeDaRequisicao('en')),
      ['numeric value out of bounds (<3 digits>.<4 digits> expected)', 'must be less than or equal to 100.00']);
    assert.deepEqual(msg('ItemOperacaoInput', 'cst', { cst: '1a' }, PT_BR), ['Informar somente dígitos', 'tamanho deve ser entre 3 e 3']);
  });
  test('@Digits olha a escala recebida; @PositiveOrZero aceita -0.00', () => {
    const viol = (valor) => validar({ baseCalculo: Dec.parse(valor) }, 'ItemOperacaoInput').filter((v) => v.caminho === 'baseCalculo').map((v) => v.anotacao);
    assert.deepEqual(viol('1.000'), ['Digits']);
    assert.deepEqual(viol('1E+13'), ['Digits']);
    assert.deepEqual(viol('1E+12'), []);
    assert.deepEqual(viol('0.00'), []);
    assert.deepEqual(viol('-0.00'), []);
    assert.deepEqual(viol('-0.01'), ['PositiveOrZero']);
  });
  test('detalhe de validação: valor rejeitado com BigDecimal.toString e lista vazia', () => {
    assert.equal(detalheValidacao('quantidade', 'x', Dec.parse('-1E+12')), "Campo 'quantidade' x, recebido: '-1E+12'");
    assert.equal(detalheValidacao('itens', 'não deve estar vazio', []), "Campo 'itens' não deve estar vazio, recebido: '[]'");
    assert.equal(detalheValidacao('id', 'não deve ser nulo', null), "Campo 'id' não deve ser nulo");
  });
});

// ─── Port-only safeguards (never sent to the oracle) ─────────────────────────────────────

describe('salvaguardas do porte', () => {
  // vProd 1E+999999999 passes @PositiveOrZero; Java would materialize 10^999999999 in BigDecimal.add
  const corpo = '{"id":"x","versao":"1","dhFatoGerador":"2026-03-01T10:00:00-03:00","municipio":4314902,"tpDoc":55,'
    + '"itens":[{"numero":1,"cst":"000","cClassTrib":"000001","gComponentesBC":{"vProd":1E+999999999}}]}';
  test('expoente gigante em gComponentesBC: falha técnica do item, sem travar', async () => {
    const roc = await proc.processarOperacao(vincularOperacao(lerJsonTexto(corpo)), 'http://localhost');
    assert.equal(roc.objetos[0].estadoItem, 'FALHA_TECNICA');
    assert.equal(roc.objetos[0].erros[0].code, 'CAL-999');
    assert.match(roc.objetos[0].erros[0].detail, /fora do limite suportado/);
    await assert.rejects(proc.calcularTributos(vincularOperacao(lerJsonTexto(corpo))), (e) => e.classeJava === 'ArithmeticException');
  });
  test('regime-geral com item nulo: NPE com a mensagem do JDK (primeira ocorrência na JVM)', async () => {
    const op = vincularOperacao(lerJsonTexto('{"id":"x","versao":"1","dhFatoGerador":"2026-03-01T10:00:00-03:00","municipio":4314902,"itens":[null]}'));
    await assert.rejects(proc.calcularTributos(op), (e) => e.classeJava === 'NullPointerException'
      && e.mensagem === 'Cannot invoke "br.gov.serpro.rtc.api.model.input.ItemOperacaoInput.getNumero()" because "item" is null');
  });
});

// ─── Live differential (generator of this slice) ─────────────────────────────────────────

const oraculoVivo = ORACULO ? await fetch(`${ORACULO}/api/calculadora/observabilidade/erros?codigo=REG-001`, { signal: AbortSignal.timeout(1500) }).then((r) => r.status === 200, () => false) : false;
const SEM_ORACULO_MOTIVO = ORACULO ? `oráculo indisponível em ${ORACULO}` : 'diferencial ao vivo desligado (defina ORACULO_URL)';
const SEM_ORACULO = !oraculoVivo && SEM_ORACULO_MOTIVO;

test('diferencial ao vivo contra o oráculo: gerador de cálculo (amostra com lote de arredondamento, 0 divergências)', { skip: SEM_ORACULO, timeout: 600_000 }, async (t) => {
  const { subirApp, compararTodos } = await import('../lib/diferencial.js');
  const { gerar } = await import('./diferencial/geradores/calculo.mjs');
  const app = await subirApp();
  const banco = abrirBanco(`${raiz}data/calculadora-pro.db`);
  try {
    const reqs = (await gerar({ seed: 7, n: 150, base: banco })).map((r) => ({ ...r, headers: { host: app.host, ...(r.headers ?? {}) } }));
    const res = await compararTodos(reqs, { oraculo: ORACULO, app: app.base }, { concorrencia: 8 });
    const div = res.filter((r) => !r.igual);
    const status = {};
    for (const r of res) status[r.java?.status] = (status[r.java?.status] ?? 0) + 1;
    t.diagnostic(`${res.length} casos, status ${JSON.stringify(status)}, ${div.length} divergências`);
    assert.ok(res.length >= 1000 && status[200] >= 700, `${res.length} casos`);
    assert.deepEqual(div.slice(0, 5).map((r) => `${r.req.rotulo}: ${r.divergencias.join(' | ')}`), []);
  } finally {
    await app.fechar();
    banco.close();
  }
});

// ─── Java non-determinism, compared with normalization ──────────────────────────────────
// Evidence (same request sent repeatedly to the oracle): 6 failing items among 36 → 5 different
// answers in 60 sends; one item with 7 Bean Validation violations → 59 different segment orders in 60.

describe('não determinismo do Java normalizado (regime-geral)', { skip: SEM_ORACULO }, () => {
  let app;
  let lib;
  before(async () => { lib = await import('../lib/diferencial.js'); app = await lib.subirApp(); });
  after(() => app?.fechar());
  const enviar = (destino, corpo, headers = {}) => lib.enviarCru(destino, { metodo: 'POST', caminho: '/api/calculadora/regime-geral', headers: { host: app.host, 'content-type': 'application/json', ...headers }, corpo });
  const texto = (r) => lib.normalizarCorpo(r.corpo.toString('utf8'), r.headers['content-type']);
  const segmentos = (detail) => detail.replace(/^Um ou mais campos são inválidos - \[/, '').replace(/\] $/, '').split('] [').sort();
  const op = (itens, extra = {}) => ({ id: 'x', versao: '1', dhFatoGerador: '2026-06-15T10:00:00-03:00', municipio: 4314902, uf: 'RS', ...extra, itens });

  test('2+ violações de Bean Validation: segmentos "[campo: msg] " comparados como multiconjunto (HashSet no Java)', async () => {
    const INVALIDOS = [
      ['numero', 0], ['cst', '1a'], ['cClassTrib', 'abcdefg'], ['baseCalculo', -1], ['quantidade', 1e12], ['impostoSeletivo', {}],
      ['tributacaoRegular', { cst: 'x' }], ['gComponentesBC', { vProd: -1, vDesc: -2 }], ['aliquotasNominais', { cbs: 101, impostoSeletivo: { adRem: -1 } }],
    ];
    const corpos = [
      '{"id":"x","versao":"1","dhFatoGerador":"2026-01-01T00:00:00-03:00","municipio":4314902,"itens":[{"numero":0,"cst":"1a","cClassTrib":"000001","baseCalculo":1.000}]}',
      '{"municipio":-1,"uf":"R","tpDoc":0,"gCompraGov":{},"itens":[{"cst":"","cClassTrib":"x","quantidade":1E+11,"impostoSeletivo":{},"tributacaoRegular":{},"gComponentesBC":{"vProd":-1},"aliquotasNominais":{"cbs":101,"impostoSeletivo":{"adRem":-1}}},{"numero":1}]}',
      '{"id":"x","versao":"1","municipio":10000000,"itens":[]}',
    ];
    for (let k = 0; k < 24; k++) {
      const item = { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: 10 };
      for (let j = 0; j < 2 + (k % 4); j++) { const [campo, valor] = INVALIDOS[(k * 7 + j * 3) % INVALIDOS.length]; item[campo] = valor; }
      corpos.push(JSON.stringify(op(k % 3 === 0 ? [item, { ...item, numero: 2 }] : [item], k % 5 === 0 ? { municipio: -1 } : {})));
    }
    let comparados = 0;
    for (const corpo of corpos) {
      for (const al of [undefined, 'en', 'es']) {
        const h = al ? { 'accept-language': al } : {};
        const [java, porte] = await Promise.all([enviar(ORACULO, corpo, h), enviar(app.base, corpo, h)]);
        assert.equal(porte.status, java.status, corpo);
        const [dj, dp] = [JSON.parse(java.corpo), JSON.parse(porte.corpo)];
        if (java.status === 400 && /^Um ou mais campos/.test(dj.detail)) {
          comparados++;
          assert.deepEqual(segmentos(dp.detail), segmentos(dj.detail), corpo);
          assert.deepEqual({ ...dp, detail: '', timestamp: '' }, { ...dj, detail: '', timestamp: '' });
        } else assert.equal(texto(porte), texto(java), corpo);
      }
    }
    assert.ok(comparados >= 60, String(comparados));
  });

  test('2+ itens com erro: Java responde o erro de um deles (o que falhar primeiro no parallelStream); o porte, o do menor índice', async (t) => {
    const ERROS = [
      { cst: '999' }, { cClassTrib: '999999' }, { ncm: '99999999' }, { nbs: '999999999' }, { cst: '550', cClassTrib: '550001' },
      { ncm: '24021000', nbs: '115012000' }, { cst: '620', cClassTrib: '620001' }, { baseCalculo: undefined }, { cst: '000', cClassTrib: '200003', ncm: '24021000' },
    ];
    const valido = (numero) => ({ numero, cst: '000', cClassTrib: '000001', baseCalculo: 100 + numero });
    const viuOutroQueNaoOPrimeiro = [];
    for (let k = 0; k < 16; k++) {
      const itens = Array.from({ length: 4 + (k % 5) }, (_, i) => valido(i + 1));
      const falhas = [];
      for (let j = 0; j < 2 + (k % 4); j++) {
        const e = ERROS[(k * 5 + j * 2) % ERROS.length];
        const pos = (k * 3 + j * 7) % (itens.length + 1);
        itens.splice(pos, 0, { ...valido(50 + j), ...e });
      }
      itens.forEach((it, i) => { if (it.numero >= 50) falhas.push(i); });
      const corpo = JSON.stringify(op(itens));
      const [java, porte] = await Promise.all([enviar(ORACULO, corpo), enviar(app.base, corpo)]);
      // each failing item alone: a single element runs on the caller thread → deterministic answer
      const candidatos = [];
      for (const i of falhas) {
        const so = await enviar(ORACULO, JSON.stringify(op([itens[i]])));
        candidatos.push(`${so.status} ${texto(so)}`);
      }
      const j = `${java.status} ${texto(java)}`;
      assert.ok(candidatos.includes(j), `java fora dos candidatos: ${j}`);
      assert.equal(`${porte.status} ${texto(porte)}`, candidatos[0], corpo);
      if (j !== candidatos[0]) viuOutroQueNaoOPrimeiro.push(k);
    }
    t.diagnostic(`operações em que o Java não escolheu o menor índice: ${viuOutroQueNaoOPrimeiro.length} de 16`);
  });

  test('item nulo: o "detail" do NPE some no Java quando a JVM omite a mensagem (fast throw / reconstrução em outra thread)', async () => {
    const valido = { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: 1 };
    for (const itens of [[null], [valido, null], [null, valido, { ...valido, numero: 2 }]]) {
      const corpo = JSON.stringify(op(itens));
      const [java, porte] = await Promise.all([enviar(ORACULO, corpo), enviar(app.base, corpo)]);
      assert.equal(porte.status, 500);
      assert.equal(java.status, 500);
      const dp = JSON.parse(porte.corpo);
      assert.equal(dp.detail, 'Cannot invoke "br.gov.serpro.rtc.api.model.input.ItemOperacaoInput.getNumero()" because "item" is null');
      const dj = JSON.parse(java.corpo);
      if (dj.detail !== undefined) assert.equal(dj.detail, dp.detail);
      const { detail, ...semDetalhe } = dp;
      assert.deepEqual({ ...dj, detail: undefined, timestamp: '' }, { ...semDetalhe, detail: undefined, timestamp: '' });
    }
  });
});
