// Jackson 3 serialization of the engine output (TributosDomain = tribCalc of each item), as the
// project configures it: property name = Java field name (SerializationVisibility), order =
// @JsonPropertyOrder, @JsonInclude(NON_NULL), numbers written as JSON STRINGS by the custom
// serializers of config/serializer (calc-core.md §2.7, §10). A serializer that throws in Java
// (negative number, malformed CST/cClassTrib/uTrib) throws ErroSerializacao here; the orchestration
// turns it into the 500 "Failed to write request" of Spring.
import { formatarAliquota, formatarMoeda, formatarQuantidade } from '../../comum/arredondamento.js';
import { ErroSerializacao } from '../../comum/problema.js';
import { ORDEM } from './dominios.js';

/** BigDecimalTDec1302Serializer / BigDecimalTDec0302_04Serializer / BigDecimalTDec1104OpRTCSerializer. */
function decimal(formatar, tipo) {
  return (v) => {
    if (v.signum() < 0) throw new ErroSerializacao(`Números negativos não são permitidos para ${tipo}`);
    return formatar(v);
  };
}
export const tdec1302 = decimal(formatarMoeda, 'TDec1302');
export const tdec0302_04 = decimal(formatarAliquota, 'TDec_0302_04');
export const tdec1104OpRTC = decimal(formatarQuantidade, 'TDec_1104OpRTC');

/** StringTCSTSerializer / StringTcClassTribSerializer / StringUTribSerializer (DatabindException). */
export function tcst(s) {
  if (!/^\d{3}$/.test(s)) throw new ErroSerializacao('TCST deve ser uma string de exatamente 3 dígitos numéricos', 'DatabindException');
  return s;
}
export function tcClassTrib(s) {
  if (!/^\d{6}$/.test(s)) throw new ErroSerializacao('TcClassTrib deve ser uma string de exatamente 6 dígitos numéricos', 'DatabindException');
  return s;
}
export function uTrib(s) {
  if (s.length === 0 || s.length > 6) throw new ErroSerializacao('uTrib deve ter entre 1 e 6 caracteres', 'DatabindException');
  return s;
}
const texto = (s) => String(s);
const inteiro = (n) => n; // java.lang.Integer → JSON number

// Serializer of every property, per class (property order comes from dominios.ORDEM).
const M = tdec1302, P = tdec0302_04, Q = tdec1104OpRTC;
const ESQUEMA = {
  TributosDomain: { IS: 'ImpostoSeletivoDomain', IBSCBS: 'IBSCBSDomain' },
  ImpostoSeletivoDomain: {
    CSTIS: tcst, cClassTribIS: tcClassTrib, vBCIS: M, pIS: P, pISEspec: P, adRemIS: P, uTrib, qTrib: Q, vIS: M, memoriaCalculo: texto,
  },
  IBSCBSDomain: {
    CST: tcst, cClassTrib: tcClassTrib, indDoacao: inteiro, gIBSCBS: 'GrupoIBSCBSDomain', gIBSCBSMono: 'MonofasiaDomain',
    gTransfCred: null, gAjusteCompet: null, gEstornoCred: null, gCredPresOper: 'CreditoPresumidoOperacaoDomain', gCredPresIBSZFM: null,
    memoriaCalculo: 'MemoriaCalculoDomain',
  },
  GrupoIBSCBSDomain: {
    vBC: M, gIBSUF: 'IBSUFDomain', gIBSMun: 'IBSMunDomain', vIBS: M, gCBS: 'CBSDomain',
    gTribRegular: 'TributacaoRegularDomain', gTribCompraGov: 'TributacaoCompraGovernamentalDomain',
  },
  IBSUFDomain: { pIBSUF: P, gDif: 'DiferimentoDomain', gDevTrib: null, gRed: 'ReducaoAliquotaDomain', vIBSUF: M },
  IBSMunDomain: { pIBSMun: P, gDif: 'DiferimentoDomain', gDevTrib: null, gRed: 'ReducaoAliquotaDomain', vIBSMun: M },
  CBSDomain: { pCBS: P, gDif: 'DiferimentoDomain', gDevTrib: null, gRed: 'ReducaoAliquotaDomain', vCBS: M },
  ReducaoAliquotaDomain: { pRedAliq: P, pAliqEfet: P },
  DiferimentoDomain: { pDif: P, vDif: M },
  TributacaoRegularDomain: {
    CSTReg: tcst, cClassTribReg: tcClassTrib, pAliqEfetRegIBSUF: P, vTribRegIBSUF: M, pAliqEfetRegIBSMun: P, vTribRegIBSMun: M,
    pAliqEfetRegCBS: P, vTribRegCBS: M,
  },
  TributacaoCompraGovernamentalDomain: { pAliqIBSUF: P, vTribIBSUF: M, pAliqIBSMun: P, vTribIBSMun: M, pAliqCBS: P, vTribCBS: M },
  MemoriaCalculoDomain: { cbs: texto, ibsUF: texto, ibsMun: texto },
  MonofasiaDomain: {
    gMonoPadrao: 'MonofasiaPadraoDomain', gMonoReten: 'MonofasiaRetencaoDomain', gMonoRet: 'MonofasiaRetidoAnteriormenteDomain',
    gMonoDif: 'MonofasiaDiferimentoDomain', vTotIBSMonoItem: M, vTotCBSMonoItem: M,
  },
  MonofasiaPadraoDomain: { qBCMono: Q, adRemIBS: P, adRemCBS: P, vIBSMono: M, vCBSMono: M },
  MonofasiaRetencaoDomain: { qBCMonoReten: Q, adRemIBSReten: P, vIBSMonoReten: M, adRemCBSReten: P, vCBSMonoReten: M },
  MonofasiaRetidoAnteriormenteDomain: { qBCMonoRet: Q, adRemIBSRet: P, vIBSMonoRet: M, adRemCBSRet: P, vCBSMonoRet: M },
  MonofasiaDiferimentoDomain: { pDifIBS: P, vIBSMonoDif: M, pDifCBS: P, vCBSMonoDif: M },
  CreditoPresumidoOperacaoDomain: { vBCCredPres: M, cCredPres: inteiro, gIBSCredPres: 'IBSCBSCreditoPresumidoDomain', gCBSCredPres: 'IBSCBSCreditoPresumidoDomain' },
  IBSCBSCreditoPresumidoDomain: { pCredPres: P, vCredPres: M, vCredPresCondSus: M },
};

/** Serializes one domain object of class `classe` (Jackson order, NON_NULL). */
export function serializar(classe, objeto) {
  const esquema = ESQUEMA[classe];
  const saida = {};
  for (const nome of ORDEM[classe]) {
    const valor = objeto[nome];
    if (valor == null) continue;
    const s = esquema[nome];
    if (s === null) {
      // groups the engine never builds (devolução, transferência, ajuste, estorno, ZFM): fail closed
      throw new ErroSerializacao(`Grupo ${classe}.${nome} não suportado pelo porte`, 'IllegalStateException');
    }
    saida[nome] = typeof s === 'string' ? serializar(s, valor) : s(valor);
  }
  return saida;
}

/** tribCalc ready for the JSON writer (comum/json.js escreverJson): ordered keys, string values. */
export const serializarTributos = (tributos) => serializar('TributosDomain', tributos);
