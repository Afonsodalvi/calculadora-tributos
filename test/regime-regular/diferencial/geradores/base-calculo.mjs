// Differential cases of the base-calculo slice (12 official endpoints):
//   E1 cbs-ibs-mercadorias, E2 is-mercadorias, E3 base-calculo-unificada (NF-e 55 / NFC-e 65),
//   E4 base-calculo-unificada-nfse, E5 nfse/base-calculo, E6 nfse/indicador-operacao/validate,
//   E7 nfse/local-operacao, E8 nfse/indicador-operacao, E9 nfse/situacoes-classificacoes-tributarias,
//   E10/E11 nfse/locais-fornecimento|incidencia, E12 pedagio.
// Years 2025–2034 (plus out-of-range ones), every component and combination, negative values,
// nulls, wrong JSON types, both document models, NFS-e regimes/MEI/locação/salão parceiro and
// adjustment types, pedágio sections duplicated/unsorted/with real and wrong municipalities/UFs and
// dates, request params in ISO and localized formats, Accept-Language variants.
// Bodies are written as raw JSON text so number lexemes (scale, exponents) reach both sides as is.
// Never generated (documented divergence, unsafe for the oracle): BigDecimal exponents beyond
// ±100000 (the Java API materializes 10^|scale|).
//
// Comparison notes for this slice: the order of E3 `avisos` (Set.of iteration, random per JVM)
// and of 2+ "[campo: mensagem] " validation segments (HashSet) is not deterministic in Java; the
// port uses declaration order, so those bodies are equal as multisets.

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Raw JSON writer: values given as { cru: 'text' } go verbatim (number lexemes, broken tokens). */
function json(v) {
  if (v && typeof v === 'object' && 'cru' in v) return v.cru;
  if (Array.isArray(v)) return `[${v.map(json).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${json(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
const n = (texto) => ({ cru: texto });

const ACEITES_IDIOMA = [undefined, undefined, undefined, 'en', 'pt', 'pt-BR', 'en-US,pt;q=0.5', 'fr', 'de', 'es', 'zh-TW', 'zh-Hant', 'xx', '*', 'pt_BR', 'az', 'tr', 'en;q=0', ',,de', 'it;q=0.9, ja'];

export function gerar({ seed = 1, n: total = 300, base }) {
  const rnd = prng(seed ^ 0xb45e);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const inteiro = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const casos = [];
  const add = (metodo, caminho, corpo, rotulo, headers = {}) => {
    const h = {};
    if (corpo !== undefined) h['content-type'] = 'application/json';
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    casos.push({ metodo, caminho, headers: h, corpo, rotulo });
  };
  const idioma = () => (chance(0.25) ? { 'accept-language': pick(ACEITES_IDIOMA) } : {});
  const quota = Math.max(1, Math.round(total / 300));

  // ── value pools ───────────────────────────────────────────────────────────
  const POSITIVOS = ['0', '0.00', '1', '10', '10.5', '100.00', '100.005', '1000.0', '0.01', '0.001', '1E+2', '1e2', '2.5E1', '1e-7', '0.0000001',
    '12345678901234.56', '999.999', '5', '7.60', '1.65', '0.5', '33.33', '250', '1000.05'];
  const decimal = () => {
    const r = rnd();
    if (r < 0.62) return n(pick(POSITIVOS));
    if (r < 0.70) return pick(['10', '0.00', '1E+2', ' 5 ', '1.5', '+3', '.5', '5.']); // String coercion
    if (r < 0.77) return n(pick(['-1', '-0.01', '-0.0', '-1E+2', '-100.5']));
    if (r < 0.83) return null;
    if (r < 0.87) return '';
    if (r < 0.90) return pick(['abc', 'null', '1,5', '1e', 'NaN']);
    if (r < 0.93) return pick([true, false]);
    if (r < 0.96) return pick([{}, [], [1]]);
    return n(pick(['1.0', '1.10', '0E-10', '1E-3', '2E+3']));
  };
  const ano = (faixa = [2025, 2034]) => {
    const r = rnd();
    if (r < 0.82) return inteiro(faixa[0], faixa[1]);
    if (r < 0.86) return pick([2024, 2035, 2040, 0, -1, 1]);
    if (r < 0.90) return pick(['2026', '2027', ' 2033 ']);
    if (r < 0.93) return n(pick(['2026.9', '2027.0', '2.026E3']));
    if (r < 0.96) return null;
    return pick(['abc', true, {}, '', n('2147483648')]);
  };
  const subconjunto = (campos, p = 0.4) => campos.filter(() => chance(p));

  // ── E1 / E2 / E5 ──────────────────────────────────────────────────────────
  const CIBS_INTEGRAM = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'frete', 'impostoSeletivo', 'outrosTributos', 'demaisImportancias'];
  const CIBS_NAO = ['icms', 'iss', 'pis', 'pisImportacao', 'cofins', 'cofinsImportacao', 'cosip', 'ipi', 'descontoIncondicional'];
  const IS_INTEGRAM = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'freteCobrado', 'outrosTributos', 'demaisImportancias'];
  const IS_NAO = ['icms', 'iss', 'cosip', 'ipi', 'descontoIncondicional', 'bonificacao', 'devolucaoVendas'];
  const NFSE = ['descontoIncondicional', 'vCalcReeRepRes', 'vCalcDedRedIBSCBS', 'iss', 'pis', 'cofins'];

  function corpoMercadorias(integram, nao, extras = []) {
    const o = {};
    if (chance(0.95)) o.anoFatoGerador = ano();
    // integrating values usually larger so the base is often positive
    for (const c of subconjunto(integram, 0.5)) o[c] = chance(0.7) ? n(pick(['1000', '500.50', '250.005', '1E+3', '99.99'])) : decimal();
    for (const c of subconjunto([...nao, ...extras], 0.35)) o[c] = decimal();
    return o;
  }
  for (let i = 0; i < 70 * quota; i++) add('POST', '/api/calculadora/base-calculo/cbs-ibs-mercadorias', json(corpoMercadorias(CIBS_INTEGRAM, CIBS_NAO, ['freteCobrado', 'x'])), 'E1', idioma());
  for (let i = 0; i < 55 * quota; i++) add('POST', '/api/calculadora/base-calculo/is-mercadorias', json(corpoMercadorias(IS_INTEGRAM, IS_NAO, ['pis', 'cofins', 'frete', 'impostoSeletivo'])), 'E2', idioma());
  for (let i = 0; i < 55 * quota; i++) {
    const o = {};
    if (chance(0.95)) o.anoFatoGerador = ano();
    if (chance(0.92)) o.valorServico = chance(0.75) ? n(pick(['100.00', '1000', '10.00', '0.01', '5E+2'])) : decimal();
    for (const c of subconjunto(NFSE, 0.4)) o[c] = decimal();
    add('POST', '/api/calculadora/nfse/base-calculo', json(o), 'E5', idioma());
  }
  // year boundaries with the extinct fields (exact messages and their order)
  for (const a of [2026, 2027, 2032, 2033, 2034]) {
    add('POST', '/api/calculadora/base-calculo/cbs-ibs-mercadorias', json({ anoFatoGerador: a, valorBem: n('1000'), pis: n('1'), pisImportacao: n('2'), cofins: n('3'), cofinsImportacao: n('4'), icms: n('5'), iss: n('6') }), 'E1-vigencia');
    add('POST', '/api/calculadora/base-calculo/is-mercadorias', json({ anoFatoGerador: a, valorBem: n('1000'), icms: n('5'), iss: n('0.00') }), 'E2-vigencia');
    add('POST', '/api/calculadora/nfse/base-calculo', json({ anoFatoGerador: a, valorServico: n('100'), pis: n('0.0'), cofins: n('1'), iss: n('2') }), 'E5-vigencia');
  }

  // ── E3 base-calculo-unificada ─────────────────────────────────────────────
  const COMPONENTES = ['vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIS', 'vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vICMSUFDest', 'vFCP', 'vFCPUFDest', 'vICMSMono', 'vISSQN'];
  const NATUREZAS = ['BEM', 'SERVICO', 'bem', 'Serviço', 'SERVIÇO', 'bém', ' bem', 'x', '', null, n('1'), true, {}, []];
  const TPDOC = [55, 65, 55, 65, 57, null, '55', n('65.9'), 'abc'];
  for (let i = 0; i < 80 * quota; i++) {
    const o = {};
    const ordem = [];
    if (chance(0.96)) ordem.push(['anoFatoGerador', ano([2025, 2034])]);
    if (chance(0.95)) ordem.push(['tipoDocumento', chance(0.85) ? pick([55, 65]) : pick(TPDOC)]);
    if (chance(0.95)) ordem.push(['natureza', chance(0.8) ? pick(['BEM', 'SERVICO']) : pick(NATUREZAS)]);
    // single avisos only most of the time (Set.of order of 2+ avisos differs from the port)
    for (const c of subconjunto(COMPONENTES, 0.35)) ordem.push([c, chance(0.85) ? n(pick(['1000', '10.005', '0', '0.00', '9.25', '46.25', '180', '1E+2', '0.0000001'])) : decimal()]);
    if (chance(0.05)) ordem.push(['componentes', { vProd: 5 }]);
    // shuffle: unwrapped values may come before the main properties
    for (let k = ordem.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [ordem[k], ordem[j]] = [ordem[j], ordem[k]]; }
    for (const [k, v] of ordem) o[k] = v;
    add('POST', '/api/calculadora/base-calculo/base-calculo-unificada', json(o), 'E3', idioma());
  }
  // every element alone, per year × nature × model (one notice at most)
  for (const c of COMPONENTES) {
    for (const a of [2025, 2026, 2027, 2032, 2033, 2034]) {
      add('POST', '/api/calculadora/base-calculo/base-calculo-unificada', json({ anoFatoGerador: a, tipoDocumento: pick([55, 65]), natureza: pick(['BEM', 'SERVICO']), [c]: n('123.456') }), `E3-elemento ${c}`);
    }
  }
  add('POST', '/api/calculadora/base-calculo/base-calculo-unificada', json({ anoFatoGerador: 2026, tipoDocumento: 55, natureza: 'BEM', vProd: n('1000.0'), vFrete: n('10.005'), vDesc: n('0.0'), vPIS: n('9.25'), vCOFINS: n('46.25') }), 'E3-T10');

  // ── E4 base-calculo-unificada-nfse ────────────────────────────────────────
  const TIPOS_AJUSTE = ['101', '102', '103', '104', '105', '199', '9', '0', '09', '101 ', 'x', n('101'), ' '];
  const documento = () => {
    const d = {};
    if (chance(0.95)) d.tpAjusteBC = chance(0.8) ? pick(['101', '102', '103', '104', '105', '199', '9']) : pick(TIPOS_AJUSTE);
    if (chance(0.95)) d.vAjusteAplic = chance(0.8) ? n(pick(['5', '10.00', '0', '50', '3.333', '0.005'])) : decimal();
    if (chance(0.5)) d.xTpAjusteBC = pick(['Ajuste', '', ' ', 'Outro ajuste', null]);
    return d;
  };
  const locacao = () => {
    if (chance(0.1)) return pick([{}, 'x', 1, []]);
    const l = {};
    for (const c of ['pCopropriedade', 'vTotOper', 'vDescIncondTot', 'somaAjustesLocImoveis']) {
      if (chance(0.95)) l[c] = chance(0.85) ? n(pick(['100', '50', '33.33', '1000.05', '10.00', '0', '0.0', '5', '80'])) : decimal();
    }
    return l;
  };
  const SITUACOES = ['comum', 'salaoParceiro', 'locacao9903'];
  for (let i = 0; i < 110 * quota; i++) {
    const o = {};
    if (chance(0.96)) o.anoFatoGerador = ano([2025, 2034]);
    if (chance(0.96)) o.opSimpNac = chance(0.85) ? pick([1, 2, 3, 4, '1', '2', '3', '4']) : pick([5, 0, -1, '5', '', ' 3 ', '1.5', n('3.7'), true, null, 'abc', {}]);
    if (chance(0.97)) o.situacao = chance(0.88) ? pick(SITUACOES) : pick(['COMUM', 0, 1, 2, 3, '2', '', '  ', null, true, n('1.5'), 'salaoparceiro']);
    for (const c of subconjunto(['vServ', 'vDescIncond', 'vISSQN', 'vPIS', 'vCOFINS'], 0.55)) o[c] = chance(0.75) ? n(pick(['100.00', '500', '20', '15', '0.65', '3.00', '5', '100.777', '5.444', '0', '-5', '1000'])) : decimal();
    if (chance(0.6)) o.regApIBSCBSSN = chance(0.85) ? pick([1, 2, 3, '1', '2', '3', null]) : pick([4, '0', '', true]);
    if (chance(0.45)) o.documentos = chance(0.95) ? Array.from({ length: inteiro(0, 4) }, documento) : pick([{}, 'x', [null]]);
    if (o.situacao === 'locacao9903' ? chance(0.85) : chance(0.15)) o.locacao = locacao();
    add('POST', '/api/calculadora/base-calculo/base-calculo-unificada-nfse', json(o), 'E4', idioma());
  }
  // the spec's scenarios (§5.7) as exact bodies
  const E4 = '/api/calculadora/base-calculo/base-calculo-unificada-nfse';
  add('POST', E4, json({ anoFatoGerador: 2026, opSimpNac: '1', situacao: 'locacao9903', vServ: n('1000.0'), vDescIncond: n('0.0'), vISSQN: n('0.0'), vPIS: n('0.0'), vCOFINS: n('0.0'), locacao: { pCopropriedade: n('33.33'), vTotOper: n('1000.05'), vDescIncondTot: n('0.0'), somaAjustesLocImoveis: n('0.0') } }), 'E4-rg12');
  add('POST', E4, json({ anoFatoGerador: 2026, opSimpNac: '3', situacao: 'comum', regApIBSCBSSN: '1', documentos: [{ tpAjusteBC: '101', vAjusteAplic: '50' }], vServ: '50', vDescIncond: '10' }), 'E4-e1534');
  add('POST', E4, json({ anoFatoGerador: 2026, opSimpNac: '2', situacao: 'locacao9903', locacao: { pCopropriedade: '100', vTotOper: '1000', vDescIncondTot: '0', somaAjustesLocImoveis: '0' }, documentos: [{ tpAjusteBC: '101', vAjusteAplic: '5' }] }), 'E4-mei-locacao');

  // ── E6 indicador-operacao/validate ────────────────────────────────────────
  const combinacoes = base.all(`SELECT c.CNIL_NBS_CD nbs, ct.CLTR_CD cct, io.IOIC_CD ind, c.CNIL_LSLC_CD lc, c.CNIL_INICIO_VIGENCIA ini
    FROM CLASSIF_NBS_INDOP_LC c JOIN CLASSIFICACAO_TRIBUTARIA ct ON c.CNIL_CLTR_ID = ct.CLTR_ID JOIN INDICADOR_OPERACAO_IBS_CBS io ON c.CNIL_IOIC_ID = io.IOIC_ID
    ORDER BY c.CNIL_ID`);
  const lcParaTribNac = (lc) => {
    if (!lc) return null;
    const p = String(lc).split('.');
    return p.map((x, i) => (i === 0 ? x.padStart(2, '0') : x)).join('');
  };
  const DATAS = ['2026-01-01', '2026-06-15', '2026-11-30', '2026-12-01', '2027-01-01', '2025-12-31', '2030-05-05'];
  for (let i = 0; i < 45 * quota; i++) {
    const c = pick(combinacoes);
    const o = {};
    if (chance(0.95)) o.cIndOp = chance(0.85) ? c.ind : pick(['999999', '12345', '', null, n('100301'), ' 100301', 'abcdef']);
    if (chance(0.95)) o.cClassTrib = chance(0.85) ? c.cct : pick(['999999', '', null, n('1'), '000001']);
    if (chance(0.95)) o.nbs = chance(0.85) ? c.nbs : pick(['999999999', '12345', '', null, n('115021000')]);
    if (chance(0.7)) o.cTribNac = chance(0.75) ? lcParaTribNac(c.lc) : pick(['0101', '170101', '9999', '101', '', null, n('101'), '1.01']);
    if (chance(0.95)) o.dataOcorrenciaFatoGerador = chance(0.85) ? (chance(0.6) ? c.ini : pick(DATAS)) : pick(['2026-02-30', '2026-1-01', n('20260101'), null, '', '2026-01-01T00:00:00']);
    add('POST', '/api/calculadora/nfse/indicador-operacao/validate', json(o), 'E6', idioma());
  }

  // ── E7 / E8 / E9 (GET with request params) ────────────────────────────────
  const indicadores = base.all('SELECT DISTINCT IOIC_CD c FROM INDICADOR_OPERACAO_IBS_CBS ORDER BY IOIC_CD').map((r) => r.c);
  const nbsVinculadas = [...new Set(combinacoes.map((c) => c.nbs))];
  const nbsSoltas = base.all(`SELECT n.NBS_CD c FROM NBS n WHERE n.NBS_CD NOT IN (SELECT CNIL_NBS_CD FROM CLASSIF_NBS_INDOP_LC) ORDER BY n.NBS_CD LIMIT 40`).map((r) => r.c);
  const dataParam = () => {
    const r = rnd();
    if (r < 0.6) return pick(DATAS);
    if (r < 0.75) return pick(['01/01/2026', '15/06/2026', '30/02/2026', '31/12/2026', '01/12/26', '1/1/2026']);
    if (r < 0.82) return pick(['', 'x', '2026-02-30', '%202026-01-01', '2026-1-01', '%2B2026-01-01', '20/01/10000', '-2026-01-01', '%2B10000-01-01', '0000-01-01', '05/10/1582']);
    return pick(['2026-01-01', '2026-12-01']);
  };
  const consulta = (pares) => pares.filter(([, v]) => v !== undefined).map(([k, v]) => (v === null ? k : `${k}=${v}`)).join('&');
  for (let i = 0; i < 40 * quota; i++) {
    const p = [];
    if (chance(0.93)) p.push(['cIndOp', chance(0.85) ? pick(indicadores) : pick(['999999', '12345', '', '1003011', 'abcdef'])]);
    if (chance(0.93)) p.push(['dataOcorrenciaFatoGerador', dataParam()]);
    if (chance(0.05)) p.push(['cIndOp', pick(indicadores)]);
    add('GET', `/api/calculadora/nfse/local-operacao?${consulta(p)}`, undefined, 'E7', idioma());
  }
  for (let i = 0; i < 40 * quota; i++) {
    const p = [];
    if (chance(0.93)) p.push(['dataOcorrenciaFatoGerador', dataParam()]);
    if (chance(0.7)) p.push(['nbs', chance(0.8) ? pick([...nbsVinculadas, ...nbsSoltas]) : pick(['999999999', '', '12', 'abcdefghi'])]);
    add('GET', `/api/calculadora/nfse/indicador-operacao?${consulta(p)}`, undefined, 'E8', idioma());
  }
  for (let i = 0; i < 40 * quota; i++) {
    const p = [];
    if (chance(0.93)) p.push(['nbs', chance(0.85) ? pick([...nbsVinculadas, ...nbsSoltas]) : pick(['999999999', '', '12345', '126050000'])]);
    if (chance(0.93)) p.push(['data', dataParam()]);
    add('GET', `/api/calculadora/nfse/situacoes-classificacoes-tributarias?${consulta(p)}`, undefined, 'E9', idioma());
  }

  // ── E10 / E11 ─────────────────────────────────────────────────────────────
  for (const caminho of ['/api/calculadora/nfse/locais-fornecimento', '/api/calculadora/nfse/locais-incidencia']) {
    add('GET', caminho, undefined, 'E10/E11');
    for (const v of ['1', '2', '7', '8', '29', '30', '0', '-3', '', '%20', 'x', '0x1', '%2B5', '007', '%201%202', '99999999999', '1.0', '%23A', '-0x2', '%2B0x1', '%01', '%C2%A0', '1&codigo=2']) {
      add('GET', `${caminho}?codigo=${v}`, undefined, 'E10/E11');
    }
  }

  // ── E12 pedágio ───────────────────────────────────────────────────────────
  const municipios = base.all('SELECT m.MUNI_CD c, u.UF_SIGLA uf FROM MUNICIPIO m JOIN UF u ON u.UF_CD = m.MUNI_UF_CD ORDER BY m.MUNI_CD');
  const ufs = [...new Set(municipios.map((m) => m.uf))];
  const local = () => {
    const m = pick(municipios);
    const r = rnd();
    if (r < 0.85) return [m.c, chance(0.15) ? m.uf.toLowerCase() : m.uf];
    if (r < 0.92) return [m.c, pick(ufs)];
    if (r < 0.96) return [pick([1234567, 9999999, 0]), m.uf];
    return [pick([-1, 99999999, null, '3550308', n('3550308.9')]), pick([m.uf, 'S', 'SPX', null, n('35')])];
  };
  const DATAHORAS = ['2026-10-20T10:00:00-03:00', '2026-01-01T00:00:00Z', '2026-12-31T23:59:59-03:00', '2026-06-03T03:00:00+05:00', '2026-01-01T01:00:00+05:00',
    '2025-12-31T23:00:00-03:00', '2027-01-01T00:00:00-03:00', '2026-10-20T10:00:00+00:00', '2026-10-20T10:00:00-00:00'];
  for (let i = 0; i < 90 * quota; i++) {
    const o = {};
    const [mo, uo] = local();
    if (chance(0.96)) o.dataHoraEmissao = chance(0.9) ? pick(DATAHORAS) : pick(['2026-10-20T10:00:00', '2026-10-20T10:00:00.5Z', n('123'), null, '', '2026-02-30T10:00:00Z', '2026-10-20T10:00:00+18:01']);
    if (chance(0.97)) o.codigoMunicipioOrigem = mo;
    if (chance(0.97)) o.ufMunicipioOrigem = uo;
    if (chance(0.97)) o.cst = chance(0.9) ? '000' : pick(['00', '0000', n('200'), null, '']);
    if (chance(0.97)) o.cClassTrib = chance(0.9) ? pick(['000001', '000002']) : pick(['1', null, n('123456')]);
    if (chance(0.97)) o.baseCalculo = chance(0.8) ? n(pick(['200', '200.0', '200.00', '1000.55', '0', '2E+2', '33.33', '0.01', '9999999999999.99'])) : pick([n('200.000'), n('0.001'), n('-1'), '200', '1e2', null, 'abc', n('12345678901234.5')]);
    const qtd = chance(0.92) ? inteiro(1, 5) : pick([0, 6]);
    const numeros = Array.from({ length: qtd }, (_, k) => k + 1);
    for (let k = numeros.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [numeros[k], numeros[j]] = [numeros[j], numeros[k]]; }
    if (qtd > 1 && chance(0.12)) numeros[1] = numeros[0];
    if (chance(0.05)) numeros[0] = pick([0, -1, null]);
    const trechos = numeros.map((num) => {
      const [m, uf] = local();
      const t = {};
      t.numero = num;
      if (chance(0.98)) t.municipio = m;
      if (chance(0.98)) t.uf = uf;
      if (chance(0.98)) t.extensao = chance(0.85) ? n(pick(['10', '13', '10.5', '0.333', '100', '1E+1', '25.25', '7'])) : pick([n('0'), n('-10'), n('-3'), '20', null]);
      return t;
    });
    if (chance(0.95)) o.trechos = chance(0.97) ? trechos : pick([[], null, {}, [null]]);
    add('POST', '/api/calculadora/pedagio', json(o), 'E12', idioma());
  }
  add('POST', '/api/calculadora/pedagio', json({ dataHoraEmissao: '2026-10-20T10:00:00-03:00', codigoMunicipioOrigem: 3550308, ufMunicipioOrigem: 'SP', cst: '000', cClassTrib: '000001', baseCalculo: n('200.0'),
    trechos: [{ numero: 1, municipio: 3550308, uf: 'SP', extensao: 10 }, { numero: 2, municipio: 3509502, uf: 'SP', extensao: 13 }, { numero: 3, municipio: 3304557, uf: 'RJ', extensao: 10 }] }), 'E12-T6');

  // ── content negotiation (produces = application/json) on success and error answers ──
  for (const a of ['application/xml', 'application/*', 'text/plain', '*/*', 'application/problem+json', 'foo', 'application/json;q=0', 'text/html, */*;q=0.1']) {
    add('GET', '/api/calculadora/nfse/locais-incidencia', undefined, 'accept', { accept: a });
    add('GET', '/api/calculadora/nfse/locais-incidencia?codigo=9', undefined, 'accept', { accept: a });
    add('POST', '/api/calculadora/base-calculo/cbs-ibs-mercadorias', '{"anoFatoGerador":2026,"valorBem":1}', 'accept', { accept: a });
    add('POST', '/api/calculadora/base-calculo/cbs-ibs-mercadorias', '{"anoFatoGerador":2020}', 'accept', { accept: a });
  }
  add('HEAD', '/api/calculadora/nfse/locais-fornecimento', undefined, 'head');
  add('HEAD', '/api/calculadora/nfse/local-operacao?cIndOp=100301&dataOcorrenciaFatoGerador=2026-01-01', undefined, 'head');

  // ── malformed bodies on every POST ────────────────────────────────────────
  const POSTS = ['/api/calculadora/base-calculo/cbs-ibs-mercadorias', '/api/calculadora/base-calculo/is-mercadorias', '/api/calculadora/base-calculo/base-calculo-unificada',
    E4, '/api/calculadora/nfse/base-calculo', '/api/calculadora/nfse/indicador-operacao/validate', '/api/calculadora/pedagio'];
  for (const p of POSTS) {
    for (const corpo of ['', 'null', '  ', '[]', '"x"', '5', '{} {}', '{"anoFatoGerador":', '{"anoFatoGerador":2026,}', '{"x":[1,{"a":}]}']) add('POST', p, corpo, 'corpo-invalido');
  }
  return casos;
}
