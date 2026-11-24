// Port of domain/service/basecalculo/BaseCalculoUnificadaNfseService (E4
// base-calculo-unificada-nfse) and TipoAjusteNfse: the RG (IBS/CBS) and SN bases of an NFS-e,
// with business errors/notices in the 200 body. Exact arithmetic; the published bases are
// rounded once (arredondarValorFiscal) and the negativity test uses the rounded value.
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';
import { javaIsBlank, javaFormat } from '../comum/java.js';
import { arredondarValorFiscal, formatarMoeda, multiplicar, percentualParaFracao, subtrair } from '../comum/arredondamento.js';
import { NULO } from '../comum/json.js';
import { opcaoSN, situacaoNfse, isCalculaBaseSN } from './entradas.js';

const ANO_EXTINCAO_PIS_COFINS = 2027;
const ANO_EXTINCAO_ISSQN = 2033;

/** TipoAjusteNfse: código → (repercuteIbsCbs, repercuteSN, requerDescricao). */
export const TIPOS_AJUSTE = Object.freeze({
  101: { nome: 'SUBCONTRATACAO', repercuteIbsCbs: true, repercuteSN: false, requerDescricao: false },
  102: { nome: 'CONSORCIO', repercuteIbsCbs: true, repercuteSN: false, requerDescricao: false },
  103: { nome: 'INTERMEDIACAO', repercuteIbsCbs: true, repercuteSN: false, requerDescricao: false },
  104: { nome: 'CESSAO_MAO_OBRA', repercuteIbsCbs: true, repercuteSN: false, requerDescricao: false },
  105: { nome: 'RESSARCIMENTO', repercuteIbsCbs: true, repercuteSN: false, requerDescricao: false },
  199: { nome: 'OUTROS', repercuteIbsCbs: true, repercuteSN: false, requerDescricao: true },
  9: { nome: 'PROFISSIONAL_PARCEIRO', repercuteIbsCbs: false, repercuteSN: true, requerDescricao: false },
});
const porCodigo = (codigo) => (typeof codigo === 'string' && Object.hasOwn(TIPOS_AJUSTE, codigo) ? TIPOS_AJUSTE[codigo] : null);
export const tipoAjuste = {
  isConhecido: (c) => porCodigo(c) !== null,
  repercuteIbsCbs: (c) => porCodigo(c)?.repercuteIbsCbs ?? false,
  repercuteSN: (c) => porCodigo(c)?.repercuteSN ?? false,
  requerDescricao: (c) => porCodigo(c)?.requerDescricao ?? false,
};

const erro = (codigo, mensagem) => ({ codigo, mensagem });
const nullToZero = (v) => v ?? Dec.ZERO;
const isBlank = (s) => s == null || javaIsBlank(s);

/** Java's `doc.getTpAjusteBC()` on a null element of the list. */
function getTpAjusteBC(doc) {
  if (doc === null) {
    throw new ErroJava('NullPointerException', 'Cannot invoke "br.gov.serpro.rtc.api.model.input.basecalculo.DocumentoAjusteNfseInput.getTpAjusteBC()" because "doc" is null');
  }
  return doc.tpAjusteBC;
}

function validarEstruturaLocacao(e) {
  if (situacaoNfse.isLocacao(e.situacao) && e.locacao === null) {
    throw new ErroJava('CampoInvalidoException', 'Campo locacao obrigatório quando situacao é locacao9903');
  }
}

function validarNegocio(e, erros) {
  const op = e.opSimpNac;
  const regAp = e.regApIBSCBSSN;
  if (opcaoSN.exigeRegimeApuracao(op) && regAp === null) erros.push(erro('EXXX-REGAP', 'Campo regApIBSCBSSN obrigatório para optante do Simples Nacional'));
  if (opcaoSN.proibeRegimeApuracao(op) && regAp !== null) erros.push(erro('EXXX-REGAP', 'Campo regApIBSCBSSN proibido para não optante do Simples Nacional'));
  if (opcaoSN.vedaLocacao(op) && situacaoNfse.isLocacao(e.situacao)) erros.push(erro('EXXX-LOC-SN', 'Locação de imóveis incompatível com optante do Simples Nacional'));
}

function scanDocumentos(documentos, avisos, erros) {
  const validos = [];
  for (const doc of documentos) {
    const tipo = getTpAjusteBC(doc);
    if (!tipoAjuste.isConhecido(tipo)) {
      avisos.push(javaFormat("Tipo de ajuste '%s' desconhecido: documento ignorado", tipo));
      continue;
    }
    if (tipoAjuste.requerDescricao(tipo) && isBlank(doc.xTpAjusteBC)) {
      erros.push(erro('LEIAUTE-XTP', `Campo xTpAjusteBC obrigatório para tipo de ajuste ${'199'}`));
      continue;
    }
    validos.push(doc);
  }
  return validos;
}

const somar = (docs, filtro) => docs.filter((d) => filtro(d.tpAjusteBC)).map((d) => d.vAjusteAplic).reduce((a, v) => a.add(v), Dec.ZERO);

function calcularSomaIbsCbs(docs, situacao) {
  if (situacaoNfse.ignoraDocumentos(situacao)) return Dec.ZERO;
  return somar(docs, tipoAjuste.repercuteIbsCbs);
}

function calcularSomaAjustesProfissionalParceiro(docs, situacao) {
  if (situacaoNfse.ignoraDocumentos(situacao)) return Dec.ZERO;
  return somar(docs, tipoAjuste.repercuteSN);
}

function aplicarRegrasDefensivas(e, documentos, avisos) {
  if (situacaoNfse.isLocacao(e.situacao) && documentos.length) avisos.push('Documentos de ajuste ignorados em contexto de locação de imóveis');
  if (!situacaoNfse.isLocacao(e.situacao) && e.locacao !== null) avisos.push('Grupo locacao ignorado fora de contexto de locação de imóveis');
}

function calcularBaseRGLocacao(e) {
  const loc = e.locacao;
  const fator = percentualParaFracao(loc.pCopropriedade);
  const vServEfetivo = multiplicar(fator, loc.vTotOper);
  const vDescIncondEfetivo = multiplicar(fator, loc.vDescIncondTot);
  const vCalcAjusteBCLocImoveis = multiplicar(fator, loc.somaAjustesLocImoveis);
  const ano = e.anoFatoGerador;
  const vPIS = ano < ANO_EXTINCAO_PIS_COFINS ? nullToZero(e.vPIS) : Dec.ZERO;
  const vCOFINS = ano < ANO_EXTINCAO_PIS_COFINS ? nullToZero(e.vCOFINS) : Dec.ZERO;
  let r = vServEfetivo;
  r = subtrair(r, vDescIncondEfetivo);
  r = subtrair(r, vCalcAjusteBCLocImoveis);
  r = subtrair(r, vPIS);
  r = subtrair(r, vCOFINS);
  return r;
}

function calcularBaseRG(e, vCalcAjusteBCIBSCBS) {
  if (situacaoNfse.isLocacao(e.situacao)) return calcularBaseRGLocacao(e);
  const ano = e.anoFatoGerador;
  const deduzISSQN = ano < ANO_EXTINCAO_ISSQN ? nullToZero(e.vISSQN) : Dec.ZERO;
  const deduzPIS = ano < ANO_EXTINCAO_PIS_COFINS ? nullToZero(e.vPIS) : Dec.ZERO;
  const deduzCOFINS = ano < ANO_EXTINCAO_PIS_COFINS ? nullToZero(e.vCOFINS) : Dec.ZERO;
  let r = nullToZero(e.vServ);
  r = subtrair(r, nullToZero(e.vDescIncond));
  r = subtrair(r, vCalcAjusteBCIBSCBS);
  r = subtrair(r, deduzISSQN);
  r = subtrair(r, deduzPIS);
  r = subtrair(r, deduzCOFINS);
  return r;
}

function calcularBaseSNLocacao(e) {
  const loc = e.locacao;
  const fator = percentualParaFracao(loc.pCopropriedade);
  return subtrair(multiplicar(fator, loc.vTotOper), multiplicar(fator, loc.vDescIncondTot));
}

function calcularBaseSN(e, vCalcAjusteBCIBSCBS, somaProfissionalParceiro) {
  const regAp = e.regApIBSCBSSN;
  if (opcaoSN.baseSNInaplicavel(e.opSimpNac)) return null;
  if (regAp === null) return null;
  let base = situacaoNfse.isLocacao(e.situacao) ? calcularBaseSNLocacao(e) : subtrair(nullToZero(e.vServ), nullToZero(e.vDescIncond));
  base = subtrair(base, vCalcAjusteBCIBSCBS);
  if (situacaoNfse.isSalaoParceiro(e.situacao) && isCalculaBaseSN(regAp)) base = subtrair(base, somaProfissionalParceiro);
  return base;
}

/** BaseCalculoUnificadaNfseService.calcular → { baseRG, baseSN, avisos, erros }. */
export function calcularUnificadaNfse(e) {
  const avisos = [];
  const erros = [];
  const documentos = e.documentos ?? [];
  validarEstruturaLocacao(e);
  validarNegocio(e, erros);
  const validos = scanDocumentos(documentos, avisos, erros);
  if (opcaoSN.isMei(e.opSimpNac)) {
    avisos.push('E1302: Operação MEI: bases de cálculo não aplicáveis');
    if (documentos.length) erros.push(erro('E0436', 'Documentos de ajuste não são permitidos para MEI'));
    return { baseRG: null, baseSN: null, avisos, erros };
  }
  const vCalcAjusteBCIBSCBS = calcularSomaIbsCbs(validos, e.situacao);
  const somaProfissionalParceiro = calcularSomaAjustesProfissionalParceiro(validos, e.situacao);
  const vServ = nullToZero(e.vServ);
  if (vCalcAjusteBCIBSCBS.compareTo(Dec.ZERO) > 0 && vCalcAjusteBCIBSCBS.compareTo(vServ) >= 0) {
    erros.push(erro('E1534', `Soma dos ajustes (${formatarMoeda(vCalcAjusteBCIBSCBS)}) excede ou iguala o valor do serviço (${formatarMoeda(vServ)})`));
  }
  aplicarRegrasDefensivas(e, documentos, avisos);
  const baseRG = calcularBaseRG(e, vCalcAjusteBCIBSCBS);
  const baseSN = calcularBaseSN(e, vCalcAjusteBCIBSCBS, somaProfissionalParceiro);
  if (opcaoSN.isPendente(e.opSimpNac)) avisos.push('Optante pendente: cálculo realizado com ressalva');
  const rg = arredondarValorFiscal(baseRG);
  const sn = arredondarValorFiscal(baseSN);
  if (rg !== null && rg.compareTo(Dec.ZERO) < 0) erros.push(erro('BASE-NEGATIVA', `Base de cálculo RG negativa: ${formatarMoeda(rg)}`));
  if (sn !== null && sn.compareTo(Dec.ZERO) < 0) erros.push(erro('BASE-NEGATIVA', `Base de cálculo SN negativa: ${formatarMoeda(sn)}`));
  return { baseRG: rg, baseSN: sn, avisos, erros };
}

/**
 * JSON of BaseCalculoUnificadaNfseOutput (getters, alphabetical: avisos, baseRG, baseSN, erros);
 * baseRG/baseSN are @JsonInclude(ALWAYS) → explicit null; ErroBaseCalculoNfse record: codigo, mensagem.
 */
export const saidaUnificadaNfse = (r) => ({
  avisos: r.avisos,
  baseRG: r.baseRG ?? NULO,
  baseSN: r.baseSN ?? NULO,
  erros: r.erros.map((x) => ({ codigo: x.codigo, mensagem: x.mensagem })),
});
