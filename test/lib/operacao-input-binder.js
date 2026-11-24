// Test-only replica of the Jackson binding of OperacaoInput (api-model.md §3) built with the
// foundation's binders: used to check the JSON reader/binders against messages captured from the
// official API. The real binder belongs to the calculation slice.
import { lerCorpoRequisicao, comoObjeto, comoLista, comoString, comoInteger, comoLong, comoBigDecimal, comoEnumValor, comoDataHora } from '../../src/regime-regular/comum/json.js';

const PKG = 'br.gov.serpro.rtc.api.model.input';
const ENTE = new Map(['1', '2', '3', '4', '5', '6'].map((x) => [x, Number(x)]));
const OPER = new Map(['1', '2', '3', '4', '5'].map((x) => [x, Number(x)]));
const s = (no) => comoString(no);
const bd = (no) => comoBigDecimal(no);

const compraGov = (no) => comoObjeto(no, `${PKG}.CompraGovernamentalInput`, {
  tpEnteGov: (v) => comoEnumValor(v, { tipoJava: `${PKG}.calculadora.enumeration.TipoEnteGovernamental`, valores: ENTE }),
  tpOperGov: (v) => comoEnumValor(v, { tipoJava: `${PKG}.calculadora.enumeration.TipoOperacaoGovernamental`, valores: OPER }),
});
const tribRegular = (no) => comoObjeto(no, `${PKG}.TributacaoRegularInput`, { cst: s, cClassTrib: s });
const impostoSeletivo = (no) => comoObjeto(no, `${PKG}.ImpostoSeletivoInput`, { cst: s, cClassTrib: s, baseCalculo: bd, quantidade: bd, unidade: s, impostoInformado: bd });
const componentes = (no) => comoObjeto(no, `${PKG}.basecalculo.ComponentesBaseCalculoInput`, Object.fromEntries(
  ['vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIS', 'vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vICMSUFDest', 'vFCP', 'vFCPUFDest', 'vICMSMono', 'vISSQN'].map((k) => [k, bd])));
const aliqIS = (no) => comoObjeto(no, `${PKG}.AliquotasNominaisImpostoSeletivo`, { adValorem: bd, adRem: bd });
const aliquotas = (no) => comoObjeto(no, `${PKG}.AliquotasNominaisInput`, { cbs: bd, ibsEstadual: bd, ibsMunicipal: bd, impostoSeletivo: aliqIS });
const item = (no) => comoObjeto(no, `${PKG}.ItemOperacaoInput`, {
  numero: comoInteger, ncm: s, nbs: s, cst: s, cClassTrib: s, baseCalculo: bd, quantidade: bd, unidade: s,
  impostoSeletivo, tributacaoRegular: tribRegular, gComponentesBC: componentes, aliquotasNominais: aliquotas,
});

export const TIPO_OPERACAO = `${PKG}.OperacaoInput`;
export const vincularOperacao = (no) => comoObjeto(no, TIPO_OPERACAO, {
  id: s, versao: s, dhFatoGerador: comoDataHora, dataHoraEmissao: comoDataHora, municipio: comoLong, uf: s, tpDoc: comoInteger,
  gCompraGov: compraGov, itens: (v) => comoLista(v, `java.util.ArrayList<${PKG}.ItemOperacaoInput>`, item),
});
export const ASSINATURA_REGIME_GERAL = 'public org.springframework.http.ResponseEntity<br.gov.serpro.rtc.api.model.roc.ROCDomain> br.gov.serpro.rtc.api.controller.CalculadoraTributoController.calcularTributos(br.gov.serpro.rtc.api.model.input.OperacaoInput)';

/** Reads a regime-geral body like Spring+Jackson; returns { ok: true, valor } or { ok: false, detail }. */
export function lerOperacao(bytes, charset) {
  try {
    return { ok: true, valor: lerCorpoRequisicao(bytes, { charset, assinatura: ASSINATURA_REGIME_GERAL, tipoJava: TIPO_OPERACAO, vincular: vincularOperacao }) };
  } catch (e) {
    if (e.classeJava === 'HttpMessageNotReadableException') return { ok: false, detail: e.mensagem };
    throw e;
  }
}
