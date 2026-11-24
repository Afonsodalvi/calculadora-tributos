// Domain objects built by the engine (api/model/roc/*Domain, api/model/output/*Output,
// domain/model/dto/AliquotaResultadoDTO) and the logic embedded in them.
//
// Objects are plain JS objects whose keys are the Java field names, in @JsonPropertyOrder order.
// Lombok builders are reproduced by functions taking the fields that were SET: a field never set
// keeps its @Builder.Default (BigDecimal.ZERO where the Java declares one), a field set to null
// stays null (and is omitted by NON_NULL). The Java getters with logic (possui*, getValor*...) are
// exported as functions grouped by class name, so the orchestration can total the items exactly
// like ValoresTotaisDomain does.
import { Dec } from '../../../core/decimal.js';
import * as A from '../../comum/arredondamento.js';
import * as E from './excecoes.js';

const ZERO = Dec.ZERO;
const definido = (campos, nome) => Object.prototype.hasOwnProperty.call(campos, nome);
/** Lombok builder: field from `campos` when set (even null), else the @Builder.Default. */
function construir(ordem, padroes, campos = {}) {
  const o = {};
  for (const nome of ordem) o[nome] = definido(campos, nome) ? campos[nome] : (padroes[nome] ?? null);
  return o;
}
const ZEROS = (nomes) => Object.fromEntries(nomes.map((n) => [n, ZERO]));

// ── Enums ──────────────────────────────────────────────────────────────────────

/** TributoEnum (codigo is a Java long). */
export const TributoEnum = Object.freeze({
  IS: Object.freeze({ nome: 'IS', codigo: 1, descricao: 'Imposto Seletivo' }),
  CBS: Object.freeze({ nome: 'CBS', codigo: 2, descricao: 'CBS' }),
  IBS_ESTADUAL: Object.freeze({ nome: 'IBS_ESTADUAL', codigo: 3, descricao: 'IBS Estadual' }),
  IBS_MUNICIPAL: Object.freeze({ nome: 'IBS_MUNICIPAL', codigo: 4, descricao: 'IBS Municipal' }),
  /** TributoEnum.get(codigo): unknown → RuntimeException("Tributo não mapeado"). */
  get(codigo) {
    const t = [this.IS, this.CBS, this.IBS_ESTADUAL, this.IBS_MUNICIPAL].find((x) => x.codigo === Number(codigo));
    if (!t) throw E.runtime('Tributo não mapeado');
    return t;
  },
});

/** TipoEnteGovernamental: JSON code → constant name and the "equivalent" constant used by the calculation. */
const ENTES = [
  [1, 'UNIAO', 'UNIAO'], [2, 'ESTADO', 'ESTADO'], [3, 'DISTRITO_FEDERAL', 'ESTADO'],
  [4, 'MUNICIPIO', 'MUNICIPIO'], [5, 'CONSORCIO_PUBLICO', 'MUNICIPIO'], [6, 'COMITE_GESTOR_IBS', 'MUNICIPIO'],
];
export const TipoEnteGovernamental = Object.freeze({
  /** Accepts the JSON code (1..6, as number, bigint or digit string) or the constant name; null → null. */
  de(v) {
    if (v == null) return null;
    const n = typeof v === 'bigint' || (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : v;
    const e = ENTES.find(([codigo, nome]) => codigo === n || nome === n);
    if (!e) throw E.runtime('Tipo de ente governamental não mapeado');
    return { codigo: e[0], nome: e[1], equivalente: e[2] };
  },
  isUniao: (v) => TipoEnteGovernamental.de(v).equivalente === 'UNIAO',
  isEstado: (v) => TipoEnteGovernamental.de(v).equivalente === 'ESTADO',
  isMunicipio: (v) => TipoEnteGovernamental.de(v).equivalente === 'MUNICIPIO',
});

// ── AliquotaResultadoDTO (record with a validating compact constructor) ─────────

/**
 * new AliquotaResultadoDTO(valorReferencia, valorPadrao, formaAplicacao): validates and applies
 * ACRESCIMO / DECRESCIMO / SUBSTITUICAO. formaAplicacao = enum name or null.
 */
export function criarAliquotaResultadoDTO(valorReferencia, valorPadrao, formaAplicacao) {
  if (valorReferencia == null) throw E.aliquotaReferenciaNaoEncontrada();
  if (valorReferencia.compareTo(ZERO) < 0) throw E.aliquotaNegativa('referencia');
  if (valorPadrao != null) {
    if (valorPadrao.compareTo(ZERO) < 0) throw E.aliquotaNegativa('padrao');
    if (formaAplicacao == null) throw E.formaAplicacaoNaoDefinida();
    if (formaAplicacao === 'ACRESCIMO') valorPadrao = valorReferencia.add(valorPadrao);
    else if (formaAplicacao === 'DECRESCIMO') valorPadrao = valorReferencia.subtract(valorPadrao);
    else if (formaAplicacao === 'SUBSTITUICAO') { /* valorPadrao stays */ } else throw E.formaAplicacaoNaoTratada();
    if (valorPadrao.compareTo(ZERO) < 0) throw E.aliquotaNegativa('aplicavel');
  } else if (formaAplicacao != null) {
    throw E.aliquotaPadraoNaoEncontrada();
  }
  return Object.freeze({
    valorReferencia, valorPadrao, formaAplicacao,
    valorAplicavel() { return valorPadrao != null ? valorPadrao : valorReferencia; },
  });
}

// ── Output DTOs of the CBS/IBS calculation (api/model/output) ────────────────────

/** CbsIbsOutput (internal, mutable, not serialized). */
export const CbsIbsOutput = Object.freeze({
  builder: (campos = {}) => construir(
    ['aliquota', 'baseCalculo', 'quantidade', 'tributoCalculado', 'tributoDevido', 'grupoReducao', 'tributacaoRegular',
      'compraGovernamental', 'grupoDiferimento', 'grupoMonofasia'], {}, campos),
  possuiCompraGov: (o) => o.compraGovernamental != null,
});

/** TributacaoRegularOutput {cst, cClassTrib, baseCalculo, aliquotaEfetiva, tributoDevido}. */
export const TributacaoRegularOutput = Object.freeze({
  builder: (campos = {}) => construir(['cst', 'cClassTrib', 'baseCalculo', 'aliquotaEfetiva', 'tributoDevido'], {}, campos),
});

/** GrupoMonofasiaOutput {tributoMonofasico, tributoSujeitoRetencao, tributoRetido, tributoDiferido}. */
export const GrupoMonofasiaOutput = Object.freeze({
  builder: (campos = {}) => construir(['tributoMonofasico', 'tributoSujeitoRetencao', 'tributoRetido', 'tributoDiferido'], {}, campos),
});

const exigirNaoNulo = (v) => { if (v == null) throw E.nullPointer(); return v; };

/** GrupoEtapaMonofasiaOutput {quantidade, aliquotaAdRem, valor}. */
export const GrupoEtapaMonofasiaOutput = Object.freeze({
  builder: (campos = {}) => construir(['quantidade', 'aliquotaAdRem', 'valor'], {}, campos),
  /** merge(g1, g2): note requireNonNull(g2.x) is evaluated before requireNonNullElse (NPE even if g1.x is set). */
  merge(g1, g2) {
    if (g1 == null) return g2;
    if (g2 == null) return g1;
    const q2 = exigirNaoNulo(g2.quantidade);
    const quantidade = g1.quantidade ?? q2;
    const a2 = exigirNaoNulo(g2.aliquotaAdRem);
    const aliquotaAdRem = g1.aliquotaAdRem ?? a2;
    const valor = (g1.valor ?? ZERO).add(g2.valor ?? ZERO);
    return GrupoEtapaMonofasiaOutput.builder({ quantidade, aliquotaAdRem, valor });
  },
});

/** GrupoDiferimentoMonofasiaOutput {valorDiferimento, percentualDiferimento}. */
export const GrupoDiferimentoMonofasiaOutput = Object.freeze({
  builder: (campos = {}) => construir(['valorDiferimento', 'percentualDiferimento'], {}, campos),
  merge(g1, g2) {
    if (g1 == null) return g2;
    if (g2 == null) return g1;
    const valorDiferimento = (g1.valorDiferimento ?? ZERO).add(g2.valorDiferimento ?? ZERO);
    const p2 = exigirNaoNulo(g2.percentualDiferimento);
    const percentualDiferimento = g1.percentualDiferimento ?? p2;
    return GrupoDiferimentoMonofasiaOutput.builder({ percentualDiferimento, valorDiferimento });
  },
});

// ── ROC domains (serialized) ───────────────────────────────────────────────────

export const ORDEM = Object.freeze({
  TributosDomain: ['IS', 'IBSCBS'],
  ImpostoSeletivoDomain: ['CSTIS', 'cClassTribIS', 'vBCIS', 'pIS', 'pISEspec', 'adRemIS', 'uTrib', 'qTrib', 'vIS', 'memoriaCalculo'],
  IBSCBSDomain: ['CST', 'cClassTrib', 'indDoacao', 'gIBSCBS', 'gIBSCBSMono', 'gTransfCred', 'gAjusteCompet', 'gEstornoCred', 'gCredPresOper', 'gCredPresIBSZFM', 'memoriaCalculo'],
  GrupoIBSCBSDomain: ['vBC', 'gIBSUF', 'gIBSMun', 'vIBS', 'gCBS', 'gTribRegular', 'gTribCompraGov'],
  IBSUFDomain: ['pIBSUF', 'gDif', 'gDevTrib', 'gRed', 'vIBSUF'],
  IBSMunDomain: ['pIBSMun', 'gDif', 'gDevTrib', 'gRed', 'vIBSMun'],
  CBSDomain: ['pCBS', 'gDif', 'gDevTrib', 'gRed', 'vCBS'],
  ReducaoAliquotaDomain: ['pRedAliq', 'pAliqEfet'],
  DiferimentoDomain: ['pDif', 'vDif'],
  TributacaoRegularDomain: ['CSTReg', 'cClassTribReg', 'pAliqEfetRegIBSUF', 'vTribRegIBSUF', 'pAliqEfetRegIBSMun', 'vTribRegIBSMun', 'pAliqEfetRegCBS', 'vTribRegCBS'],
  TributacaoCompraGovernamentalDomain: ['pAliqIBSUF', 'vTribIBSUF', 'pAliqIBSMun', 'vTribIBSMun', 'pAliqCBS', 'vTribCBS'],
  MemoriaCalculoDomain: ['cbs', 'ibsUF', 'ibsMun'],
  MonofasiaDomain: ['gMonoPadrao', 'gMonoReten', 'gMonoRet', 'gMonoDif', 'vTotIBSMonoItem', 'vTotCBSMonoItem'],
  MonofasiaPadraoDomain: ['qBCMono', 'adRemIBS', 'adRemCBS', 'vIBSMono', 'vCBSMono'],
  MonofasiaRetencaoDomain: ['qBCMonoReten', 'adRemIBSReten', 'vIBSMonoReten', 'adRemCBSReten', 'vCBSMonoReten'],
  MonofasiaRetidoAnteriormenteDomain: ['qBCMonoRet', 'adRemIBSRet', 'vIBSMonoRet', 'adRemCBSRet', 'vCBSMonoRet'],
  MonofasiaDiferimentoDomain: ['pDifIBS', 'vIBSMonoDif', 'pDifCBS', 'vCBSMonoDif'],
  CreditoPresumidoOperacaoDomain: ['vBCCredPres', 'cCredPres', 'gIBSCredPres', 'gCBSCredPres'],
  IBSCBSCreditoPresumidoDomain: ['pCredPres', 'vCredPres', 'vCredPresCondSus'],
});

export const ReducaoAliquotaDomain = Object.freeze({ builder: (c = {}) => construir(ORDEM.ReducaoAliquotaDomain, {}, c) });
export const DiferimentoDomain = Object.freeze({ builder: (c = {}) => construir(ORDEM.DiferimentoDomain, ZEROS(['pDif', 'vDif']), c) });
export const TributacaoRegularDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.TributacaoRegularDomain, ZEROS(ORDEM.TributacaoRegularDomain.slice(2)), c),
});
export const MemoriaCalculoDomain = Object.freeze({ criar: (cbs = null, ibsUF = null, ibsMun = null) => ({ cbs, ibsUF, ibsMun }) });

/** CBSDomain / IBSUFDomain / IBSMunDomain: `new X()` with p* and v* initialized to ZERO, then setters. */
function grupoTributo(ordem) {
  const p = ordem[0], v = ordem[4];
  return Object.freeze({
    novo: () => construir(ordem, { [p]: ZERO, [v]: ZERO }),
    getVDif: (g) => (g.gDif != null ? g.gDif.vDif : ZERO),
    getVDevTrib: (g) => (g.gDevTrib != null ? g.gDevTrib.vDevTrib : ZERO),
  });
}
export const CBSDomain = grupoTributo(ORDEM.CBSDomain);
export const IBSUFDomain = grupoTributo(ORDEM.IBSUFDomain);
export const IBSMunDomain = grupoTributo(ORDEM.IBSMunDomain);

/** ImpostoSeletivoDomain (builder without defaults). */
export const ImpostoSeletivoDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.ImpostoSeletivoDomain, {}, c),
  getValorImpostoSeletivo: (is) => (is.vIS != null ? is.vIS : ZERO),
});

/** TributacaoCompraGovernamentalDomain: 6 fields @Builder.Default ZERO + the redistribution of art. 473. */
export const TributacaoCompraGovernamentalDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.TributacaoCompraGovernamentalDomain, ZEROS(ORDEM.TributacaoCompraGovernamentalDomain), c),
  zerarValores(d) { for (const k of ORDEM.TributacaoCompraGovernamentalDomain) d[k] = ZERO; },
  /**
   * getValoresEfetivos(tpEnteGov, pTransferenciaCBS, dataFatoGerador 'AAAA-MM-DD', vBC): the main
   * group values. Before 2027 returns the very same object (each entity keeps its own values).
   */
  getValoresEfetivos(d, tpEnteGov, pTransferenciaCBS, dataFatoGerador, vBC) {
    if (tpEnteGov == null) return null;
    if (dataFatoGerador == null) throw E.nullPointer('Data do fato gerador obrigatória');
    if (pTransferenciaCBS == null) throw E.nullPointer('Percentual de transferência da CBS obrigatória');
    if (dataFatoGerador < '2027-01-01') return d; // LocalDate.isBefore on ISO dates
    const soma = d.pAliqCBS.add(d.pAliqIBSUF).add(d.pAliqIBSMun);
    const comAliquotas = (cbs, uf, mun) => TributacaoCompraGovernamentalDomain.builder({
      pAliqCBS: cbs, vTribCBS: valorPelaAliquotaPublicada(vBC, cbs),
      pAliqIBSUF: uf, vTribIBSUF: valorPelaAliquotaPublicada(vBC, uf),
      pAliqIBSMun: mun, vTribIBSMun: valorPelaAliquotaPublicada(vBC, mun),
    });
    if (TipoEnteGovernamental.isUniao(tpEnteGov)) return comAliquotas(soma, ZERO, ZERO);
    // who cedes (CBS) is rounded to 4 places; who receives closes by the exact difference
    const pAliqCBSFinal = A.arredondarAliquotaPublicada(d.pAliqCBS.subtract(d.pAliqCBS.multiply(A.percentualParaFracao(pTransferenciaCBS))));
    const pAliqRecebedor = soma.subtract(pAliqCBSFinal);
    if (TipoEnteGovernamental.isEstado(tpEnteGov)) return comAliquotas(pAliqCBSFinal, pAliqRecebedor, ZERO);
    if (TipoEnteGovernamental.isMunicipio(tpEnteGov)) return comAliquotas(pAliqCBSFinal, ZERO, pAliqRecebedor);
    return comAliquotas(pAliqCBSFinal, ZERO, ZERO);
  },
});
const valorPelaAliquotaPublicada = (vBC, aliquota) => A.arredondarValorFiscal(A.multiplicar(vBC, A.percentualParaFracao(aliquota)));

// ── Monofasia ──────────────────────────────────────────────────────────────────

/** Monofasia*Domain.create(cbs, ibsEstadual, ibsMunicipal): CBS part from cbs, IBS part from the IBS UF only. */
function fabricaMonofasia(ordem, etapa, merge, camposCbs, camposIbs) {
  const fonte = (o) => (o != null && o.grupoMonofasia != null ? o.grupoMonofasia[etapa] ?? null : null);
  const builder = (c = {}) => construir(ordem, ZEROS(ordem), c);
  return Object.freeze({
    builder,
    create(cbs, ibsEstadual /* , ibsMunicipal: ignored ("por enquanto") */) {
      const tCbs = fonte(cbs);
      let b = tCbs != null ? camposCbs(tCbs) : null;
      const monoUF = fonte(ibsEstadual);
      if (monoUF != null) {
        const t = merge(monoUF, null);
        b = { ...(b ?? {}), ...camposIbs(t) };
        return builder(b);
      }
      return null; // the CBS part alone is discarded
    },
  });
}
export const MonofasiaPadraoDomain = fabricaMonofasia(ORDEM.MonofasiaPadraoDomain, 'tributoMonofasico', GrupoEtapaMonofasiaOutput.merge,
  (t) => ({ qBCMono: t.quantidade, adRemCBS: t.aliquotaAdRem, vCBSMono: t.valor }),
  (t) => ({ qBCMono: t.quantidade, adRemIBS: t.aliquotaAdRem, vIBSMono: t.valor }));
export const MonofasiaRetencaoDomain = fabricaMonofasia(ORDEM.MonofasiaRetencaoDomain, 'tributoSujeitoRetencao', GrupoEtapaMonofasiaOutput.merge,
  (t) => ({ qBCMonoReten: t.quantidade, adRemCBSReten: t.aliquotaAdRem, vCBSMonoReten: t.valor }),
  (t) => ({ qBCMonoReten: t.quantidade, adRemIBSReten: t.aliquotaAdRem, vIBSMonoReten: t.valor }));
export const MonofasiaRetidoAnteriormenteDomain = fabricaMonofasia(ORDEM.MonofasiaRetidoAnteriormenteDomain, 'tributoRetido', GrupoEtapaMonofasiaOutput.merge,
  (t) => ({ qBCMonoRet: t.quantidade, adRemCBSRet: t.aliquotaAdRem, vCBSMonoRet: t.valor }),
  (t) => ({ qBCMonoRet: t.quantidade, adRemIBSRet: t.aliquotaAdRem, vIBSMonoRet: t.valor }));
export const MonofasiaDiferimentoDomain = fabricaMonofasia(ORDEM.MonofasiaDiferimentoDomain, 'tributoDiferido', GrupoDiferimentoMonofasiaOutput.merge,
  (t) => ({ pDifCBS: t.percentualDiferimento, vCBSMonoDif: t.valorDiferimento }),
  (t) => ({ pDifIBS: t.percentualDiferimento, vIBSMonoDif: t.valorDiferimento }));

/** MonofasiaDomain: builder with vTot* defaults and the null-safe convenience getters. */
export const MonofasiaDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.MonofasiaDomain, ZEROS(['vTotIBSMonoItem', 'vTotCBSMonoItem']), c),
  getVIBSMono: (m) => (m.gMonoPadrao != null ? m.gMonoPadrao.vIBSMono : ZERO),
  getVCBSMono: (m) => (m.gMonoPadrao != null ? m.gMonoPadrao.vCBSMono : ZERO),
  getVIBSMonoReten: (m) => (m.gMonoReten != null ? m.gMonoReten.vIBSMonoReten : ZERO),
  getVCBSMonoReten: (m) => (m.gMonoReten != null ? m.gMonoReten.vCBSMonoReten : ZERO),
  getVIBSMonoRet: (m) => (m.gMonoRet != null ? m.gMonoRet.vIBSMonoRet : ZERO),
  getVCBSMonoRet: (m) => (m.gMonoRet != null ? m.gMonoRet.vCBSMonoRet : ZERO),
  getVIBSMonoDif: (m) => (m.gMonoDif != null ? m.gMonoDif.vIBSMonoDif : ZERO),
  getVCBSMonoDif: (m) => (m.gMonoDif != null ? m.gMonoDif.vCBSMonoDif : ZERO),
  getVTotIBSMonoItem: (m) => m.vTotIBSMonoItem ?? ZERO,
  getVTotCBSMonoItem: (m) => m.vTotCBSMonoItem ?? ZERO,
});

// ── Crédito presumido (never produced by the engine; getters used by the totals) ──

export const CreditoPresumidoOperacaoDomain = Object.freeze({
  possuiCredPresCbs: (c) => c.gCBSCredPres != null,
  possuiCredPresIbs: (c) => c.gIBSCredPres != null && c.gIBSCredPres.vCredPres != null,
  getVCredPresIbs: (c) => (CreditoPresumidoOperacaoDomain.possuiCredPresIbs(c) ? c.gIBSCredPres.vCredPres : ZERO),
  possuiCredPresCondSusIbs: (c) => c.gIBSCredPres != null && c.gIBSCredPres.vCredPresCondSus != null,
  getVCredPresCondSusIbs: (c) => (CreditoPresumidoOperacaoDomain.possuiCredPresCondSusIbs(c) ? c.gIBSCredPres.vCredPresCondSus : ZERO),
});

// ── GrupoIBSCBSDomain / IBSCBSDomain / TributosDomain ────────────────────────────

export const GrupoIBSCBSDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.GrupoIBSCBSDomain, {}, c),
  possuiBaseCalculoIBSCBS: (g) => g.vBC != null,
  getValorBaseCalculoIBSCBS: (g) => (g.vBC != null ? g.vBC : ZERO),
  possuiCbs: (g) => g.gCBS != null,
  possuiIBSUF: (g) => g.gIBSUF != null,
  possuiIBSMun: (g) => g.gIBSMun != null,
  possuiTributacaoRegular: (g) => g.gTribRegular != null,
  getTributacaoRegular: (g) => g.gTribRegular,
});

const G = GrupoIBSCBSDomain;
const CP = CreditoPresumidoOperacaoDomain;
export const IBSCBSDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.IBSCBSDomain, {}, c),
  possuiBaseCalculoIBSCBS: (d) => d.gIBSCBS != null && G.possuiBaseCalculoIBSCBS(d.gIBSCBS),
  getValorBaseCalculoIBSCBS: (d) => (IBSCBSDomain.possuiBaseCalculoIBSCBS(d) ? G.getValorBaseCalculoIBSCBS(d.gIBSCBS) : ZERO),
  possuiCbs: (d) => d.gIBSCBS != null && G.possuiCbs(d.gIBSCBS),
  getGCBS: (d) => (d.gIBSCBS != null ? d.gIBSCBS.gCBS : null),
  possuiCredPresCbs: (d) => d.gCredPresOper != null && CP.possuiCredPresCbs(d.gCredPresOper),
  getCredPresCbs: (d) => (IBSCBSDomain.possuiCredPresCbs(d) ? d.gCredPresOper.gCBSCredPres : null),
  possuiCredPresIbs: (d) => d.gCredPresOper != null && CP.possuiCredPresIbs(d.gCredPresOper),
  getVCredPresIbs: (d) => (IBSCBSDomain.possuiCredPresIbs(d) ? CP.getVCredPresIbs(d.gCredPresOper) : ZERO),
  possuiCredPresCondSusIbs: (d) => d.gCredPresOper != null && CP.possuiCredPresCondSusIbs(d.gCredPresOper),
  getVCredPresCondSusIbs: (d) => (IBSCBSDomain.possuiCredPresCondSusIbs(d) ? CP.getVCredPresCondSusIbs(d.gCredPresOper) : ZERO),
  getGrupoIBSCBS: (d) => d.gIBSCBS,
  possuiIBSUF: (d) => d.gIBSCBS != null && G.possuiIBSUF(d.gIBSCBS),
  possuiIBSMun: (d) => d.gIBSCBS != null && G.possuiIBSMun(d.gIBSCBS),
  getGIBSUF: (d) => (d.gIBSCBS != null ? d.gIBSCBS.gIBSUF : null),
  getGIBSMun: (d) => (d.gIBSCBS != null ? d.gIBSCBS.gIBSMun : null),
  possuiMonofasia: (d) => d.gIBSCBSMono != null,
  possuiTributacaoRegular: (d) => d.gIBSCBS != null && G.possuiTributacaoRegular(d.gIBSCBS),
  getTributacaoRegular: (d) => (d.gIBSCBS != null ? G.getTributacaoRegular(d.gIBSCBS) : null),
  possuiEstornoCredito: (d) => d.gEstornoCred != null,
});

const D = IBSCBSDomain;
export const TributosDomain = Object.freeze({
  builder: (c = {}) => construir(ORDEM.TributosDomain, {}, c),
  possuiImpostoSeletivo: (t) => t.IS != null,
  getValorImpostoSeletivo: (t) => (t.IS != null ? ImpostoSeletivoDomain.getValorImpostoSeletivo(t.IS) : ZERO),
  possuiBaseCalculoIBSCBS: (t) => t.IBSCBS != null && D.possuiBaseCalculoIBSCBS(t.IBSCBS),
  getValorBaseCalculoIBSCBS: (t) => (TributosDomain.possuiBaseCalculoIBSCBS(t) ? D.getValorBaseCalculoIBSCBS(t.IBSCBS) : ZERO),
  possuiCbs: (t) => t.IBSCBS != null && D.possuiCbs(t.IBSCBS),
  getGCBS: (t) => (t.IBSCBS != null ? D.getGCBS(t.IBSCBS) : null),
  possuiCredPresCbs: (t) => t.IBSCBS != null && D.possuiCredPresCbs(t.IBSCBS),
  getCredPresCbs: (t) => (TributosDomain.possuiCredPresCbs(t) ? D.getCredPresCbs(t.IBSCBS) : null),
  possuiCredPresIbs: (t) => t.IBSCBS != null && D.possuiCredPresIbs(t.IBSCBS),
  getVCredPresIbs: (t) => (TributosDomain.possuiCredPresIbs(t) ? D.getVCredPresIbs(t.IBSCBS) : ZERO),
  possuiCredPresCondSusIbs: (t) => t.IBSCBS != null && D.possuiCredPresCondSusIbs(t.IBSCBS),
  getVCredPresCondSusIbs: (t) => (TributosDomain.possuiCredPresCondSusIbs(t) ? D.getVCredPresCondSusIbs(t.IBSCBS) : ZERO),
  getGrupoIBSCBS: (t) => (t.IBSCBS != null ? D.getGrupoIBSCBS(t.IBSCBS) : null),
  possuiIBSUF: (t) => t.IBSCBS != null && D.possuiIBSUF(t.IBSCBS),
  possuiIBSMun: (t) => t.IBSCBS != null && D.possuiIBSMun(t.IBSCBS),
  getGIBSUF: (t) => (t.IBSCBS != null ? D.getGIBSUF(t.IBSCBS) : null),
  getGIBSMun: (t) => (t.IBSCBS != null ? D.getGIBSMun(t.IBSCBS) : null),
  possuiMonofasia: (t) => t.IBSCBS != null && D.possuiMonofasia(t.IBSCBS),
  getGIBSCBSMono: (t) => (TributosDomain.possuiMonofasia(t) ? t.IBSCBS.gIBSCBSMono : null),
  possuiTributacaoRegular: (t) => t.IBSCBS != null && D.possuiTributacaoRegular(t.IBSCBS),
  getTributacaoRegular: (t) => (t.IBSCBS != null ? D.getTributacaoRegular(t.IBSCBS) : null),
  possuiEstornoCredito: (t) => t.IBSCBS != null && D.possuiEstornoCredito(t.IBSCBS),
  getGEstornoCred: (t) => (t.IBSCBS != null ? t.IBSCBS.gEstornoCred : null),
});
