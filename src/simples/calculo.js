// Puts the pieces together for the app:
//  1. groups the company's invoices by month (competência) and by revenue type, as the PGDAS-D
//     does (LC 123 art. 18 §4º), and computes the DAS of each group (src/das.js);
//  2. for months from 2027 on — or as a simulation of the 2027 rules — builds the contributor's
//     effective-rate line and runs every invoice through the OFFICIAL Receita Federal engine
//     (src/rtc, endpoint nao-assistido), which returns the CBS/IBS of each invoice.
import { Dec } from '../core/decimal.js';
import { atividadePorId } from './atividades.js';

const money = (v) => (v == null ? null : v.setScale(2).toString());
const pct = (v, casas = 4) => (v == null ? null : v.setScale(casas, 'HALF_EVEN').toString());
const ANO_REFORMA = '2027';

/**
 * @param nota {object} normalized invoice:
 *   { id, origem, tipo:'NFS-e'|'NF-e'|'manual', competencia:'YYYY-MM', valor (string), atividade (id),
 *     issRetido, issForaDoSimples, issNaoIncide, exportacao, cTribNac, nbs, ncm, cClassTrib,
 *     tribISSQN, tpRetISSQN, tpBM, regApTribSN, regApIBSCBSSN, itens? (NF-e) }
 * @param empresa {object} per competência: { 'YYYY-MM': { rbt12, folha12 } } + sublimiteExcedido
 */
const VALOR = /^\d{1,13}(\.\d{1,2})?$/;
const COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/;
const decimalOuNulo = (v) => (v == null || v === '' ? null : VALOR.test(String(v)) ? Dec.of(String(v)) : undefined);

/** Work per request of /api/simples/calcular: every note (and NF-e item) runs through the official engine. */
export const LIMITE_NOTAS = 2000;
export const LIMITE_ITENS = 10000;

/** Error message when `notas` is not a list or exceeds the limits above, else null. */
export function verificarLimites(notas) {
  if (notas == null) return null;
  if (!Array.isArray(notas)) return 'Envie as notas como uma lista.';
  if (notas.length > LIMITE_NOTAS) return `Envie até ${LIMITE_NOTAS} notas por cálculo (recebidas ${notas.length}).`;
  let itens = 0;
  for (const n of notas) if (Array.isArray(n?.itens)) itens += n.itens.length;
  if (itens > LIMITE_ITENS) return `Envie até ${LIMITE_ITENS} itens de nota por cálculo (recebidos ${itens}).`;
  return null;
}

export function calcular({ notas, empresa, simularReforma = true }, { das, engine }) {
  const erros = [];
  const porMes = new Map();
  for (const n of notas ?? []) {
    const nome = n.tipo === 'manual' ? 'digitada' : `nº ${n.numero ?? n.id}`;
    if (!COMPETENCIA.test(n.competencia ?? '')) { erros.push({ nota: n.id, erro: `Nota ${nome} sem mês de competência válido: não entrou no cálculo.` }); continue; }
    if (!porMes.has(n.competencia)) porMes.set(n.competencia, { lista: [], fora: [] });
    const m = porMes.get(n.competencia);
    if (n.ignorar) { m.fora.push({ nota: n.id, motivo: `Nota ${nome} fora do cálculo: ${n.ignorar}` }); continue; }
    if (!VALOR.test(String(n.valor ?? ''))) { m.fora.push({ nota: n.id, motivo: `Nota ${nome} sem valor válido: informe o valor para incluí-la.` }); continue; }
    if (n.opSimpNac === '2' || n.crt === '4') { m.fora.push({ nota: n.id, motivo: `Nota ${nome} emitida como MEI: o MEI paga valor fixo mensal, não o DAS por faturamento.` }); continue; }
    m.lista.push(n);
  }
  const meses = [];
  for (const [competencia, { lista, fora }] of [...porMes.entries()].sort()) {
    const dadosMes = empresa?.[competencia] ?? {};
    const rbt12 = decimalOuNulo(dadosMes.rbt12);
    const folha12 = decimalOuNulo(dadosMes.folha12);
    const mes = { competencia, notas: lista.map((n) => n.id), receitaTotal: money(lista.reduce((s, n) => s.add(Dec.of(n.valor)), Dec.ZERO)), pendencias: fora.map((f) => f.motivo), foraDoCalculo: fora };
    if (rbt12 == null || folha12 === undefined) {
      mes.pendencias.push(rbt12 === undefined || folha12 === undefined ? 'Valor inválido no faturamento ou na folha: use números como 250000.00.' : 'Informe o faturamento dos 12 meses anteriores (RBT12) para calcular a alíquota.');
      meses.push(mes);
      continue;
    }
    let sublimiteExcedido = dadosMes.sublimiteExcedido;
    if (rbt12.cmp(Dec.of('3600000')) > 0 && typeof sublimiteExcedido !== 'boolean') {
      mes.pendencias.push('RBT12 acima de R$ 3,6 milhões: informe se a receita deste ano já passou do sublimite de R$ 3,6 milhões.');
      meses.push(mes);
      continue;
    }
    mes.das = calcularDasDoMes(competencia, lista, rbt12, folha12, sublimiteExcedido, das, mes);
    const ehReforma = competencia >= `${ANO_REFORMA}-01`;
    if (ehReforma || simularReforma) {
      const compRtc = ehReforma ? competencia : `${ANO_REFORMA}-${competencia.slice(5)}`;
      mes.reforma = { simulacao: !ehReforma, competenciaCalculo: compRtc };
      try {
        if (!ehReforma) mes.reforma.das = calcularDasDoMes(compRtc, lista, rbt12, folha12, sublimiteExcedido, das, { pendencias: [] });
        mes.reforma.oficial = cbsIbsOficial(compRtc, lista, rbt12, folha12, sublimiteExcedido, das, engine);
      } catch (e) {
        mes.reforma.erro = e.message;
      }
    }
    meses.push(mes);
  }
  return { meses, erros };
}

function flagsDaNota(n) {
  return {
    issRetido: n.issRetido === true || n.tpRetISSQN === '2' || n.tpRetISSQN === '3',
    issForaDoSimples: n.issForaDoSimples === true || n.regApTribSN === '2' || n.regApTribSN === '3',
    issNaoIncide: n.issNaoIncide === true || ['2', '3', '4'].includes(String(n.tribISSQN ?? '')),
    issIsento: n.tpBM === '1',
    exportacao: n.exportacao === true || n.tribISSQN === '3',
    icmsSt: n.icmsSt === true,
  };
}

/** Revenue entries of a note: one per NF-e item (each with its own ST/export flags), else the note. */
function receitasDaNota(n) {
  const base = flagsDaNota(n);
  if (n.itens?.length && n.itens.every((it) => VALOR.test(String(it.valor ?? '')))) {
    return n.itens.map((it) => ({ valor: Dec.of(it.valor), flags: { ...base, icmsSt: it.icmsSt === true || base.icmsSt, exportacao: it.exportacao === true || base.exportacao } }));
  }
  return [{ valor: Dec.of(n.valor), flags: base }];
}

/** Groups revenue by (activity, flags) and computes each group once, like the PGDAS-D. */
function calcularDasDoMes(competencia, lista, rbt12, folha12, sublimiteExcedido, das, mes) {
  const grupos = new Map();
  for (const n of lista) {
    const at = atividadePorId(n.atividade);
    if (!at) { mes.pendencias.push(`Escolha o tipo de atividade da nota ${n.numero ?? n.id}.`); continue; }
    for (const { valor, flags } of receitasDaNota(n)) {
      const chave = JSON.stringify([at.id, flags]);
      if (!grupos.has(chave)) grupos.set(chave, { at, flags, notas: [], ids: new Set(), valor: Dec.ZERO });
      const g = grupos.get(chave);
      if (!g.ids.has(n.id)) { g.ids.add(n.id); g.notas.push(n.id); }
      g.valor = g.valor.add(valor);
    }
  }
  const linhas = [];
  for (const g of grupos.values()) {
    try {
      const r = das.calcularReceita({ competencia, rbt12, folha12, valor: g.valor, das: g.at.das, ...g.flags, sublimiteExcedido });
      linhas.push({
        atividade: g.at.id, atividadeNome: g.at.nome, notas: g.notas, receita: money(g.valor), anexo: r.anexo, faixa: r.faixa,
        aliquotaNominal: pct(r.aliquotaNominal, 2), parcelaDeduzir: money(r.parcelaDeduzir), aliquotaEfetiva: pct(r.aliquotaEfetiva, 6),
        aliquotaAplicada: pct(r.aliquotaAplicada, 6), fatorR: r.fatorR == null ? null : pct(r.fatorR.movePointRight(2), 2),
        tetoIssAplicado: r.tetoIssAplicado, flags: g.flags,
        tributos: Object.fromEntries(Object.entries(r.tributos).map(([t, v]) => [t, { percentual: pct(v.percentual, 6), valor: money(v.valor) }])),
        excluidos: r.excluidos, total: money(r.total), avisos: r.avisos, periodo: r.periodo,
      });
    } catch (e) {
      mes.pendencias.push(e.message);
    }
  }
  const total = linhas.reduce((s, l) => s.add(Dec.of(l.total)), Dec.ZERO);
  // revenue shown as the month's faturamento: only lines that are receita bruta tributável
  const receita = linhas.filter((l) => l.anexo != null).reduce((s, l) => s.add(Dec.of(l.receita)), Dec.ZERO);
  const naoTributavel = linhas.filter((l) => l.anexo == null).reduce((s, l) => s.add(Dec.of(l.receita)), Dec.ZERO);
  const porTributo = {};
  for (const l of linhas) for (const [t, v] of Object.entries(l.tributos)) porTributo[t] = Dec.of(porTributo[t] ?? '0').add(Dec.of(v.valor)).toString();
  return {
    linhas, total: money(total), receita: money(receita), naoTributavel: money(naoTributavel), porTributo: Object.fromEntries(Object.entries(porTributo).map(([k, v]) => [k, money(Dec.of(v))])),
    aliquotaMedia: receita.isZero() ? null : pct(total.div(receita, 8).movePointRight(2), 2),
  };
}

/** Runs each invoice through the official engine (nao-assistido) with the computed rate line. */
function cbsIbsOficial(competencia, lista, rbt12, folha12, sublimiteExcedido, das, engine) {
  const linha = das.linhaAliquotasEfetivas(competencia, rbt12, folha12, { sublimiteExcedido: sublimiteExcedido === true });
  const acima = rbt12.cmp(Dec.of('3600000')) > 0 && sublimiteExcedido === true;
  const resultados = [];
  for (const n of lista) {
    const at = atividadePorId(n.atividade);
    if (!at) continue;
    const dia = (n.dataEmissao && n.dataEmissao.slice(0, 7) === n.competencia ? n.dataEmissao.slice(8, 10) : '01');
    const data = `${competencia}-${dia}`;
    const req = montarRequisicao(n, at, data, linha, acima);
    const res = engine.naoAssistido(req);
    resultados.push({ nota: n.id, requisicao: req, status: res.status, resposta: res.body });
  }
  const soma = (campo) => resultados.reduce((s, r) => (r.status === 200 && r.resposta.total?.[campo] ? s.add(Dec.of(r.resposta.total[campo])) : s), Dec.ZERO);
  return {
    linhaAliquotas: linha,
    resultados,
    total: { vCBSSN: money(soma('vCBSSNtot')), vIBSSN: money(soma('vIBSSNtot')), totalTributos: money(soma('totalTributos')), vRBSN: money(soma('vRBSNtot')) },
  };
}

function montarRequisicao(n, at, data, linha, acimaSublimite) {
  const base = { id: `nota-${n.id}`, versao: '1.0.0', data, aliquotasEfetivas: linha };
  const ehServico = at.tipo === 'servico' && !at.tpDoc;
  if (ehServico) {
    return {
      ...base, tpDoc: '91', opSimpNac: '3',
      regApIBSCBSSN: n.regApIBSCBSSN ?? (acimaSublimite ? '2' : '1'),
      regApTribSN: n.regApTribSN ?? (acimaSublimite ? '2' : '1'),
      itens: [{
        numero: 1, cAtivSN: at.cAtivSN, cClassTrib: n.cClassTrib || (at.id === 'nao-tributavel' ? '410999' : '000001'),
        nbs: n.nbs || undefined, baseCalculo: n.valor,
        tribISSQN: n.tribISSQN ?? (at.das?.semIss ? undefined : '1'),
        tpRetISSQN: n.tpRetISSQN ?? (at.das?.semIss ? undefined : (n.issRetido ? '2' : '1')),
        tpBM: n.tpBM || undefined,
      }],
    };
  }
  const tpDoc = at.tpDoc ?? '55';
  const itens = (n.itens?.length ? n.itens : [{ numero: 1, valor: n.valor }]).map((it, i) => ({
    numero: i + 1, cAtivSN: at.cAtivSN, cClassTrib: it.cClassTrib || n.cClassTrib || (at.id === 'nao-tributavel' ? '410999' : '000001'),
    ncm: it.ncm || undefined, baseCalculo: it.valor ?? n.valor, valorImpostoSeletivo: '0.00',
  }));
  return { ...base, tpDoc, CRT: acimaSublimite ? '2' : '1', itens };
}
