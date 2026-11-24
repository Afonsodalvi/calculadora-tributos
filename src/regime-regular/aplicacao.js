// App routes of the Regime Regular (what the UI uses):
//   POST /api/regime-regular/preparar  { notas }               → editable operations built from the invoices
//   POST /api/regime-regular/calcular  { operacoes, aliquotas } → official CBS/IBS/IS per operation + summary
// All tax math is done by the OFFICIAL contract routes (/api/calculadora/...), called in-process
// (or, when RTC_API_URL is set, on that official API — e.g. the Java one — instead).
import { Readable } from 'node:stream';
import { Dec } from '../core/decimal.js';
import { criarContexto } from '../http/roteador.js';
import { estiloOficial, tratarOficial } from './comum/spring.js';

const PADRAO = { cst: '000', cClassTrib: '000001' }; // tributação integral
const OBSERVABILIDADE = '/api/calculadora/observabilidade/regime-geral';
const BASE_NFSE = '/api/calculadora/base-calculo/base-calculo-unificada-nfse';
const MAX_OPERACOES = 500;
// Work cap per request (sum of items over all notes/operations): each item is one official
// calculation, and the in-process pipeline does not yield inside an operation.
const MAX_ITENS = 5000;
const MAX_ITENS_OPERACAO = 990; // NF-e/NFC-e layout (det nItem 1-990): bounds the longest pause
// 2 MB like the other app JSON routes: 500 NFS-e notes are ~1 MB and 5,000 slim items ~1.5 MB
// (the UI sends /preparar in chunks and strips display-only fields before /calcular).
const LIMITE_JSON = 2 * 1024 * 1024;
const ESTADOS_OK = new Set(['CALCULADO', 'CALCULO_SIMULADO']);
/** Lets other sockets (and the health check) be served between two operations. */
const ceder = () => new Promise((r) => setImmediate(r));

/** Calls an official route of this server in-process (same code path as an HTTP request). */
export function criarChamadaInterna(roteador, urlExterna = process.env.RTC_API_URL) {
  if (urlExterna) {
    const raiz = urlExterna.replace(/\/api\/?$/, '');
    return async (method, path, corpo) => {
      const res = await fetch(raiz + path, { method, headers: { 'content-type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
      const texto = await res.text();
      return { status: res.status, body: texto ? JSON.parse(texto) : null, headers: Object.fromEntries(res.headers) };
    };
  }
  // Same pipeline as a real HTTP request to the official route (binding, validation, problem bodies),
  // minus the app guards (token/rate limit), which already ran for the outer request.
  const rotas = roteador.rotas.filter((x) => x.oficial);
  return async (method, path, corpo) => {
    const bytes = Buffer.from(corpo === undefined ? '' : JSON.stringify(corpo));
    const req = Object.assign(Readable.from(bytes.length ? [bytes] : []), {
      method, url: path,
      headers: { host: 'localhost', accept: 'application/json', 'content-type': 'application/json', 'content-length': String(bytes.length) },
    });
    let status = 0; let headers = {}; let texto = '';
    const res = {
      headersSent: false,
      writeHead(s, h) { status = s; headers = h ?? {}; this.headersSent = true; },
      end(b) { texto = b == null ? '' : Buffer.isBuffer(b) ? b.toString('utf8') : String(b); },
      destroy() {},
    };
    const enviarApp = (_res, s, body, h = {}) => { status = s; headers = h; texto = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body); };
    await tratarOficial(req, res, { rotas, estilo: estiloOficial(path), criarContexto, enviarApp });
    return { status, body: texto ? JSON.parse(texto) : null, headers };
  };
}

const vazio = (v) => v == null || v === '';
const dec = (v) => (vazio(v) ? null : String(v));
const dataDe = (dh) => (typeof dh === 'string' && dh ? dh.slice(0, 10) : null);
/** "2026-04-29" → OffsetDateTime at noon in Brasília (the calculation uses the local date). */
const dhDe = (data) => (data ? `${data}T12:00:00-03:00` : null);
const ehObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

const normNome = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Official município table (current rows) indexed by normalized name, built once per database. */
const indicesMunicipio = new WeakMap();
function indiceMunicipios(base) {
  let idx = indicesMunicipio.get(base);
  if (!idx) {
    idx = new Map();
    const linhas = base.all(`SELECT m.MUNI_CD codigo, m.MUNI_NOME nome, u.UF_SIGLA uf FROM MUNICIPIO m JOIN UF u ON u.UF_CD = m.MUNI_UF_CD
      WHERE m.MUNI_FIM_VIGENCIA IS NULL`);
    for (const l of linhas) {
      const k = normNome(String(l.nome));
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ codigo: Number(l.codigo), uf: String(l.uf).toUpperCase() });
    }
    indicesMunicipio.set(base, idx);
  }
  return idx;
}

/** Município name + UF (as printed on a DANFSe) → IBGE code, using the official table. */
function municipioPorNome(base, nome, uf) {
  if (typeof nome !== 'string' || !nome.trim()) return null;
  const [n, sigla] = nome.includes('/') ? nome.split('/').map((s) => s.trim()) : [nome, typeof uf === 'string' ? uf : null];
  const candidatos = indiceMunicipios(base).get(normNome(n)) ?? [];
  const achados = sigla ? candidatos.filter((c) => c.uf === sigla.toUpperCase()) : candidatos;
  return achados.length === 1 ? achados[0].codigo : null;
}

/** Splits "000 / 000001" or "000001" printed on a DANFSe. */
function cstClassDoTexto(t) {
  const m = /(\d{3})\D+(\d{6})/.exec(t ?? '') ?? /()(\d{6})/.exec(t ?? '');
  return m ? { cst: m[1] || m[2].slice(0, 3), cClassTrib: m[2] } : null;
}

/** Builds the editable operation (ROC input + provenance notes) for one normalized invoice. */
export async function prepararNota(nota, { chamar, base }) {
  const avisos = [];
  const origem = {};
  const r = nota.rtc ?? {};
  const op = { notaId: nota.id ?? nota.chave ?? nota.numero, tipo: nota.tipo, numero: nota.numero, tpDoc: Number(nota.tpDoc) || null, itens: [] };

  if (nota.tipo === 'NFS-e') {
    op.data = r.dCompet ?? nota.dataCompetencia ?? dataDe(r.dhEmi) ?? nota.dataEmissao;
    origem.data = r.dCompet || nota.dataCompetencia ? 'competência da NFS-e' : 'data de emissão';
    // IBS place (LC 214 art. 11): the one the NFS-e system computed; else the general rule for
    // services (acquirer's domicile); the ISS incidence place (LC 116) only as a last resort.
    const locais = [
      [r.cLocalidadeIncid, 'local de incidência do IBS/CBS informado na NFS-e'],
      [r.municipioTomador, 'município do tomador (regra geral do IBS: domicílio do adquirente — confira se o serviço é prestado presencialmente ou sobre imóvel)'],
      [r.cLocPrestacao, 'local da prestação (confira o do IBS/CBS)'],
      [r.municipioPrestador, 'município do prestador (confira o do IBS/CBS)'],
      [r.cLocIncid, 'local de incidência do ISS (confira o do IBS/CBS)'],
    ];
    const local = locais.find(([v]) => Number(v));
    op.municipio = local ? Number(local[0]) : null;
    origem.municipio = local ? local[1] : 'município do tomador ou do prestador';
    if (!op.municipio) { // DANFSe (PDF): names printed on the document
      for (const [nome, texto] of [
        [nota.tomador?.municipio, 'município do tomador impresso no DANFSe (regra geral do IBS — confira)'],
        [nota.servico?.localPrestacao, 'local da prestação impresso no DANFSe'],
        [nota.prestador?.municipio, 'município do prestador impresso no DANFSe (confira o do IBS/CBS)'],
      ]) {
        op.municipio = municipioPorNome(base, nome, null);
        if (op.municipio) { origem.municipio = texto; break; }
      }
    }
    const cc = nota.ibscbs?.cClassTrib ? { cst: nota.ibscbs.cst ?? nota.ibscbs.cClassTrib.slice(0, 3), cClassTrib: nota.ibscbs.cClassTrib } : cstClassDoTexto(nota.ibscbs?.cstCClassTrib);
    if (!cc) avisos.push('A nota não informa CST/cClassTrib: usado 000/000001 (tributação integral). Confira.');
    const ano = Number((op.data ?? '').slice(0, 4));
    // Official unified NFS-e base (regime regular: opSimpNac 1, operação comum).
    let baseCalculo = null;
    if (ano) {
      const res = await chamar('POST', BASE_NFSE, {
        anoFatoGerador: ano, opSimpNac: 1, situacao: 'comum',
        vServ: dec(nota.valores?.vServ), vDescIncond: dec(nota.valores?.vDescIncond), vISSQN: dec(r.vISSQN ?? nota.iss?.valor),
        vPIS: dec(r.vPis), vCOFINS: dec(r.vCofins),
      });
      if (res.status === 200 && res.body?.baseRG != null) {
        baseCalculo = String(res.body.baseRG);
        for (const a of res.body.avisos ?? []) avisos.push(a);
        for (const e of res.body.erros ?? []) avisos.push(`${e.codigo ?? e.code ?? ''} ${e.mensagem ?? e.message ?? JSON.stringify(e)}`.trim());
      } else {
        avisos.push(`Base de cálculo da NFS-e não calculada (${res.status}): ${res.body?.detail ?? ''}`);
      }
    }
    op.itens.push({
      numero: 1, descricao: nota.servico?.descricao ?? null, nbs: nota.servico?.nbs ?? null,
      ...(cc ?? PADRAO), baseCalculo, quantidade: '1', unidade: 'UN',
      declarado: r.declarado ?? null,
    });
    if (r.operacao?.tpEnteGov) op.gCompraGov = { tpEnteGov: Number(r.operacao.tpEnteGov) };
  } else if (nota.tipo === 'NF-e' || nota.tipo === 'NFC-e') {
    op.data = dataDe(r.dhEmi) ?? nota.dataEmissao;
    origem.data = 'data de emissão';
    op.municipio = Number(r.cMunFGIBS ?? r.municipioEntrega ?? r.municipioDestinatario ?? r.cMunFG) || null;
    origem.municipio = r.cMunFGIBS ? 'município do fato gerador do IBS/CBS (cMunFGIBS)'
      : r.municipioEntrega ? 'local de entrega' : r.municipioDestinatario ? 'município do destinatário' : 'município do fato gerador (cMunFG)';
    if (r.tpEnteGov) op.gCompraGov = { tpEnteGov: Number(r.tpEnteGov) };
    for (const it of nota.itens ?? []) {
      const x = it.rtc ?? {};
      const cc = x.ibscbs?.cClassTrib ? { cst: x.ibscbs.cst, cClassTrib: x.ibscbs.cClassTrib } : null;
      if (!cc) avisos.push(`Item ${it.numero}: sem grupo IBSCBS na nota, usado 000/000001 (tributação integral). Confira.`);
      const item = {
        numero: it.numero, descricao: it.descricao ?? null, ncm: it.ncm ?? null, ...(cc ?? PADRAO),
        quantidade: dec(x.qTrib), unidade: x.uTrib && x.uTrib.length <= 6 ? x.uTrib : null,
        gComponentesBC: Object.fromEntries(Object.entries({
          vProd: it.vProd, vFrete: it.vFrete, vSeg: it.vSeg, vOutro: it.vOutro, vDesc: it.vDesc, vII: x.vII,
          vIS: x.is?.vIS, vPIS: x.vPIS, vCOFINS: x.vCOFINS, vICMS: x.vICMS, vICMSUFDest: x.vICMSUFDest, vFCP: x.vFCP,
          vFCPUFDest: x.vFCPUFDest, vICMSMono: x.vICMSMono, vISSQN: x.vISSQN,
        }).filter(([, v]) => !vazio(v)).map(([k, v]) => [k, String(v)])),
        declarado: x.ibscbs ? { vBC: x.ibscbs.vBC, vCBS: x.ibscbs.vCBS, vIBSUF: x.ibscbs.vIBSUF, vIBSMun: x.ibscbs.vIBSMun, pCBS: x.ibscbs.pCBS, pIBSUF: x.ibscbs.pIBSUF, pIBSMun: x.ibscbs.pIBSMun } : null,
      };
      if (x.ibscbs?.tributacaoRegular?.cClassTrib) item.tributacaoRegular = x.ibscbs.tributacaoRegular;
      if (x.is) {
        item.impostoSeletivo = {
          cst: x.is.cst, cClassTrib: x.is.cClassTrib, baseCalculo: dec(x.is.vBC),
          quantidade: dec(x.is.qTrib), unidade: x.is.uTrib, impostoInformado: dec(x.is.vIS),
        };
        // IS rates printed on the invoice: from 2027 the official table has none, so they are sent as
        // this item's aliquotasNominais.impostoSeletivo (editable in the UI).
        // (a zero ad rem rate adds nothing but makes the official engine require qTrib/uTrib)
        const aliq = Object.fromEntries([['adValorem', dec(x.is.pIS)], ['adRem', Number(x.is.pISEspec) ? dec(x.is.pISEspec) : null]].filter(([, v]) => v != null));
        if (Object.keys(aliq).length) item.aliquotasIS = aliq;
      }
      op.itens.push(item);
    }
  } else {
    avisos.push('Tipo de nota não suportado no regime regular.');
  }
  if (!op.municipio) avisos.push('Município do fato gerador não identificado: escolha-o antes de calcular.');
  return { ...op, origem, avisos };
}

/** { adValorem, adRem } with at least one value, else null. */
function taxaIS(a) {
  if (!ehObjeto(a)) return null;
  const t = Object.fromEntries(['adValorem', 'adRem'].map((k) => [k, dec(a[k])]).filter(([, v]) => v != null));
  return Object.keys(t).length ? t : null;
}

/** Official ROC input from an (edited) operation. */
export function montarOperacao(op, aliquotas) {
  const ano = Number(String(op.data ?? '').slice(0, 4));
  const nominais = ano >= 2027 && aliquotas ? aliquotas : null;
  const corpo = {
    id: String(op.notaId ?? op.numero ?? 'operacao'),
    versao: '1.0.0',
    dhFatoGerador: dhDe(op.data),
    municipio: op.municipio,
    uf: op.uf || undefined,
    tpDoc: op.tpDoc || undefined,
    gCompraGov: op.gCompraGov || undefined,
    itens: op.itens.map((it) => {
      const x = {
        numero: it.numero, ncm: it.ncm || undefined, nbs: it.nbs || undefined, cst: it.cst, cClassTrib: it.cClassTrib,
        baseCalculo: it.baseCalculo ?? undefined, quantidade: it.quantidade ?? undefined, unidade: it.unidade ?? undefined,
        impostoSeletivo: it.impostoSeletivo || undefined,
        tributacaoRegular: it.tributacaoRegular || undefined,
        // With an IS group the official engine derives only the IS base from the components (the
        // IBS/CBS base would stay 0): leave it to the legacy rule, base = IS base + IS informed.
        gComponentesBC: it.gComponentesBC && Object.keys(it.gComponentesBC).length && it.baseCalculo == null && !it.impostoSeletivo ? it.gComponentesBC : undefined,
      };
      // IS rate: the one sent for the whole request, else this item's (from the invoice or edited)
      const aliqIS = ano >= 2027 && it.impostoSeletivo ? (nominais?.impostoSeletivo ?? taxaIS(it.aliquotasIS)) : null;
      if (nominais || aliqIS) {
        x.aliquotasNominais = { cbs: nominais?.cbs, ibsEstadual: nominais?.ibsEstadual, ibsMunicipal: nominais?.ibsMunicipal, ...(aliqIS ? { impostoSeletivo: aliqIS } : {}) };
      }
      return x;
    }),
  };
  return JSON.parse(JSON.stringify(corpo)); // drop undefined
}

const somar = (a, b) => (b == null ? a : a.add(Dec.of(String(b))));

/** Runs the official calculation for every operation and sums the results by month. */
export async function calcularOperacoes(operacoes, aliquotas, { chamar }) {
  const resultados = [];
  const meses = new Map();
  let naoCalculadasSemMes = 0;
  for (const [i, op] of operacoes.entries()) {
    if (i) await ceder();
    const entrada = montarOperacao(op, aliquotas);
    const res = await chamar('POST', OBSERVABILIDADE, entrada);
    const tot = res.status === 200 ? res.body?.total?.tribCalc : null;
    resultados.push({ notaId: op.notaId, numero: op.numero, tipo: op.tipo, data: op.data, entrada, status: res.status, resposta: res.body, simulado: res.headers?.['x-warning-dados-simulados'] ?? null });
    // What is left out of the month total is counted, so the summary cannot be read as complete.
    const mes = /^\d{4}-(0[1-9]|1[0-2])/.test(String(op.data ?? '')) || tot ? String(op.data).slice(0, 7) : null;
    if (!mes) { if (!tot) naoCalculadasSemMes += 1; continue; }
    const m = meses.get(mes) ?? { mes, notas: 0, vBC: Dec.ZERO, vCBS: Dec.ZERO, vIBSUF: Dec.ZERO, vIBSMun: Dec.ZERO, vIS: Dec.ZERO, notasNaoCalculadas: 0, itensNaoCalculados: 0 };
    meses.set(mes, m);
    if (!tot) { m.notasNaoCalculadas += 1; continue; }
    m.itensNaoCalculados += (res.body?.objetos ?? []).filter((o) => !ESTADOS_OK.has(o?.estadoItem)).length;
    m.notas += 1;
    m.vBC = somar(m.vBC, tot.IBSCBSTot?.vBCIBSCBS);
    m.vCBS = somar(m.vCBS, tot.IBSCBSTot?.gCBS?.vCBS);
    m.vIBSUF = somar(m.vIBSUF, tot.IBSCBSTot?.gIBS?.gIBSUF?.vIBSUF);
    m.vIBSMun = somar(m.vIBSMun, tot.IBSCBSTot?.gIBS?.gIBSMun?.vIBSMun);
    m.vIS = somar(m.vIS, tot.ISTot?.vIS);
  }
  const resumo = [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes)).map((m) => {
    const vIBS = m.vIBSUF.add(m.vIBSMun);
    const total = m.vCBS.add(vIBS).add(m.vIS);
    return {
      mes: m.mes, notas: m.notas, vBC: m.vBC.toString(), vCBS: m.vCBS.toString(), vIBSUF: m.vIBSUF.toString(), vIBSMun: m.vIBSMun.toString(), vIBS: vIBS.toString(), vIS: m.vIS.toString(), total: total.toString(),
      notasNaoCalculadas: m.notasNaoCalculadas, itensNaoCalculados: m.itensNaoCalculados,
    };
  });
  return { resultados, resumo, naoCalculadasSemMes };
}

const excedeItens = (n) => `Envie no máximo ${MAX_ITENS} itens por requisição (foram ${n}); divida as notas em lotes menores.`;

/** Shape checks of /preparar (each note an object; NF-e items an array of objects). */
function validarNotas(notas) {
  let itens = 0;
  for (const [i, n] of notas.entries()) {
    if (!ehObjeto(n)) return `A nota ${i + 1} não é um objeto.`;
    if (n.itens != null && (!Array.isArray(n.itens) || !n.itens.every(ehObjeto))) return `A nota ${i + 1} tem itens inválidos: envie uma lista de objetos.`;
    if (n.itens?.length > MAX_ITENS_OPERACAO) return `A nota ${i + 1} tem mais de ${MAX_ITENS_OPERACAO} itens (limite da NF-e).`;
    itens += Array.isArray(n.itens) ? n.itens.length : 1;
  }
  return itens > MAX_ITENS ? excedeItens(itens) : null;
}

/** Shape checks of /calcular (each operation an object with a non-empty list of item objects). */
function validarOperacoes(operacoes) {
  let itens = 0;
  for (const [i, op] of operacoes.entries()) {
    if (!ehObjeto(op)) return `A operação ${i + 1} não é um objeto.`;
    if (!Array.isArray(op.itens) || !op.itens.length || !op.itens.every(ehObjeto)) return `A operação ${i + 1} precisa de uma lista não vazia de itens (objetos).`;
    if (op.itens.length > MAX_ITENS_OPERACAO) return `A operação ${i + 1} tem mais de ${MAX_ITENS_OPERACAO} itens (limite da NF-e).`;
    itens += op.itens.length;
  }
  return itens > MAX_ITENS ? excedeItens(itens) : null;
}

export function moduloAplicacaoRegimeRegular({ base }) {
  let chamar = null;
  return {
    id: 'regime-regular-app',
    /** needs the router to call the official routes in-process */
    registrar(r) {
      chamar = criarChamadaInterna(r);
      r.post('/api/regime-regular/preparar', async (ctx) => {
        const corpo = await ctx.json(LIMITE_JSON);
        const notas = ehObjeto(corpo) ? corpo.notas : null;
        if (!Array.isArray(notas) || notas.length > MAX_OPERACOES) return { status: 400, body: { erro: `Envie de 1 a ${MAX_OPERACOES} notas.` } };
        const erro = validarNotas(notas);
        if (erro) return { status: 400, body: { erro } };
        const operacoes = [];
        for (const [i, n] of notas.entries()) {
          if (i) await ceder();
          operacoes.push(await prepararNota(n, { chamar, base }));
        }
        return { status: 200, body: { operacoes } };
      });
      r.post('/api/regime-regular/calcular', async (ctx) => {
        const corpo = await ctx.json(LIMITE_JSON);
        const { operacoes, aliquotas } = ehObjeto(corpo) ? corpo : {};
        if (!Array.isArray(operacoes) || !operacoes.length || operacoes.length > MAX_OPERACOES) return { status: 400, body: { erro: `Envie de 1 a ${MAX_OPERACOES} operações.` } };
        const erro = validarOperacoes(operacoes);
        if (erro) return { status: 400, body: { erro } };
        return { status: 200, body: await calcularOperacoes(operacoes, aliquotas ?? null, { chamar }) };
      });
    },
  };
}
