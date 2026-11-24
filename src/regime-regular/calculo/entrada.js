// Request model of the calculation endpoints (api/model/input/*): Jackson 3 binding of
// OperacaoInput from the JSON tree of comum/json.js, plus the small behaviour the Java input
// classes carry (OperacaoInput.getFatoGeradorAplicavel/getTpEnteGov, ItemOperacaoInput.ajustarNcm,
// ComponentesBaseCalculoInput.possuiComponentes, ImpostoSeletivoInput.getValorImpostoSeletivoInformado).
//
// Bound objects keep the Java field names; BigDecimal → Dec (value AND scale of the JSON lexeme),
// Integer → number, Long → number (BigInt beyond 2^53), OffsetDateTime → its validated text,
// enums with @JsonValue Integer → the code (number). Every known field is present (null when absent).
import { Dec } from '../../core/decimal.js';
import {
  lerCorpoRequisicao, comoObjeto, comoLista, comoString, comoInteger, comoLong, comoBigDecimal, comoEnumValor, comoDataHora,
} from '../comum/json.js';
import { dataFatoGeradorNaoInformada } from './excecoes.js';

export const PKG = 'br.gov.serpro.rtc.api.model.input';
export const TIPO_OPERACAO = `${PKG}.OperacaoInput`;
export const TIPO_ITENS = `java.util.ArrayList<${PKG}.ItemOperacaoInput>`;

/** TipoEnteGovernamental (@JsonValue getCodigo): 1 União … 6 Comitê Gestor do IBS. */
export const TIPOS_ENTE = Object.freeze([
  { codigo: 1, nome: 'UNIAO', descricao: 'União', equivalente: 'UNIAO' },
  { codigo: 2, nome: 'ESTADO', descricao: 'Estado', equivalente: 'ESTADO' },
  { codigo: 3, nome: 'DISTRITO_FEDERAL', descricao: 'Distrito Federal', equivalente: 'ESTADO' },
  { codigo: 4, nome: 'MUNICIPIO', descricao: 'Município', equivalente: 'MUNICIPIO' },
  { codigo: 5, nome: 'CONSORCIO_PUBLICO', descricao: 'Consórcio Público', equivalente: 'MUNICIPIO' },
  { codigo: 6, nome: 'COMITE_GESTOR_IBS', descricao: 'Comitê Gestor do IBS', equivalente: 'MUNICIPIO' },
]);
const ENTE = new Map(TIPOS_ENTE.map((t) => [String(t.codigo), t.codigo]));
/** TipoOperacaoGovernamental (@JsonValue Integer 1..5). */
const OPER = new Map(['1', '2', '3', '4', '5'].map((x) => [x, Number(x)]));

const s = (no) => comoString(no);
const bd = (no) => comoBigDecimal(no);

/** The 15 fields of ComponentesBaseCalculoInput in declaration order. */
export const CAMPOS_COMPONENTES = ['vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIS', 'vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vICMSUFDest', 'vFCP', 'vFCPUFDest', 'vICMSMono', 'vISSQN'];

const compraGov = (no) => comoObjeto(no, `${PKG}.CompraGovernamentalInput`, {
  tpEnteGov: (v) => comoEnumValor(v, { tipoJava: `${PKG}.calculadora.enumeration.TipoEnteGovernamental`, valores: ENTE }),
  tpOperGov: (v) => comoEnumValor(v, { tipoJava: `${PKG}.calculadora.enumeration.TipoOperacaoGovernamental`, valores: OPER }),
});
const tributacaoRegular = (no) => comoObjeto(no, `${PKG}.TributacaoRegularInput`, { cst: s, cClassTrib: s });
const impostoSeletivo = (no) => comoObjeto(no, `${PKG}.ImpostoSeletivoInput`, {
  cst: s, cClassTrib: s, baseCalculo: bd, quantidade: bd, unidade: s, impostoInformado: bd,
});
const componentes = (no) => comoObjeto(no, `${PKG}.basecalculo.ComponentesBaseCalculoInput`, Object.fromEntries(CAMPOS_COMPONENTES.map((k) => [k, bd])));
const aliquotasIS = (no) => comoObjeto(no, `${PKG}.AliquotasNominaisImpostoSeletivo`, { adValorem: bd, adRem: bd });
const aliquotasNominais = (no) => comoObjeto(no, `${PKG}.AliquotasNominaisInput`, {
  cbs: bd, ibsEstadual: bd, ibsMunicipal: bd, impostoSeletivo: aliquotasIS,
});

/** ItemOperacaoInput (field order = Java declaration order). */
export const vincularItem = (no) => comoObjeto(no, `${PKG}.ItemOperacaoInput`, {
  numero: comoInteger, ncm: s, nbs: s, cst: s, cClassTrib: s, baseCalculo: bd, quantidade: bd, unidade: s,
  impostoSeletivo, tributacaoRegular, gComponentesBC: componentes, aliquotasNominais,
});

/** OperacaoInput (FAIL_ON_UNKNOWN_PROPERTIES=false; duplicates: the last wins). */
export const vincularOperacao = (no) => comoObjeto(no, TIPO_OPERACAO, {
  id: s, versao: s, dhFatoGerador: comoDataHora, dataHoraEmissao: comoDataHora, municipio: comoLong, uf: s, tpDoc: comoInteger,
  gCompraGov: compraGov, itens: (v) => comoLista(v, TIPO_ITENS, vincularItem),
});

/** Method.toGenericString() of the two controller methods (text of "Required request body is missing"). */
export const ASSINATURA_REGIME_GERAL = 'public org.springframework.http.ResponseEntity<br.gov.serpro.rtc.api.model.roc.ROCDomain> br.gov.serpro.rtc.api.controller.CalculadoraTributoController.calcularTributos(br.gov.serpro.rtc.api.model.input.OperacaoInput)';
export const ASSINATURA_OBSERVABILIDADE = 'public org.springframework.http.ResponseEntity<br.gov.serpro.rtc.api.model.roc.ObservabilidadeROCDomain> br.gov.serpro.rtc.api.controller.ObservabilidadeController.calcularTributosObservabilidade(br.gov.serpro.rtc.api.model.input.OperacaoInput)';

/** @RequestBody OperacaoInput: raw bytes → bound operation (HttpMessageNotReadableException on failure). */
export function lerOperacao(bytes, { charset, assinatura }) {
  return lerCorpoRequisicao(bytes, { charset, assinatura, tipoJava: TIPO_OPERACAO, vincular: vincularOperacao });
}

/** OperacaoInput.getFatoGeradorAplicavel(): local date of the offset date-time as written ('YYYY-MM-DD'). */
export function fatoGeradorAplicavel(operacao) {
  if (operacao.dhFatoGerador != null) return operacao.dhFatoGerador.slice(0, 10);
  if (operacao.dataHoraEmissao != null) return operacao.dataHoraEmissao.slice(0, 10);
  throw dataFatoGeradorNaoInformada();
}

/** LocalDate.getYear(). */
export const anoDe = (data) => Number(data.slice(0, 4));

/** OperacaoInput.getTpEnteGov(): the TipoEnteGovernamental code or null. */
export const tpEnteGovDe = (operacao) => (operacao.gCompraGov == null ? null : operacao.gCompraGov.tpEnteGov);

/** TipoEnteGovernamental.tipoEnteEquivalente() by code ('UNIAO' | 'ESTADO' | 'MUNICIPIO'). */
export const enteEquivalente = (codigo) => TIPOS_ENTE.find((t) => t.codigo === codigo)?.equivalente ?? null;

/** ComponentesBaseCalculoInput.possuiComponentes(): any of the 15 fields not null (zero counts). */
export const possuiComponentes = (c) => CAMPOS_COMPONENTES.some((k) => c[k] != null);

/** ElementoBaseCalculo constant → field of ComponentesBaseCalculoInput (getValor switch). */
export const CAMPO_DO_ELEMENTO = Object.freeze({
  V_PROD: 'vProd', V_FRETE: 'vFrete', V_SEG: 'vSeg', V_OUTRO: 'vOutro', V_II: 'vII', V_IS: 'vIS', V_DESC: 'vDesc', V_PIS: 'vPIS',
  V_COFINS: 'vCOFINS', V_ICMS: 'vICMS', V_ICMS_UF_DEST: 'vICMSUFDest', V_FCP: 'vFCP', V_FCP_UF_DEST: 'vFCPUFDest', V_ICMS_MONO: 'vICMSMono', V_ISSQN: 'vISSQN',
});

/** ComponentesBaseCalculoInput.getValor(ElementoBaseCalculo). */
export const valorComponente = (c, elemento) => c[CAMPO_DO_ELEMENTO[elemento]] ?? null;

/** ItemOperacaoInput.ajustarNcm(tipoDfe): NF-e/NFC-e accept NCM "00"/"00000000" as "no NCM" (exact match, no trim). */
export function ajustarNcm(item, tipoDfe) {
  if (tipoDfe != null && tipoDfe.permiteNcmZero && (item.ncm === '00' || item.ncm === '00000000')) item.ncm = null;
}

/** ImpostoSeletivoInput.getValorImpostoSeletivoInformado(). */
export const valorImpostoSeletivoInformado = (is) => (is.impostoInformado != null ? is.impostoInformado : Dec.ZERO);
