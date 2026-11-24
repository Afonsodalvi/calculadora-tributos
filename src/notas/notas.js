// Turns a parsed invoice (DANFSe PDF, NFS-e XML or NF-e XML) into the normalized note used by
// the UI and by src/calculo.js, deciding what is revenue and suggesting the activity.
import { createHash } from 'node:crypto';
import { Dec } from '../core/decimal.js';
import { ATIVIDADES, sugerirAtividade, sugerirPorCfop, icmsSubstituido, cfopExportacao } from '../simples/atividades.js';
import { LIMITE_XML, tags, tag } from './xml-nf.js';

const VALOR = /^\d{1,13}\.\d{2}$/;
const somar = (...vs) => vs.reduce((s, v) => s.add(Dec.of(v ?? '0')), Dec.ZERO);
const CSTAT_CANCELADA = ['101', '135', '151', '155']; // NF-e: cancelamento homologado (no prazo / fora do prazo)
/**
 * Normalized invoice for the UI and for src/calculo.js. `avisos` are shown by both panels;
 * `avisosSimples` only by the Simples panel (activity choice, DAS).
 */
export function normalizarNota(nf, nomeArquivo, bytes) {
  const id = nf.chave || createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const comp = nf.competencia ? nf.competencia.slice(0, 7) : null;
  const competencia = /^\d{4}-(0[1-9]|1[0-2])$/.test(comp ?? '') ? comp : null;
  const base = {
    id, arquivo: nomeArquivo, origem: nf.origem, tipo: nf.tipo, numero: nf.numero, chave: nf.chave, competencia,
    dataEmissao: nf.dataEmissao, prestador: nf.prestador, tomador: nf.tomador, avisos: [...(nf.avisos ?? [])], avisosSimples: [], ignorar: null,
    substitui: nf.substitui ?? null,
    // Regime Regular (CBS/IBS) fields, see src/regime-regular/aplicacao.js
    tpDoc: nf.tpDoc ?? null, dataCompetencia: nf.competencia ?? null, rtc: nf.rtc ?? null, ibscbs: nf.ibscbs ?? null,
  };
  if (!competencia) base.avisos.push('Mês de competência não encontrado na nota.');
  if (/CANCELAD/i.test(nf.situacao ?? '')) base.ignorar = 'nota cancelada';
  else if (/SUBSTITU/i.test(nf.situacao ?? '')) base.ignorar = 'nota substituída por outra';
  if (nf.ambiente === '2') base.avisos.push('Nota de homologação (teste), sem valor fiscal.');
  if (nf.tipo === 'NFS-e') {
    const vServ = nf.valores?.vServ ?? null;
    const desc = nf.valores?.vDescIncond ?? '0.00';
    const liquido = vServ == null ? null : somar(vServ).sub(Dec.of(desc)).setScale(2);
    const valor = liquido == null || liquido.signum() < 0 ? null : liquido.toString();
    if (liquido?.signum() < 0) base.avisos.push('Desconto maior que o valor do serviço.');
    const sug = sugerirAtividade(nf.servico?.cTribNac);
    // the issuer's own declaration (cAtvSN, numeric in the DPS: "9" ⇒ "09") wins over the suggestion
    const declarado = nf.simples?.cAtivSN ? String(nf.simples.cAtivSN).trim().padStart(2, '0') : null;
    const atDeclarada = declarado ? ATIVIDADES.find((a) => a.cAtivSN === declarado && a.tipo === 'servico') : null;
    if (declarado && !atDeclarada) base.avisosSimples.push(`Atividade declarada na nota (cAtvSN ${declarado}) não reconhecida: confira o tipo de atividade.`);
    return {
      ...base, valor, valorServico: vServ, descontoIncondicionado: desc,
      descricao: nf.servico?.descricao, itemLc116: nf.servico?.itemLc116 ?? null, cTribNac: nf.servico?.cTribNac, nbs: nf.servico?.nbs,
      tribISSQN: nf.iss?.tribISSQN ?? null, tpRetISSQN: nf.iss?.tpRetISSQN ?? null, tpBM: nf.iss?.tpBM ?? null,
      issAliquota: nf.iss?.aliquota ?? null, issValor: nf.iss?.valor ?? null,
      opSimpNac: nf.simples?.opSimpNac ?? null, regApTribSN: nf.simples?.regApTribSN ?? null, regApIBSCBSSN: nf.simples?.regApIBSCBSSN ?? null,
      cClassTrib: nf.ibscbs?.cClassTrib ?? null,
      servico: nf.servico ?? null, valores: nf.valores ?? null, iss: nf.iss ?? null,
      atividade: atDeclarada?.id ?? sug?.atividade ?? null,
      sugestao: atDeclarada ? { atividade: atDeclarada.id, curto: `atividade declarada na nota (cAtvSN ${declarado})`, motivo: 'Informada pelo emitente na NFS-e' } : sug,
    };
  }
  // NF-e / NFC-e: one revenue entry per item, each with its own ST/export flags
  const itens = nf.itens.map((it) => {
    const v = somar(it.vProd, it.vFrete, it.vSeg, it.vOutro).sub(Dec.of(it.vDesc ?? '0')).setScale(2);
    return {
      numero: it.numero, descricao: it.descricao, ncm: it.ncm, cfop: it.cfop, cClassTrib: it.cClassTrib, valor: v.signum() < 0 ? null : v.toString(),
      icmsSt: icmsSubstituido(it.cfop), exportacao: cfopExportacao(it.cfop),
      vProd: it.vProd, vFrete: it.vFrete, vSeg: it.vSeg, vOutro: it.vOutro, vDesc: it.vDesc, rtc: it.rtc ?? null,
    };
  });
  const valor = itens.every((it) => it.valor != null) ? itens.reduce((s, it) => s.add(Dec.of(it.valor)), Dec.ZERO).setScale(2).toString() : null;
  const sugs = itens.map((it) => sugerirPorCfop(it.cfop));
  const tipos = new Set(sugs.map((s) => s?.atividade ?? null));
  const sug = tipos.size === 1 ? sugs[0] : null;
  if (tipos.size > 1) base.avisosSimples.push('Os itens desta nota têm tipos de venda diferentes (CFOPs): escolha o tipo principal ou digite os valores separados.');
  if (itens.some((it) => it.icmsSt) && !itens.every((it) => it.icmsSt)) base.avisosSimples.push('Parte dos itens tem ICMS por substituição tributária: o ICMS desses itens sai do DAS.');
  if (nf.tpNF === '0') base.ignorar = 'nota de entrada (compra), não é receita';
  if (nf.finalidade === '4') base.ignorar = 'nota de devolução, não é receita bruta';
  // a cancelled NF-e exported after the cancellation carries the cancellation cStat in protNFe
  if (CSTAT_CANCELADA.includes(nf.protocolo)) base.ignorar = 'nota cancelada';
  else if (nf.protocolo && !['100', '150'].includes(nf.protocolo)) base.ignorar = `nota não autorizada (cStat ${nf.protocolo})`;
  if (!nf.protocolo) base.avisos.push('XML sem protocolo de autorização: confira se a nota foi autorizada.');
  return { ...base, valor, itens, exportacao: itens.length > 0 && itens.every((it) => it.exportacao), atividade: sug?.atividade ?? null, sugestao: sug, crt: nf.prestador?.crt ?? null };
}

/** Notes issued by another company (not the most common issuer) are not this company's revenue. */
export function marcarEmitentesDiferentes(notas) {
  // A company is its CNPJ root (8 digits): head office and branches share one DAS / one RBT12.
  const raiz = (d) => (d?.length === 14 ? d.slice(0, 8) : d);
  const docs = notas.filter((n) => n.tipo !== 'manual' && n.prestador?.doc).map((n) => raiz(n.prestador.doc));
  const conta = docs.reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map());
  const empresa = [...conta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const n of notas) {
    if (empresa && n.prestador?.doc && raiz(n.prestador.doc) !== empresa && !n.ignorar && !n.incluirMesmoAssim) n.ignorar = `emitida por outro CNPJ/CPF (${n.prestador.doc}), não é receita da empresa`;
  }
}
/** A replacement NFS-e (subst/chSubstda) supersedes the note it replaces when both are loaded. */
export function marcarSubstituidas(notas) {
  const substituidas = new Set(notas.map((n) => n.substitui).filter(Boolean));
  for (const n of notas) if (n.chave && substituidas.has(n.chave) && !n.ignorar) n.ignorar = 'substituída por outra nota enviada';
}

// ── Cancellation events ─────────────────────────────────────────────────────
// Cancelling is a separate event XML: the authorized invoice XML still says cStat 100 (NF-e) and the
// NFS-e padrão nacional has no cancelled status at all (its cStat 100-103 only says how it was issued).
const CANCELA_NFE = { 110111: 'Cancelamento de NF-e/NFC-e', 110112: 'Cancelamento de NFC-e por substituição' };
const CANCELA_NFSE = {
  e101101: 'Cancelamento de NFS-e', e105102: 'Cancelamento de NFS-e por substituição',
  e105104: 'Cancelamento de NFS-e deferido em análise fiscal', e305101: 'Cancelamento de NFS-e por ofício',
};
const REGISTRADO = ['135', '155']; // retEvento: registrado e vinculado à NF-e / cancelamento fora de prazo

/** Comments out, namespace prefixes out (same as stripNs in xml-nf.js). */
function limparXml(xml) {
  if (xml.length > LIMITE_XML) throw new Error('XML grande demais para uma nota fiscal.');
  let out = '', i = 0;
  for (;;) {
    const a = xml.indexOf('<!--', i);
    if (a === -1) { out += xml.slice(i); break; }
    out += xml.slice(i, a);
    const b = xml.indexOf('-->', a + 4);
    if (b === -1) break;
    i = b + 3;
  }
  return out.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
}

/**
 * Cancellation event XML → { tipo: 'cancelamento', chave, descricao }; null when the XML has no event.
 * NF-e/NFC-e: procEventoNFe / envEvento / evento (tpEvento 110111, 110112), also inside retConsSitNFe;
 * NFS-e padrão nacional: evento / pedRegEvento with e101101, e105102, e105104 or e305101.
 * Throws (user message) for an event that does not cancel or that SEFAZ refused.
 */
export function lerEventoCancelamento(xml) {
  const x = limparXml(xml);
  const ped = tags(x, 'infPedReg')[0];
  if (ped != null) {
    const codigo = Object.keys(CANCELA_NFSE).find((c) => tags(ped, c).length > 0);
    if (!codigo) throw new Error('Evento da NFS-e que não é de cancelamento: não muda o cálculo.');
    const chave = tag(ped, 'chNFSe');
    if (!/^[0-9A-Z]{50}$/.test(chave ?? '')) throw new Error('Evento de cancelamento de NFS-e sem chave de acesso válida (chNFSe).');
    return { tipo: 'cancelamento', chave, descricao: CANCELA_NFSE[codigo] };
  }
  const infos = tags(x, 'infEvento').map((b) => ({ tp: tag(b, 'tpEvento'), chave: tag(b, 'chNFe'), cStat: tag(b, 'cStat') }));
  const pedido = infos.find((i) => i.tp && i.chave);
  if (!pedido) return null;
  const canc = infos.find((i) => CANCELA_NFE[i.tp] && i.chave);
  if (!canc) throw new Error(`Evento da NF-e (tipo ${pedido.tp}) que não é de cancelamento: não muda o cálculo.`);
  if (!/^[0-9A-Z]{44}$/.test(canc.chave)) throw new Error('Evento de cancelamento de NF-e sem chave de acesso válida (chNFe).');
  // SEFAZ answer (retEvento), when the file has one: only a registered event cancels the note
  const respostas = infos.filter((i) => i.cStat != null && (i.tp == null || i.tp === canc.tp) && (i.chave == null || i.chave === canc.chave));
  if (respostas.length && !respostas.some((i) => REGISTRADO.includes(i.cStat))) {
    throw new Error(`Evento de cancelamento não registrado pela SEFAZ (cStat ${respostas[0].cStat}): a nota continua valendo.`);
  }
  return { tipo: 'cancelamento', chave: canc.chave, descricao: CANCELA_NFE[canc.tp] };
}
