// Every remaining 'unit:*' vector of the official Simples repo (test/fixtures/simples/official-vectors.json)
// that maps onto a function of our port. Mocked collaborators are built from each vector's `mocks`
// (Mockito stubs) plus meta.defaultMocks / meta.fixtures; unstubbed calls return Mockito defaults
// (false / 0 / empty / null). Vectors already covered elsewhere: calcularItem and escolher
// (official-units.test.js), AtividadeSimplesService.* and DerivacaoAnexosSimples.derivar (atividades.test.js).
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Dec } from '../../src/core/decimal.js';
import { openDb } from '../../src/simples/rtc/db.js';
import { createEngine, contextoClassico, avisoParSemRedistribuicaoAusente } from '../../src/simples/rtc/engine.js';
import * as A from '../../src/simples/rtc/arredondamento.js';
import { lerCorpoJson, TIPOS } from '../../src/simples/rtc/jackson.js';
import * as N from '../../src/simples/rtc/nomenclatura.js';

const { meta, vectors } = JSON.parse(readFileSync(new URL('../fixtures/simples/official-vectors.json', import.meta.url)));
const db = openDb(fileURLToPath(new URL('../../data/calculadora-pro.db', import.meta.url)));
const porEndpoint = (e) => vectors.filter((v) => v.endpoint === `unit:${e}`);

/** BigDecimal text (plain or with exponent, e.g. "0E-8") → Dec keeping the scale. */
function bd(t) {
  if (t == null) return null;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(t));
  const frac = m[3] ?? '';
  return new Dec(BigInt(m[2] + frac) * (m[1] === '-' ? -1n : 1n), frac.length - Number(m[4] ?? 0));
}
const texto = (v) => (v == null ? '<null>' : v instanceof Dec ? v.toString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** compareTo for numbers; text otherwise (Mockito/AssertJ conventions of the vectors). */
function igual(atual, esperado) {
  if (esperado === '<null>') return atual == null;
  if (esperado === '<present>') return atual != null;
  if (esperado === '<none>') return atual == null;
  const c = /^<contains:([\s\S]*)>$/.exec(esperado);
  if (c) return Array.isArray(atual) ? atual.some((x) => String(x).includes(c[1])) : String(atual ?? '').includes(c[1]);
  if (esperado === '>0') return Number(atual) > 0;
  if (atual instanceof Dec || (typeof atual === 'string' && /^-?\d+(\.\d+)?$/.test(atual) && /^-?\d+(\.\d+)?$/.test(esperado))) {
    return /^-?\d+(\.\d+)?$/.test(esperado) && Dec.of(String(atual)).cmp(esperado) === 0;
  }
  if (typeof atual === 'boolean' || typeof atual === 'number') return String(atual) === esperado;
  if (atual != null && typeof atual === 'object') return JSON.stringify(atual) === esperado || JSON.stringify(atual.map?.(texto)) === esperado;
  return String(atual) === esperado;
}
/** a.b[0].c / a[*].b / x.length() over plain objects. */
function em(o, caminho) {
  const toks = [...caminho.matchAll(/([^.[\]]+)|\[(\d+|\*)\]/g)].map((m) => m[1] ?? m[2]);
  let cur = [o], multi = false;
  for (const t of toks) {
    if (t === 'length()') { cur = cur.map((c) => c?.length); continue; }
    if (t === '*') { multi = true; cur = cur.flatMap((c) => (Array.isArray(c) ? c : [])); continue; }
    cur = cur.map((c) => (c == null ? undefined : c[t]));
  }
  return multi ? cur : cur[0];
}
function conferir(resultado, esperado, ignorar = []) {
  const falhas = [];
  for (const [k, e] of Object.entries(esperado)) {
    if (ignorar.includes(k)) continue;
    const a = em(resultado, k);
    const ok = Array.isArray(a) && k.includes('[*]') && !e.startsWith('[') && !e.startsWith('<contains') ? a.every((x) => igual(x, e)) : igual(Array.isArray(a) && e.startsWith('[') && a.every((x) => typeof x === 'string') ? a : a, e);
    if (!ok) falhas.push(`${k}: ${texto(a)} != ${e}`);
  }
  return falhas;
}

// ── mocks (Mockito-like): stubs by method and argument pattern, call log ─────
function argsDe(lista) {
  const args = [];
  let atual = '', aspas = false, nivel = 0;
  for (const c of lista) {
    if (c === "'") aspas = !aspas;
    if (!aspas && (c === '(' || c === '{' || c === '[')) nivel++;
    if (!aspas && (c === ')' || c === '}' || c === ']')) nivel--;
    if (c === ',' && !aspas && nivel === 0) { args.push(atual.trim()); atual = ''; } else atual += c;
  }
  if (atual.trim()) args.push(atual.trim());
  return args;
}
const semAspas = (s) => s.replace(/^'(.*)'$/, '$1');
/** Mock value → result; "throws X('a','b')" throws the Java exception (domain ones from nomenclatura.js). */
function valorMock(v) {
  if (v === 'Optional.empty()') return null;
  const t = typeof v === 'string' && /^throws (\w+)\((.*)\)$/.exec(v);
  if (t) {
    const args = argsDe(t[2]).map(semAspas);
    const Classe = N[t[1]];
    throw Classe ? new Classe(...args) : Object.assign(new Error(args[0]), { name: t[1] });
  }
  return v;
}
function criarMocks(mocks = {}) {
  const chamadas = [];
  const stubs = Object.entries(mocks).map(([k, v]) => {
    const m = /^([\w.]+)(?:\((.*)\))?$/.exec(k);
    return { nome: m[1], args: m[2] == null ? null : argsDe(m[2]), valor: v };
  });
  /** Calls `nome(args)`: records it and answers the first matching stub (or undefined). */
  function chamar(nome, ...args) {
    chamadas.push({ nome, args });
    for (const s of stubs) {
      if (s.nome !== nome) continue;
      if (s.args && !s.args.every((p, i) => p === '*' || (i < args.length && semAspas(p) === String(args[i])))) continue;
      return { achou: true, valor: valorMock(s.valor) };
    }
    return { achou: false };
  }
  const contagem = (nome) => chamadas.filter((c) => c.nome === nome || c.nome.endsWith(`.${nome}`)).length;
  return { chamar, chamadas, contagem };
}

/** Checks the "calls" expectation clauses that can be checked (Mockito verify). */
function conferirChamadas(descricao, { contagem, chamadas }) {
  const falhas = [];
  for (const clausula of descricao.split(';').map((s) => s.trim()).filter(Boolean)) {
    let m;
    if ((m = /^(.+?) never called$/.exec(clausula))) {
      for (const n of m[1].split(/\s*\/\s*|\s*,\s*/)) if (contagem(n.trim())) falhas.push(`${n} called`);
    } else if ((m = /^no interaction with (.+)$/.exec(clausula))) {
      for (const n of m[1].split(/\s*\/\s*|\s*,\s*/)) {
        const alvo = { ncmService: 'existeNcm', nbsService: 'existeNbs', ncm: 'existeNcm', nbs: 'existeNbs', validacaoNomenclaturaService: 'validar', validacao: 'validar', 'validacao services': 'validar', atividadeRepository: 'buscarVigentesPorCAtivSN' }[n.trim()] ?? n.trim();
        if (contagem(alvo)) falhas.push(`${alvo} called`);
      }
    } else if ((m = /^(.+?) called exactly once$/.exec(clausula))) {
      if (contagem(m[1]) !== 1) falhas.push(`${m[1]} called ${contagem(m[1])}x`);
    } else if (clausula === 'no aplicavel/excecao queries') {
      for (const n of ['temAplicavel', 'temExcecaoAplicavel', 'temAplicavelSemExcecao']) if (contagem(n)) falhas.push(`${n} called`);
    } else if (clausula === 'nbs untouched') {
      if (chamadas.some((c) => c.nome.startsWith('nbs.'))) falhas.push('nbs called');
    } else if ((m = /^no (.+) calls$/.exec(clausula))) {
      for (const n of m[1].split(/\s*\/\s*/)) {
        const alvo = n.trim() === 'atividade repository' ? 'buscarVigentesPorCAtivSN' : n.trim();
        if (contagem(alvo)) falhas.push(`${alvo} called`);
      }
    } else if ((m = /^([\w.]+)\((.*)\)$/.exec(clausula))) {
      const nome = m[1], padrao = argsDe(m[2]);
      const casa = chamadas.some((c) => (c.nome === nome || c.nome.endsWith(`.${nome}`)) && padrao.every((p, i) => {
        if (p === '*' || p === '...') return true;
        const kv = /^(ncm|nbs)=(.*)$/.exec(p);
        if (kv) return texto(c.args[kv[1] === 'ncm' ? 3 : 4]).replace('<null>', 'null') === semAspas(kv[2]);
        if (padrao[0] === '...') return true;
        return semAspas(p) === (c.args[i] == null ? 'null' : String(c.args[i]));
      }));
      if (!casa) falhas.push(`missing call ${clausula}`);
    } else {
      falhas.push(`cláusula de chamada não verificável: ${clausula}`);
    }
  }
  return falhas;
}

// ── real-DB parameter / repository vectors ──────────────────────────────────
const bool = (v) => (v == null ? null : Number(v) === 1);
const efeito = (r) => r && {
  descricao: r.descricao, compoeReceita: bool(r.compoeReceita), impostoSeletivoCompoeReceita: bool(r.isCompoeReceita), fatorReceita: Dec.of(r.fatorReceita),
  pendenteSuspenso: bool(r.pendenteSuspenso), exigeAliquota: bool(r.exigeAliquota), vedadoNaoTributavel: bool(r.vedadoNaoTributavel), vocabularioRegime: r.vocabularioRegime,
};
const regimeDe = (r) => r && { id: Number(r.id), codigo: r.codigo, calculaTributos: bool(r.calculaTributos), geraIbs: bool(r.geraIbs), destinoDevido: r.destinoDevido, destinoPendenteSuspenso: r.destinoPendenteSuspenso };
const REGIMES = { CRT_1: ['CRT', 1, null], CRT_2: ['CRT', 2, null], CRT_3_TPREGIME_2: ['CRT', 3, 2] };

for (const v of porEndpoint('ClassificacaoTributariaSimplesRepository.contarTratamentosNaoImplementados')) {
  test(v.id, () => {
    const falhas = [];
    for (const [k, e] of Object.entries(v.expected)) {
      const [codigo, data] = k.split('@');
      const n = db.contarTratamentosNaoImplementados(codigo, data ?? v.input.data);
      if (!igual(n, e)) falhas.push(`${k}: ${n} != ${e}`);
    }
    assert.deepEqual(falhas, []);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.tpDocSuportado')) {
  test(v.id, () => {
    for (const [tpDoc, e] of Object.entries(v.expected)) assert.equal(String(db.contarVinculosVigentesTipoDfeCalculo(Number(tpDoc), v.input.data) > 0), e, tpDoc);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarTipoReceitaBruta')) {
  test(v.id, () => {
    for (const data of v.input.datas) {
      const r = efeito(db.buscarTipoReceitaBruta(v.input.codigo, null, data));
      assert.deepEqual(conferir({ present: r != null, ...r }, v.expected), [], data);
    }
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarTipoReceitaBruta(vocab)')) {
  test(v.id, () => {
    const r = efeito(db.buscarTipoReceitaBruta(v.input.codigo, v.input.vocabulario, v.input.data));
    assert.deepEqual(conferir(r, v.expected), []);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarRegimeApuracao')) {
  test(v.id, () => {
    const [vocab, crt, tp] = REGIMES[v.input.regime];
    const r = regimeDe(db.buscarRegimeApuracao(vocab, crt, tp, null, null, v.input.data));
    assert.deepEqual(conferir({ present: r != null, ...r }, v.expected), []);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarRegimeApuracao(vocab)')) {
  test(v.id, () => {
    const i = v.input;
    if (i.consultas) { // "NFSE(4,2)" = opSimpNac, regApIBSCBSSN; "CRT(1,null)" = CRT, tpRegimeIBSCBS
      const res = {};
      for (const q of i.consultas) {
        const [, voc, a, b] = /^(\w+)\((\w+),(\w+)\)$/.exec(q);
        const n = (x) => (x === 'null' ? null : Number(x));
        res[q] = regimeDe(voc === 'NFSE' ? db.buscarRegimeApuracao('NFSE', null, null, n(a), n(b), i.data) : db.buscarRegimeApuracao('CRT', n(a), n(b), null, null, i.data));
      }
      const falhas = Object.entries(v.expected).filter(([k, e]) => { const [q, campo] = [k.slice(0, k.indexOf(').') + 1), k.slice(k.indexOf(').') + 2)]; return !igual(res[q]?.[campo], e); }).map(([k, e]) => `${k} != ${e}`);
      assert.deepEqual(falhas, []);
      return;
    }
    const r = regimeDe(db.buscarRegimeApuracao(i.vocabulario, i.CRT, i.tpRegimeIBSCBS, i.opSimpNac, i.regApIBSCBSSN, i.data));
    assert.deepEqual(conferir({ present: r != null, ...r }, v.expected), []);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarTipoDfeCalculo')) {
  test(v.id, () => {
    const r = db.buscarTipoDfeCalculo(v.input.tpDoc, v.input.data);
    const view = r && { vocabularioRegime: r.vocabulario, casasAliquotaCalculo: r.casas, maximoItens: r.maximoItens, admiteImpostoSeletivo: bool(r.admiteIs) };
    assert.deepEqual(conferir({ present: r != null, ...view }, v.expected), []);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarFatorTransicaoCompraGov')) {
  test(v.id, () => {
    const f = db.buscarFatorTransicaoCompraGov(v.input.data);
    assert.deepEqual(conferir({ present: f != null, fator: f }, v.expected), []);
  });
}
for (const v of porEndpoint('ParametroCalculoSimplesService.buscarSituacoesIssParAliquota')) {
  test(v.id, () => {
    const s = db.buscarSituacoesIss(v.input.data);
    assert.equal(String(s.length), v.expected.size);
    for (const regra of ['ISS_FORA_DO_SIMPLES', 'ISS_NAO_INCIDE', 'ISENCAO_MUNICIPAL', 'ISS_RETIDO']) {
      assert.equal(JSON.stringify(s.filter((x) => x.regra === regra).map((x) => `${x.campo}=${x.valor}`)), v.expected[regra], regra);
    }
    const ordinal = { ISS_FORA_DO_SIMPLES: 4, ISS_NAO_INCIDE: 6, ISENCAO_MUNICIPAL: 7, ISS_RETIDO: 8 }; // regra.ordinal()+1
    for (const x of s) { assert.equal(x.tipoAliquota, v.expected['*.tipoAliquota']); assert.equal(Number(x.ordem), ordinal[x.regra]); }
  });
}
for (const v of porEndpoint('TransicaoAliquotaCompraGovSimplesRepository.findAll')) {
  test(v.id, () => {
    const linhas = db.listarTransicoesCompraGov();
    assert.equal(String(linhas.length), v.expected.size);
    for (let d = new Date('2027-01-01T00:00:00Z'); d <= new Date('2035-12-31T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const dia = d.toISOString().slice(0, 10);
      const n = linhas.filter((l) => l.inicioVigencia <= dia && (l.fimVigencia == null || dia <= l.fimVigencia)).length;
      assert.equal(String(n), v.expected['vigentesPorDia[2027-01-01..2035-12-31]'], dia);
    }
  });
}
for (const v of porEndpoint('AtividadeSimplesRepository.buscarVigentes')) {
  test(v.id, () => {
    const lista = db.buscarAtividadesVigentes(v.input.data);
    const falhas = [];
    for (const [k, e] of Object.entries(v.expected)) {
      if (k === 'size') { if (String(lista.length) !== e) falhas.push(`size ${lista.length}`); continue; }
      const [chave, campo] = k.replace(/#\d+$/, '').split('.'); // "x#2": second assertion on the same field
      const a = chave.startsWith('ordem') ? lista.find((x) => x.ordem === Number(chave.slice(5))) : lista.find((x) => x.cAtivSN === chave);
      if (!igual(a?.[campo], e)) falhas.push(`${k}: ${texto(a?.[campo])} != ${e}`);
    }
    assert.deepEqual(falhas, []);
  });
}
for (const v of porEndpoint('AtividadeSimplesRepository.buscarVinculosTpDocVigentes')) {
  test(v.id, () => {
    const vinculos = db.buscarVinculosTpDocVigentes(v.input.data);
    const cativ = new Map(db.buscarAtividadesVigentes(v.input.data).map((a) => [a.id, a.cAtivSN]));
    assert.equal(String(vinculos.length), v.expected.size);
    for (const [k, e] of Object.entries(v.expected)) {
      if (k === 'size') continue;
      assert.equal(JSON.stringify(vinculos.filter((x) => cativ.get(x.atividadeId) === k).map((x) => x.tpDoc).sort((a, b) => a - b)), e, k);
    }
  });
}

// ── ArredondamentoUtils ──────────────────────────────────────────────────────
/** java.util.Random (48-bit LCG) for the property vectors. */
function javaRandom(semente) {
  const MASK = (1n << 48n) - 1n;
  let s = (BigInt(semente) ^ 0x5DEECE66Dn) & MASK;
  const next = (bits) => { s = (s * 0x5DEECE66Dn + 0xBn) & MASK; return BigInt.asIntN(32, s >> BigInt(48 - bits)); };
  return {
    nextInt(bound) {
      if ((bound & -bound) === bound) return Number((BigInt(bound) * next(31)) >> 31n);
      let bits, val;
      do { bits = Number(next(31)); val = bits % bound; } while (bits - val + (bound - 1) > 2147483647);
      return val;
    },
    nextLong() { return BigInt.asIntN(64, (next(32) << 32n) + next(32)); },
  };
}
const valueOf = (unscaled, escala) => new Dec(BigInt(unscaled), escala); // BigDecimal.valueOf(long, scale)

for (const v of vectors.filter((x) => x.endpoint.startsWith('unit:ArredondamentoUtils.'))) {
  const metodo = v.endpoint.split('.')[1];
  test(v.id, () => {
    if (metodo === 'MODO') {
      assert.equal(A.MODO, v.expected.MODO);
      assert.equal(A.CONTEXTO_DIVISAO.roundingMode, v.expected['CONTEXTO_DIVISAO.roundingMode']);
      assert.equal(String(A.CONTEXTO_DIVISAO.precision), v.expected['CONTEXTO_DIVISAO.precision']);
      return;
    }
    if (v.input.generator) {
      const r = javaRandom(20261117n);
      for (let k = 0; k < 2000; k++) {
        if (metodo === 'ratearValorFiscal') {
          const n = 1 + r.nextInt(12);
          const exatas = Array.from({ length: n }, () => valueOf(r.nextInt(5_000_000), 6));
          const parcelas = A.ratearValorFiscal(exatas);
          assert.equal(A.totalizar(parcelas).cmp(A.arredondarValorFiscal(A.totalizar(exatas))), 0);
          for (let i = 0; i < n; i++) {
            assert.equal(parcelas[i].s, 2);
            const d = parcelas[i].sub(exatas[i]);
            assert.ok((d.signum() < 0 ? d.neg() : d).cmp('0.01') < 0);
          }
        } else if (metodo === 'formatarMoeda') {
          let l = r.nextLong() % 1_000_000_000_000n; if (l < 0n) l = -l;
          const val = A.arredondarValorFiscal(valueOf(l, 5));
          assert.equal(Dec.of(A.formatarMoeda(val)).cmp(val), 0);
        } else if (metodo === 'formatarAliquota') {
          const a = A.arredondarAliquotaPublicada(valueOf(r.nextInt(100_000_000), 6));
          assert.equal(Dec.of(A.formatarAliquota(a)).cmp(a), 0);
        } else throw new Error(`gerador sem mapeamento: ${metodo}`);
      }
      return;
    }
    const args = v.input.args.map((a) => (Array.isArray(a) ? a.map(bd) : typeof a === 'number' ? a : bd(a)));
    const r = A[metodo](...args);
    for (const [k, e] of Object.entries(v.expected)) {
      if (k === 'result.precision()') { assert.equal(String(A.precisao(r)), e); continue; }
      if (e === '<null>') { assert.equal(r, null); continue; }
      if (Array.isArray(r)) { assert.equal(JSON.stringify(r.map((x) => x.toString())), e); continue; }
      if (typeof r === 'string') { assert.equal(r, e); continue; }
      const esperado = bd(e); // BigDecimal.equals: value AND scale
      assert.equal(`${r.u}/${r.s}`, `${esperado.u}/${esperado.s}`, `${r} != ${e}`);
    }
  });
}

// ── small pure functions of the engine / binder ─────────────────────────────
const engineReal = createEngine(db);
for (const v of porEndpoint('ProcessadorItemSimples.normalizarCAtivSN')) {
  test(v.id, () => assert.equal(engineReal._internals.normalizarCAtivSN(v.input.cAtivSN, v.input.normalizar), v.expected.result));
}
for (const v of porEndpoint('EscolhaParAliquotasService.avisoParSemRedistribuicaoAusente')) {
  test(v.id, () => assert.ok(igual(avisoParSemRedistribuicaoAusente(v.input.anexo), v.expected.result)));
}
for (const v of porEndpoint('ContextoItemSimples.classico')) {
  test(v.id, () => {
    const i = v.input;
    const c = contextoClassico(i.data, i.tpDoc, i.regime, i.tpEnteGov, i.fatorTransicaoCompraGov, i.siglaDfe, i.permiteNcmZero);
    const view = { vocabularioTipoReceita: c.vocabularioTipoReceita, casasAliquotaCalculo: c.casas, admiteImpostoSeletivo: c.admiteIs, normalizarCAtivSN: c.normalizarCAtivSN };
    assert.deepEqual(conferir(view, v.expected), []);
  });
}
for (const v of porEndpoint('ItemSimplesUnificadoInput(json)')) {
  test(v.id, () => {
    const item = lerCorpoJson(new TextEncoder().encode(JSON.stringify(v.input.json)), TIPOS.ItemSimplesUnificadoInput, '');
    assert.equal(item.ncm, v.expected['NCM()']); // component NCM, JSON property "ncm" with @JsonAlias("NCM")
  });
}
for (const v of porEndpoint('EscolhaParAliquotasService.avaliarCamposIss')) {
  test(v.id, () => {
    const { avaliarCamposIss, Collector } = engineReal._internals;
    const collector = new Collector(v.input.collector.indice, v.input.collector.baseURL);
    const r = avaliarCamposIss(v.input.vocabulario, v.input.atividade, v.input.campos, collector);
    const view = { ...r, collector: { hasErros: collector.hasErros(), erros: collector.erros.map((e) => ({ ...e })) } };
    const falhas = [];
    for (const [k, e] of Object.entries(v.expected)) {
      const a = em(view, k);
      const ok = k.includes('[*]') ? JSON.stringify(a) === e : k === 'avisos' ? JSON.stringify(a) === e : igual(a, e);
      if (!ok) falhas.push(`${k}: ${texto(a)} != ${e}`);
    }
    assert.deepEqual(falhas, []);
  });
}

// ── NcmAplicavelService / NbsAplicavelService / ValidacaoNomenclaturaService ──
function aplicavelMock(prefixo, mocks, log) {
  const registrar = (nome, valor) => (...args) => { log.push({ nome: `${prefixo}.${nome}`, args }); return valor; };
  return {
    tem: registrar('tem', mocks.tem ?? false), temAplicavel: registrar('temAplicavel', mocks.temAplicavel ?? false),
    temExcecaoAplicavel: registrar('temExcecaoAplicavel', mocks.temExcecaoAplicavel ?? false), temAplicavelSemExcecao: registrar('temAplicavelSemExcecao', mocks.temAplicavelSemExcecao ?? false),
  };
}
const exigir = (v, f) => {
  let erro = null, resultado;
  try { resultado = f(); } catch (e) { erro = e; }
  const esperado = v.expected.throws;
  if (esperado === '<none>' || esperado == null) assert.equal(erro, null, String(erro));
  else assert.equal(erro?.constructor?.name, esperado, String(erro));
  if (v.expected.result) assert.equal(String(resultado), v.expected.result);
};
for (const v of vectors.filter((x) => /^unit:(Ncm|Nbs)AplicavelService\./.test(x.endpoint))) {
  test(v.id, () => {
    const ncm = v.endpoint.includes(':Ncm');
    const log = [];
    const servico = (ncm ? N.criarNcmAplicavelService : N.criarNbsAplicavelService)(aplicavelMock(ncm ? 'ncm' : 'nbs', v.input.mocks, log));
    const i = v.input;
    exigir(v, () => (v.endpoint.endsWith('ContraAnexo') ? servico.criticarContraAnexo : servico.validar)(i.codigo, i.id, i.cClassTrib, i.data, i.tributos));
    if (v.expected.calls) {
      const contagem = (n) => log.filter((c) => c.nome.endsWith(`.${n.replace(/^tem(Ncm|Nbs)Aplicavel$/, 'temAplicavel')}`)).length;
      assert.deepEqual(conferirChamadas(v.expected.calls, { contagem, chamadas: log }), []);
    }
  });
}
for (const v of porEndpoint('ValidacaoNomenclaturaService.validar')) {
  test(v.id, () => {
    const log = [];
    const registrar = (nome) => (...args) => { log.push({ nome, args }); };
    const servico = N.criarValidacaoNomenclaturaService({
      nomenclaturaService: { determinarNomenclatura: () => v.input.mocks.determinarNomenclatura },
      ncmAplicavelService: { validar: registrar('ncm.validarNcmAplicavel'), criticarContraAnexo: registrar('ncm.criticarNcmContraAnexo') },
      nbsAplicavelService: { validar: registrar('nbs.validarNbsAplicavel'), criticarContraAnexo: registrar('nbs.criticarNbsContraAnexo') },
    });
    const i = v.input;
    exigir(v, () => servico.validar(i.dfe, i.id, i.cClassTrib, i.ncm, i.nbs, i.data, i.tributos, i.modo));
    if (v.expected.calls) {
      const contagem = (n) => log.filter((c) => c.nome === n || c.nome.endsWith(`.${n}`)).length;
      assert.deepEqual(conferirChamadas(v.expected.calls, { contagem, chamadas: log }), []);
    }
  });
}

// ── ProcessadorItemSimples / SimplesNacionalObservabilidadeService / CalculoSimplesUnificadoService (mocked) ──
const F = meta.fixtures;
const linhaReceita = (e) => e && { ...e, isCompoeReceita: e.impostoSeletivoCompoeReceita };
/** Repositories of the engine answering from the vector's stubs, meta.defaultMocks and Mockito defaults. */
function dbMockado(mocks, { classico = false } = {}) {
  const m = criarMocks(mocks);
  const ou = (r, padrao) => (r.achou ? r.valor : padrao);
  const repo = {
    contarSemTratamentoCalculadoraVigentes: (tpDoc) => {
      const r = m.chamar('parametroService.tpDocSemTratamentoCalculadora', tpDoc);
      if (r.achou && typeof r.valor === 'string') return [77, 94, 95, 96].includes(tpDoc) ? 1 : 0; // "true iff tpDoc in {77,94,95,96}"
      return ou(r, false) ? 1 : 0;
    },
    contarVinculosVigentesTipoDfeCalculo: (tpDoc) => { m.chamar('parametroService.tpDocSuportado', tpDoc); return classico && [55, 65].includes(tpDoc) ? 1 : 0; },
    buscarTipoDfeCalculo: (tpDoc) => {
      const r = m.chamar('parametroService.buscarTipoDfeCalculo', tpDoc);
      if (r.achou) return r.valor && { tipoDfeId: r.valor.tipoDfeId, vocabulario: r.valor.vocabularioRegime, casas: r.valor.casasAliquotaCalculo, maximoItens: r.valor.maximoItens, admiteIs: r.valor.admiteImpostoSeletivo ? 1 : 0 };
      return classico ? { tipoDfeId: tpDoc, vocabulario: null, casas: null, maximoItens: null, admiteIs: null } : null;
    },
    buscarSiglaVigentePorId: (id, data) => { m.chamar('tipoDfeRepository.buscarSiglaVigentePorId', id, data); return id === 65 ? 'NFCe' : id === 91 ? 'NFSe' : 'NFe'; },
    permiteNcmZeroVigentePorId: () => false,
    buscarRegimeApuracao: (vocab, crt, tp) => {
      const r = m.chamar('parametroService.buscarRegimeApuracao', crt === 1 ? 'CRT_1' : crt === 2 ? 'CRT_2' : 'CRT_3_TPREGIME_2');
      if (r.achou) return r.valor;
      const f = vocab === 'CRT' && crt === 1 && tp == null ? F.regimeCrt1 : vocab === 'CRT' && crt === 2 && tp == null ? F.regimeCrt2 : vocab === 'CRT' && crt === 3 && tp === 2 ? F.regimeCrt3TpRegime2 : null;
      return f && { ...f, calculaTributos: f.calculaTributos ? 1 : 0, geraIbs: f.geraIbs == null ? null : f.geraIbs ? 1 : 0 };
    },
    buscarFatorTransicaoCompraGov: (data) => (data < '2027-01-01' ? null : '0.00'),
    buscarTipoReceitaBruta: (codigo, vocab) => {
      const r = m.chamar('parametroService.buscarTipoReceitaBruta', codigo, vocab ?? '*');
      if (r.achou) return linhaReceita(r.valor);
      return linhaReceita((vocab === 'NFSE' ? F.tipoReceitaNfse : F.tipoReceita)[codigo]) ?? null;
    },
    contarTratamentosNaoImplementados: (codigo) => ou(m.chamar('classificacaoRepository.contarTratamentosNaoImplementados', codigo), 0),
    buscarClassificacoesVigentes: (codigo) => ou(m.chamar('classificacaoRepository.buscarVigentes', codigo), []),
    contarVinculosClassificacaoTpDoc: (codigo, tpDoc) => ou(m.chamar('classificacaoRepository.contarVinculosComTpDoc', codigo, tpDoc), 0),
    buscarAtividadeVigente: (cAtivSN) => {
      const r = m.chamar('atividadeRepository.buscarVigentesPorCAtivSN', cAtivSN);
      const r2 = r.achou ? r : m.chamar('atividadeCalculoRepository.buscarVigentesPorCAtivSN', cAtivSN);
      return ou(r2, [])[0] ?? null;
    },
    contarVinculosAtividadeTpDoc: (id, tpDoc) => {
      const r = m.chamar('atividadeRepository.contarVinculosComTpDoc', id, tpDoc);
      return ou(r.achou ? r : m.chamar('atividadeCalculoRepository.contarVinculosComTpDoc', id, tpDoc), 0);
    },
    existeNcm: (ncm, data) => ou(m.chamar('ncmService.existeNcm', ncm, data), false),
    existeNbs: (nbs, data) => ou(m.chamar('nbsService.existeNbs', nbs, data), false),
    buscarSituacoesIss: () => F.situacoesDaCarga,
  };
  const validacaoNomenclaturaService = { validar: (...args) => { const r = m.chamar('validacaoNomenclaturaService.validar', ...args); m.chamadas.at(-1).nome = 'validar'; return r.achou ? r.valor : undefined; } };
  return { repo, validacaoNomenclaturaService, mocks: m };
}
const contextoDe = (c) => ({
  data: c.data, tpDoc: c.tpDoc, regime: c.regime, tpEnteGov: c.tpEnteGov, fator: bd(c.fatorTransicaoCompraGov), vocabulario: c.vocabularioTipoReceita,
  vocabularioTipoReceita: c.vocabularioTipoReceita, normalizarCAtivSN: c.normalizarCAtivSN, admiteIs: c.admiteImpostoSeletivo,
  casas: c.casasAliquotaCalculo, siglaDfe: c.siglaDfe, permiteNcmZero: c.permiteNcmZero,
});
function resolvedorDe(r, mocks) {
  return {
    resolver: () => {
      mocks.chamar('resolvedor');
      if (typeof r === 'string') throw new Error('AssertionError: resolvedor chamado');
      return { pIBSSN: bd(r.pIBSSN), pCBSSN: bd(r.pCBSSN), naoCalcular: r.naoCalcular, resolucao: r.resolucao };
    },
    naoAvaliado: () => null,
  };
}
const objetoView = (o) => ({ nObj: o.nObj, estadoItem: o.estadoItem, motivoEstado: o.motivoEstado ?? null, tribCalc: o.tribCalc ?? null, erros: o.erros ?? null });

for (const v of porEndpoint('ProcessadorItemSimples.processarItem')) {
  test(v.id, () => {
    const { repo, validacaoNomenclaturaService, mocks } = dbMockado(v.input.mocks ?? {});
    const { processarItem } = createEngine(repo, { validacaoNomenclaturaService })._internals;
    const { objeto } = processarItem(v.input.entrada, v.input.indice, contextoDe(v.input.contexto), resolvedorDe(v.input.resolvedor, mocks), v.input.baseURL);
    const falhas = conferir(objetoView(objeto), v.expected, ['calls']);
    if (v.expected.calls) falhas.push(...conferirChamadas(v.expected.calls, mocks));
    assert.deepEqual(falhas, [], JSON.stringify(objeto).slice(0, 600));
  });
}
for (const v of porEndpoint('ProcessadorItemSimples.processarItens')) {
  // processarItens = processarItem per item (parallel in Java; a technical failure stays on its item)
  test(v.id, () => {
    const { repo, validacaoNomenclaturaService, mocks } = dbMockado(v.input.mocks ?? {});
    const { processarItem } = createEngine(repo, { validacaoNomenclaturaService })._internals;
    const ctx = contextoDe(v.input.contexto);
    const objetos = v.input.itens.map((it, i) => objetoView(processarItem(it.entrada, i, ctx, resolvedorDe(it.resolvedor, mocks), v.input.baseURL).objeto));
    assert.deepEqual(conferir(objetos, v.expected), []);
  });
}
for (const v of porEndpoint('SimplesNacionalObservabilidadeService.processarOperacao')) {
  test(v.id, () => {
    const { repo, validacaoNomenclaturaService, mocks } = dbMockado(v.input.mocks ?? {}, { classico: true });
    const engine = createEngine(repo, { validacaoNomenclaturaService });
    const r = engine.classico(v.input.operacao, { baseURL: v.input.baseURL });
    const falhas = [];
    if (v.expected.throws) {
      if (r.status !== 422) falhas.push(`status ${r.status} (esperado ErrosCalculoException → 422)`);
      falhas.push(...conferir({ errors: (r.body.errors ?? []).map((e) => e.code) }, Object.fromEntries(Object.entries(v.expected).filter(([k]) => k !== 'throws').map(([k, e]) => [k.replace('errors[*].code', 'errors'), e]))));
    } else {
      if (r.status !== 200) falhas.push(`status ${r.status}`);
      const corpo = { ...r.body, total: r.body.total ?? null, objetos: r.body.objetos.map((o) => ({ ...objetoView(o), tribCalc: o.tribCalc ?? null })) };
      falhas.push(...conferir(corpo, v.expected, ['calls']));
      if (v.expected.calls) falhas.push(...conferirChamadas(v.expected.calls, mocks));
    }
    assert.deepEqual(falhas, [], JSON.stringify(r.body).slice(0, 800));
  });
}
for (const v of porEndpoint('CalculoSimplesUnificadoService.processar')) {
  test(v.id, () => {
    const { repo, validacaoNomenclaturaService } = dbMockado(v.input.mocks ?? {});
    const r = createEngine(repo, { validacaoNomenclaturaService }).naoAssistido(v.input.operacao, { baseURL: v.input.baseURL });
    assert.equal(r.status, 422); // ErrosCalculoException
    assert.equal(r.body.errors[0].code, v.expected['erros[0].code']);
    assert.equal(r.body.errors[0].pointer, v.expected['erros[0].pointer']);
  });
}

// every unit endpoint of the official file is mapped here or in another test file
test('todos os vetores unit:* têm mapeamento', () => {
  const cobertos = new Set(['SimplesNacionalCalculoService.calcularItem', 'EscolhaParAliquotasService.escolher', 'AtividadeSimplesService.listar', 'AtividadeSimplesService.buscarPorCodigo', 'DerivacaoAnexosSimples.derivar']);
  const aqui = /^(ClassificacaoTributariaSimplesRepository|ParametroCalculoSimplesService|TransicaoAliquotaCompraGovSimplesRepository|AtividadeSimplesRepository|ArredondamentoUtils|ProcessadorItemSimples|ContextoItemSimples|EscolhaParAliquotasService\.(avisoPar|avaliarCamposIss)|ItemSimplesUnificadoInput|NcmAplicavelService|NbsAplicavelService|ValidacaoNomenclaturaService|SimplesNacionalObservabilidadeService|CalculoSimplesUnificadoService)/;
  const sem = [...new Set(vectors.filter((v) => v.endpoint.startsWith('unit:')).map((v) => v.endpoint.slice(5)))].filter((e) => !cobertos.has(e) && !aqui.test(e));
  assert.deepEqual(sem, []);
});
