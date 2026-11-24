// Port of domain/service/calculotributo/CalculoTributoService (calc-core.md §7): orchestrates the
// Imposto Seletivo, CBS, IBS UF and IBS Municipal of one item and builds the TributosDomain
// (the tribCalc of the response).
//
// The Java runs the three CBS/IBS calculations in CompletableFutures and, when more than one
// fails, allOf(cbs, uf, mun) surfaces the left-most failure; there is no shared mutable state, so
// running them sequentially CBS → IBS UF → IBS Mun and stopping at the first error is equivalent.
import { Dec } from '../../../core/decimal.js';
import * as A from '../../comum/arredondamento.js';
import { javaIsBlank } from '../../comum/java.js';
import {
  CBSDomain, CbsIbsOutput, GrupoIBSCBSDomain, IBSCBSDomain, IBSMunDomain, IBSUFDomain, ImpostoSeletivoDomain,
  MemoriaCalculoDomain, MonofasiaDiferimentoDomain, MonofasiaDomain, MonofasiaPadraoDomain, MonofasiaRetencaoDomain,
  MonofasiaRetidoAnteriormenteDomain, ReducaoAliquotaDomain, TributacaoCompraGovernamentalDomain, TributacaoRegularDomain,
  TributoEnum, TributosDomain,
} from './dominios.js';
import * as E from './excecoes.js';

const ZERO = Dec.ZERO;
const isNotBlank = (s) => s != null && !javaIsBlank(s);

/**
 * @param partes { calculoCbsIbs, calculoImpostoSeletivo, memoriaCalculo, transferenciaService }
 * @param config { calculoIbsHabilitado } (application.ibs.enabled = true in the offline/testes profiles)
 */
export function criarCalculoTributo({ calculoCbsIbs, calculoImpostoSeletivo, memoriaCalculo, transferenciaService }, { calculoIbsHabilitado = true } = {}) {
  /** calcular(OperacaoModel) → TributosDomain { IS, IBSCBS }. */
  function calcular(operacao) {
    const item = operacao.item;
    const data = operacao.data;
    const nbs = item.nbs ?? null;
    const tc = operacao.tratamentoClassificacao;

    const tratamentoClassificacaoCbsIbs = tc.tratamentoClassificacaoCbsIbs ?? null;
    const tratamentoClassificacaoImpostoSeletivo = tc.tratamentoClassificacaoImpostoSeletivo ?? null;
    const temDesoneracao = Boolean(tc.temDesoneracao);
    const tratamentoClassificacaoCbsIbsDesoneracao = temDesoneracao ? tc.tratamentoClassificacaoCbsIbsDesoneracao ?? null : null;
    // the calculation memory uses the ORIGINAL classification of the item
    const tratamentoClassificacao = temDesoneracao ? tratamentoClassificacaoCbsIbsDesoneracao : tratamentoClassificacaoCbsIbs;

    let impostoSeletivo = null;
    if (tratamentoClassificacaoImpostoSeletivo != null) {
      const aliquotaImpostoSeletivo = tc.aliquotaImpostoSeletivo ?? null;
      impostoSeletivo = calculoImpostoSeletivo.calcularImpostoSeletivo(1, item, tratamentoClassificacaoImpostoSeletivo, aliquotaImpostoSeletivo, data);
      memoriaCalculo.gerarMemoriaCalculoImpostoSeletivo(tratamentoClassificacaoImpostoSeletivo, impostoSeletivo,
        item.impostoSeletivo.quantidade ?? null, item.impostoSeletivo.unidade ?? null, data);
    }

    let cbs = null;
    let ibsEstadual = null;
    let ibsMunicipal = null;
    let memoria = null;
    if (tratamentoClassificacaoCbsIbs != null) {
      const impostoSeletivoCalculado = impostoSeletivo != null ? ImpostoSeletivoDomain.getValorImpostoSeletivo(impostoSeletivo) : ZERO;
      const calcularIBSEstadual = calculoIbsHabilitado || isNotBlank(nbs) || possuiAliquotaIbsInformada(item, TributoEnum.IBS_ESTADUAL);
      const calcularIBSMunicipal = calculoIbsHabilitado || isNotBlank(nbs) || possuiAliquotaIbsInformada(item, TributoEnum.IBS_MUNICIPAL);
      const calcular1 = (tributo, codigoUf, codigoMunicipio, habilitado) => (habilitado
        ? calculoCbsIbs.calcularCbsIbs(tributo, codigoUf, codigoMunicipio, item, tratamentoClassificacaoCbsIbs, impostoSeletivoCalculado,
          temDesoneracao, data, operacao.tpEnteGov ?? null, operacao.pRedutor ?? null)
        : null);
      cbs = calcular1(TributoEnum.CBS, null, null, true);
      ibsEstadual = calcular1(TributoEnum.IBS_ESTADUAL, operacao.codigoUf ?? null, null, calcularIBSEstadual);
      ibsMunicipal = calcular1(TributoEnum.IBS_MUNICIPAL, null, operacao.codigoMunicipio ?? null, calcularIBSMunicipal);

      const baseCalculo = item.baseCalculo ?? null;
      const quantidade = item.quantidade ?? null;
      const unidade = item.unidade ?? null;
      memoria = MemoriaCalculoDomain.criar(
        memoriaCalculo.gerarMemoriaCalculoCbsIbs(tratamentoClassificacao, cbs, baseCalculo, quantidade, unidade, data),
        calcularIBSEstadual ? memoriaCalculo.gerarMemoriaCalculoCbsIbs(tratamentoClassificacao, ibsEstadual, baseCalculo, quantidade, unidade, data) : null,
        calcularIBSMunicipal ? memoriaCalculo.gerarMemoriaCalculoCbsIbs(tratamentoClassificacao, ibsMunicipal, baseCalculo, quantidade, unidade, data) : null,
      );
    }

    // rule: the suspension of CBS and IBS does not suspend the Imposto Seletivo
    const ibsCbs = getIBSCBS(item, cbs, ibsEstadual, ibsMunicipal, operacao.tpEnteGov ?? null, data);
    ibsCbs.memoriaCalculo = memoria;
    return TributosDomain.builder({ IS: impostoSeletivo, IBSCBS: ibsCbs });
  }

  function getIBSCBS(item, cbs, ibsEstadual, ibsMunicipal, tpEnteGov, dataFatoGerador) {
    const monofasia = getMonofasia(cbs, ibsEstadual, ibsMunicipal);
    return IBSCBSDomain.builder({
      CST: item.cst ?? null,
      cClassTrib: item.cClassTrib ?? null,
      gIBSCBS: monofasia == null ? getGIBSCBS(cbs, ibsEstadual, ibsMunicipal, tpEnteGov, dataFatoGerador) : null,
      gIBSCBSMono: monofasia,
      // credit transfer, competence adjustment, credit reversal, presumed credits: TODO in the Java (always null)
      gTransfCred: null,
      gAjusteCompet: null,
      gEstornoCred: null,
      gCredPresOper: null,
      gCredPresIBSZFM: null,
    });
  }

  function getGIBSCBS(cbs, ibsEstadual, ibsMunicipal, tpEnteGov, dataFatoGerador) {
    // CST without gIBSCBS (e.g. immunity): nothing calculated, no group (and no transfer lookup)
    if (cbs == null && ibsEstadual == null && ibsMunicipal == null) return null;

    const vBC = getVBC(ibsMunicipal, getVBC(ibsEstadual, getVBC(cbs, null)));
    const pTransferenciaCBS = transferenciaService.getPercentualTransferencia(dataFatoGerador);
    const compraGovernamental = getCompraGovernamental(cbs, ibsEstadual, ibsMunicipal);
    const compraGovernamentalEfetiva = compraGovernamental == null ? null
      : TributacaoCompraGovernamentalDomain.getValoresEfetivos(compraGovernamental, tpEnteGov, pTransferenciaCBS, dataFatoGerador, vBC);

    if (compraGovernamentalEfetiva != null) {
      // values are read now: zerarValores() below cannot change what was copied (BigDecimal is immutable)
      const e = { ...compraGovernamentalEfetiva };
      trataImpactoCompraGov(cbs, e.pAliqCBS, e.vTribCBS, vBC);
      trataImpactoCompraGov(ibsEstadual, e.pAliqIBSUF, e.vTribIBSUF, vBC);
      trataImpactoCompraGov(ibsMunicipal, e.pAliqIBSMun, e.vTribIBSMun, vBC);
    }

    const gIBSUF = getIBSUF(ibsEstadual);
    const gIBSMun = getIBSMun(ibsMunicipal);
    const vIBS = getVIbs(gIBSUF, gIBSMun);
    const gCBS = getCbs(cbs);
    const tributacaoRegular = getTributacaoRegular(cbs, ibsEstadual, ibsMunicipal);

    // suspension with government purchase: the detail group is zeroed
    if (tributacaoRegular != null && compraGovernamental != null) TributacaoCompraGovernamentalDomain.zerarValores(compraGovernamental);

    return GrupoIBSCBSDomain.builder({
      vBC, gIBSUF, gIBSMun, vIBS, gCBS, gTribRegular: tributacaoRegular, gTribCompraGov: compraGovernamental,
    });
  }

  return { calcular };
}

/**
 * Takes the government purchase redistribution to the main group of one tax: the redistributed
 * effective rate (4 places) and the value calculated with it; with deferral, vDif and the due value
 * come from the published rate. aliquotaEfetiva in percentage points.
 */
function trataImpactoCompraGov(tributo, aliquotaEfetiva, valor, vBC) {
  if (tributo == null) return;
  let grupoReducao = tributo.grupoReducao;
  if (grupoReducao == null) {
    grupoReducao = ReducaoAliquotaDomain.builder({ pRedAliq: ZERO });
    tributo.grupoReducao = grupoReducao;
  }
  const tributacaoRegular = tributo.tributacaoRegular;
  if (tributacaoRegular != null) {
    // suspension
    grupoReducao.pRedAliq = ZERO;
    grupoReducao.pAliqEfet = ZERO;
    tributo.tributoDevido = ZERO;
    tributacaoRegular.aliquotaEfetiva = aliquotaEfetiva;
    tributacaoRegular.tributoDevido = valor;
    return;
  }
  grupoReducao.pAliqEfet = aliquotaEfetiva;
  const diferimento = tributo.grupoDiferimento;
  if (diferimento == null) {
    tributo.tributoDevido = valor;
    return;
  }
  const bruto = A.arredondarValorFiscal(A.multiplicar(vBC, A.percentualParaFracao(aliquotaEfetiva)));
  const vDif = A.arredondarValorFiscal(A.multiplicar(
    A.multiplicar(vBC, A.percentualParaFracao(aliquotaEfetiva)),
    A.percentualParaFracao(diferimento.pDif)));
  diferimento.vDif = vDif;
  const devido = bruto.subtract(vDif);
  tributo.tributoDevido = devido.signum() < 0 ? ZERO : devido;
}

/** vIBS of the item: published vIBSUF + vIBSMun. */
function getVIbs(ibsUF, ibsMun) {
  const vIbsUF = ibsUF != null ? ibsUF.vIBSUF : ZERO;
  const vIbsMun = ibsMun != null ? ibsMun.vIBSMun : ZERO;
  if (vIbsUF == null || vIbsMun == null) throw E.nullPointer('Cannot invoke "java.math.BigDecimal.add(java.math.BigDecimal)" because a value is null');
  return vIbsUF.add(vIbsMun);
}

function getVBC(c, valor) {
  if (valor != null) return valor;
  if (c != null) return c.baseCalculo;
  return null;
}

/** new X() (p* and v* = ZERO) then the four setters, which overwrite even with null. */
function grupoDoTributo(fabrica, saida, campoAliquota, campoValor) {
  const g = fabrica.novo();
  g[campoAliquota] = saida.aliquota;
  g.gDif = saida.grupoDiferimento;
  g.gDevTrib = null; // devolução de tributos: TODO in the Java
  g.gRed = saida.grupoReducao;
  g[campoValor] = saida.tributoDevido;
  return g;
}
const getIBSUF = (o) => (o == null ? null : grupoDoTributo(IBSUFDomain, o, 'pIBSUF', 'vIBSUF'));
const getIBSMun = (o) => (o == null ? null : grupoDoTributo(IBSMunDomain, o, 'pIBSMun', 'vIBSMun'));
const getCbs = (o) => (o == null ? null : grupoDoTributo(CBSDomain, o, 'pCBS', 'vCBS'));

/**
 * getTributacaoRegular: builder chain CBS → IBS UF → IBS Mun. Each step returns null when its tax
 * has no regular taxation, DISCARDING the builder it received (reproduced on purpose): the group
 * exists only if the IBS Municipal has it, and the CBS data is lost if the IBS UF has none.
 */
function getTributacaoRegular(cbs, ibsEstadual, ibsMunicipal) {
  let builder = passoTributacaoRegular(cbs, null, 'pAliqEfetRegCBS', 'vTribRegCBS');
  builder = passoTributacaoRegular(ibsEstadual, builder, 'pAliqEfetRegIBSUF', 'vTribRegIBSUF');
  builder = passoTributacaoRegular(ibsMunicipal, builder, 'pAliqEfetRegIBSMun', 'vTribRegIBSMun');
  return builder != null ? TributacaoRegularDomain.builder(builder) : null;
}
function passoTributacaoRegular(tributo, builder, campoAliquota, campoValor) {
  if (tributo != null && tributo.tributacaoRegular != null) {
    const tr = tributo.tributacaoRegular;
    if (builder == null) builder = { CSTReg: tr.cst, cClassTribReg: tr.cClassTrib };
    builder[campoAliquota] = tr.aliquotaEfetiva;
    builder[campoValor] = tr.tributoDevido;
    return builder;
  }
  return null;
}

/** Consolidates the government purchase detail of the three taxes (all or none). */
function getCompraGovernamental(cbs, ibsEstadual, ibsMunicipal) {
  const possuiCBS = possuiCompraGov(cbs);
  const possuiIBSUF = possuiCompraGov(ibsEstadual);
  const possuiIBSMun = possuiCompraGov(ibsMunicipal);
  if (possuiCBS && possuiIBSUF && possuiIBSMun) {
    const c = cbs.compraGovernamental, u = ibsEstadual.compraGovernamental, m = ibsMunicipal.compraGovernamental;
    return TributacaoCompraGovernamentalDomain.builder({
      pAliqCBS: c.pAliqCBS, vTribCBS: c.vTribCBS,
      pAliqIBSUF: u.pAliqIBSUF, vTribIBSUF: u.vTribIBSUF,
      pAliqIBSMun: m.pAliqIBSMun, vTribIBSMun: m.vTribIBSMun,
    });
  }
  if (possuiCBS || possuiIBSUF || possuiIBSMun) {
    throw E.runtime('Erro ao consolidar valores de compras governamentais. Algum dos tributos não calculou compra governamental.');
  }
  return null;
}
const possuiCompraGov = (v) => v != null && CbsIbsOutput.possuiCompraGov(v);

function possuiAliquotaIbsInformada(item, tributo) {
  const an = item.aliquotasNominais;
  if (an == null) return false;
  if (tributo === TributoEnum.IBS_ESTADUAL) return an.ibsEstadual != null;
  if (tributo === TributoEnum.IBS_MUNICIPAL) return an.ibsMunicipal != null;
  return false;
}

/** getMonofasia: groups of the monophasic taxation and the item totals (NT NF-e 1.30). Unreachable today. */
function getMonofasia(cbs, ibsEstadual, ibsMunicipal) {
  const monoPadrao = MonofasiaPadraoDomain.create(cbs, ibsEstadual, ibsMunicipal);
  const monoReten = MonofasiaRetencaoDomain.create(cbs, ibsEstadual, ibsMunicipal);
  const monoRet = MonofasiaRetidoAnteriormenteDomain.create(cbs, ibsEstadual, ibsMunicipal);
  const monoDif = MonofasiaDiferimentoDomain.create(cbs, ibsEstadual, ibsMunicipal);
  if (monoPadrao == null && monoReten == null && monoRet == null && monoDif == null) return null;
  const nn = (v) => { if (v == null) throw E.nullPointer('Cannot invoke "java.math.BigDecimal.add(java.math.BigDecimal)" because a value is null'); return v; };
  const vIBSMono = monoPadrao != null ? monoPadrao.vIBSMono : ZERO;
  const vCBSMono = monoPadrao != null ? monoPadrao.vCBSMono : ZERO;
  const vIBSMonoReten = monoReten != null ? monoReten.vIBSMonoReten : ZERO;
  const vCBSMonoReten = monoReten != null ? monoReten.vCBSMonoReten : ZERO;
  const vIBSMonoDif = monoDif != null ? monoDif.vIBSMonoDif : ZERO;
  const vCBSMonoDif = monoDif != null ? monoDif.vCBSMonoDif : ZERO;
  // vTot = vMono + vMonoReten - vMonoDif
  const vTotIBSMonoItem = nn(vIBSMono).add(nn(vIBSMonoReten)).subtract(nn(vIBSMonoDif));
  const vTotCBSMonoItem = nn(vCBSMono).add(nn(vCBSMonoReten)).subtract(nn(vCBSMonoDif));
  return MonofasiaDomain.builder({
    gMonoPadrao: monoPadrao, gMonoReten: monoReten, gMonoRet: monoRet, gMonoDif: monoDif, vTotIBSMonoItem, vTotCBSMonoItem,
  });
}
