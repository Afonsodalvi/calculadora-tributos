// Differential cases of the calculation slice: POST /api/calculadora/regime-geral,
// POST /api/calculadora/observabilidade/regime-geral and GET /api/calculadora/observabilidade/erros.
//
// Valid-heavy. Section 1 walks EVERY CBS/IBS classification of the database in EVERY year 2026–2034
// (each one at least once per year, at a date where it is in force): CST/cClassTrib of the
// classification, NCM/NBS of its annex (or free/zero/absent per tpDoc), tpDoc linked to it or none,
// 2026 with the database rates and 2027–2034 with informed nominal rates, Imposto Seletivo (ad valorem
// / ad rem, informed tax, IS base composing the CBS/IBS base), government purchases (tpEnteGov 1–6,
// CBS transfer 2029+), suspension with regular taxation (desoneração), deferral, gComponentesBC,
// HALF_EVEN ties and huge values, operations of 1 to 990 items. Each item is checked with the port's
// own pipeline in-process and rebuilt (other nomenclature / regular taxation / no IS) until it is
// calculated, so most items reach the engine and the memória de cálculo; a share of the failed
// attempts is kept on purpose. The oracle decides every case; the in-process check only steers the
// generator. Sections 2–6 are the invalid inputs (business errors, Bean Validation, request locale,
// Jackson, charsets, GET erros); section 7 replays the official rounding batch
// (lote-arredondamento.jsonl, 2000 notes) on both endpoints.
//
// The MAIN endpoint runs the items on a parallel stream and Bean Validation keeps the violations in
// a HashSet, so it is sent only what is deterministic on the Java side (see deterministaNoPrincipal):
//  - at most 1 Bean Validation violation in the whole operation (2+ come in random order);
//  - at most 1 failing item, and only when its exception keeps its message if ForkJoinTask rebuilds
//    it on another thread (project exceptions without a public no-arg/Throwable constructor, or whose
//    no-arg constructor gives the same text). With 2+ failing items Java reports whichever fails first;
//  - no null item (the NPE "detail" disappears once HotSpot throws it from compiled code).
// Those cases are compared with normalization (multiset / set membership) in calculo.test.js.
// Also not generated: BigDecimal inputs with huge exponents in fields without @Digits (gComponentesBC,
// adRem) — the Java API would try to materialize 10^n and stall (the port rejects |scale| > 100000).
import { readFileSync } from 'node:fs';
import { Dec } from '../../../../src/core/decimal.js';
import { escreverJson, NumeroCru, lerDocumentoJson } from '../../../../src/regime-regular/comum/json.js';
import { problemTypePorClasse, ErroSerializacao } from '../../../../src/regime-regular/comum/problema.js';
import { criarProcessamento } from '../../../../src/regime-regular/calculo/processamento.js';
import { calcularBaseUnificada } from '../../../../src/regime-regular/calculo/servicos.js';
import { vincularOperacao } from '../../../../src/regime-regular/calculo/entrada.js';
import { validar } from '../../../../src/regime-regular/calculo/validacao.js';

const RG = '/api/calculadora/regime-geral';
const OBS = '/api/calculadora/observabilidade/regime-geral';
const ERROS = '/api/calculadora/observabilidade/erros';
const LOTE = new URL('../../../fixtures/regime-regular/lote-arredondamento.jsonl', import.meta.url);

/** Largest item count of an NF-e (nItem 1..990). */
export const MAX_ITENS = 990;

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const N = (t) => new NumeroCru(t);

// ─── SQL (classifications in force at a date, with the treatment flags; annexes; tpDoc links) ────

const SQL_LISTA = `SELECT ct.CLTR_ID id, ct.CLTR_CD cod, st.SITR_CD cst, tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO exd, tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO inc
 FROM CLASSIFICACAO_TRIBUTARIA ct JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
 JOIN TRATAMENTO_CLASSIFICACAO tc ON tc.TRCL_CLTR_ID = ct.CLTR_ID AND :d BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :d)
 JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
 WHERE tst.TRST_TBTO_ID = :t AND :d BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :d)
 AND :d BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :d) AND :d BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :d)
 ORDER BY ct.CLTR_CD`;
const SQL_TPDOC_CLASSIF = `SELECT tc.TDCL_CLTR_ID id, t.TPDF_TIPO tipo FROM TIPO_DFE_CLASSIFICACAO tc JOIN TIPO_DFE t ON t.TPDF_ID = tc.TDCL_TPDF_ID
 WHERE t.TPDF_B_POSSUI_TRATAMENTO_CALCULADORA = 1 AND :d BETWEEN tc.TDCL_INICIO_VIGENCIA AND COALESCE(tc.TDCL_FIM_VIGENCIA, :d)
 AND :d BETWEEN t.TPDF_INICIO_VIGENCIA AND COALESCE(t.TPDF_FIM_VIGENCIA, :d)`;

/**
 * Exceptions that keep their message when ForkJoinTask.getException rebuilds them on another thread:
 * every project exception mapped to a ProblemType except the two with BOTH a public no-arg
 * constructor and a constructor with arguments (the no-arg one would change the text). JDK and
 * framework exceptions (CAL-999: NPE, ArithmeticException, IllegalArgumentException…) are rebuilt
 * with a null or "class: message" text.
 */
const RECONSTRUIDAS_COM_OUTRA_MENSAGEM = new Set(['AliquotaNegativaException', 'AliquotaReferenciaNaoEncontradaException']);
export const mensagemEstavelEntreThreads = (classe) => classe != null && problemTypePorClasse(classe).code != null && !RECONSTRUIDAS_COM_OUTRA_MENSAGEM.has(classe);

/** The port's in-process view of a request body (steers the generator; the oracle decides). */
export function criarAvaliador(base) {
  const proc = criarProcessamento(base);
  const motor = proc.obterMotor();
  const vincular = (texto) => {
    try {
      const doc = lerDocumentoJson(Buffer.from(texto));
      if (doc.vazio || doc.raiz === null) return null;
      const op = vincularOperacao(doc.raiz);
      doc.verificarFim('x');
      return op;
    } catch {
      return null;
    }
  };
  const serializavel = (t) => {
    try { motor.serializarTributos(t); return true; } catch (e) { if (e instanceof ErroSerializacao) return false; throw e; }
  };
  /** { violacoes, global, itens: [{ ok, code }] } or null when the body does not bind. */
  async function avaliar(texto) {
    const op = vincular(texto);
    if (!op) return null;
    const violacoes = validar(op, 'OperacaoInput').length;
    let roc;
    try {
      roc = await proc.processarOperacao(vincular(texto), 'http://x');
    } catch {
      return { violacoes, global: true, itens: [] };
    }
    const itens = roc.objetos.map((o) => ({
      ok: (o.estadoItem === 'CALCULADO' || o.estadoItem === 'CALCULO_SIMULADO') && serializavel(o.tribCalc),
      code: o.erros?.[0]?.code ?? null,
    }));
    return { violacoes, global: false, itens };
  }
  /** Java exception class the main endpoint raises for this body (null when it calculates). */
  async function classeNoPrincipal(texto) {
    const op = vincular(texto);
    if (!op) return null;
    try { await proc.calcularTributos(op); return null; } catch (e) { return e.classeJava ?? 'Error'; }
  }
  /**
   * True when the Java main endpoint answers this body deterministically: ≤ 1 Bean Validation
   * violation, no null item, and ≤ 1 failing item whose exception keeps its message across threads.
   */
  async function deterministaNoPrincipal(texto) {
    const r = await avaliar(texto);
    if (r == null) return true; // Jackson error: raised before validation and the stream
    if (r.violacoes > 1) return false;
    if (r.violacoes === 1 || r.global) return true;
    const doc = JSON.parse(texto);
    if (!Array.isArray(doc.itens) || doc.itens.some((x) => x == null)) return false;
    const falhas = r.itens.map((x, i) => (x.ok ? -1 : i)).filter((i) => i >= 0);
    if (falhas.length === 0) return true;
    if (falhas.length > 1) return false;
    if (r.itens.length === 1) return true; // a single element runs on the caller thread
    const so = { ...doc, itens: [doc.itens[falhas[0]]] };
    return mensagemEstavelEntreThreads(await classeNoPrincipal(JSON.stringify(so)));
  }
  return { avaliar, classeNoPrincipal, deterministaNoPrincipal, proc };
}

export async function gerar({ seed = 1, n = 300, base } = {}) {
  const rnd = prng(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const inteiro = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const embaralhar = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const avaliador = criarAvaliador(base);
  const casos = [];
  const add = (caminho, corpo, rotulo, headers = {}, metodo = 'POST') => {
    const h = { ...headers };
    if (metodo === 'POST' && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    casos.push({ metodo, caminho, headers: h, corpo: typeof corpo === 'string' || Buffer.isBuffer(corpo) || corpo === undefined ? corpo : escreverJson(corpo), rotulo });
  };
  const ambos = (corpo, rotulo, headers) => { add(RG, corpo, `rg ${rotulo}`, headers); add(OBS, corpo, `obs ${rotulo}`, headers); };
  /** Operations whose main-endpoint case depends on the determinism check (resolved at the end). */
  const pendentes = [];
  const enviar = (op, rotulo, headers = {}) => pendentes.push({ corpo: typeof op === 'string' ? op : escreverJson(op), rotulo, headers });

  // ── data from the official database ────────────────────────────────────────
  const municipios = base.all('SELECT m.MUNI_CD c, u.UF_SIGLA s FROM MUNICIPIO m JOIN UF u ON u.UF_CD = m.MUNI_UF_CD ORDER BY m.MUNI_CD');
  const classificacoes = base.all(`SELECT DISTINCT ct.CLTR_ID id, ct.CLTR_CD codigo, st.SITR_CD cst, ct.CLTR_INICIO_VIGENCIA ini
    FROM CLASSIFICACAO_TRIBUTARIA ct JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
    JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID WHERE tst.TRST_TBTO_ID = 2 ORDER BY ct.CLTR_CD`);
  const ncmPorClasse = new Map();
  for (const l of base.all('SELECT n.NCMA_CLTR_ID id, n.NCMA_NCM_CD ncm FROM NCM_APLICAVEL n')) { if (!ncmPorClasse.has(l.id)) ncmPorClasse.set(l.id, []); ncmPorClasse.get(l.id).push(l.ncm); }
  const nbsPorClasse = new Map();
  for (const l of base.all('SELECT n.NBSA_CLTR_ID id, n.NBSA_NBS_CD nbs FROM NBS_APLICAVEL n')) { if (!nbsPorClasse.has(l.id)) nbsPorClasse.set(l.id, []); nbsPorClasse.get(l.id).push(l.nbs); }
  const ncms = base.all("SELECT NCM_CD c FROM NCM WHERE LENGTH(NCM_CD) = 8 AND NCM_FIM_VIGENCIA = '9999-12-31' AND NCM_INICIO_VIGENCIA <= '2026-01-01' ORDER BY NCM_CD").map((x) => x.c);
  const nbss = base.all("SELECT NBS_CD c FROM NBS WHERE LENGTH(NBS_CD) = 9 AND NBS_FIM_VIGENCIA IS NULL AND NBS_INICIO_VIGENCIA <= '2026-01-01' ORDER BY NBS_CD").map((x) => x.c);
  const prefixosIS = [...new Set(base.all('SELECT AARP_NCM_CD c FROM ALIQUOTA_AD_REM_PRODUTO UNION SELECT AAVP_NCM_CD FROM ALIQUOTA_AD_VALOREM_PRODUTO').map((x) => x.c))];
  const ncmIS = prefixosIS.flatMap((p) => ncms.filter((x) => x.startsWith(p)).slice(0, 3));
  const comIS = (ncm) => prefixosIS.some((p) => ncm.startsWith(p));
  const ncmsSemIS = ncms.filter((x) => !comIS(x));
  const tiposDfe = base.all('SELECT TPDF_TIPO t FROM TIPO_DFE ORDER BY TPDF_TIPO').map((x) => x.t);
  const classesIS = base.all(`SELECT DISTINCT ct.CLTR_CD codigo, st.SITR_CD cst FROM CLASSIFICACAO_TRIBUTARIA ct JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
    JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID WHERE tst.TRST_TBTO_ID = 1 ORDER BY 1`);
  const suspensoes = classificacoes.filter((c) => ['550'].includes(c.cst) || ['200022', '200024'].includes(c.codigo));

  // per-date lookups (cached)
  const cache = new Map();
  const lembrar = (chave, f) => { if (!cache.has(chave)) cache.set(chave, f()); return cache.get(chave); };
  const listaEm = (d, t) => lembrar(`L${t}${d}`, () => base.all(SQL_LISTA, { d, t: BigInt(t) }));
  const idsEm = (d) => lembrar(`I${d}`, () => new Set(listaEm(d, 2).map((c) => c.id)));
  // complete NCM/NBS codes under each annex prefix (vigência of the annex row and of the code checked per date)
  const vigente = (d, ini, fim) => ini <= d && d <= (fim ?? d);
  function indiceAnexo(codigos, linhasAnexo) {
    const porClasse = new Map();
    for (const a of linhasAnexo) {
      let lo = 0;
      let hi = codigos.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (codigos[m].c < a.p) lo = m + 1; else hi = m; }
      for (let i = lo; i < codigos.length && codigos[i].c.startsWith(a.p); i++) {
        if (!porClasse.has(a.id)) porClasse.set(a.id, []);
        porClasse.get(a.id).push({ ...codigos[i], ai: a.i, af: a.f });
      }
    }
    return (id, d) => [...new Set((porClasse.get(id) ?? []).filter((x) => vigente(d, x.ai, x.af) && vigente(d, x.i, x.f)).map((x) => x.c))].sort();
  }
  const ncmAnexo = indiceAnexo(base.all('SELECT NCM_CD c, NCM_INICIO_VIGENCIA i, NCM_FIM_VIGENCIA f FROM NCM WHERE LENGTH(NCM_CD) = 8 ORDER BY NCM_CD'),
    base.all('SELECT NCMA_CLTR_ID id, NCMA_NCM_CD p, NCMA_INICIO_VIGENCIA i, NCMA_FIM_VIGENCIA f FROM NCM_APLICAVEL'));
  const nbsAnexo = indiceAnexo(base.all('SELECT NBS_CD c, NBS_INICIO_VIGENCIA i, NBS_FIM_VIGENCIA f FROM NBS WHERE LENGTH(NBS_CD) = 9 ORDER BY NBS_CD'),
    base.all('SELECT NBSA_CLTR_ID id, NBSA_NBS_CD p, NBSA_INICIO_VIGENCIA i, NBSA_FIM_VIGENCIA f FROM NBS_APLICAVEL'));
  const anexoNcm = (id, d) => lembrar(`N${id}${d}`, () => ncmAnexo(id, d));
  const anexoNbs = (id, d) => lembrar(`S${id}${d}`, () => nbsAnexo(id, d));
  const vinculosEm = (d) => lembrar(`V${d}`, () => {
    const m = new Map();
    for (const { id, tipo } of base.all(SQL_TPDOC_CLASSIF, { d })) { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(tipo); }
    return m;
  });
  const vinculado = (c, tpDoc, d) => tpDoc === undefined || (vinculosEm(d).get(c.id)?.has(tpDoc) ?? false);
  const bissexto = (a) => (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
  const datasDoAno = (a) => [`${a}-01-01`, `${a}-01-02`, `${a}-03-15`, `${a}-06-15`, `${a}-09-30`, `${a}-12-31`, ...(bissexto(a) ? [`${a}-02-29`] : [`${a}-02-28`])];
  const HORAS = ['T00:00:00', 'T09:50:05', 'T23:59:59', 'T12:00:00', 'T10:00:00'];
  const FUSOS = ['-03:00', 'Z', '+14:00', '-12:00', '+00:00', '-02:30'];
  const dataHora = (d) => `${d}${pick(HORAS)}${pick(FUSOS)}`;

  // ── values ──────────────────────────────────────────────────────────────────
  const dinheiro = () => pick([
    () => (rnd() * 5000).toFixed(inteiro(0, 2)),
    () => (rnd() * 5000).toFixed(2),
    () => pick(['0.50', '1.50', '5.00', '15.00', '25.00', '35.00', '0.05', '0.15', '0.25', '100.05', '1234.57', '0', '0.00', '0.01', '1000', '1000.0']),
    () => (rnd() * 1e9).toFixed(2),
    () => pick(['9999999999999.99', '1E+2', '2.50E+3', '1000000000000', '4321.1', '7777777.77']),
  ])();
  const pequeno = () => (rnd() * 300).toFixed(inteiro(0, 2));
  const percentual = (max) => (rnd() * max).toFixed(inteiro(0, 4));
  const nominal = (max) => pick([() => percentual(max), () => percentual(max), () => pick(['8.8', '8.7', '0.9', '0.1', '0.05', '0', '100', '100.00', '99.9999', '17.5', '12.3456'])])();
  const nominais = () => ({ cbs: N(nominal(12)), ibsEstadual: N(nominal(20)), ibsMunicipal: N(nominal(8)) });
  const QUANTIDADES = ['1', '2.5', '1000', '0.0001', '3', '12.3456', '1E+3', '12345678901.1234', '0.5'];
  const UNIDADES = ['UN', 'KG', 'LT', 'VN', 'M3', 'TON', 'CX', 'PCT', 'MWH'];
  const UNIDADES_IS = ['VN', 'UN', 'LT', 'KG', 'M3', 'TON', 'L'];
  const LOCAIS_FIXOS = [[3550308, 'SP'], [3304557, 'RJ'], [1200013, 'AC'], [5300108, 'DF'], [4314902, 'RS']];
  const local = () => (chance(0.3) ? (([c, s]) => ({ c, s }))(pick(LOCAIS_FIXOS)) : pick(municipios));

  /**
   * gComponentesBC (tpDoc 55/65): the CBS/IBS base derived (no baseCalculo) or declared equal to it;
   * with the Imposto Seletivo group the declared IS base (@NotNull) is the IS base of the components.
   */
  function componentes(it, ano, tpDoc) {
    const c = { vProd: N(dinheiro()) };
    const extras = [['vFrete', 0.5, pequeno], ['vSeg', 0.3, pequeno], ['vOutro', 0.3, pequeno], ['vII', 0.2, pequeno], ['vIS', 0.25, pequeno],
      ['vDesc', 0.4, () => (rnd() * 20).toFixed(2)], ['vPIS', 0.3, () => (rnd() * 10).toFixed(2)], ['vCOFINS', 0.3, () => (rnd() * 10).toFixed(2)],
      ['vICMS', 0.4, () => (rnd() * 30).toFixed(2)], ['vICMSUFDest', 0.15, () => (rnd() * 5).toFixed(2)], ['vFCP', 0.15, () => (rnd() * 5).toFixed(2)],
      ['vFCPUFDest', 0.1, () => (rnd() * 5).toFixed(2)], ['vICMSMono', 0.1, () => (rnd() * 5).toFixed(2)], ['vISSQN', 0.2, () => (rnd() * 10).toFixed(2)]];
    for (const [k, p, f] of extras) if (chance(p)) c[k] = N(f());
    it.gComponentesBC = c;
    const exatos = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Dec.parse(v.texto)]));
    const temNcm = it.ncm != null && it.ncm.trim() !== '' && it.ncm !== '00' && it.ncm !== '00000000';
    const natureza = temNcm && !it.nbs ? 'BEM' : !temNcm && it.nbs ? 'SERVICO' : null;
    const bases = calcularBaseUnificada(exatos, ano, natureza, tpDoc);
    const texto = (v) => (chance(0.7) ? v.toPlainString() : v.toJavaString());
    if (it.impostoSeletivo) {
      if (bases.baseIS.signum() >= 0) it.impostoSeletivo.baseCalculo = N(texto(bases.baseIS));
      if (chance(0.5)) delete it.baseCalculo;
      return;
    }
    delete it.baseCalculo;
    if (chance(0.4) && bases.baseRG.signum() >= 0) it.baseCalculo = N(texto(bases.baseRG));
  }

  /** Imposto Seletivo group with informed rates (2027+): IS base, ad valorem and/or ad rem, informed tax. */
  function grupoIS(it, d) {
    const lista = listaEm(d, 1);
    const cis = lista.length ? pick(lista) : { cst: '000', cod: '000001' };
    const is = { cst: cis.cst, cClassTrib: cis.cod, baseCalculo: N(dinheiro()) };
    const adValorem = chance(0.8) ? N(nominal(30)) : undefined;
    const adRem = !adValorem || chance(0.5) ? N((rnd() * 50).toFixed(inteiro(0, 8))) : undefined;
    if (adRem || chance(0.5)) { is.quantidade = N(pick(QUANTIDADES.slice(0, 7))); is.unidade = pick(UNIDADES_IS); }
    if (chance(0.4)) is.impostoInformado = N(pequeno());
    it.impostoSeletivo = is;
    it.aliquotasNominais = { ...(it.aliquotasNominais ?? nominais()), impostoSeletivo: { adValorem, adRem } };
    const somaIS = () => Dec.parse(is.baseCalculo.texto).add(is.impostoInformado ? Dec.parse(is.impostoInformado.texto) : Dec.ZERO);
    const r = rnd();
    if (r < 0.5) delete it.baseCalculo;
    else if (r < 0.8) it.baseCalculo = N(somaIS().toPlainString());
    else if (!is.impostoInformado) it.baseCalculo = N(somaIS().add(Dec.parse(pequeno())).toPlainString());
    else delete it.baseCalculo;
  }

  /**
   * One item of classification `c` in the context { d, ano, tpDoc }; `tentativa` 0.. changes the
   * nomenclature strategy and drops the optional groups in later attempts.
   */
  function montarItem(c, ctx, numero, tentativa) {
    const { d, ano, tpDoc } = ctx;
    const it = { numero, cst: c.cst, cClassTrib: c.cod };
    // regular taxation (suspensions) first: the nomenclature is checked against the effective classification
    const regulares = listaEm(d, 2).filter((x) => !x.exd && !x.inc && vinculado(x, tpDoc, d));
    let alvo = c;
    if ((c.exd || (tentativa < 3 && chance(0.04))) && regulares.length) {
      const semAnexo = regulares.filter((x) => !anexoNcm(x.id, d).length && !anexoNbs(x.id, d).length);
      const reg = tentativa >= 2 && semAnexo.length ? pick(semAnexo) : pick(regulares);
      it.tributacaoRegular = { cst: reg.cst, cClassTrib: reg.cod };
      if (c.exd) alvo = reg;
    }
    const isElegivel = ano >= 2027 && (tpDoc === undefined || tpDoc === 55 || tpDoc === 65) && tentativa < 4;
    const querIS = isElegivel && chance(0.25);
    // nomenclature strategies
    const nAnexo = anexoNcm(alvo.id, d);
    const sAnexo = anexoNbs(alvo.id, d);
    const estrategias = [];
    if (nAnexo.length) estrategias.push('ncmAnexo');
    if (sAnexo.length) estrategias.push('nbsAnexo');
    if (tpDoc === 55 || tpDoc === 65) estrategias.push(querIS ? 'ncmIS' : 'ncmLivre', 'nenhuma', 'ncmZero', 'ncmLivre');
    else if (tpDoc === 91 || tpDoc === 92) estrategias.push('nbsLivre', 'nenhuma');
    else if (tpDoc === undefined) estrategias.push(querIS ? 'ncmIS' : 'ncmLivre', 'nbsLivre', 'nenhuma');
    else estrategias.push('nenhuma', 'ncmLivre', 'nbsLivre');
    const estrategia = tentativa === 0 && chance(0.2) ? pick(estrategias) : estrategias[tentativa % estrategias.length];
    if (estrategia === 'ncmAnexo') it.ncm = pick(nAnexo);
    else if (estrategia === 'nbsAnexo') it.nbs = pick(sAnexo);
    else if (estrategia === 'ncmIS') it.ncm = pick(ncmIS.length ? ncmIS : ncmsSemIS);
    else if (estrategia === 'ncmLivre') it.ncm = pick(ano >= 2027 && ano <= 2033 ? ncmsSemIS : ncms);
    else if (estrategia === 'nbsLivre') it.nbs = pick(nbss);
    else if (estrategia === 'ncmZero') it.ncm = pick(['00000000', '00']);
    // base, quantity, unit
    it.baseCalculo = N(dinheiro());
    if (chance(0.5)) it.quantidade = N(pick(QUANTIDADES));
    if (chance(0.4)) it.unidade = pick(UNIDADES);
    // nominal rates: required from 2027 on (CST with the IBS/CBS group), forbidden before
    if (ano >= 2027) { if (chance(0.97) || tentativa > 0) it.aliquotasNominais = nominais(); } else if (chance(0.02)) it.aliquotasNominais = {};
    if (querIS || (isElegivel && it.ncm && comIS(it.ncm))) {
      grupoIS(it, d);
      if ((tpDoc === 55 || tpDoc === 65) && tentativa < 3 && chance(0.2)) componentes(it, ano, tpDoc);
    } else if ((tpDoc === 55 || tpDoc === 65) && tentativa < 4 && chance(0.15)) componentes(it, ano, tpDoc);
    return it;
  }

  /** Builds an item that the port calculates (up to 8 attempts); keeps some failed attempts on purpose. */
  async function itemCalculavel(c, ctx, numero) {
    let ultimo;
    for (let t = 0; t < 8; t++) {
      const it = montarItem(c, ctx, numero, t);
      ultimo = it;
      const r = await avaliador.avaliar(escreverJson(operacaoDe(ctx, [it])));
      if (r && !r.global && r.itens[0]?.ok) return it;
      if (t === 0 && chance(0.08)) return it; // invalid on purpose (error coverage inside valid operations)
    }
    return ultimo;
  }

  /** Operation envelope of a context. */
  function operacaoDe(ctx, itens) {
    const op = { id: ctx.id, versao: ctx.versao };
    op[ctx.campoData] = ctx.dh;
    op.municipio = ctx.municipio;
    if (ctx.uf !== undefined) op.uf = ctx.uf;
    if (ctx.tpDoc !== undefined) op.tpDoc = ctx.tpDoc;
    if (ctx.gCompraGov) op.gCompraGov = ctx.gCompraGov;
    op.itens = itens;
    return op;
  }

  function contexto(d, tpDoc) {
    const m = local();
    const ctx = { id: `op-${inteiro(1, 1e6)}`, versao: pick(['1.0.0', '0.0.1']), d, ano: Number(d.slice(0, 4)), tpDoc, dh: dataHora(d), campoData: chance(0.9) ? 'dhFatoGerador' : 'dataHoraEmissao', municipio: m.c };
    if (chance(0.75)) ctx.uf = m.s;
    if (chance(0.3)) ctx.gCompraGov = { tpEnteGov: inteiro(1, 6), ...(chance(0.75) ? { tpOperGov: inteiro(1, 5) } : {}) };
    return ctx;
  }

  const TAMANHOS = [1, 1, 1, 1, 2, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60];
  const TPDOCS_FREQUENTES = [55, 55, 55, 65, 65, 91, 57, 62, 63, 66, 67, 75, 76, 83, 92, 93, 97];

  /** Numbering of the items: sequential, shuffled, or with repetitions/gaps (sorting by nObj). */
  function numerar(itens) {
    const r = rnd();
    if (r < 0.1) { const ns = embaralhar(itens.map((_, i) => i + 1)); itens.forEach((it, i) => { it.numero = ns[i]; }); } else if (r < 0.15) itens.forEach((it) => { it.numero = inteiro(1, Math.max(2, Math.ceil(itens.length / 2))); });
    else if (r < 0.18) itens.forEach((it, i) => { it.numero = 9999999 - i; });
  }

  // ── 1. every CBS/IBS classification × every year 2026–2034 (valid-heavy) ─────────
  const ANOS_VALIDOS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034];
  const extra = Math.max(0, Math.floor(n / 9));
  for (const ano of ANOS_VALIDOS) {
    const datas = datasDoAno(ano);
    // classifications in force at some date of the year (each one ≥ 1 time, plus random extras)
    const doAno = new Map();
    for (const d of datas) for (const c of listaEm(d, 2)) if (!doAno.has(c.id)) doAno.set(c.id, c);
    const fila = embaralhar([...doAno.values(), ...Array.from({ length: extra }, () => pick([...doAno.values()]))]);
    while (fila.length) {
      const primeiro = fila.shift();
      const d = pick(datas.filter((x) => idsEm(x).has(primeiro.id)));
      const ligados = TPDOCS_FREQUENTES.filter((t) => vinculado(primeiro, t, d));
      const tpDoc = chance(0.55) && ligados.length ? pick(ligados) : undefined;
      const ctx = contexto(d, tpDoc);
      const alvo = pick(TAMANHOS);
      const escolhidas = [primeiro];
      for (let i = 0; i < fila.length && escolhidas.length < alvo;) {
        const c = fila[i];
        if (idsEm(d).has(c.id) && vinculado(c, tpDoc, d)) { escolhidas.push(c); fila.splice(i, 1); } else i++;
      }
      const itens = [];
      for (const c of escolhidas) itens.push(await itemCalculavel(c, ctx, itens.length + 1));
      numerar(itens);
      enviar(operacaoDe(ctx, itens), `familias ${ano} tpDoc=${tpDoc ?? '-'} itens=${itens.length}${ctx.gCompraGov ? ` ente=${ctx.gCompraGov.tpEnteGov}` : ''}`,
        chance(0.08) ? { 'accept-language': pick(['en', 'fr', 'pt-PT', 'de']) } : {});
    }
  }

  // large operations (up to the NF-e limit of 990 items): up to 60 calculable items of the date cycled, bases varied
  for (const [ano, tamanho] of [[2026, 100], [2027, 250], [pick([2028, 2029, 2030]), 500], [2026, MAX_ITENS], [pick([2031, 2032, 2033, 2034]), MAX_ITENS]]) {
    const d = `${ano}-${pick(['03-15', '06-15', '09-30'])}`;
    const tpDoc = pick([55, undefined]);
    const ctx = contexto(d, tpDoc);
    const lista = listaEm(d, 2).filter((c) => vinculado(c, tpDoc, d));
    const modelos = [];
    for (const c of embaralhar(lista).slice(0, 60)) modelos.push(await itemCalculavel(c, ctx, 1));
    const itens = Array.from({ length: tamanho }, (_, i) => {
      const it = structuredClone(modelos[i % modelos.length]);
      it.numero = i + 1;
      if (it.baseCalculo && !it.impostoSeletivo && !it.gComponentesBC) it.baseCalculo = N(dinheiro());
      return it;
    });
    enviar(operacaoDe(ctx, itens), `grande ${ano} tpDoc=${tpDoc ?? '-'} itens=${tamanho}`);
  }

  // ── building blocks of the random and invalid sections ─────────────────────────
  const ANOS = [2026, 2026, 2026, 2027, 2027, 2028, 2029, 2030, 2031, 2033, 2034];
  const data = (ano = pick(ANOS)) => `${ano}-${String(inteiro(1, 12)).padStart(2, '0')}-${String(inteiro(1, 28)).padStart(2, '0')}T${pick(['00:00:00', '09:50:05', '23:59:59', '12:00:00'])}${pick(['-03:00', 'Z', '+14:00', '-12:00', '+00:00'])}`;
  const valor = () => N(pick(['200', '200.00', '1000.5', '0.01', '0', '99999.99', '123456789.12', '15.3', `${inteiro(1, 99999)}.${String(inteiro(0, 99)).padStart(2, '0')}`]));
  const municipioValido = () => pick(municipios);
  const aliquotasNominais = () => ({ cbs: N(pick(['8.8', '0.9', '0', '12.3456', '100.00'])), ibsEstadual: N(pick(['0.1', '8.85', '0', '17.5'])), ibsMunicipal: N(pick(['0', '8.85', '0.05', '2'])) });

  /** One random item: a classification with a consistent CST and, when it has an annex, an NCM/NBS from it. */
  function item(numero, ano, { tpDoc } = {}) {
    const c = pick(classificacoes);
    const it = { numero, cst: c.cst, cClassTrib: c.codigo };
    const anexoN = ncmPorClasse.get(c.id);
    const anexoS = nbsPorClasse.get(c.id);
    const r = rnd();
    if (anexoN && r < 0.6) { const p = pick(anexoN); it.ncm = ncms.find((x) => x.startsWith(p)) ?? p; } else if (anexoS && r < 0.8) { const p = pick(anexoS); it.nbs = nbss.find((x) => x.startsWith(p)) ?? p; }
    else if (r < 0.9) it.ncm = pick(ncms);
    else if (chance(0.5)) it.nbs = pick(nbss);
    it.baseCalculo = valor();
    if (chance(0.6)) it.quantidade = N(pick(['1', '2.5', '1000', '0.0001', '10']));
    if (chance(0.5)) it.unidade = pick(['UN', 'KG', 'LT', 'VN', 'M3']);
    if (suspensoes.some((s) => s.codigo === c.codigo) && chance(0.85)) {
      const reg = pick(classificacoes.filter((x) => ['000', '200', '010', '011'].includes(x.cst)));
      it.tributacaoRegular = { cst: reg.cst, cClassTrib: reg.codigo };
    }
    if (ano >= 2027 && chance(0.85)) it.aliquotasNominais = aliquotasNominais();
    if ([55, 65].includes(tpDoc) && chance(0.25)) {
      delete it.baseCalculo;
      it.gComponentesBC = { vProd: valor(), vFrete: chance(0.5) ? valor() : undefined, vDesc: chance(0.4) ? N('1.00') : undefined, vICMS: chance(0.4) ? N('10') : undefined, vIS: chance(0.2) ? N('5') : undefined };
    }
    return it;
  }

  /** Random Imposto Seletivo item (NCM with an IS rate row). */
  function itemIS(numero, ano) {
    const cis = pick(classesIS.length ? classesIS : [{ codigo: '000001', cst: '000' }]);
    const it = { numero, ncm: pick(ncmIS.length ? ncmIS : ['24021000']), cst: '000', cClassTrib: '000001', baseCalculo: N('200'), quantidade: N('1'), unidade: 'VN' };
    it.impostoSeletivo = { cst: cis.cst, cClassTrib: cis.codigo, baseCalculo: N(pick(['200', '188.00', '150.5'])), quantidade: N(pick(['1', '3', '0.5'])), unidade: pick(['VN', 'UN', 'LT']) };
    if (chance(0.5)) it.impostoSeletivo.impostoInformado = N(pick(['0', '12.00', '50']));
    if (chance(0.5)) delete it.baseCalculo;
    if (ano >= 2027) {
      it.aliquotasNominais = aliquotasNominais();
      if (chance(0.85)) it.aliquotasNominais.impostoSeletivo = { adValorem: chance(0.8) ? N(pick(['13', '0.5', '25.25'])) : undefined, adRem: chance(0.6) ? N(pick(['21.3', '0.5', '1'])) : undefined };
    }
    return it;
  }

  function operacao({ ano = pick(ANOS), itens = 1, tpDoc, compraGov = chance(0.2), uf = 'auto' } = {}) {
    const m = municipioValido();
    const op = { id: `op-${inteiro(1, 1e6)}`, versao: '1.0.0' };
    if (chance(0.85)) op.dhFatoGerador = data(ano); else op.dataHoraEmissao = data(ano);
    op.municipio = m.c;
    if (uf === 'auto' ? chance(0.7) : uf) op.uf = uf === 'auto' || uf === true ? m.s : uf;
    if (tpDoc !== undefined) op.tpDoc = tpDoc;
    if (compraGov) op.gCompraGov = { tpEnteGov: inteiro(1, 6), tpOperGov: chance(0.7) ? inteiro(1, 5) : undefined };
    op.itens = Array.from({ length: itens }, (_, i) => (ano >= 2026 && chance(0.12) ? itemIS(i + 1, ano) : item(i + 1, ano, { tpDoc })));
    return op;
  }

  // random operations (valid and invalid items mixed: families × dates × tpDoc × UF)
  for (let i = 0; i < Math.max(40, Math.floor(n * 0.2)); i++) {
    const ano = pick(ANOS);
    const tpDoc = chance(0.45) ? pick([55, 65, 55, 91, 62, 57, 63, 66, 67, 75, 76, 83]) : undefined;
    const op = operacao({ ano, tpDoc, itens: chance(0.75) ? 1 : inteiro(2, 4) });
    enviar(op, `aleatorio ${ano} tpDoc=${tpDoc ?? '-'}`, chance(0.15) ? { 'accept-language': pick(['en', 'fr', 'pt-PT', 'de']) } : {});
  }

  // several items that always pass validation (sorting by nObj, duplicates, totals)
  for (let i = 0; i < Math.max(12, Math.floor(n / 20)); i++) {
    const ano = pick(ANOS);
    const op = operacao({ ano, itens: 1, compraGov: chance(0.3) });
    const numeros = Array.from({ length: inteiro(2, 5) }, () => inteiro(1, 6));
    op.itens = numeros.map((numero) => {
      const it = { numero, cst: '000', cClassTrib: '000001', baseCalculo: valor() };
      if (chance(0.3)) it.ncm = pick(ncmsSemIS.slice(0, 400));
      if (ano >= 2027) it.aliquotasNominais = aliquotasNominais();
      return it;
    });
    ambos(op, `varios itens ${ano}`);
  }
  // serializer failures (500 "Failed to write request", X-CALC-* kept): IS unit → uTrib outside 1..6 chars
  for (const un of ['UNIDADE7', '', 'ABCDEF', 'ÇÃO1234']) {
    const op = operacao({ ano: 2027, itens: 1, compraGov: false });
    op.itens = [{ numero: 1, ncm: '24021000', cst: '000', cClassTrib: '000001', baseCalculo: N('200'), quantidade: N('1'), unidade: 'VN',
      impostoSeletivo: { cst: '000', cClassTrib: '000001', baseCalculo: N('200'), quantidade: N('1'), unidade: un },
      aliquotasNominais: { cbs: N('8.8'), ibsEstadual: N('0.1'), ibsMunicipal: N('0.05'), impostoSeletivo: { adValorem: N('10'), adRem: N('1') } } }];
    ambos(op, `serializacao uTrib ${JSON.stringify(un)}`);
  }
  // main endpoint: one failing item among valid ones (deterministic: the exception keeps its message)
  for (let k = 0; k < Math.max(10, Math.floor(n / 25)); k++) {
    const d = `${pick([2026, 2027, 2030])}-06-15`;
    const ctx = contexto(d, pick([undefined, 55]));
    const lista = listaEm(d, 2).filter((c) => !c.exd && vinculado(c, ctx.tpDoc, d));
    const itens = [];
    for (let i = 0; i < inteiro(2, 12); i++) itens.push(await itemCalculavel(pick(lista), ctx, i + 1));
    const ruim = { numero: 99, cst: '000', cClassTrib: '000001', baseCalculo: N('10') };
    pick([
      () => { ruim.cst = '999'; }, () => { ruim.cClassTrib = '999999'; }, () => { ruim.ncm = '99999999'; }, () => { ruim.cst = '550'; ruim.cClassTrib = '550001'; },
      () => { ruim.ncm = '24021000'; ruim.nbs = '115012000'; }, () => { delete ruim.baseCalculo; }, () => { ruim.cst = '620'; ruim.cClassTrib = '620001'; },
      () => { ruim.nbs = '999999999'; },
    ])();
    if (ctx.ano >= 2027) ruim.aliquotasNominais = nominais();
    itens.splice(inteiro(0, itens.length), 0, ruim);
    enviar(operacaoDe(ctx, itens), `um item com erro entre validos ${ctx.ano}`);
  }

  // ── 2. global business errors ───────────────────────────────────────────────
  const base0 = () => operacao({ ano: 2026, compraGov: false });
  const globais = [
    ['municipio inexistente', (o) => { o.municipio = 9999990; delete o.uf; }],
    ['municipio inexistente com uf', (o) => { o.municipio = 1234567; o.uf = 'RS'; }],
    ['uf de outro estado', (o) => { o.municipio = 4314902; o.uf = 'SP'; }],
    ['uf inexistente', (o) => { o.uf = 'XX'; }],
    ['uf minuscula', (o) => { o.uf = o.uf ? o.uf.toLowerCase() : 'rs'; o.municipio = o.uf ? o.municipio : 4314902; }],
    ['uf EX', (o) => { o.municipio = 9999999; o.uf = 'EX'; }],
    ['sem data', (o) => { delete o.dhFatoGerador; delete o.dataHoraEmissao; }],
    ['tpDoc inexistente', (o) => { o.tpDoc = pick([1, 2, 54, 99, 100, 998]); }],
    ['tpDoc sem tratamento', (o) => { o.tpDoc = pick([77, 94, 95, 96]); }],
    ['tpDoc antes de 2026', (o) => { o.tpDoc = 55; o.dhFatoGerador = '2025-12-31T23:59:59-03:00'; delete o.dataHoraEmissao; }],
    ['data 2025 sem tpDoc', (o) => { o.dhFatoGerador = '2025-06-01T10:00:00-03:00'; delete o.dataHoraEmissao; }],
    ['offset vira o ano', (o) => { o.dhFatoGerador = '2026-12-31T23:30:00-03:00'; delete o.dataHoraEmissao; }],
    ['dataHoraEmissao e dhFatoGerador', (o) => { o.dhFatoGerador = '2027-01-01T00:00:00Z'; o.dataHoraEmissao = '2026-01-01T00:00:00Z'; }],
  ];
  for (const [rotulo, f] of globais) for (let k = 0; k < 2; k++) { const o = base0(); f(o); ambos(o, `global ${rotulo}`); }
  for (const t of tiposDfe) { const o = operacao({ ano: chance(0.5) ? 2026 : 2027, tpDoc: t, itens: 1 }); ambos(o, `tpDoc ${t}`); }

  // ── 3. item business errors (single item, so the main endpoint is deterministic) ──
  const um = (ano = 2026) => operacao({ ano, itens: 1, compraGov: false });
  const itensErro = [
    ['ncm e nbs', (it) => { it.ncm = '24021000'; it.nbs = '115012000'; }],
    ['ncm inexistente', (it) => { it.ncm = pick(['99999999', '1', ' 24021000', '00', '00000000', '2402100', ' ']); delete it.nbs; }],
    ['nbs inexistente', (it) => { it.nbs = pick(['999999999', '1', '11501200 ']); delete it.ncm; }],
    ['cst inexistente', (it) => { it.cst = '999'; }],
    ['cClassTrib inexistente', (it) => { it.cClassTrib = '999999'; }],
    ['cst x cClassTrib', (it) => { it.cst = '000'; it.cClassTrib = '200003'; it.ncm = '24021000'; delete it.nbs; }],
    ['sem base', (it) => { delete it.baseCalculo; delete it.gComponentesBC; delete it.impostoSeletivo; }],
    ['suspensao sem regular', (it) => { it.cst = '550'; it.cClassTrib = '550001'; delete it.tributacaoRegular; }],
    ['suspensao incompativel', (it) => { it.cst = '550'; it.cClassTrib = '550001'; it.tributacaoRegular = { cst: '550', cClassTrib: '550001' }; }],
    ['regular cst errado', (it) => { it.cst = '550'; it.cClassTrib = '550001'; it.tributacaoRegular = { cst: '010', cClassTrib: '000001' }; it.ncm = '24021000'; delete it.nbs; }],
    ['aliquotas nominais 2026', (it) => { it.aliquotasNominais = pick([{ cbs: N('1') }, { impostoSeletivo: { adRem: N('1') } }, {}, { impostoSeletivo: {} }]); }],
    ['IS em 2026', (it) => { it.impostoSeletivo = { cst: '000', cClassTrib: '000001', baseCalculo: N('100') }; }],
    ['quantidade zero', (it) => { it.quantidade = N(pick(['0', '-1', '-0.5'])); }],
    ['unidade longa', (it) => { it.unidade = 'UNIDADE-LONGA'; }],
  ];
  for (const [rotulo, f] of itensErro) for (let k = 0; k < 3; k++) { const o = um(); f(o.itens[0]); ambos(o, `item ${rotulo}`); }
  const itensErro2027 = [
    ['sem aliquotas nominais', (it) => { delete it.aliquotasNominais; it.cst = '000'; it.cClassTrib = '000001'; }],
    ['aliquotas parciais', (it) => { it.aliquotasNominais = { cbs: N('8.8') }; it.cst = '000'; it.cClassTrib = '000001'; }],
    ['IS exigido sem grupo', (it) => { it.ncm = pick(ncmIS.length ? ncmIS : ['24021000']); delete it.nbs; delete it.impostoSeletivo; it.cst = '000'; it.cClassTrib = '000001'; it.aliquotasNominais = aliquotasNominais(); }],
    ['IS sem aliquota', (it) => { it.ncm = '24021000'; delete it.nbs; it.cst = '000'; it.cClassTrib = '000001'; it.aliquotasNominais = aliquotasNominais(); it.impostoSeletivo = { cst: '000', cClassTrib: '000001', baseCalculo: N('200') }; }],
    ['IS adRem sem unidade', (it) => { it.ncm = '24021000'; delete it.nbs; it.cst = '000'; it.cClassTrib = '000001'; it.aliquotasNominais = { ...aliquotasNominais(), impostoSeletivo: { adRem: N('1') } }; it.impostoSeletivo = { cst: '000', cClassTrib: '000001', baseCalculo: N('200'), quantidade: N('1'), unidade: pick(['', ' ', '\t']) }; }],
    ['IS adRem sem quantidade', (it) => { it.ncm = '24021000'; delete it.nbs; it.cst = '000'; it.cClassTrib = '000001'; it.aliquotasNominais = { ...aliquotasNominais(), impostoSeletivo: { adRem: N('1') } }; it.impostoSeletivo = { cst: '000', cClassTrib: '000001', baseCalculo: N('200'), unidade: 'VN' }; }],
    ['base IS inconsistente', (it) => { it.ncm = '24021000'; delete it.nbs; it.cst = '000'; it.cClassTrib = '000001'; it.baseCalculo = N('200.00'); it.aliquotasNominais = { ...aliquotasNominais(), impostoSeletivo: { adValorem: N('10') } }; it.impostoSeletivo = { cst: '000', cClassTrib: '000001', baseCalculo: N('188.0'), impostoInformado: N('1E+1') }; }],
    ['base menor que IS', (it) => { it.ncm = '24021000'; delete it.nbs; it.cst = '000'; it.cClassTrib = '000001'; it.baseCalculo = N('100'); it.aliquotasNominais = { ...aliquotasNominais(), impostoSeletivo: { adValorem: N('10') } }; it.impostoSeletivo = { cst: '000', cClassTrib: '000001', baseCalculo: N('188.0') }; }],
    ['IS cst inexistente', (it) => { it.impostoSeletivo = { cst: '999', cClassTrib: '000001', baseCalculo: N('1') }; }],
    ['IS classificacao inexistente', (it) => { it.impostoSeletivo = { cst: '000', cClassTrib: '999999', baseCalculo: N('1') }; }],
  ];
  for (const [rotulo, f] of itensErro2027) for (let k = 0; k < 3; k++) { const o = um(2027); f(o.itens[0]); ambos(o, `item2027 ${rotulo}`); }
  // tpDoc × nomenclature (NF-e, NFC-e, NFS-e, NFCom, CT-e) and NCM zero
  for (let k = 0; k < 24; k++) {
    const o = operacao({ ano: chance(0.6) ? 2026 : 2027, tpDoc: pick([55, 65, 91, 62, 57]), itens: 1, compraGov: false });
    const it = o.itens[0];
    const r = rnd();
    if (r < 0.25) { it.ncm = pick(['00', '00000000', '0', ' 00']); delete it.nbs; } else if (r < 0.45) { delete it.ncm; delete it.nbs; } else if (r < 0.6) { it.nbs = pick(nbss); delete it.ncm; } else if (r < 0.75) { it.ncm = pick(ncms).slice(0, inteiro(2, 7)); delete it.nbs; }
    ambos(o, `nomenclatura tpDoc=${o.tpDoc}`);
  }
  // gComponentesBC
  for (let k = 0; k < 16; k++) {
    const o = operacao({ ano: pick([2026, 2027, 2030, 2033, 2034]), tpDoc: pick([55, 65, 55, 57, undefined]), itens: 1, compraGov: false });
    const it = o.itens[0];
    it.gComponentesBC = { vProd: N(pick(['1000', '1000.00', '100', '0'])), vFrete: chance(0.5) ? N('50') : undefined, vDesc: chance(0.5) ? N(pick(['40', '2000'])) : undefined, vPIS: chance(0.4) ? N('9.25') : undefined, vICMS: chance(0.5) ? N('180') : undefined, vISSQN: chance(0.3) ? N('20') : undefined, vII: chance(0.3) ? N('150') : undefined };
    if (chance(0.4)) it.baseCalculo = N(pick(['850', '850.00', '900', '850.125', '1000']));
    else delete it.baseCalculo;
    if (chance(0.15)) it.gComponentesBC = {};
    ambos(o, `componentes tpDoc=${o.tpDoc ?? '-'}`);
  }

  // ── 4. Bean Validation ──────────────────────────────────────────────────────
  const valid = () => { const o = um(2026); o.itens[0] = { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: N('100') }; return o; };
  const camposOperacao = [
    ['id', [null]], ['versao', [null]], ['municipio', [null, -1, 10000000, N('-0.5'), '12']], ['uf', ['R', 'RSS', '', null]],
    ['tpDoc', [0, 1000, -5, N('1.9'), '55']], ['gCompraGov', [{}, { tpOperGov: 1 }]], ['itens', [null, []]],
  ];
  for (const [campo, valores] of camposOperacao) {
    for (const v of valores) {
      const o = valid();
      o[campo] = v;
      if (v === null) delete o[campo];
      ambos(o, `bv operacao ${campo}=${JSON.stringify(v instanceof NumeroCru ? v.texto : v)}`);
      if (chance(0.5)) add(OBS, o, `bv operacao locale ${campo}`, { 'accept-language': pick(['en', 'fr;q=0.5, en', 'zh-CN', 'az', '*', 'ja', 'xx', 'pt']) });
    }
  }
  const camposItem = [
    ['numero', [null, 0, 10000000, N('1.9'), '7']], ['cst', [null, '1a', '0001', '', '00', '000\n']], ['cClassTrib', [null, 'abcdef', '00001', '0000011']],
    ['baseCalculo', [N('-1'), N('1.000'), N('1E+13'), N('1E+12'), N('-0.00'), N('9999999999999.99'), '"200.50"']], ['quantidade', [N('1E+11'), N('0.00001'), N('-1')]],
    ['impostoSeletivo', [{}, { cst: '000', cClassTrib: '000001' }, { cst: '000', cClassTrib: '000001', baseCalculo: N('-1') }, { cst: '000', cClassTrib: '000001', baseCalculo: N('1'), quantidade: N('-1') }]],
    ['tributacaoRegular', [{}, { cst: 'x', cClassTrib: '000001' }]],
    ['gComponentesBC', [{ vProd: N('-1') }, { vDesc: N('-0.01'), vICMS: N('-2') }]],
    ['aliquotasNominais', [{ cbs: N('100.00001') }, { cbs: N('101') }, { ibsEstadual: N('-1') }, { impostoSeletivo: { adRem: N('-0.1') } }, { impostoSeletivo: { adValorem: N('1000') } }]],
  ];
  for (const [campo, valores] of camposItem) {
    for (const v of valores) {
      const o = valid();
      if (v === null) delete o.itens[0][campo];
      else o.itens[0][campo] = typeof v === 'string' && v.startsWith('"') ? N(v) : v;
      const rotulo = `bv item ${campo}=${v instanceof NumeroCru ? v.texto : JSON.stringify(v)}`;
      add(OBS, o, `obs ${rotulo}`);
      if (validacoesItem(o.itens[0]) <= 1) add(RG, o, `rg ${rotulo}`, chance(0.3) ? { 'accept-language': pick(['en', 'pt', 'es', 'it']) } : {});
    }
  }
  // request locale of the messages (Tomcat AcceptLanguage2 + JDK ResourceBundle + HV bundles)
  const IDIOMAS = ['en', 'en-US,en;q=0.9', 'pt', 'pt-PT', 'pt-BR,pt;q=0.9,en;q=0.8', 'es', 'fr', 'de', 'it', 'nl', 'ja', 'ko', 'zh', 'zh-CN', 'zh-TW', 'zh-Hant', 'zh-HK',
    'ru', 'uk', 'pl', 'cs', 'sk', 'hu', 'ro', 'tr', 'az', 'ar', 'fa', 'da', 'mn-MN', 'mn', 'xx', '*', 'i-klingon', 'x-pt', 'en;q=0', 'fr;q=0.4, de;q=0.6', 'pt_BR', 'de-CH-1996'];
  for (const al of IDIOMAS) {
    const v1 = valid();
    v1.itens[0].numero = pick([0, 10000000]);
    add(RG, v1, `rg locale ${al}`, { 'accept-language': al });
    const v2 = valid();
    const mut = pick([(o) => { o.municipio = -1; }, (o) => { o.tpDoc = 1000; }, (o) => { o.uf = 'R'; }, (o) => { o.itens = []; }, (o) => { o.gCompraGov = {}; }]);
    mut(v2);
    add(OBS, v2, `obs locale ${al}`, { 'accept-language': al });
    const v3 = valid();
    v3.itens[0].baseCalculo = N('1.000');
    add(RG, v3, `rg locale digits ${al}`, { 'accept-language': al });
  }
  // several invalid fields at once (observabilidade only: VAL lists are compared as multisets)
  for (let k = 0; k < 10; k++) {
    const o = valid();
    const it = o.itens[0];
    for (const [campo, valores] of camposItem) if (chance(0.3)) it[campo] = pick(valores.filter((x) => x !== null && !(typeof x === 'string' && x.startsWith('"'))));
    if (chance(0.3)) o.itens.push({ numero: 2, cst: '000', cClassTrib: '000001', baseCalculo: N('1') }, { cst: '1' });
    add(OBS, o, 'obs bv multiplos');
  }

  // ── 5. Jackson / body level ─────────────────────────────────────────────────
  const corpoValido = escreverJson(valid());
  const crus = [
    ['vazio', ''], ['espacos', '  \n '], ['null', 'null'], ['array', '[]'], ['string vazia', '""'], ['string', '"x"'], ['numero', '1'],
    ['objeto aberto', '{'], ['lixo depois', `${corpoValido} x`], ['dois objetos', `${corpoValido}{}`], ['virgula final', '{"id":"x",}'],
    ['comentario', '{/*c*/"id":"x"}'], ['aspas simples', "{'id':'x'}"], ['NaN', '{"municipio":NaN}'], ['zero a esquerda', '{"municipio":01}'],
    ['mais', '{"municipio":+1}'], ['ponto', '{"municipio":.5}'], ['controle', '{"id":"a\u0001b"}'], ['escape invalido', '{"id":"\\x"}'],
    ['itens objeto', '{"id":"x","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":{}}'],
    ['itens string', '{"itens":"x"}'], ['gCompraGov string', '{"gCompraGov":""}'], ['gCompraGov numero', '{"gCompraGov":1}'],
    ['tpEnteGov 7', '{"gCompraGov":{"tpEnteGov":7}}'], ['tpEnteGov "02"', '{"gCompraGov":{"tpEnteGov":"02"}}'], ['tpEnteGov " 2 "', `{"id":"x","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","gCompraGov":{"tpEnteGov":" 2 "},"itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":1}]}`],
    ['tpEnteGov 2.0', '{"gCompraGov":{"tpEnteGov":2.0}}'], ['tpEnteGov vazio', '{"gCompraGov":{"tpEnteGov":""}}'], ['tpOperGov 9', '{"gCompraGov":{"tpEnteGov":1,"tpOperGov":9}}'],
    ['numero fora int', '{"itens":[{"numero":3000000000}]}'], ['numero string decimal', '{"itens":[{"numero":"5.0"}]}'], ['numero booleano', '{"itens":[{"numero":true}]}'],
    ['municipio fora long', '{"municipio":9223372036854775808}'], ['municipio string', '{"municipio":"abc"}'], ['municipio float', '{"municipio":1.5e3}'],
    ['baseCalculo string', '{"itens":[{"baseCalculo":"abc"}]}'], ['baseCalculo booleano', '{"itens":[{"baseCalculo":false}]}'], ['baseCalculo objeto', '{"itens":[{"baseCalculo":{}}]}'],
    ['baseCalculo string vazia', `{"id":"x","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":" "}]}`],
    ['id objeto', '{"id":{}}'], ['id array', '{"id":[]}'], ['id numero', `{"id":1.50,"versao":true,"municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":[{"numero":1,"cst":0,"cClassTrib":"000001","baseCalculo":1}]}`],
    ['numero longo', `{"itens":[{"baseCalculo":${'1'.repeat(1001)}}]}`], ['aninhamento', `{"x":${'['.repeat(600)}${']'.repeat(600)}}`],
    ['item null', '{"id":"x","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":[null]}'],
    ['item null com outro', '{"id":"x","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":1},null]}'],
    ['chave duplicada', '{"id":"x","id":null,"versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":1}]}'],
    ['chave desconhecida', '{"id":"x","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","__proto__":{"a":1},"tpEnteGov":1,"itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":1,"constructor":2}]}'],
  ];
  const datas = ['2026-01-15T13:45:00+0300', '2026-01-15T13:45:00.000-03:00', '2026-01-15', '2026-02-30T00:00:00Z', '2026-01-15T24:00:00Z', '2026-01-15T13:45:00+18:01',
    '2026-01-15T13:45:00z', '2026-01-15 13:45:00Z', '2026-01-15T13:45Z', '0000-01-01T00:00:00Z', '2024-02-29T00:00:00-00:00', '2026-01-15T13:45:00+03', 20260101, true, {}];
  for (const d of datas) {
    const campo = pick(['dhFatoGerador', 'dataHoraEmissao']);
    crus.push([`data ${campo} ${JSON.stringify(d)}`, `{"id":"x","versao":"1","municipio":4314902,"${campo}":${JSON.stringify(d)},"itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":1}]}`]);
  }
  for (const [rotulo, texto] of crus) {
    // main endpoint + null item: HotSpot's OmitStackTraceInFastThrow drops the NPE message once the JIT has
    // seen it often enough (the oracle answers with or without "detail" depending on its history)
    if (rotulo.startsWith('item null')) add(OBS, texto, `obs json ${rotulo}`);
    else ambos(texto, `json ${rotulo}`);
  }
  add(RG, Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), 'rg utf8 invalido');
  add(OBS, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(corpoValido)]), 'obs bom utf8');
  add(OBS, Buffer.from('{"id":"\xe9","versao":"1","municipio":4314902,"dhFatoGerador":"2026-01-01T00:00:00Z","itens":[{"numero":1,"cst":"000","cClassTrib":"000001","baseCalculo":1}]}', 'latin1'), 'obs latin1 declarado', { 'content-type': 'application/json;charset=ISO-8859-1' });
  add(RG, corpoValido, 'rg sem content-type', { 'content-type': undefined });
  for (const [cs, bytes] of [['UTF-16', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(corpoValido, 'utf16le').swap16()])], ['UTF-16LE', Buffer.from(corpoValido, 'utf16le')],
    ['windows-1252', Buffer.from(corpoValido, 'latin1')], ['utf-8', Buffer.from(corpoValido)], ['US-ASCII', Buffer.from(corpoValido)]]) {
    add(OBS, bytes, `obs charset ${cs}`, { 'content-type': `application/json;charset=${cs}` });
    add(RG, bytes, `rg charset ${cs}`, { 'content-type': `application/json; charset=${cs}` });
  }
  // coercions that reach the pipeline (Long/Integer/BigDecimal from strings and floats)
  for (const [rotulo, campo, v] of [['municipio string espacos', 'municipio', '" 4314902 "'], ['municipio mais', 'municipio', '"+4314902"'], ['municipio float', 'municipio', '4314902.9'],
    ['municipio expoente', 'municipio', '4.314902E6'], ['tpDoc string', 'tpDoc', '"55"'], ['tpDoc float', 'tpDoc', '55.7'], ['uf com espaco', 'uf', '" RS"'], ['uf minuscula', 'uf', '"rs"']]) {
    const o = valid();
    o.municipio = 4314902;
    o[campo] = N(v);
    ambos(o, `coercao ${rotulo}`);
  }
  // observabilidade: items without numero (nObj = index + 1), duplicates and mixed states
  for (let k = 0; k < 8; k++) {
    const o = operacao({ ano: pick([2026, 2027]), itens: inteiro(2, 5), compraGov: chance(0.3) });
    for (const it of o.itens) { if (chance(0.3)) delete it.numero; else if (chance(0.3)) it.numero = inteiro(1, 3); }
    add(OBS, o, 'obs numeros ausentes e repetidos');
  }
  // limits of the numeric formats
  for (const v of ['9999999999999.99', '0.01', '0.001', '12345678901.1234', '1E+2', '1.0E+2', '100.0']) {
    const o = valid();
    o.itens[0].baseCalculo = N(v);
    o.itens[0].quantidade = N(pick(['12345678901.1234', '0.0001', '1E+3', '3']));
    ambos(o, `limites baseCalculo=${v}`);
  }

  // ── 6. GET erros?codigo= ───────────────────────────────────────────────────
  const codigos = [...Array.from({ length: 39 }, (_, i) => `REG-${String(i).padStart(3, '0')}`), ...Array.from({ length: 13 }, (_, i) => `CAL-${String(i).padStart(3, '0')}`), 'CAL-999',
    ...Array.from({ length: 17 }, (_, i) => `VAL-${String(i).padStart(3, '0')}`), 'reg-001', '%20REG-001', 'REG-001%20', '', 'REG-001&codigo=REG-002', 'X', 'ERRO_SISTEMA', '%C3%A9'];
  for (const c of codigos) add(`${ERROS}?codigo=${c}`, undefined, `erros ${c}`, {}, 'GET');
  add(ERROS, undefined, 'erros sem codigo', {}, 'GET');
  add(`${ERROS}?Codigo=REG-001`, undefined, 'erros parametro maiusculo', {}, 'GET');
  add(`${ERROS}?codigo=REG-001`, undefined, 'erros accept xml', { accept: 'application/xml' }, 'GET');

  // ── 7. official rounding batch (GeradorLoteArredondamento: 2000 notes, 1–20 items each) ─────────
  const notas = readFileSync(LOTE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const nota of notas.slice(0, Math.min(notas.length, Math.max(100, 2 * n)))) enviar(nota.corpo, `lote ${nota.indice} ${nota.perfil}`);

  // ── main-endpoint cases that are deterministic on the Java side ───────────────────
  for (const p of pendentes) {
    add(OBS, p.corpo, `obs ${p.rotulo}`, p.headers);
    if (await avaliador.deterministaNoPrincipal(p.corpo)) add(RG, p.corpo, `rg ${p.rotulo}`, p.headers);
  }
  for (const c of casos) for (const k of Object.keys(c.headers)) if (c.headers[k] === undefined) delete c.headers[k];
  return casos;
}

/** Count of Bean Validation violations of an item (to keep the main endpoint deterministic). */
function validacoesItem(item) {
  try {
    const op = vincularOperacao(lerDocumentoJson(Buffer.from(escreverJson({ itens: [item] }))).raiz);
    return validar(op.itens[0], 'ItemOperacaoInput').length;
  } catch {
    return 99;
  }
}
