// Request bodies of the slice: Jackson 3.1.7 binding (field visibility, unknown keys ignored,
// defaults kept when a key is absent, explicit null/"" overriding them) and the enums with their
// own creators. Built on the binders of comum/json.js; the few Jackson behaviours not covered
// there (primitive int of a delegating @JsonCreator, Enum by @JsonProperty/ordinal, the String
// creator of BaseCalculoNatureza, @JsonUnwrapped) are ported here.
import { Dec } from '../../core/decimal.js';
import {
  JsonObj, JsonNum, ErroJson, erroForma, erroStringEstranha, erroEscalarParaObjeto, textoDoToken,
  comoString, comoInteger, comoLong, comoBigDecimal, comoLista, comoData, comoDataHora, parseInteiroJava,
} from '../comum/json.js';
import { javaTrim, javaIsBlank } from '../comum/java.js';

const PKG = 'br.gov.serpro.rtc.api.model.input';
export const TIPOS = {
  CIBS: `${PKG}.basecalculo.BaseCalculoCibsInput`,
  IS: `${PKG}.basecalculo.BaseCalculoISMercadoriasInput`,
  UNIFICADA: `${PKG}.basecalculo.BaseCalculoUnificadaInput`,
  COMPONENTES: `${PKG}.basecalculo.ComponentesBaseCalculoInput`,
  UNIFICADA_NFSE: `${PKG}.basecalculo.BaseCalculoUnificadaNfseInput`,
  DOCUMENTO: `${PKG}.basecalculo.DocumentoAjusteNfseInput`,
  LOCACAO: `${PKG}.basecalculo.LocacaoNfseInput`,
  NFSE_BASE: `${PKG}.nfse.NfseBaseCalculoInput`,
  NFSE_VALIDACAO: `${PKG}.nfse.NfseValidacaoIndicadorOperacaoInput`,
  PEDAGIO: `${PKG}.pedagio.PedagioInput`,
  TRECHO: `${PKG}.pedagio.TrechoPedagioInput`,
  OPCAO_SN: `${PKG}.basecalculo.enumeration.OpcaoSimplesNacional`,
  REGIME_SN: `${PKG}.basecalculo.enumeration.RegimeApuracaoIbsCbsSN`,
  SITUACAO: `${PKG}.basecalculo.enumeration.SituacaoOperacaoNfse`,
  NATUREZA: `${PKG}.basecalculo.enumeration.BaseCalculoNatureza`,
};

// ─── Scalars ────────────────────────────────────────────────────────────────

/**
 * Exponent guard (documented divergence): BigDecimal values whose scale is beyond ±100000 are
 * refused at reading. The Java API accepts any int exponent and then materializes 10^|scale|
 * in the first add/setScale (1e999999999 exhausts CPU/heap); the port answers 400 instead.
 */
export const LIMITE_ESCALA = 100000;

/** BigDecimal field (comoBigDecimal) + the exponent guard. */
export function comoDecimal(no) {
  const d = comoBigDecimal(no);
  if (d !== null && Math.abs(d.scale()) > LIMITE_ESCALA) {
    throw new ErroJson(`Value "${textoDoToken(no)}" cannot be deserialized as \`java.math.BigDecimal\`, reason:  value exceeds limits`);
  }
  return d;
}

const INT_MIN = -2147483648n;
const INT_MAX = 2147483647n;
const foraDeInt = (src) => new ErroJson(`Numeric value (${src}) out of range of \`int\` (-2147483648 - 2147483647)`);
const nuloParaInt = () => new ErroJson('Cannot coerce `null` to `int` value (disable `DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES` to allow)');

/** Primitive `int` (StdDeserializer._parseIntPrimitive): argument of the int @JsonCreator of the code enums. */
export function comoIntPrimitivo(no) {
  if (no instanceof JsonNum) {
    if (no.inteiro) {
      const v = BigInt(no.src);
      if (v < INT_MIN || v > INT_MAX) throw foraDeInt(no.src);
      return Number(v);
    }
    const d = Number(no.src);
    if (!(d >= -2147483648 && d <= 2147483647)) throw foraDeInt(no.src);
    return Math.trunc(d) + 0;
  }
  if (typeof no === 'string') {
    // Jackson's _isBlank: every char <= U+0020 (empty and blank coerce to null, refused for int)
    const t = javaTrim(no);
    if (t === '') throw nuloParaInt();
    if (t === 'null') throw new ErroJson('Cannot coerce String "null" to Null value as `int` value (disable `DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES` to allow)');
    if (t.length > 9) {
      const l = parseInteiroJava(t, -9223372036854775808n, 9223372036854775807n);
      if (l === null) throw erroStringEstranha('int', t, 'not a valid `int` value');
      if (l < INT_MIN || l > INT_MAX) throw erroStringEstranha('int', t, `Overflow: numeric value (${t}) out of range of int (-2147483648 -2147483647)`);
      return Number(l);
    }
    const v = parseInteiroJava(t, INT_MIN, INT_MAX);
    if (v === null) throw erroStringEstranha('int', t, 'not a valid `int` value');
    return Number(v);
  }
  throw erroForma('int', no);
}

// ─── Enums ──────────────────────────────────────────────────────────────────

/** OpcaoSimplesNacional (código, descrição) with its predicates. */
export const OpcaoSimplesNacional = Object.freeze({
  NAO_OPTANTE: { nome: 'NAO_OPTANTE', codigo: 1, descricao: 'Não Optante' },
  MEI: { nome: 'MEI', codigo: 2, descricao: 'MEI' },
  OPTANTE_ME_EPP: { nome: 'OPTANTE_ME_EPP', codigo: 3, descricao: 'Optante ME/EPP' },
  OPTANTE_PENDENTE: { nome: 'OPTANTE_PENDENTE', codigo: 4, descricao: 'Optante Pendente' },
});
const OPCOES_SN = Object.values(OpcaoSimplesNacional);
export const opcaoSN = {
  isOptante: (o) => o === OpcaoSimplesNacional.OPTANTE_ME_EPP || o === OpcaoSimplesNacional.OPTANTE_PENDENTE,
  isMei: (o) => o === OpcaoSimplesNacional.MEI,
  exigeRegimeApuracao: (o) => opcaoSN.isOptante(o),
  proibeRegimeApuracao: (o) => o === OpcaoSimplesNacional.NAO_OPTANTE,
  isPendente: (o) => o === OpcaoSimplesNacional.OPTANTE_PENDENTE,
  vedaLocacao: (o) => o === OpcaoSimplesNacional.MEI || o === OpcaoSimplesNacional.OPTANTE_ME_EPP,
  baseSNInaplicavel: (o) => o === OpcaoSimplesNacional.NAO_OPTANTE || o === OpcaoSimplesNacional.MEI,
};

export const RegimeApuracaoIbsCbsSN = Object.freeze({
  IBS_CBS_PELO_SN: { nome: 'IBS_CBS_PELO_SN', codigo: 1, descricao: 'IBS+CBS pelo SN' },
  CBS_PELO_SN_IBS_REGULAR: { nome: 'CBS_PELO_SN_IBS_REGULAR', codigo: 2, descricao: 'CBS pelo SN + IBS regular' },
  AMBOS_REGULARES: { nome: 'AMBOS_REGULARES', codigo: 3, descricao: 'Ambos regulares' },
});
const REGIMES_SN = Object.values(RegimeApuracaoIbsCbsSN);
export const isCalculaBaseSN = (r) => r !== RegimeApuracaoIbsCbsSN.AMBOS_REGULARES;

/** @JsonCreator fromCodigo(int): IllegalArgumentException inside the creator → ValueInstantiationException. */
function porCodigo(no, valores, tipoJava, nomeEnum) {
  if (no === null) return null;
  const codigo = comoIntPrimitivo(no);
  const v = valores.find((x) => x.codigo === codigo);
  if (!v) throw new ErroJson(`Cannot construct instance of \`${tipoJava}\`, problem: Código inválido para ${nomeEnum}: ${codigo}`);
  return v;
}
export const comoOpcaoSimplesNacional = (no) => porCodigo(no, OPCOES_SN, TIPOS.OPCAO_SN, 'OpcaoSimplesNacional');
export const comoRegimeApuracao = (no) => porCodigo(no, REGIMES_SN, TIPOS.REGIME_SN, 'RegimeApuracaoIbsCbsSN');

/** SituacaoOperacaoNfse: plain enum, @JsonProperty names, ordinals accepted (FAIL_ON_NUMBERS_FOR_ENUMS off). */
export const SituacaoOperacaoNfse = Object.freeze({
  COMUM: { nome: 'COMUM', json: 'comum', ordinal: 0 },
  SALAO_PARCEIRO: { nome: 'SALAO_PARCEIRO', json: 'salaoParceiro', ordinal: 1 },
  LOCACAO_9903: { nome: 'LOCACAO_9903', json: 'locacao9903', ordinal: 2 },
});
const SITUACOES = Object.values(SituacaoOperacaoNfse);
export const situacaoNfse = {
  isLocacao: (s) => s === SituacaoOperacaoNfse.LOCACAO_9903,
  isSalaoParceiro: (s) => s === SituacaoOperacaoNfse.SALAO_PARCEIRO,
  ignoraDocumentos: (s) => s === SituacaoOperacaoNfse.LOCACAO_9903,
};

/** EnumDeserializer (Jackson 3): name lookup, trimmed retry, quoted index, index range check. */
export function comoSituacaoOperacao(no) {
  if (no === null) return null;
  const tipo = TIPOS.SITUACAO;
  if (no instanceof JsonNum) {
    if (!no.inteiro) throw erroForma(tipo, no);
    const v = BigInt(no.src);
    if (v < INT_MIN || v > INT_MAX) throw foraDeInt(no.src);
    const i = Number(v);
    if (i >= 0 && i < SITUACOES.length) return SITUACOES[i];
    throw new ErroJson(`Cannot deserialize value of type \`${tipo}\` from number ${i}: index value outside legal index range [0..${SITUACOES.length - 1}]`);
  }
  if (typeof no !== 'string') throw erroForma(tipo, no);
  const exato = SITUACOES.find((s) => s.json === no);
  if (exato) return exato;
  const nome = javaTrim(no);
  const aparado = SITUACOES.find((s) => s.json === nome);
  if (aparado) return aparado;
  if (nome === '') {
    throw new ErroJson(`Cannot coerce empty String ("") to \`${tipo}\` value (but could if coercion was enabled using \`CoercionConfig\`)`);
  }
  const c = nome.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39 && !(c === 0x30 && nome.length > 1)) {
    const idx = parseInteiroJava(nome, INT_MIN, INT_MAX);
    if (idx !== null && idx >= 0n && idx < BigInt(SITUACOES.length)) return SITUACOES[Number(idx)];
  }
  throw erroStringEstranha(tipo, nome, `not one of the values accepted for Enum class: [comum, locacao9903, salaoParceiro]`);
}

/** BaseCalculoNatureza (BEM, SERVICO). */
export const BaseCalculoNatureza = Object.freeze({ BEM: 'BEM', SERVICO: 'SERVICO' });

/** BaseCalculoNatureza.fromString: upper case, accents of the list removed, ' ' → '_', valueOf or null. */
export function naturezaDeTexto(valor) {
  if (valor == null || javaIsBlank(valor)) return null;
  const normal = valor.toUpperCase()
    .replaceAll('Á', 'A').replaceAll('À', 'A').replaceAll('Ã', 'A').replaceAll('Ç', 'C').replaceAll('É', 'E').replaceAll('Ê', 'E')
    .replaceAll('Í', 'I').replaceAll('Ó', 'O').replaceAll('Ô', 'O').replaceAll('Õ', 'O').replaceAll('Ú', 'U').replaceAll(' ', '_');
  return Object.hasOwn(BaseCalculoNatureza, normal) ? BaseCalculoNatureza[normal] : null;
}

/** Delegating String @JsonCreator: any scalar token → its text; object/array → Jackson errors. */
export function comoNatureza(no) {
  if (no === null) return null;
  if (no instanceof JsonObj) throw erroForma(TIPOS.NATUREZA, no);
  if (typeof no === 'object' && !(no instanceof JsonNum)) {
    throw new ErroJson(`Input mismatch reading Enum \`${TIPOS.NATUREZA}\`: properties-based \`@JsonCreator\` ([method ${TIPOS.NATUREZA}#fromString(java.lang.String)]) expects String Value, got Array value (\`JsonToken.START_ARRAY\`)`);
  }
  return naturezaDeTexto(textoDoToken(no));
}

// ─── Beans ──────────────────────────────────────────────────────────────────

/**
 * BeanDeserializer over a JsonObj: starts from the Java defaults, binds the entries in document
 * order (duplicates in turn, unknown keys skipped) and finally rethrows a pending syntax error.
 */
export function comoBean(no, tipoJava, campos, padroes = {}) {
  if (no === null) return null;
  if (!(no instanceof JsonObj)) throw erroEscalarParaObjeto(tipoJava, no);
  const r = {};
  for (const k of Object.keys(campos)) r[k] = Object.hasOwn(padroes, k) ? padroes[k] : null;
  for (const [k, v] of no.entradas) if (Object.hasOwn(campos, k)) r[k] = campos[k](v, k);
  if (no.erroPendente) throw no.erroPendente;
  return r;
}

const ZERO = () => Dec.ZERO;
const zeros = (nomes) => Object.fromEntries(nomes.map((n) => [n, ZERO()]));

const CAMPOS_CIBS = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'frete', 'impostoSeletivo', 'outrosTributos', 'demaisImportancias',
  'icms', 'iss', 'pis', 'pisImportacao', 'cofins', 'cofinsImportacao', 'cosip', 'ipi', 'descontoIncondicional'];
const CAMPOS_IS = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'freteCobrado', 'outrosTributos', 'demaisImportancias',
  'icms', 'iss', 'cosip', 'ipi', 'descontoIncondicional', 'bonificacao', 'devolucaoVendas'];
const CAMPOS_NFSE = ['descontoIncondicional', 'vCalcReeRepRes', 'vCalcDedRedIBSCBS', 'iss', 'pis', 'cofins'];

const decimais = (nomes) => Object.fromEntries(nomes.map((n) => [n, comoDecimal]));

/** BaseCalculoCibsInput (E1). */
export const lerCibs = (no) => comoBean(no, TIPOS.CIBS, { anoFatoGerador: comoInteger, ...decimais(CAMPOS_CIBS) }, zeros(CAMPOS_CIBS));

/** BaseCalculoISMercadoriasInput (E2). */
export const lerIS = (no) => comoBean(no, TIPOS.IS, { anoFatoGerador: comoInteger, ...decimais(CAMPOS_IS) }, zeros(CAMPOS_IS));

/** NfseBaseCalculoInput (E5). */
export const lerNfseBaseCalculo = (no) => comoBean(no, TIPOS.NFSE_BASE, { anoFatoGerador: comoInteger, valorServico: comoDecimal, ...decimais(CAMPOS_NFSE) }, zeros(CAMPOS_NFSE));

/** The 15 fields of ComponentesBaseCalculoInput (declaration order). */
export const CAMPOS_COMPONENTES = ['vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIS', 'vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vICMSUFDest', 'vFCP', 'vFCPUFDest', 'vICMSMono', 'vISSQN'];

/**
 * BaseCalculoUnificadaInput (E3) with @JsonUnwrapped componentes: anoFatoGerador, tipoDocumento
 * and natureza are bound while streaming; every other entry is buffered and, after the whole
 * object was read (a pending syntax error wins first), bound as ComponentesBaseCalculoInput.
 */
export function lerUnificada(no) {
  if (no === null) return null;
  if (!(no instanceof JsonObj)) throw erroEscalarParaObjeto(TIPOS.UNIFICADA, no);
  const principais = { anoFatoGerador: comoInteger, tipoDocumento: comoInteger, natureza: comoNatureza };
  const r = { anoFatoGerador: null, tipoDocumento: null, natureza: null };
  const buffer = new JsonObj();
  for (const [k, v] of no.entradas) {
    if (Object.hasOwn(principais, k)) r[k] = principais[k](v, k);
    else buffer.entradas.push([k, v]);
  }
  if (no.erroPendente) throw no.erroPendente;
  r.componentes = comoBean(buffer, TIPOS.COMPONENTES, decimais(CAMPOS_COMPONENTES));
  return r;
}

/** BaseCalculoUnificadaNfseInput (E4). */
export function lerUnificadaNfse(no) {
  const documento = (d) => comoBean(d, TIPOS.DOCUMENTO, { tpAjusteBC: comoString, vAjusteAplic: comoDecimal, xTpAjusteBC: comoString });
  const locacao = (l) => comoBean(l, TIPOS.LOCACAO, { pCopropriedade: comoDecimal, vTotOper: comoDecimal, vDescIncondTot: comoDecimal, somaAjustesLocImoveis: comoDecimal });
  return comoBean(no, TIPOS.UNIFICADA_NFSE, {
    anoFatoGerador: comoInteger,
    opSimpNac: comoOpcaoSimplesNacional,
    situacao: comoSituacaoOperacao,
    vServ: comoDecimal,
    vDescIncond: comoDecimal,
    vISSQN: comoDecimal,
    vPIS: comoDecimal,
    vCOFINS: comoDecimal,
    regApIBSCBSSN: comoRegimeApuracao,
    documentos: (v) => comoLista(v, `java.util.ArrayList<${TIPOS.DOCUMENTO}>`, documento),
    locacao,
  });
}

/** NfseValidacaoIndicadorOperacaoInput (E6). */
export const lerValidacaoIndicador = (no) => comoBean(no, TIPOS.NFSE_VALIDACAO, {
  cTribNac: comoString, cIndOp: comoString, cClassTrib: comoString, nbs: comoString, dataOcorrenciaFatoGerador: comoData,
});

/** PedagioInput (E12). */
export function lerPedagio(no) {
  const trecho = (t) => comoBean(t, TIPOS.TRECHO, { numero: comoInteger, municipio: comoLong, uf: comoString, extensao: comoDecimal });
  return comoBean(no, TIPOS.PEDAGIO, {
    dataHoraEmissao: comoDataHora,
    codigoMunicipioOrigem: comoLong,
    ufMunicipioOrigem: comoString,
    cst: comoString,
    cClassTrib: comoString,
    baseCalculo: comoDecimal,
    trechos: (v) => comoLista(v, `java.util.ArrayList<${TIPOS.TRECHO}>`, trecho),
  });
}
