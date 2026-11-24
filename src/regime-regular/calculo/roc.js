// Response model of the calculation endpoints (api/model/roc/*): ROCDomain, ObservabilidadeROCDomain,
// ObjetoDomain, ObservabilidadeItemDomain, OperacaoConsumoDomain/CompraGovernamentalDomain, the totals
// (ValoresTotaisDomain.create … and the api/model/roc/reduce accumulators) and their Jackson output:
// @JsonPropertyOrder order, NON_NULL, BigDecimal through the project serializers (TDec1302 money,
// TDec0302_04 rate), negative values → serializer exception (the 500 "Failed to write request").
// Item tribCalc objects come from the engine (calculo/motor) as TributosDomain trees with the Java
// field names and Dec values; their JSON is produced by the engine's serializarTributos.
import { Dec } from '../../core/decimal.js';
import { ErroSerializacao } from '../comum/problema.js';
import { formatarMoeda, formatarAliquota } from '../comum/arredondamento.js';

const ZERO = Dec.ZERO;
const ouZero = (v) => (v != null ? v : ZERO); // Objects.requireNonNullElse(v, ZERO)

// ─── ObjetoDomain navigation (@JsonIgnore helpers used by the totals) ─────────────

const ibscbs = (o) => o.tribCalc?.IBSCBS ?? null;
const grupo = (o) => ibscbs(o)?.gIBSCBS ?? null;
export const objeto = {
  possuiImpostoSeletivo: (o) => o.tribCalc != null && o.tribCalc.IS != null,
  getValorImpostoSeletivo: (o) => (objeto.possuiImpostoSeletivo(o) ? ouZero(o.tribCalc.IS.vIS) : ZERO),
  possuiBaseCalculoIBSCBS: (o) => grupo(o) != null && grupo(o).vBC != null,
  getValorBaseCalculoIBSCBS: (o) => (objeto.possuiBaseCalculoIBSCBS(o) ? grupo(o).vBC : ZERO),
  possuiCbs: (o) => grupo(o) != null && grupo(o).gCBS != null,
  getGCBS: (o) => grupo(o)?.gCBS ?? null,
  possuiCredPresCbs: (o) => ibscbs(o)?.gCredPresOper != null && ibscbs(o).gCredPresOper.gCBSCredPres != null,
  getCredPresCbs: (o) => (objeto.possuiCredPresCbs(o) ? ibscbs(o).gCredPresOper.gCBSCredPres : null),
  possuiCredPresIbs: (o) => ibscbs(o)?.gCredPresOper?.gIBSCredPres != null && ibscbs(o).gCredPresOper.gIBSCredPres.vCredPres != null,
  getVCredPresIbs: (o) => (objeto.possuiCredPresIbs(o) ? ibscbs(o).gCredPresOper.gIBSCredPres.vCredPres : ZERO),
  possuiCredPresCondSusIbs: (o) => ibscbs(o)?.gCredPresOper?.gIBSCredPres != null && ibscbs(o).gCredPresOper.gIBSCredPres.vCredPresCondSus != null,
  getVCredPresCondSusIbs: (o) => (objeto.possuiCredPresCondSusIbs(o) ? ibscbs(o).gCredPresOper.gIBSCredPres.vCredPresCondSus : ZERO),
  getGrupoIBSCBS: (o) => grupo(o),
  possuiIBSUF: (o) => grupo(o) != null && grupo(o).gIBSUF != null,
  getGIBSUF: (o) => grupo(o)?.gIBSUF ?? null,
  possuiIBSMun: (o) => grupo(o) != null && grupo(o).gIBSMun != null,
  getGIBSMun: (o) => grupo(o)?.gIBSMun ?? null,
  possuiMonofasia: (o) => ibscbs(o)?.gIBSCBSMono != null,
  getGIBSCBSMono: (o) => (objeto.possuiMonofasia(o) ? ibscbs(o).gIBSCBSMono : null),
  possuiTributacaoRegular: (o) => grupo(o) != null && grupo(o).gTribRegular != null,
  getTributacaoRegular: (o) => grupo(o)?.gTribRegular ?? null,
  possuiEstornoCredito: (o) => ibscbs(o)?.gEstornoCred != null,
  getGEstornoCred: (o) => ibscbs(o)?.gEstornoCred ?? null,
};

/** CBSDomain/IBSUFDomain/IBSMunDomain.getVDif() / getVDevTrib() (may be null when the group's value is null). */
const getVDif = (g) => (g.gDif != null ? g.gDif.vDif : ZERO);
const getVDevTrib = (g) => (g.gDevTrib != null ? g.gDevTrib.vDevTrib : ZERO);

/** MonofasiaDomain convenience getters (gMonoDif and vTot*MonoItem are not totalled). */
const mono = {
  getVIBSMono: (m) => (m.gMonoPadrao != null ? m.gMonoPadrao.vIBSMono : ZERO),
  getVCBSMono: (m) => (m.gMonoPadrao != null ? m.gMonoPadrao.vCBSMono : ZERO),
  getVIBSMonoReten: (m) => (m.gMonoReten != null ? m.gMonoReten.vIBSMonoReten : ZERO),
  getVCBSMonoReten: (m) => (m.gMonoReten != null ? m.gMonoReten.vCBSMonoReten : ZERO),
  getVIBSMonoRet: (m) => (m.gMonoRet != null ? m.gMonoRet.vIBSMonoRet : ZERO),
  getVCBSMonoRet: (m) => (m.gMonoRet != null ? m.gMonoRet.vCBSMonoRet : ZERO),
};

// ─── Accumulators (api/model/roc/reduce) ──────────────────────────────────────────

export class CBSTotalAccumulator {
  constructor(vDif = ZERO, vDevTrib = ZERO, vCBS = ZERO, vCredPres = ZERO, vCredPresCondSus = ZERO) {
    this.vDif = ouZero(vDif); this.vDevTrib = ouZero(vDevTrib); this.vCBS = ouZero(vCBS);
    this.vCredPres = ouZero(vCredPres); this.vCredPresCondSus = ouZero(vCredPresCondSus);
  }
  static from(cbs, credPres) {
    return new CBSTotalAccumulator(
      cbs != null ? getVDif(cbs) : ZERO, cbs != null ? getVDevTrib(cbs) : ZERO, cbs != null ? ouZero(cbs.vCBS) : ZERO,
      credPres != null ? ouZero(credPres.vCredPres) : ZERO, credPres != null ? ouZero(credPres.vCredPresCondSus) : ZERO);
  }
  add(o) {
    if (o == null) return this;
    return new CBSTotalAccumulator(this.vDif.add(o.vDif), this.vDevTrib.add(o.vDevTrib), this.vCBS.add(o.vCBS), this.vCredPres.add(o.vCredPres), this.vCredPresCondSus.add(o.vCredPresCondSus));
  }
  toCBSTotal() { return { vDif: this.vDif, vDevTrib: this.vDevTrib, vCBS: this.vCBS, vCredPres: this.vCredPres, vCredPresCondSus: this.vCredPresCondSus }; }
}

export class IBSUFTotalAccumulator {
  constructor(vDif = ZERO, vDevTrib = ZERO, vIBSUF = ZERO) { this.vDif = ouZero(vDif); this.vDevTrib = ouZero(vDevTrib); this.vIBSUF = ouZero(vIBSUF); }
  static from(uf) { return uf == null ? new IBSUFTotalAccumulator() : new IBSUFTotalAccumulator(getVDif(uf), getVDevTrib(uf), uf.vIBSUF); }
  add(o) { return o == null ? this : new IBSUFTotalAccumulator(this.vDif.add(o.vDif), this.vDevTrib.add(o.vDevTrib), this.vIBSUF.add(o.vIBSUF)); }
  toIBSUFTotal() { return { vDif: this.vDif, vDevTrib: this.vDevTrib, vIBSUF: this.vIBSUF }; }
}

export class IBSMunTotalAccumulator {
  constructor(vDif = ZERO, vDevTrib = ZERO, vIBSMun = ZERO) { this.vDif = ouZero(vDif); this.vDevTrib = ouZero(vDevTrib); this.vIBSMun = ouZero(vIBSMun); }
  static from(mun) { return mun == null ? new IBSMunTotalAccumulator() : new IBSMunTotalAccumulator(ouZero(getVDif(mun)), ouZero(getVDevTrib(mun)), ouZero(mun.vIBSMun)); }
  add(o) { return o == null ? this : new IBSMunTotalAccumulator(this.vDif.add(o.vDif), this.vDevTrib.add(o.vDevTrib), this.vIBSMun.add(o.vIBSMun)); }
  toIBSMunTotal() { return { vDif: this.vDif, vDevTrib: this.vDevTrib, vIBSMun: this.vIBSMun }; }
}

export class MonofasiaTotalAccumulator {
  constructor(vIBSMono = ZERO, vCBSMono = ZERO, vIBSMonoReten = ZERO, vCBSMonoReten = ZERO, vIBSMonoRet = ZERO, vCBSMonoRet = ZERO) {
    this.vIBSMono = ouZero(vIBSMono); this.vCBSMono = ouZero(vCBSMono); this.vIBSMonoReten = ouZero(vIBSMonoReten);
    this.vCBSMonoReten = ouZero(vCBSMonoReten); this.vIBSMonoRet = ouZero(vIBSMonoRet); this.vCBSMonoRet = ouZero(vCBSMonoRet);
  }
  static from(m) {
    if (m == null) return new MonofasiaTotalAccumulator();
    return new MonofasiaTotalAccumulator(mono.getVIBSMono(m), mono.getVCBSMono(m), mono.getVIBSMonoReten(m), mono.getVCBSMonoReten(m), mono.getVIBSMonoRet(m), mono.getVCBSMonoRet(m));
  }
  add(o) {
    if (o == null) return this;
    return new MonofasiaTotalAccumulator(this.vIBSMono.add(o.vIBSMono), this.vCBSMono.add(o.vCBSMono), this.vIBSMonoReten.add(o.vIBSMonoReten),
      this.vCBSMonoReten.add(o.vCBSMonoReten), this.vIBSMonoRet.add(o.vIBSMonoRet), this.vCBSMonoRet.add(o.vCBSMonoRet));
  }
  toMonofasiaTotal() {
    return { vIBSMono: this.vIBSMono, vCBSMono: this.vCBSMono, vIBSMonoReten: this.vIBSMonoReten, vCBSMonoReten: this.vCBSMonoReten, vIBSMonoRet: this.vIBSMonoRet, vCBSMonoRet: this.vCBSMonoRet };
  }
}

export class EstornoCreditoAccumulator {
  constructor(vIBSEstCred = ZERO, vCBSEstCred = ZERO) { this.vIBSEstCred = ouZero(vIBSEstCred); this.vCBSEstCred = ouZero(vCBSEstCred); }
  static from(e) { return e == null ? new EstornoCreditoAccumulator() : new EstornoCreditoAccumulator(ouZero(e.vIBSEstCred), ouZero(e.vCBSEstCred)); }
  add(o) { return o == null ? this : new EstornoCreditoAccumulator(this.vIBSEstCred.add(o.vIBSEstCred), this.vCBSEstCred.add(o.vCBSEstCred)); }
  toEstornoCreditoDomainTotal() { return { vIBSEstCred: this.vIBSEstCred, vCBSEstCred: this.vCBSEstCred }; }
}

// ─── Totals (ValoresTotaisDomain.create and friends) ──────────────────────────────

const temDetalhes = (d) => d != null && d.length > 0;
const somar = (d, filtro, valor) => d.filter(filtro).map(valor).reduce((a, b) => a.add(b), ZERO);

export function impostoSeletivoTotal(d) {
  if (!temDetalhes(d) || !d.some(objeto.possuiImpostoSeletivo)) return null;
  return { vIS: somar(d, objeto.possuiImpostoSeletivo, objeto.getValorImpostoSeletivo) };
}

export function ibsUfTotal(d) {
  if (!temDetalhes(d) || !d.some(objeto.possuiIBSUF)) return null;
  return d.filter(objeto.possuiIBSUF).map((o) => IBSUFTotalAccumulator.from(objeto.getGIBSUF(o))).reduce((a, b) => a.add(b), new IBSUFTotalAccumulator()).toIBSUFTotal();
}

export function ibsMunTotal(d) {
  if (!temDetalhes(d) || !d.some(objeto.possuiIBSMun)) return null;
  return d.filter(objeto.possuiIBSMun).map((o) => IBSMunTotalAccumulator.from(objeto.getGIBSMun(o))).reduce((a, b) => a.add(b), new IBSMunTotalAccumulator()).toIBSMunTotal();
}

export function cbsTotal(d) {
  const cond = (o) => objeto.possuiCbs(o) || objeto.possuiCredPresCbs(o);
  if (!temDetalhes(d) || !d.some(cond)) return null;
  return d.filter(cond).map((o) => CBSTotalAccumulator.from(objeto.getGCBS(o), objeto.getCredPresCbs(o))).reduce((a, b) => a.add(b), new CBSTotalAccumulator()).toCBSTotal();
}

export function monofasiaTotal(d) {
  if (!temDetalhes(d) || !d.some(objeto.possuiMonofasia)) return null;
  return d.filter(objeto.possuiMonofasia).map((o) => MonofasiaTotalAccumulator.from(objeto.getGIBSCBSMono(o))).reduce((a, b) => a.add(b), new MonofasiaTotalAccumulator()).toMonofasiaTotal();
}

export function estornoCreditoTotal(d) {
  if (!temDetalhes(d) || !d.some(objeto.possuiEstornoCredito)) return null;
  return d.filter(objeto.possuiEstornoCredito).map((o) => EstornoCreditoAccumulator.from(objeto.getGEstornoCred(o))).reduce((a, b) => a.add(b), new EstornoCreditoAccumulator()).toEstornoCreditoDomainTotal();
}

export function ibsTotal(d) {
  if (!temDetalhes(d)) return null;
  return {
    gIBSUF: ibsUfTotal(d) ?? new IBSUFTotalAccumulator().toIBSUFTotal(),
    gIBSMun: ibsMunTotal(d) ?? new IBSMunTotalAccumulator().toIBSMunTotal(),
    vIBS: d.map(objeto.getGrupoIBSCBS).filter((g) => g != null).map((g) => g.vIBS).filter((v) => v != null).reduce((a, b) => a.add(b), ZERO),
    vCredPres: somar(d, objeto.possuiCredPresIbs, objeto.getVCredPresIbs),
    vCredPresCondSus: somar(d, objeto.possuiCredPresCondSusIbs, objeto.getVCredPresCondSusIbs),
  };
}

/** IBSCBSTotalDomain.create(detalhes): null only for an empty list; gCBS/gMono always present (zeros). */
export function ibsCbsTotal(d) {
  if (!temDetalhes(d)) return null;
  return {
    vBCIBSCBS: somar(d, objeto.possuiBaseCalculoIBSCBS, objeto.getValorBaseCalculoIBSCBS),
    gIBS: ibsTotal(d),
    gCBS: cbsTotal(d) ?? new CBSTotalAccumulator().toCBSTotal(),
    gMono: monofasiaTotal(d) ?? new MonofasiaTotalAccumulator().toMonofasiaTotal(),
    gEstornoCred: estornoCreditoTotal(d),
  };
}

/** ValoresTotaisDomain.create(detalhes) = { tribCalc: TributosTotaisDomain.create(detalhes) }. */
export function valoresTotais(detalhes) {
  return { tribCalc: { ISTot: impostoSeletivoTotal(detalhes), IBSCBSTot: ibsCbsTotal(detalhes) } };
}

// ─── Serialization ────────────────────────────────────────────────────────────────

/** BigDecimalTDec1302Serializer (null omitted by NON_NULL). */
export function moeda(v) {
  if (v == null) return undefined;
  if (v.signum() < 0) throw new ErroSerializacao('Números negativos não são permitidos para TDec1302');
  return formatarMoeda(v);
}

/** BigDecimalTDec0302_04Serializer. */
export function aliquota(v) {
  if (v == null) return undefined;
  if (v.signum() < 0) throw new ErroSerializacao('Números negativos não são permitidos para TDec_0302_04');
  return formatarAliquota(v);
}

const valoresMoeda = (o, campos) => (o == null ? undefined : Object.fromEntries(campos.map((c) => [c, moeda(o[c])])));

/** ValoresTotaisDomain JSON tree (keys in @JsonPropertyOrder order). */
export function totalJson(total) {
  if (total == null) return undefined;
  const t = total.tribCalc;
  if (t == null) return {};
  const ib = t.IBSCBSTot;
  return {
    tribCalc: {
      ISTot: valoresMoeda(t.ISTot, ['vIS']),
      IBSCBSTot: ib == null ? undefined : {
        vBCIBSCBS: moeda(ib.vBCIBSCBS),
        gIBS: ib.gIBS == null ? undefined : {
          gIBSUF: valoresMoeda(ib.gIBS.gIBSUF, ['vDif', 'vDevTrib', 'vIBSUF']),
          gIBSMun: valoresMoeda(ib.gIBS.gIBSMun, ['vDif', 'vDevTrib', 'vIBSMun']),
          vIBS: moeda(ib.gIBS.vIBS),
          vCredPres: moeda(ib.gIBS.vCredPres),
          vCredPresCondSus: moeda(ib.gIBS.vCredPresCondSus),
        },
        gCBS: valoresMoeda(ib.gCBS, ['vDif', 'vDevTrib', 'vCBS', 'vCredPres', 'vCredPresCondSus']),
        gMono: valoresMoeda(ib.gMono, ['vIBSMono', 'vCBSMono', 'vIBSMonoReten', 'vCBSMonoReten', 'vIBSMonoRet', 'vCBSMonoRet']),
        gEstornoCred: valoresMoeda(ib.gEstornoCred, ['vIBSEstCred', 'vCBSEstCred']),
      },
    },
  };
}

/** OperacaoConsumoDomain JSON: { gCompraGov: { tpEnteGov, pRedutor, tpOperGov } }. */
export function operJson(oper) {
  if (oper == null) return undefined;
  const g = oper.gCompraGov;
  return { gCompraGov: g == null ? undefined : { tpEnteGov: g.tpEnteGov ?? undefined, pRedutor: aliquota(g.pRedutor), tpOperGov: g.tpOperGov ?? undefined } };
}

/** ROCDomain JSON: { oper, objetos: [ObjetoDomain{nObj, tribCalc, calculoSimulado}], total }. */
export function rocJson(roc, serializarTributos) {
  return {
    oper: operJson(roc.oper),
    objetos: roc.objetos.map((o) => ({
      nObj: o.nObj ?? undefined,
      tribCalc: o.tribCalc == null ? undefined : serializarTributos(o.tribCalc),
      calculoSimulado: o.calculoSimulado === true,
    })),
    total: totalJson(roc.total),
  };
}

/** ObservabilidadeROCDomain JSON: { oper, objetos: [ObservabilidadeItemDomain{nObj, estadoItem, tribCalc, erros}], total }. */
export function observabilidadeJson(roc, serializarTributos) {
  return {
    oper: operJson(roc.oper),
    objetos: roc.objetos.map((o) => ({
      nObj: o.nObj ?? undefined,
      estadoItem: o.estadoItem ?? undefined,
      tribCalc: o.tribCalc == null ? undefined : serializarTributos(o.tribCalc),
      erros: o.erros ?? undefined,
    })),
    total: totalJson(roc.total),
  };
}
