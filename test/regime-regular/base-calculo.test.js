// Base de cálculo (CIBS / IS / unificada NF-e e NFS-e), NFS-e auxiliar e pedágio — porte de
// calculadora-rtc-regime-regular 1.7.2:
//  1. every official HTTP vector of these endpoints through the real server (test/lib/servidor.js);
//  2. every official unit vector of BaseCalculoService, BaseCalculoUnificadaService, NfseService,
//     PedagioService, TributoTotalPedagioOutput and ComponentesBaseCalculoInput (direct calls, as
//     the Java tests do: they bypass Spring and some use Mockito mocks);
//  3. answers captured from the official API (oracle) compared byte for byte through the server
//     (timestamp aside; 2+ "[campo: mensagem] " segments compared as a multiset, Java iterates a HashSet);
//  4. the Java/Tomcat/Spring semantics ported in this slice (Accept-Language → Locale, Hibernate
//     Validator messages, LocalDate/Integer request params), each case observed on the oracle.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lerResposta, verificarChave } from '../lib/jsonpath-regreg.js';
import { Dec } from '../../src/core/decimal.js';
import { escreverJson, lerJsonTexto } from '../../src/regime-regular/comum/json.js';
import { abrirBanco } from '../../src/core/db.js';
import { calcularCibs, calcularISMercadorias, calcularComponentes, calcularUnificada, getValor, ELEMENTO_POR_NOME } from '../../src/regime-regular/base-calculo/base-calculo.js';
import { calcularBaseCalculoNfse } from '../../src/regime-regular/base-calculo/nfse.js';
import {
  aliquotaResultado, buscarAliquotaPadrao, calcularPedagio, criarDependenciasPedagio, saidaPedagio, totalizaCbs, totalizaIbsEstadual, totalizaIbsMunicipal, TributoEnum,
} from '../../src/regime-regular/base-calculo/pedagio.js';
import { CAMPOS_COMPONENTES, lerPedagio, naturezaDeTexto } from '../../src/regime-regular/base-calculo/entradas.js';
import { localeDaRequisicao, localeLegado } from '../../src/regime-regular/base-calculo/idioma.js';
import { mensagemPadrao } from '../../src/regime-regular/base-calculo/validacao.js';
import { converterData, parametroInteger } from '../../src/regime-regular/base-calculo/parametros.js';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/regime-regular/', import.meta.url));
const ARQUIVOS = { calculo: 'vectors-calculo.json', validacao: 'vectors-validacao.json', 'dados-unit': 'vectors-dados-unit.json' };
const carregar = (nome) => JSON.parse(readFileSync(FIXTURES + ARQUIVOS[nome], 'utf8')).vectors;

const ENDPOINTS_HTTP = ['pedagio', 'base-calculo-cbs-ibs-mercadorias', 'base-calculo-is-mercadorias', 'base-calculo-unificada', 'base-calculo-unificada-nfse',
  'nfse-indicador-operacao', 'nfse-local-operacao', 'nfse-base-calculo', 'nfse-indicador-operacao-validate', 'nfse-situacoes-classificacoes-tributarias'];
const PREFIXOS_UNIT = ['unit:BaseCalculoService.', 'unit:BaseCalculoUnificadaService.', 'unit:NfseService.', 'unit:PedagioService.', 'unit:TributoTotalPedagioOutput.',
  'unit:ComponentesBaseCalculoInput.getValor'];

/** Validation segments sorted (field names may hold "[i]"). */
function normalizar(texto) {
  return texto.replace(/,"timestamp":"[^"]*"/, '').replace(/("detail":"Um ou mais campos são inválidos - )((?:\[(?:[^\]]|\](?! ))*\] )+)/, (_, a, segs) => a + segs.match(/\[(?:[^\]]|\](?! ))*\] /g).sort().join(''));
}

// ─── 1. Official HTTP vectors ───────────────────────────────────────────────────

describe('vetores oficiais HTTP (servidor real)', () => {
  const itens = [];
  for (const arquivo of Object.keys(ARQUIVOS)) for (const vetor of carregar(arquivo)) if (ENDPOINTS_HTTP.includes(vetor.endpoint)) itens.push({ arquivo, vetor });
  let s;
  let executarVetor;
  const contexto = { respostas: new Map() };
  before(async () => {
    ({ executarVetor } = await import('../lib/vetores.js'));
    const { subir } = await import('../lib/servidor.js');
    s = await subir();
  });
  after(() => s?.fechar());
  test('quantidade de vetores HTTP da área', () => assert.equal(itens.length, 382));
  for (const item of itens) {
    test(`${item.vetor.endpoint} ${item.vetor.id}`, async () => {
      const r = await executarVetor(s, item, contexto);
      assert.deepEqual(r.falhas, [], r.resumo);
      assert.deepEqual(r.naoAplicavel, []);
    });
  }
});

// ─── 2. Official unit vectors ───────────────────────────────────────────────────

const dec = (v) => (v === null || v === undefined ? v : Dec.parse(String(v)));
const igualNumero = (atual, esperado) => atual != null && atual.compareTo(Dec.parse(esperado)) === 0;

/** Input bean of BaseCalculoService / NfseService: absent → BigDecimal.ZERO, null stays null. */
function beanComZeros(input, campos) {
  const r = { anoFatoGerador: input.anoFatoGerador ?? null };
  for (const c of campos) r[c] = c in input ? dec(input[c]) : Dec.ZERO;
  return r;
}

/** Shared checks of `throws`, `message*`, `order` keys. */
function verificarExcecao(v, erro) {
  const falhas = [];
  const esperado = v.expected.throws;
  if (esperado === '<none>') { if (erro) falhas.push(`lançou ${erro.classeJava}`); return falhas; }
  if (!erro) return ['não lançou'];
  const simples = esperado.split('.').pop();
  if (esperado !== '<any>' && erro.classeJava !== simples) falhas.push(`classe ${erro.classeJava} != ${simples}`);
  const msg = erro.mensagem ?? '';
  for (const [k, e] of Object.entries(v.expected)) {
    if (k.startsWith('message.indexOf(')) {
      const alvo = /indexOf\("(.*)"\)/.exec(k)[1];
      const min = Number(/<gte:(\d+)>/.exec(e)[1]);
      if (!(msg.indexOf(alvo) >= min)) falhas.push(`${k}: ${msg.indexOf(alvo)}`);
    } else if (k.startsWith('message')) {
      const m = /^<(contains|not-contains):(.*)>$/.exec(e);
      if (m && m[1] === 'contains' && !msg.includes(m[2])) falhas.push(`${k}: '${msg}' não contém '${m[2]}'`);
      else if (m && m[1] === 'not-contains' && msg.includes(m[2])) falhas.push(`${k}: '${msg}' contém '${m[2]}'`);
      else if (!m && msg !== e) falhas.push(`${k}: '${msg}' != '${e}'`);
    } else if (k === 'order') {
      const partes = e.includes('indexOf(') ? [...e.matchAll(/indexOf\("([^"]*)"\)/g)].map((x) => x[1]) : e.split(' < ');
      const pos = partes.map((p) => msg.indexOf(p));
      if (pos.some((p) => p < 0) || pos.some((p, i) => i > 0 && p <= pos[i - 1])) falhas.push(`order ${e}: ${pos}`);
    }
  }
  return falhas;
}

function executar(fn) {
  try { return { resultado: fn(), erro: null }; } catch (e) { if (!e.classeJava) throw e; return { resultado: null, erro: e }; }
}

const CAMPOS_CIBS = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'frete', 'impostoSeletivo', 'outrosTributos', 'demaisImportancias',
  'icms', 'iss', 'pis', 'pisImportacao', 'cofins', 'cofinsImportacao', 'cosip', 'ipi', 'descontoIncondicional'];
const CAMPOS_IS = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'freteCobrado', 'outrosTributos', 'demaisImportancias',
  'icms', 'iss', 'cosip', 'ipi', 'descontoIncondicional', 'bonificacao', 'devolucaoVendas'];
const CAMPOS_NFSE = ['valorServico', 'descontoIncondicional', 'vCalcReeRepRes', 'vCalcDedRedIBSCBS', 'iss', 'pis', 'cofins'];

/** Services whose result is { baseCalculo } (BaseCalculoService / NfseService.calcularBaseCalculo). */
function verificarBaseCalculo(v, fn, campos) {
  const entrada = beanComZeros(v.input, campos);
  if (campos === CAMPOS_NFSE && !('valorServico' in v.input)) entrada.valorServico = null;
  const { resultado, erro } = executar(() => fn(entrada));
  if (v.expected.throws) return verificarExcecao(v, erro);
  if (erro) return [`lançou ${erro.classeJava}: ${erro.mensagem}`];
  const falhas = [];
  if (v.expected.result === '<present>' && !resultado) falhas.push('result ausente');
  if (v.expected['result.baseCalculo'] && !igualNumero(resultado.baseCalculo, v.expected['result.baseCalculo'])) falhas.push(`baseCalculo ${resultado.baseCalculo} != ${v.expected['result.baseCalculo']}`);
  return falhas;
}

function componentesDe(input) {
  const fonte = input.componentes ?? input;
  return Object.fromEntries(CAMPOS_COMPONENTES.map((c) => [c, dec(fonte[c] ?? null)]));
}

const resultadosUnificada = new Map();
function verificarUnificada(v) {
  const falhas = [];
  const comDto = v.endpoint.endsWith('(BaseCalculoUnificadaInput)');
  const { resultado, erro } = executar(() => (comDto
    ? calcularUnificada({ anoFatoGerador: v.input.anoFatoGerador, tipoDocumento: v.input.tipoDocumento, natureza: v.input.natureza, componentes: componentesDe(v.input) })
    : calcularComponentes(componentesDe(v.input), v.input.ano, v.input.natureza, v.input.tpDoc)));
  if (v.expected.throws) return verificarExcecao(v, erro);
  if (erro) return [`lançou ${erro.classeJava}: ${erro.mensagem}`];
  resultadosUnificada.set(v.id, resultado);
  for (const [k, e] of Object.entries(v.expected)) {
    const chave = k.replace(/^result\./, '');
    if (['baseRG', 'baseIS', 'baseSN'].includes(chave)) {
      const ref = /^<eqOf:(.+)\.(\w+)>$/.exec(e);
      const alvo = ref ? resultadosUnificada.get(ref[1])?.[ref[2]]?.toString() : e;
      if (!igualNumero(resultado[chave], alvo)) falhas.push(`${k}: ${resultado[chave]} != ${alvo}`);
    } else if (chave === 'avisos') {
      if (e === '<nonempty>') { if (!resultado.avisos.length) falhas.push('avisos vazio'); continue; }
      const m = /^<containsExactlyInAnyOrder:(.*)>$/s.exec(e);
      const esperado = JSON.parse(m ? m[1] : e);
      const a = m ? [...resultado.avisos].sort() : resultado.avisos;
      const b = m ? [...esperado].sort() : esperado;
      if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`avisos ${JSON.stringify(resultado.avisos)}`);
    } else if (chave === 'avisos.length()') {
      if (resultado.avisos.length !== Number(e)) falhas.push(`avisos.length ${resultado.avisos.length}`);
    } else if (/^avisos\[\d+\]$/.test(chave)) {
      const i = Number(/\d+/.exec(chave)[0]);
      const c = /^<contains:(.*)>$/.exec(e);
      if (!(c ? resultado.avisos[i]?.includes(c[1]) : resultado.avisos[i] === e)) falhas.push(`${k}: ${resultado.avisos[i]}`);
    } else {
      falhas.push(`chave não tratada ${k}`);
    }
  }
  return falhas;
}

function verificarGetValor(v) {
  const componentes = componentesDe(v.input);
  const falhas = [];
  const conferir = (rotulo, atual, e) => {
    if (e === '<null>') { if (atual !== null) falhas.push(`${rotulo}: ${atual}`); } else if (!igualNumero(atual, e)) falhas.push(`${rotulo}: ${atual} != ${e}`);
  };
  for (const [k, e] of Object.entries(v.expected)) {
    if (k === 'result') conferir(k, getValor(componentes, ELEMENTO_POR_NOME.get(v.input.elemento)), e);
    else conferir(k, getValor(componentes, ELEMENTO_POR_NOME.get(/getValor\((\w+)\)/.exec(k)[1])), e);
  }
  return falhas;
}

function verificarTotal(v) {
  const trechos = v.input.trechos.map((t) => ({ numero: 1, cbs: { tributoCalculado: dec(t.cbs) }, ibsEstadual: { tributoCalculado: dec(t.ibsEstadual) }, ibsMunicipal: { tributoCalculado: dec(t.ibsMunicipal) } }));
  const fn = { totalizaCbs, totalizaIbsEstadual, totalizaIbsMunicipal }[v.endpoint.split('.').pop()];
  const r = fn(trechos, dec(v.input.totalBC));
  return Object.entries(v.expected).filter(([k, e]) => !igualNumero(r[k], e)).map(([k, e]) => `${k}: ${r[k]} != ${e}`);
}

function verificarAliquotaPadrao(v) {
  const mocks = v.input.mocks;
  const resposta = (m) => aliquotaResultado(dec(m.valorReferencia), dec(m.valorPadrao), m.formaAplicacao);
  const deps = {
    buscarAliquota(id, uf, mun, data) {
      const chave = `aliquotaPadraoService.buscarAliquota(${id}, ${uf}, ${mun}, ${data})`;
      return resposta(mocks[chave] ?? mocks['aliquotaPadraoService.buscarAliquota']);
    },
  };
  const chamadas = v.input.calls ?? [v.input];
  const resultados = chamadas.map((c) => buscarAliquotaPadrao(deps, TributoEnum[c.tributo], c.data, c.codigoUf, c.codigoMunicipio));
  const exigeEscala = /BigDecimal\.equals/.test(v.notes ?? '');
  const falhas = [];
  for (const [k, e] of Object.entries(v.expected)) {
    const i = /\[(\d+)\]/.exec(k);
    const atual = resultados[i ? Number(i[1]) : 0];
    if (!igualNumero(atual, e) || (exigeEscala && atual.toString() !== e)) falhas.push(`${k}: ${atual} != ${e}`);
  }
  return falhas;
}

let banco;
function verificarCalcularCIBS(v) {
  banco ??= abrirBanco(`${RAIZ}data/calculadora-pro.db`);
  const entrada = lerPedagio(lerJsonTexto(JSON.stringify(v.input)));
  const { resultado, erro } = executar(() => calcularPedagio(criarDependenciasPedagio(banco), entrada));
  if (v.expected.throws) return verificarExcecao(v, erro);
  if (erro) return [`lançou ${erro.classeJava}: ${erro.mensagem}`];
  const texto = escreverJson(saidaPedagio(resultado));
  const resp = { status: 200, headers: {}, texto, json: lerResposta(texto) };
  const falhas = [];
  for (const [k, e] of Object.entries(v.expected)) {
    const r = verificarChave(resp, k, e, { regraTexto: 'texto' });
    if (r && typeof r !== 'object') falhas.push(r);
  }
  return falhas;
}

function verificarUnitario(v) {
  const ep = v.endpoint;
  if (ep === 'unit:BaseCalculoService.calcularCibs') return verificarBaseCalculo(v, calcularCibs, CAMPOS_CIBS);
  if (ep === 'unit:BaseCalculoService.calcularISMercadorias') return verificarBaseCalculo(v, calcularISMercadorias, CAMPOS_IS);
  if (ep === 'unit:NfseService.calcularBaseCalculo') return verificarBaseCalculo(v, calcularBaseCalculoNfse, CAMPOS_NFSE);
  if (ep.startsWith('unit:BaseCalculoUnificadaService.calcular')) return verificarUnificada(v);
  if (ep === 'unit:ComponentesBaseCalculoInput.getValor') return verificarGetValor(v);
  if (ep.startsWith('unit:TributoTotalPedagioOutput.')) return verificarTotal(v);
  if (ep === 'unit:PedagioService.buscarAliquotaPadrao') return verificarAliquotaPadrao(v);
  if (ep === 'unit:PedagioService.calcularCIBS') return verificarCalcularCIBS(v);
  return [`endpoint sem executor: ${ep}`];
}

describe('vetores oficiais unitários', () => {
  const itens = [];
  for (const arquivo of Object.keys(ARQUIVOS)) for (const v of carregar(arquivo)) if (PREFIXOS_UNIT.some((p) => v.endpoint.startsWith(p))) itens.push(v);
  after(() => banco?.close());
  test('quantidade de vetores unitários da área', () => assert.equal(itens.length, 172));
  for (const v of itens) test(`${v.endpoint} ${v.id}`, () => assert.deepEqual(verificarUnitario(v), []));
});

// ─── 3. Oracle answers through the server ───────────────────────────────────────

// [método, caminho, corpo, headers, status, corpo da resposta sem timestamp] (Host localhost:5181)
const CAPTURADOS = [
  ["POST","/api/calculadora/base-calculo/cbs-ibs-mercadorias","{\"anoFatoGerador\":2026,\"valorBem\":100,\"frete\":10.5,\"icms\":18}",{},200,"{\"baseCalculo\":92.5}"],
  ["POST","/api/calculadora/base-calculo/cbs-ibs-mercadorias","{\"anoFatoGerador\":2026,\"valorBem\":\"1e-7\"}",{},200,"{\"baseCalculo\":1E-7}"],
  ["POST","/api/calculadora/base-calculo/cbs-ibs-mercadorias","{\"anoFatoGerador\":2027,\"pis\":1,\"cofinsImportacao\":2,\"icms\":3}",{},400,"{\"detail\":\"Os seguintes campos não podem ser informados a partir de 2027: COFINS Importação, PIS\",\"instance\":\"/api/calculadora/base-calculo/cbs-ibs-mercadorias\",\"status\":400,\"title\":\"Campo inválido\",\"type\":\"http://localhost/errors/campo-invalido\"}"],
  ["POST","/api/calculadora/base-calculo/cbs-ibs-mercadorias","{\"anoFatoGerador\":2026,\"pis\":null}",{},500,"{\"instance\":\"/api/calculadora/base-calculo/cbs-ibs-mercadorias\",\"status\":500,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/cbs-ibs-mercadorias","{\"anoFatoGerador\":2026,\"valorBem\":null}",{},500,"{\"detail\":\"Cannot invoke \\\"java.math.BigDecimal.add(java.math.BigDecimal)\\\" because the return value of \\\"br.gov.serpro.rtc.api.model.input.basecalculo.BaseCalculoCibsInput.getValorBem()\\\" is null\",\"instance\":\"/api/calculadora/base-calculo/cbs-ibs-mercadorias\",\"status\":500,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/cbs-ibs-mercadorias","{\"anoFatoGerador\":2026,\"valorBem\":-1}",{"accept-language":"fr"},400,"{\"detail\":\"Um ou mais campos são inválidos - [valorBem: doit être supérieur ou égal à 0] \",\"instance\":\"/api/calculadora/base-calculo/cbs-ibs-mercadorias\",\"status\":400,\"title\":\"Campos inválidos.\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/is-mercadorias","{\"anoFatoGerador\":2027,\"valorBem\":1000.00,\"bonificacao\":150.00}",{},200,"{\"baseCalculo\":850.00}"],
  ["POST","/api/calculadora/base-calculo/is-mercadorias","{\"anoFatoGerador\":2027,\"valorBem\":1,\"devolucaoVendas\":2}",{},400,"{\"detail\":\"Base de cálculo não pode ser negativa. A soma dos valores que não integram a base é maior que a soma dos valores que integram a base.\",\"instance\":\"/api/calculadora/base-calculo/is-mercadorias\",\"status\":400,\"title\":\"Campo inválido\",\"type\":\"http://localhost/errors/campo-invalido\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada","{\"anoFatoGerador\":2026,\"tipoDocumento\":55,\"natureza\":\"BEM\",\"vProd\":1000.0,\"vFrete\":10.005,\"vDesc\":0.0,\"vPIS\":9.25,\"vCOFINS\":46.25}",{},200,"{\"avisos\":[],\"baseIS\":954.50,\"baseRG\":954.50,\"baseSN\":1010.00}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada","{\"anoFatoGerador\":2026,\"tipoDocumento\":65,\"natureza\":\"serviço\",\"vProd\":100,\"vISSQN\":2}",{},200,"{\"avisos\":[],\"baseIS\":98.00,\"baseRG\":98.00,\"baseSN\":100.00}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada","{\"anoFatoGerador\":2026,\"tipoDocumento\":57,\"natureza\":\"BEM\",\"vProd\":5}",{},400,"{\"detail\":\"Tipo de documento deve ser 55 (NF-e) ou 65 (NFC-e)\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada\",\"status\":400,\"title\":\"Campo inválido\",\"type\":\"http://localhost/errors/campo-invalido\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada","{\"anoFatoGerador\":2026,\"tipoDocumento\":55,\"natureza\":[]}",{},400,"{\"detail\":\"JSON parse error: Input mismatch reading Enum `br.gov.serpro.rtc.api.model.input.basecalculo.enumeration.BaseCalculoNatureza`: properties-based `@JsonCreator` ([method br.gov.serpro.rtc.api.model.input.basecalculo.enumeration.BaseCalculoNatureza#fromString(java.lang.String)]) expects String Value, got Array value (`JsonToken.START_ARRAY`)\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada","{\"vProd\":\"abc\",\"anoFatoGerador\":\"xyz\",\"tipoDocumento\":55,\"natureza\":\"BEM\"}",{},400,"{\"detail\":\"JSON parse error: Cannot deserialize value of type `java.lang.Integer` from String \\\"xyz\\\": not a valid `java.lang.Integer` value\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":\"1\",\"situacao\":\"locacao9903\",\"vServ\":1000.0,\"locacao\":{\"pCopropriedade\":33.33,\"vTotOper\":1000.05,\"vDescIncondTot\":0.0,\"somaAjustesLocImoveis\":0.0}}",{},200,"{\"avisos\":[],\"baseRG\":333.32,\"baseSN\":null,\"erros\":[]}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":\"3\",\"situacao\":\"comum\",\"regApIBSCBSSN\":\"1\",\"documentos\":[{\"tpAjusteBC\":\"101\",\"vAjusteAplic\":\"50\"}],\"vServ\":\"50\",\"vDescIncond\":\"10\"}",{},200,"{\"avisos\":[],\"baseRG\":-10.00,\"baseSN\":-10.00,\"erros\":[{\"codigo\":\"E1534\",\"mensagem\":\"Soma dos ajustes (50.00) excede ou iguala o valor do serviço (50.00)\"},{\"codigo\":\"BASE-NEGATIVA\",\"mensagem\":\"Base de cálculo RG negativa: -10.00\"},{\"codigo\":\"BASE-NEGATIVA\",\"mensagem\":\"Base de cálculo SN negativa: -10.00\"}]}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":4,\"situacao\":\"comum\",\"vServ\":200,\"vDescIncond\":10}",{},200,"{\"avisos\":[\"Optante pendente: cálculo realizado com ressalva\"],\"baseRG\":190.00,\"baseSN\":null,\"erros\":[{\"codigo\":\"EXXX-REGAP\",\"mensagem\":\"Campo regApIBSCBSSN obrigatório para optante do Simples Nacional\"}]}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":2,\"situacao\":\"locacao9903\",\"locacao\":{\"pCopropriedade\":\"100\",\"vTotOper\":\"1000\",\"vDescIncondTot\":\"0\",\"somaAjustesLocImoveis\":\"0\"},\"documentos\":[{\"tpAjusteBC\":\"101\",\"vAjusteAplic\":\"5\"}]}",{},200,"{\"avisos\":[\"E1302: Operação MEI: bases de cálculo não aplicáveis\"],\"baseRG\":null,\"baseSN\":null,\"erros\":[{\"codigo\":\"EXXX-LOC-SN\",\"mensagem\":\"Locação de imóveis incompatível com optante do Simples Nacional\"},{\"codigo\":\"E0436\",\"mensagem\":\"Documentos de ajuste não são permitidos para MEI\"}]}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":1,\"situacao\":\"locacao9903\"}",{},400,"{\"detail\":\"Campo locacao obrigatório quando situacao é locacao9903\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada-nfse\",\"status\":400,\"title\":\"Campo inválido\",\"type\":\"http://localhost/errors/campo-invalido\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":5,\"situacao\":\"comum\"}",{},400,"{\"detail\":\"JSON parse error: Cannot construct instance of `br.gov.serpro.rtc.api.model.input.basecalculo.enumeration.OpcaoSimplesNacional`, problem: Código inválido para OpcaoSimplesNacional: 5\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada-nfse\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":\"\",\"situacao\":\"comum\"}",{},400,"{\"detail\":\"JSON parse error: Cannot coerce `null` to `int` value (disable `DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES` to allow)\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada-nfse\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":1,\"situacao\":3}",{},400,"{\"detail\":\"JSON parse error: Cannot deserialize value of type `br.gov.serpro.rtc.api.model.input.basecalculo.enumeration.SituacaoOperacaoNfse` from number 3: index value outside legal index range [0..2]\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada-nfse\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":1,\"situacao\":\"COMUM\"}",{},400,"{\"detail\":\"JSON parse error: Cannot deserialize value of type `br.gov.serpro.rtc.api.model.input.basecalculo.enumeration.SituacaoOperacaoNfse` from String \\\"COMUM\\\": not one of the values accepted for Enum class: [comum, locacao9903, salaoParceiro]\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada-nfse\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":1,\"situacao\":\"comum\",\"documentos\":[null]}",{},500,"{\"detail\":\"Cannot invoke \\\"br.gov.serpro.rtc.api.model.input.basecalculo.DocumentoAjusteNfseInput.getTpAjusteBC()\\\" because \\\"doc\\\" is null\",\"instance\":\"/api/calculadora/base-calculo/base-calculo-unificada-nfse\",\"status\":500,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/base-calculo/base-calculo-unificada-nfse","{\"anoFatoGerador\":2026,\"opSimpNac\":3,\"regApIBSCBSSN\":1,\"situacao\":\"salaoParceiro\",\"vServ\":-5,\"documentos\":[{\"tpAjusteBC\":\"101\",\"vAjusteAplic\":1},{\"tpAjusteBC\":\"x\",\"vAjusteAplic\":1},{\"tpAjusteBC\":\"199\",\"vAjusteAplic\":1,\"xTpAjusteBC\":\" \"},{\"tpAjusteBC\":\"9\",\"vAjusteAplic\":2}],\"locacao\":{\"pCopropriedade\":1,\"vTotOper\":1,\"vDescIncondTot\":1,\"somaAjustesLocImoveis\":1}}",{},200,"{\"avisos\":[\"Tipo de ajuste 'x' desconhecido: documento ignorado\",\"Grupo locacao ignorado fora de contexto de locação de imóveis\"],\"baseRG\":-6.00,\"baseSN\":-8.00,\"erros\":[{\"codigo\":\"LEIAUTE-XTP\",\"mensagem\":\"Campo xTpAjusteBC obrigatório para tipo de ajuste 199\"},{\"codigo\":\"E1534\",\"mensagem\":\"Soma dos ajustes (1.00) excede ou iguala o valor do serviço (-5.00)\"},{\"codigo\":\"BASE-NEGATIVA\",\"mensagem\":\"Base de cálculo RG negativa: -6.00\"},{\"codigo\":\"BASE-NEGATIVA\",\"mensagem\":\"Base de cálculo SN negativa: -8.00\"}]}"],
  ["POST","/api/calculadora/nfse/base-calculo","{\"anoFatoGerador\":2026,\"valorServico\":100.00,\"descontoIncondicional\":5.00,\"vCalcReeRepRes\":6.00,\"vCalcDedRedIBSCBS\":4.00,\"iss\":5.00,\"pis\":1.65,\"cofins\":7.60}",{},200,"{\"baseCalculo\":70.75}"],
  ["POST","/api/calculadora/nfse/base-calculo","{\"anoFatoGerador\":2026}",{"accept-language":"en"},400,"{\"detail\":\"Um ou mais campos são inválidos - [valorServico: must not be null] \",\"instance\":\"/api/calculadora/nfse/base-calculo\",\"status\":400,\"title\":\"Campos inválidos.\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/nfse/indicador-operacao/validate","{\"cIndOp\":\"100301\",\"cClassTrib\":\"000001\",\"nbs\":\"115021000\",\"cTribNac\":\"0101\",\"dataOcorrenciaFatoGerador\":\"2026-01-01\"}",{},200,"{\"cClassTrib\":\"000001\",\"cIndOp\":\"100301\",\"cTribNac\":\"0101\",\"dataOcorrenciaFatoGerador\":\"2026-01-01\",\"nbs\":\"115021000\",\"valido\":true}"],
  ["POST","/api/calculadora/nfse/indicador-operacao/validate","{\"cIndOp\":\"100301\",\"cClassTrib\":\"000001\",\"nbs\":\"115021000\",\"dataOcorrenciaFatoGerador\":\"2026-02-30\"}",{},400,"{\"detail\":\"JSON parse error: Campo 'dataOcorrenciaFatoGerador' [2026-02-30] inválido. Formato esperado: 'yyyy-MM-dd'. Exemplo de valor: '2026-01-05'\",\"instance\":\"/api/calculadora/nfse/indicador-operacao/validate\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/nfse/indicador-operacao/validate","{\"cIndOp\":\"\",\"cClassTrib\":\"000001\",\"nbs\":\"115021000\",\"dataOcorrenciaFatoGerador\":\"2026-01-01\"}",{},400,"{\"detail\":\"Um ou mais campos são inválidos - [cIndOp: O campo cIndOp deve conter exatamente 6 dígitos numéricos] [cIndOp: O campo cIndOp é obrigatório] \",\"instance\":\"/api/calculadora/nfse/indicador-operacao/validate\",\"status\":400,\"title\":\"Campos inválidos.\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=2026-01-01",null,{},200,"{\"cIndOp\":\"100301\",\"codigoLocalFornecimento\":11,\"codigoLocalIncidencia\":2,\"dataOcorrenciaFatoGerador\":\"2026-01-01\",\"localFornecimento\":\"Local do domicílio principal do adquirente residente ou domiciliado no País. Nas aquisições indicadas no art. 11, §4º, II, considera-se domicílio principal do adquirente o estabelecimento matriz\",\"localIncidencia\":\"Endereço do Tomador/Adquirente\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=010104&dataOcorrenciaFatoGerador=2026-12-01",null,{},200,"{\"cIndOp\":\"010104\",\"codigoLocalFornecimento\":18,\"dataOcorrenciaFatoGerador\":\"2026-12-01\",\"localFornecimento\":\"Local onde se encontra o bem móvel material\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=20/01/26",null,{},404,"{\"detail\":\"Indicador de operação '100301' não encontrado para a data 0026-01-20\",\"instance\":\"/api/calculadora/nfse/local-operacao\",\"status\":404,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=30/02/2026",null,{},200,"{\"cIndOp\":\"100301\",\"codigoLocalFornecimento\":11,\"codigoLocalIncidencia\":2,\"dataOcorrenciaFatoGerador\":\"2026-02-28\",\"localFornecimento\":\"Local do domicílio principal do adquirente residente ou domiciliado no País. Nas aquisições indicadas no art. 11, §4º, II, considera-se domicílio principal do adquirente o estabelecimento matriz\",\"localIncidencia\":\"Endereço do Tomador/Adquirente\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=1/20/26",null,{"accept-language":"en-US"},200,"{\"cIndOp\":\"100301\",\"codigoLocalFornecimento\":11,\"codigoLocalIncidencia\":2,\"dataOcorrenciaFatoGerador\":\"2026-01-20\",\"localFornecimento\":\"Local do domicílio principal do adquirente residente ou domiciliado no País. Nas aquisições indicadas no art. 11, §4º, II, considera-se domicílio principal do adquirente o estabelecimento matriz\",\"localIncidencia\":\"Endereço do Tomador/Adquirente\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=999999&dataOcorrenciaFatoGerador=2026-01-01",null,{},404,"{\"detail\":\"Indicador de operação '999999' não encontrado para a data 2026-01-01\",\"instance\":\"/api/calculadora/nfse/local-operacao\",\"status\":404,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=12345&dataOcorrenciaFatoGerador=2026-01-01",null,{},400,"{\"detail\":\"Validation failure\",\"instance\":\"/api/calculadora/nfse/local-operacao\",\"status\":400,\"title\":\"Bad Request\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=x",null,{},400,"{\"detail\":\"Parâmetro inválido [dataOcorrenciaFatoGerador: x] \",\"instance\":\"/api/calculadora/nfse/local-operacao\",\"status\":400,\"title\":\"Tipo de argumento inválido\",\"type\":\"http://localhost/errors/tipo-argumento-invalido\"}"],
  ["GET","/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=",null,{},400,"{\"detail\":\"Required parameter 'dataOcorrenciaFatoGerador' is not present.\",\"instance\":\"/api/calculadora/nfse/local-operacao\",\"status\":400,\"title\":\"Bad Request\"}"],
  ["GET","/api/calculadora/nfse/indicador-operacao?dataOcorrenciaFatoGerador=2026-01-01&nbs=115021000",null,{},200,"[{\"adquirenteExterior\":false,\"cIndOp\":\"100301\",\"codigoLocalFornecimento\":11,\"codigoLocalIncidencia\":2,\"localFornecimento\":\"Local do domicílio principal do adquirente residente ou domiciliado no País. Nas aquisições indicadas no art. 11, §4º, II, considera-se domicílio principal do adquirente o estabelecimento matriz\",\"localIncidencia\":\"Endereço do Tomador/Adquirente\",\"prestacaoServicoOnerosa\":true,\"tipoOperacao\":\"Demais serviços, em operações onerosas\"}]"],
  ["GET","/api/calculadora/nfse/indicador-operacao?dataOcorrenciaFatoGerador=2026-01-01&nbs=999999999",null,{},404,"{\"detail\":\"NBS de código 999999999 não encontrada para a data 2026-01-01\",\"instance\":\"/api/calculadora/nfse/indicador-operacao\",\"status\":404,\"title\":\"NBS não encontrada\",\"type\":\"http://localhost/errors/nbs-nao-encontrada\"}"],
  ["GET","/api/calculadora/nfse/indicador-operacao?dataOcorrenciaFatoGerador=2024-01-01",null,{},200,"[]"],
  ["GET","/api/calculadora/nfse/situacoes-classificacoes-tributarias?nbs=115021000&data=2026-01-01",null,{},200,"[{\"codigoSituacaoTributaria\":\"000\",\"descricaoSituacaoTributaria\":\"Tributação integral\",\"codigoClassificacaoTributaria\":\"000001\",\"descricaoClassificacaoTributaria\":\"Situações tributadas integralmente pelo IBS e CBS.\"}]"],
  ["GET","/api/calculadora/nfse/situacoes-classificacoes-tributarias?nbs=102020000&data=2027-06-01",null,{},200,"[{\"codigoSituacaoTributaria\":\"000\",\"descricaoSituacaoTributaria\":\"Tributação integral\",\"codigoClassificacaoTributaria\":\"000001\",\"descricaoClassificacaoTributaria\":\"Situações tributadas integralmente pelo IBS e CBS.\"}]"],
  ["GET","/api/calculadora/nfse/locais-fornecimento?codigo=2",null,{},200,"[{\"codigo\":2,\"descricao\":\"Local da prestação do serviço diverso do estabelecimento do fornecedor\"}]"],
  ["GET","/api/calculadora/nfse/locais-fornecimento?codigo=-0x2",null,{},400,"{\"detail\":\"Código inválido: -2\",\"instance\":\"/api/calculadora/nfse/locais-fornecimento\",\"status\":400,\"title\":\"Campo inválido\",\"type\":\"http://localhost/errors/campo-invalido\"}"],
  ["GET","/api/calculadora/nfse/locais-fornecimento?codigo=%2B0x1",null,{},400,"{\"detail\":\"Parâmetro inválido [codigo: +0x1] \",\"instance\":\"/api/calculadora/nfse/locais-fornecimento\",\"status\":400,\"title\":\"Tipo de argumento inválido\",\"type\":\"http://localhost/errors/tipo-argumento-invalido\"}"],
  ["GET","/api/calculadora/nfse/locais-incidencia",null,{},200,"[{\"codigo\":1,\"descricao\":\"Endereço do Destinatário\"},{\"codigo\":2,\"descricao\":\"Endereço do Tomador/Adquirente\"},{\"codigo\":3,\"descricao\":\"Estabelecimento do Prestador/Fornecedor\"},{\"codigo\":4,\"descricao\":\"Local da Prestação\"},{\"codigo\":5,\"descricao\":\"Local do Evento\"},{\"codigo\":6,\"descricao\":\"Localidade do Imóvel\"},{\"codigo\":7,\"descricao\":\"Localização do Trecho\"}]"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"SP\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200.0,\"trechos\":[{\"numero\":1,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":10},{\"numero\":2,\"municipio\":3509502,\"uf\":\"SP\",\"extensao\":13},{\"numero\":3,\"municipio\":3304557,\"uf\":\"RJ\",\"extensao\":10}]}",{},200,"{\"baseCalculo\":200.0,\"cClassTrib\":\"000001\",\"cst\":\"000\",\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"extensaoTotal\":33,\"municipioOrigem\":3550308,\"total\":{\"cbsTotal\":{\"baseCalculo\":\"200.00\",\"valorApurado\":\"1.80\",\"valorDevido\":\"1.80\",\"valorTributo\":\"1.80\"},\"ibsEstadualTotal\":{\"baseCalculo\":\"200.00\",\"valorApurado\":\"0.20\",\"valorDevido\":\"0.20\",\"valorTributo\":\"0.20\"},\"ibsMunicipalTotal\":{\"baseCalculo\":\"200.00\",\"valorApurado\":\"0.00\",\"valorDevido\":\"0.00\",\"valorTributo\":\"0.00\"}},\"trechos\":[{\"baseCalculo\":200.0,\"cbs\":{\"aliquota\":0.9,\"aliquotaEfetiva\":0.2727,\"tributoCalculado\":0.55},\"extensaoTrecho\":10,\"ibsEstadual\":{\"aliquota\":0.1,\"aliquotaEfetiva\":0.0303,\"tributoCalculado\":0.06},\"ibsMunicipal\":{\"aliquota\":0.0,\"aliquotaEfetiva\":0.0000,\"tributoCalculado\":0.00},\"municipio\":3550308,\"numero\":1,\"uf\":\"SP\"},{\"baseCalculo\":200.0,\"cbs\":{\"aliquota\":0.9,\"aliquotaEfetiva\":0.3545,\"tributoCalculado\":0.71},\"extensaoTrecho\":13,\"ibsEstadual\":{\"aliquota\":0.1,\"aliquotaEfetiva\":0.0394,\"tributoCalculado\":0.08},\"ibsMunicipal\":{\"aliquota\":0.0,\"aliquotaEfetiva\":0.0000,\"tributoCalculado\":0.00},\"municipio\":3509502,\"numero\":2,\"uf\":\"SP\"},{\"baseCalculo\":200.0,\"cbs\":{\"aliquota\":0.9,\"aliquotaEfetiva\":0.2727,\"tributoCalculado\":0.54},\"extensaoTrecho\":10,\"ibsEstadual\":{\"aliquota\":0.1,\"aliquotaEfetiva\":0.0303,\"tributoCalculado\":0.06},\"ibsMunicipal\":{\"aliquota\":0.0,\"aliquotaEfetiva\":0.0000,\"tributoCalculado\":0.00},\"municipio\":3304557,\"numero\":3,\"uf\":\"RJ\"}],\"ufMunicipioOrigem\":\"SP\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00Z\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"sp\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":2E+2,\"trechos\":[{\"numero\":2,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":1E+1},{\"numero\":1,\"municipio\":3509502,\"uf\":\"sp\",\"extensao\":-3}]}",{},200,"{\"baseCalculo\":2E+2,\"cClassTrib\":\"000001\",\"cst\":\"000\",\"dataHoraEmissao\":\"2026-10-20T10:00:00Z\",\"extensaoTotal\":7,\"municipioOrigem\":3550308,\"total\":{\"cbsTotal\":{\"baseCalculo\":\"200.00\",\"valorApurado\":\"1.80\",\"valorDevido\":\"1.80\",\"valorTributo\":\"1.80\"},\"ibsEstadualTotal\":{\"baseCalculo\":\"200.00\",\"valorApurado\":\"0.20\",\"valorDevido\":\"0.20\",\"valorTributo\":\"0.20\"},\"ibsMunicipalTotal\":{\"baseCalculo\":\"200.00\",\"valorApurado\":\"0.00\",\"valorDevido\":\"0.00\",\"valorTributo\":\"0.00\"}},\"trechos\":[{\"baseCalculo\":2E+2,\"cbs\":{\"aliquota\":0.9,\"aliquotaEfetiva\":-0.3857,\"tributoCalculado\":-0.77},\"extensaoTrecho\":-3,\"ibsEstadual\":{\"aliquota\":0.1,\"aliquotaEfetiva\":-0.0429,\"tributoCalculado\":-0.08},\"ibsMunicipal\":{\"aliquota\":0.0,\"aliquotaEfetiva\":0.0000,\"tributoCalculado\":0.00},\"municipio\":3509502,\"numero\":1,\"uf\":\"sp\"},{\"baseCalculo\":2E+2,\"cbs\":{\"aliquota\":0.9,\"aliquotaEfetiva\":1.2857,\"tributoCalculado\":2.57},\"extensaoTrecho\":1E+1,\"ibsEstadual\":{\"aliquota\":0.1,\"aliquotaEfetiva\":0.1429,\"tributoCalculado\":0.28},\"ibsMunicipal\":{\"aliquota\":0.0,\"aliquotaEfetiva\":0.0000,\"tributoCalculado\":0.00},\"municipio\":3550308,\"numero\":2,\"uf\":\"SP\"}],\"ufMunicipioOrigem\":\"sp\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2027-01-01T00:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"SP\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200,\"trechos\":[{\"numero\":1,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":10}]}",{},404,"{\"detail\":\"Alíquota de referencia ou padrão não encontrada para o tributo com id 2, UF null, município null e data 2027-01-01\",\"instance\":\"/api/calculadora/pedagio\",\"status\":404,\"title\":\"Alíquota não encontrada\",\"type\":\"http://localhost/errors/aliquota-nao-encontrada\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"SP\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200,\"trechos\":[{\"numero\":1,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":10},{\"numero\":2,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":-10}]}",{},500,"{\"detail\":\"Division by zero\",\"instance\":\"/api/calculadora/pedagio\",\"status\":500,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"RJ\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200,\"trechos\":[{\"numero\":1,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":10}]}",{},422,"{\"detail\":\"Município de código 3550308 não pertence à UF de sigla RJ\",\"instance\":\"/api/calculadora/pedagio\",\"status\":422,\"title\":\"Município não pertencente à UF\",\"type\":\"http://localhost/errors/municipio-nao-pertencente-uf\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"SP\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200.000,\"trechos\":[{\"numero\":1,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":10}]}",{"accept-language":"en"},400,"{\"detail\":\"Um ou mais campos são inválidos - [baseCalculo: numeric value out of bounds (<13 digits>.<2 digits> expected)] \",\"instance\":\"/api/calculadora/pedagio\",\"status\":400,\"title\":\"Campos inválidos.\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"SP\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200,\"trechos\":[{\"numero\":2,\"municipio\":3550308,\"uf\":\"SP\",\"extensao\":10},{\"numero\":2,\"municipio\":1,\"uf\":\"SP\",\"extensao\":10}]}",{},400,"{\"detail\":\"Número de trecho duplicado: 2\",\"instance\":\"/api/calculadora/pedagio\",\"status\":400,\"title\":\"Campo inválido\",\"type\":\"http://localhost/errors/campo-invalido\"}"],
  ["POST","/api/calculadora/pedagio","{\"dataHoraEmissao\":\"2026-10-20T10:00:00-03:00\",\"codigoMunicipioOrigem\":3550308,\"ufMunicipioOrigem\":\"SP\",\"cst\":\"000\",\"cClassTrib\":\"000001\",\"baseCalculo\":200,\"trechos\":\"x\"}",{},400,"{\"detail\":\"JSON parse error: Cannot deserialize value of type `java.util.ArrayList<br.gov.serpro.rtc.api.model.input.pedagio.TrechoPedagioInput>` from String value (token `JsonToken.VALUE_STRING`)\",\"instance\":\"/api/calculadora/pedagio\",\"status\":400,\"title\":\"Erro de sistema não previsto\",\"type\":\"http://localhost/errors/erro-de-sistema-nao-previsto\"}"],
];

describe('respostas do oráculo (byte a byte, servidor real)', () => {
  let s;
  before(async () => { const { subir } = await import('../lib/servidor.js'); s = await subir(); });
  after(() => s?.fechar());
  for (const [metodo, caminho, corpo, headers, status, resposta] of CAPTURADOS) {
    test(`${metodo} ${caminho} ${corpo ?? ''} ${JSON.stringify(headers)}`.slice(0, 220), async () => {
      const r = await s.chamar(caminho, { method: metodo, headers: { ...(corpo !== null ? { 'content-type': 'application/json' } : {}), ...headers }, body: corpo ?? undefined });
      assert.equal(r.status, status, r.texto);
      assert.equal(normalizar(r.texto), normalizar(resposta));
      assert.equal(r.headers['content-type'], status === 200 ? 'application/json' : 'application/problem+json');
    });
  }
  test('E3: avisos (Set.of no Java) na ordem de declaração dos elementos', async () => {
    const r = await s.chamar('/api/calculadora/base-calculo/base-calculo-unificada', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"anoFatoGerador":2026,"tipoDocumento":65,"natureza":"SERVICO","vProd":100,"vII":5,"vIS":3,"vICMS":7,"vISSQN":2}' });
    assert.equal(r.texto, '{"avisos":["Campo vII não compõe as bases para a natureza SERVICO (aplicável apenas a BEM) e foi ignorado no cálculo",'
      + '"Campo vIS não compõe as bases para o ano 2026 (vigência 2027–2033) e foi ignorado no cálculo",'
      + '"Campo vICMS não compõe as bases para a natureza SERVICO (aplicável apenas a BEM) e foi ignorado no cálculo"],"baseIS":98.00,"baseRG":98.00,"baseSN":100.00}');
  });
  test('E12: sem cabeçalho x-warning-dados-simulados em 2026', async () => {
    const r = await s.chamar('/api/calculadora/pedagio', { method: 'POST', headers: { 'content-type': 'application/json' }, body: CAPTURADOS.find((c) => c[0] === 'POST' && c[1] === '/api/calculadora/pedagio')[2] });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-warning-dados-simulados'], undefined);
  });
});

// ─── 4. Java/Tomcat/Spring semantics of this slice ──────────────────────────────

describe('Accept-Language → Locale (Tomcat 11.0.27 AcceptLanguage2, legado)', () => {
  const casos = [
    [null, 'pt_BR_'], ['', 'pt_BR_'], ['en', 'en__'], ['pt-BR', 'pt_BR_'], ['PT-br', 'pt_BR_'], ['pt_BR', '__'], ['*', '__'], ['x-klingon', '__'],
    ['zh-Hant', 'zh__HANT'], ['zh-Hant-TW', 'zh_TW_HANT'], ['zh-min-nan', 'zh__'], ['de-CH-1996', 'de_CH_1996'], ['es-419', 'es_419_'],
    ['fr;q=0.5, de', 'de__'], ['de;q=0.5, fr', 'fr__'], ['en;q=0', 'pt_BR_'], ['en;q=0, fr', 'fr__'], [',,de', 'de__'], ['fr;q=abc', 'pt_BR_'],
    ['fr;q=0.5;x=1', 'pt_BR_'], ['en-GB, fr;q=1.0', 'en_GB_'], ['iw', 'he__'], ['i-default', '__'],
  ];
  for (const [h, esperado] of casos) {
    test(`${JSON.stringify(h)} → ${esperado}`, () => {
      const l = localeDaRequisicao(h);
      assert.equal(`${l.idioma}_${l.pais}_${l.variante}`, esperado);
    });
  }
  test('localeLegado: script vira variante em maiúsculas', () => assert.deepEqual(localeLegado('zh-Hans-CN'), { idioma: 'zh', pais: 'CN', variante: 'HANS' }));
});

describe('mensagens do Hibernate Validator 9.1.5 por idioma (como no oráculo)', () => {
  const casos = [
    [null, 'Min', { value: 0 }, 'deve ser maior que ou igual à 0'],
    ['pt', 'Min', { value: 0 }, 'deve ser maior que ou igual a 0'],
    ['pt-PT', 'Min', { value: 0 }, 'deve ser maior que ou igual a 0'],
    ['en', 'Min', { value: 0 }, 'must be greater than or equal to 0'],
    ['pt_BR', 'Min', { value: 0 }, 'must be greater than or equal to 0'],
    ['xx', 'Min', { value: 0 }, 'deve ser maior que ou igual à 0'],
    ['mn', 'Min', { value: 0 }, 'deve ser maior que ou igual à 0'],
    ['mn-MN', 'Min', { value: 0 }, '0-аас их буюу тэнцүү байх ёстой'],
    ['zh-Hant', 'Min', { value: 0 }, '必须大于或等于 0'],
    ['zh-TW', 'Min', { value: 0 }, '必須大於或等於 0'],
    ['zh-CN', 'Min', { value: 0 }, '最小不能小于0'],
    ['zh-HK', 'Min', { value: 0 }, '必须大于或等于 0'],
    ['tr', 'Min', { value: 0 }, "'0' değerinden büyük yada eşit olmalı"],
    ['az', 'Min', { value: 0 }, '0-dan böyük bərabər olmalıdır'],
    ['az', 'Min', { value: 1 }, '1-dən böyük bərabər olmalıdır'],
    ['fr', 'Size', { min: 2, max: 2 }, 'la taille doit être comprise entre 2 et 2'],
    [null, 'Digits', { integer: 13, fraction: 2 }, 'valor númerico fora do limite (<13 dígito>.<2 dígitos> esperar)'],
    ['en', 'Digits', { integer: 13, fraction: 2 }, 'numeric value out of bounds (<13 digits>.<2 digits> expected)'],
    [null, 'NotNull', {}, 'não deve ser nulo'],
    [null, 'NotEmpty', {}, 'não deve estar vazio'],
    [null, 'NotBlank', {}, 'não deve estar em branco'],
    [null, 'PositiveOrZero', {}, 'deve ser maior ou igual a 0'],
    [null, 'Positive', {}, 'deve ser maior que 0'],
  ];
  for (const [h, restricao, attrs, esperado] of casos) {
    test(`${h} ${restricao} → ${esperado}`, () => assert.equal(mensagemPadrao(localeDaRequisicao(h), restricao, attrs), esperado));
  }
});

describe('@RequestParam LocalDate (SHORT localizado + ISO) e Integer', () => {
  const datas = [
    ['2026-01-01', null, '2026-01-01'], ['20/01/2026', null, '2026-01-20'], ['30/02/2026', null, '2026-02-28'], ['31/04/2026', null, '2026-04-30'],
    ['32/01/2026', null, null], ['20/1/2026', null, null], ['20/01/26', null, '0026-01-20'], ['20/01/0', null, null], ['20/01/+2026', null, null],
    ['20/01/-2026', null, null], ['20/01/02026', null, '2026-01-20'], ['1/20/26', 'en-US', '2026-01-20'], ['1/20/2026', 'en-US', null],
    ['20/01/2026', 'en-US', null], ['20.01.26', 'de', '2026-01-20'], ['26-01-20', '*', '0026-01-20'], ['20/01/2026', 'pt-PT', null],
    ['20/01/2026', 'xx', null], ['2026-1-20', null, null], ['+2026-01-20', null, null], ['20/01/10000', null, '+10000-01-20'],
    ['20/01/2026 ', null, null], ['2026/01/20', 'ja', '2026-01-20'], ['20/1/26', 'es', '2026-01-20'], ['20/01/2026', 'it', null],
    ['1/20/26', 'zh', null], ['2026/1/20', 'zh', '2026-01-20'], ['2026-02-30', null, null], ['x', null, null],
  ];
  for (const [texto, idioma, esperado] of datas) {
    test(`${texto} (${idioma ?? 'padrão'}) → ${esperado}`, () => assert.equal(converterData(texto, localeDaRequisicao(idioma)), esperado));
  }
  const params = (v) => ({ valores: () => (v === undefined ? null : [].concat(v)) });
  const inteiros = [[undefined, null], ['', null], [' ', null], ['\u001c', null], [' ', null], ['2', 2], ['0x1', 1], ['+5', 5], ['007', 7], [' 1 2', 12],
    ['#A', 10], ['-0x2', -2], ['-#0', 0], ['-0x80000000', -2147483648], ['२', 2], ['１', 1], [['1', '2'], 1]];
  for (const [v, esperado] of inteiros) test(`codigo=${JSON.stringify(v)} → ${esperado}`, () => assert.equal(parametroInteger(params(v), 'codigo'), esperado));
  for (const v of ['x', '-', '0x', '+0x1', '1.0', '99999999999', '\u0001', ' ', '0x80000000', '0x-1', '#', '00x1']) {
    test(`codigo=${JSON.stringify(v)} → 400`, () => assert.throws(() => parametroInteger(params(v), 'codigo'), (e) => e.classeJava === 'MethodArgumentTypeMismatchException' && e.valor === v));
  }
});

describe('BaseCalculoNatureza.fromString', () => {
  for (const [t, e] of [['bem', 'BEM'], ['Bém', 'BEM'], ['serviço', 'SERVICO'], ['SERVIÇO', 'SERVICO'], [' bem', null], ['bem ', null], ['', null], ['  ', null], ['x', null], ['1', null], [null, null]]) {
    test(`${JSON.stringify(t)} → ${e}`, () => assert.equal(naturezaDeTexto(t), e));
  }
});
