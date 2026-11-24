// ROCDomain as Jackson 3 binds it for POST /calculadora/xml/generate (api/model/roc/**).
// Every ROC class implements SerializationVisibility (fields only, names = Java field names, case
// sensitive). Classes with @Builder @Jacksonized are bound through their Lombok builder (error
// messages name `X$XBuilder`; @Builder.Default fields start at ZERO); the others through the
// default constructor (field initializers = ZERO). Absent property → default; explicit null → null.
// Unknown properties are ignored (fail-on-unknown-properties=false); duplicates: the last wins.
// Values: BigDecimal → Dec (exact lexeme and scale), Integer → number, String → string,
// enums → their code (number), boolean primitive → boolean.
import { Dec } from '../../core/decimal.js';
import { javaTrim } from '../comum/java.js';
import {
  JsonObj, ErroJson, comoString, comoInteger, comoBigDecimal, comoEnumValor, comoLista, erroForma,
  erroEscalarParaObjeto, ignorar, tokenDe,
} from '../comum/json.js';

const PACOTE = 'br.gov.serpro.rtc.api.model.roc';
const PACOTE_ENUM = 'br.gov.serpro.rtc.api.model.input.calculadora.enumeration';

/** Default value marker: BigDecimal.ZERO (scale 0). */
const ZERO = () => new Dec(0n, 0);

// Field kinds
const S = { tipo: 'string' };
const I = { tipo: 'integer' };
const BD = { tipo: 'bigdecimal' };
const BD0 = { tipo: 'bigdecimal', padrao: ZERO };
const BOOL = { tipo: 'boolean-primitivo' };
const classe = (nome) => ({ tipo: 'classe', nome });
const lista = (nome) => ({ tipo: 'lista', nome });
const enumeracao = (nome, codigos) => ({
  tipo: 'enum',
  tipoJava: `${PACOTE_ENUM}.${nome}`,
  valores: new Map(codigos.map((c) => [String(c), c])),
});

/**
 * ROC classes: builder (true = @Builder @Jacksonized) and fields in declaration order.
 * (Defaults: @Builder.Default fields and field initializers of the non-builder classes.)
 */
export const CLASSES_ROC = {
  ROCDomain: { builder: true, campos: { oper: classe('OperacaoConsumoDomain'), objetos: lista('ObjetoDomain'), total: classe('ValoresTotaisDomain') } },
  OperacaoConsumoDomain: { builder: true, campos: { gCompraGov: classe('CompraGovernamentalDomain') } },
  CompraGovernamentalDomain: {
    builder: false,
    campos: {
      tpEnteGov: enumeracao('TipoEnteGovernamental', [1, 2, 3, 4, 5, 6]),
      pRedutor: BD0,
      tpOperGov: enumeracao('TipoOperacaoGovernamental', [1, 2, 3, 4, 5]),
    },
  },
  ObjetoDomain: { builder: true, campos: { nObj: I, tribCalc: classe('TributosDomain'), calculoSimulado: BOOL } },
  TributosDomain: { builder: true, campos: { IS: classe('ImpostoSeletivoDomain'), IBSCBS: classe('IBSCBSDomain') } },
  ImpostoSeletivoDomain: {
    builder: true,
    campos: { CSTIS: S, cClassTribIS: S, vBCIS: BD, pIS: BD, pISEspec: BD, adRemIS: BD, uTrib: S, qTrib: BD, vIS: BD, memoriaCalculo: S },
  },
  IBSCBSDomain: {
    builder: true,
    campos: {
      CST: S, cClassTrib: S, indDoacao: I, gIBSCBS: classe('GrupoIBSCBSDomain'), gIBSCBSMono: classe('MonofasiaDomain'),
      gTransfCred: classe('TransferenciaCreditoDomain'), gAjusteCompet: classe('AjusteCompetenciaDomain'),
      gEstornoCred: classe('EstornoCreditoDomain'), gCredPresOper: classe('CreditoPresumidoOperacaoDomain'),
      gCredPresIBSZFM: classe('CreditoPresumidoIBSZFMDomain'), memoriaCalculo: classe('MemoriaCalculoDomain'),
    },
  },
  MemoriaCalculoDomain: { builder: true, campos: { cbs: S, ibsUF: S, ibsMun: S } },
  GrupoIBSCBSDomain: {
    builder: true,
    campos: {
      vBC: BD, gIBSUF: classe('IBSUFDomain'), gIBSMun: classe('IBSMunDomain'), vIBS: BD, gCBS: classe('CBSDomain'),
      gTribRegular: classe('TributacaoRegularDomain'), gTribCompraGov: classe('TributacaoCompraGovernamentalDomain'),
    },
  },
  IBSUFDomain: { builder: false, campos: { pIBSUF: BD0, gDif: classe('DiferimentoDomain'), gDevTrib: classe('DevolucaoTributosDomain'), gRed: classe('ReducaoAliquotaDomain'), vIBSUF: BD0 } },
  IBSMunDomain: { builder: false, campos: { pIBSMun: BD0, gDif: classe('DiferimentoDomain'), gDevTrib: classe('DevolucaoTributosDomain'), gRed: classe('ReducaoAliquotaDomain'), vIBSMun: BD0 } },
  CBSDomain: { builder: false, campos: { pCBS: BD0, gDif: classe('DiferimentoDomain'), gDevTrib: classe('DevolucaoTributosDomain'), gRed: classe('ReducaoAliquotaDomain'), vCBS: BD0 } },
  DiferimentoDomain: { builder: true, campos: { pDif: BD0, vDif: BD0 } },
  DevolucaoTributosDomain: { builder: true, campos: { pDevTrib: BD0, vDevTrib: BD0 } },
  ReducaoAliquotaDomain: { builder: true, campos: { pRedAliq: BD, pAliqEfet: BD } },
  TributacaoRegularDomain: {
    builder: true,
    campos: { CSTReg: S, cClassTribReg: S, pAliqEfetRegIBSUF: BD0, vTribRegIBSUF: BD0, pAliqEfetRegIBSMun: BD0, vTribRegIBSMun: BD0, pAliqEfetRegCBS: BD0, vTribRegCBS: BD0 },
  },
  TributacaoCompraGovernamentalDomain: {
    builder: true,
    campos: { pAliqIBSUF: BD0, vTribIBSUF: BD0, pAliqIBSMun: BD0, vTribIBSMun: BD0, pAliqCBS: BD0, vTribCBS: BD0 },
  },
  MonofasiaDomain: {
    builder: true,
    campos: {
      gMonoPadrao: classe('MonofasiaPadraoDomain'), gMonoReten: classe('MonofasiaRetencaoDomain'),
      gMonoRet: classe('MonofasiaRetidoAnteriormenteDomain'), gMonoDif: classe('MonofasiaDiferimentoDomain'),
      vTotIBSMonoItem: BD0, vTotCBSMonoItem: BD0,
    },
  },
  MonofasiaPadraoDomain: { builder: true, campos: { qBCMono: BD0, adRemIBS: BD0, adRemCBS: BD0, vIBSMono: BD0, vCBSMono: BD0 } },
  MonofasiaRetencaoDomain: { builder: true, campos: { qBCMonoReten: BD0, adRemIBSReten: BD0, vIBSMonoReten: BD0, adRemCBSReten: BD0, vCBSMonoReten: BD0 } },
  MonofasiaRetidoAnteriormenteDomain: { builder: true, campos: { qBCMonoRet: BD0, adRemIBSRet: BD0, vIBSMonoRet: BD0, adRemCBSRet: BD0, vCBSMonoRet: BD0 } },
  MonofasiaDiferimentoDomain: { builder: true, campos: { pDifIBS: BD0, vIBSMonoDif: BD0, pDifCBS: BD0, vCBSMonoDif: BD0 } },
  TransferenciaCreditoDomain: { builder: true, campos: { vIBS: BD0, vCBS: BD0 } },
  AjusteCompetenciaDomain: { builder: false, campos: { competApur: S, vIBS: BD, vCBS: BD } },
  EstornoCreditoDomain: { builder: false, campos: { vIBSEstCred: BD, vCBSEstCred: BD } },
  CreditoPresumidoOperacaoDomain: {
    builder: false,
    campos: { vBCCredPres: BD, cCredPres: I, gIBSCredPres: classe('IBSCBSCreditoPresumidoDomain'), gCBSCredPres: classe('IBSCBSCreditoPresumidoDomain') },
  },
  IBSCBSCreditoPresumidoDomain: { builder: false, campos: { pCredPres: BD, vCredPres: BD, vCredPresCondSus: BD } },
  CreditoPresumidoIBSZFMDomain: { builder: true, campos: { competApur: S, tpCredPresIBSZFM: I, vCredPresIBSZFM: BD0 } },
  ValoresTotaisDomain: { builder: false, campos: { tribCalc: classe('TributosTotaisDomain') } },
  TributosTotaisDomain: { builder: false, campos: { ISTot: classe('ImpostoSeletivoTotalDomain'), IBSCBSTot: classe('IBSCBSTotalDomain') } },
  ImpostoSeletivoTotalDomain: { builder: false, campos: { vIS: BD0 } },
  IBSCBSTotalDomain: {
    builder: false,
    campos: { vBCIBSCBS: BD, gIBS: classe('IBSTotalDomain'), gCBS: classe('CBSTotalDomain'), gMono: classe('MonofasiaTotalDomain'), gEstornoCred: classe('EstornoCreditoDomain') },
  },
  IBSTotalDomain: { builder: false, campos: { gIBSUF: classe('IBSUFTotalDomain'), gIBSMun: classe('IBSMunTotalDomain'), vIBS: BD, vCredPres: BD, vCredPresCondSus: BD } },
  IBSUFTotalDomain: { builder: false, campos: { vDif: BD0, vDevTrib: BD0, vIBSUF: BD0 } },
  IBSMunTotalDomain: { builder: false, campos: { vDif: BD0, vDevTrib: BD0, vIBSMun: BD0 } },
  CBSTotalDomain: { builder: false, campos: { vDif: BD0, vDevTrib: BD0, vCBS: BD0, vCredPres: BD0, vCredPresCondSus: BD0 } },
  MonofasiaTotalDomain: { builder: false, campos: { vIBSMono: BD0, vCBSMono: BD0, vIBSMonoReten: BD0, vCBSMonoReten: BD0, vIBSMonoRet: BD0, vCBSMonoRet: BD0 } },
};

/** Class name Jackson reports for a POJO target (the builder for @Jacksonized classes). */
export function nomeJava(nome) {
  return CLASSES_ROC[nome].builder ? `${PACOTE}.${nome}$${nome}Builder` : `${PACOTE}.${nome}`;
}

const TEXTO_NULO = (t) => t === 'null';

/**
 * Primitive boolean (ObjetoDomain.calculoSimulado): StdDeserializer._parseBooleanPrimitive with
 * Jackson 3 defaults (FAIL_ON_NULL_FOR_PRIMITIVES on, int → boolean accepted).
 */
function comoBooleanPrimitivo(no) {
  if (no === true || no === false) return no;
  if (no === null) throw new ErroJson('Cannot map `null` into type `boolean` (set `DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES` to \'false\' to allow)');
  const token = tokenDe(no);
  if (token === 'VALUE_NUMBER_INT') return BigInt(no.src) !== 0n;
  if (token === 'VALUE_STRING') {
    if (no === '') throw new ErroJson('Cannot coerce `null` to `boolean` value (disable `DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES` to allow)');
    const t = javaTrim(no);
    if (t.length === 4 && (t === 'true' || t === 'True' || t === 'TRUE')) return true;
    if (t.length === 5 && (t === 'false' || t === 'False' || t === 'FALSE')) return false;
    if (TEXTO_NULO(t)) throw new ErroJson(`Cannot coerce String "${t}" to Null value as \`boolean\` value (disable \`DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES\` to allow)`);
    throw new ErroJson(`Cannot deserialize value of type \`boolean\` from String "${t}": only "true"/"True"/"TRUE" or "false"/"False"/"FALSE" recognized`);
  }
  throw erroForma('boolean', no);
}

function vincularCampo(def, no) {
  switch (def.tipo) {
    case 'string': return comoString(no);
    case 'integer': return comoInteger(no);
    case 'bigdecimal': return comoBigDecimal(no);
    case 'boolean-primitivo': return comoBooleanPrimitivo(no);
    case 'enum': return comoEnumValor(no, def);
    case 'classe': return vincularClasse(def.nome, no);
    case 'lista': return comoLista(no, `java.util.ArrayList<${PACOTE}.${def.nome}>`, (v) => vincularClasse(def.nome, v));
    default: throw new Error(`tipo de campo desconhecido: ${def.tipo}`);
  }
}

/**
 * Binds one ROC class (BeanDeserializer / BuilderBasedDeserializer): entries in document order,
 * unknown keys skipped (only their pending syntax error matters), defaults for absent fields.
 */
export function vincularClasse(nome, no) {
  if (no === null) return null;
  const def = CLASSES_ROC[nome];
  if (!(no instanceof JsonObj)) throw erroEscalarParaObjeto(nomeJava(nome), no);
  const r = {};
  for (const [campo, d] of Object.entries(def.campos)) r[campo] = d.padrao ? d.padrao() : d.tipo === 'boolean-primitivo' ? false : null;
  for (const [k, v] of no.entradas) {
    if (Object.hasOwn(def.campos, k)) r[k] = vincularCampo(def.campos[k], v);
    else ignorar(v);
  }
  if (no.erroPendente) throw no.erroPendente;
  return r;
}

/** Spring @RequestBody ROCDomain: method signature used in "Required request body is missing". */
export const ASSINATURA_GENERATE = 'public org.springframework.http.ResponseEntity<java.lang.String> br.gov.serpro.rtc.api.controller.XMLController.generate(br.gov.serpro.rtc.api.model.roc.ROCDomain,br.gov.serpro.rtc.api.model.xml.enumeration.TipoDocumento)';
export const TIPO_JAVA_ROC = `${PACOTE}.ROCDomain`;
export const vincularRoc = (raiz) => vincularClasse('ROCDomain', raiz);
