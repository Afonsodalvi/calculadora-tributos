// Port of domain/service/basecalculo/BaseCalculoService (E1 cbs-ibs-mercadorias, E2 is-mercadorias)
// and BaseCalculoUnificadaService + ElementoBaseCalculo + ComponentesBaseCalculoInput.getValor
// (E3 base-calculo-unificada; calcularComponentes is also the entry point of the item calculation
// of the main /regime-geral endpoint). Exact BigDecimal arithmetic, no rounding but the published
// arredondarValorFiscal of E3.
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';
import { arredondarValorFiscal, subtrair } from '../comum/arredondamento.js';

const ANO_INICIO_CBS_IBS = 2026;
const ANO_INICIO_IS = 2027;
const ANO_EXTINCAO_PIS_COFINS = 2027;
const ANO_EXTINCAO_ICMS_ISS = 2033;
const MENSAGEM_ERRO_IS = `Para IS, o ano do fato gerador deve ser ${ANO_INICIO_IS} ou superior`;
const MENSAGEM_ERRO_CBS_IBS = `Para CBS/IBS, o ano do fato gerador deve ser ${ANO_INICIO_CBS_IBS} ou superior`;
const MENSAGEM_BASE_NEGATIVA = 'Base de cálculo não pode ser negativa. A soma dos valores que não integram a base é maior que a soma dos valores que integram a base.';

export const campoInvalido = (mensagem) => new ErroJava('CampoInvalidoException', mensagem);

// ─── Java NullPointerException texts (JDK 25 helpful NPE messages) ─────────────

/** Map.of(k, null, …) → Objects.requireNonNull → NPE without message. */
export function mapaDe(pares) {
  for (const [, v] of pares) if (v === null || v === undefined) throw new ErroJava('NullPointerException', null);
  return pares;
}

const getter = (campo) => `get${campo[0].toUpperCase()}${campo.slice(1)}`;

/**
 * `entrada.getA().add(entrada.getB()).add(…)`: a null receiver fails the invokevirtual
 * ("the return value of …getA() is null"); a null argument fails inside BigDecimal.add.
 */
export function somarCadeia(entrada, campos, classeJava) {
  const [primeiro, ...resto] = campos;
  let total = entrada[primeiro];
  if (total == null) {
    throw new ErroJava('NullPointerException', `Cannot invoke "java.math.BigDecimal.add(java.math.BigDecimal)" because the return value of "${classeJava}.${getter(primeiro)}()" is null`);
  }
  for (const c of resto) {
    const v = entrada[c];
    if (v == null) throw new ErroJava('NullPointerException', 'Cannot read field "intCompact" because "augend" is null');
    total = total.add(v);
  }
  return total;
}

/** validaAnoInicioTributo. */
export function validaAnoInicioTributo(ano, anoInicio, mensagemErro) {
  if (ano < anoInicio) throw campoInvalido(mensagemErro);
}

/** validaValoresForaLimiteVigenciaPermitido: names of non-zero values, natural order, joined by ", ". */
export function validaValoresForaLimiteVigenciaPermitido(campos, ano, anoExtincao) {
  if (ano >= anoExtincao) {
    const informados = campos.filter(([, v]) => v != null && v.compareTo(Dec.ZERO) !== 0).map(([k]) => k).sort();
    if (informados.length) throw campoInvalido(`Os seguintes campos não podem ser informados a partir de ${anoExtincao}: ${informados.join(', ')}`);
  }
}

function validaValorFinalBaseCalculo(base) {
  if (base.compareTo(Dec.ZERO) < 0) throw campoInvalido(MENSAGEM_BASE_NEGATIVA);
}

const CLASSE_CIBS = 'br.gov.serpro.rtc.api.model.input.basecalculo.BaseCalculoCibsInput';
const CLASSE_IS = 'br.gov.serpro.rtc.api.model.input.basecalculo.BaseCalculoISMercadoriasInput';

/** BaseCalculoService.calcularCibs → { baseCalculo } (exact). */
export function calcularCibs(e) {
  const ano = e.anoFatoGerador;
  validaAnoInicioTributo(ano, ANO_INICIO_CBS_IBS, MENSAGEM_ERRO_CBS_IBS);
  validaValoresForaLimiteVigenciaPermitido(mapaDe([
    ['PIS', e.pis], ['PIS Importação', e.pisImportacao], ['COFINS', e.cofins], ['COFINS Importação', e.cofinsImportacao],
  ]), ano, ANO_EXTINCAO_PIS_COFINS);
  validaValoresForaLimiteVigenciaPermitido(mapaDe([['ICMS', e.icms], ['ISS', e.iss]]), ano, ANO_EXTINCAO_ICMS_ISS);
  const integra = somarCadeia(e, ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'frete', 'impostoSeletivo', 'outrosTributos', 'demaisImportancias'], CLASSE_CIBS);
  const naoIntegra = somarCadeia(e, ['cosip', 'ipi', 'descontoIncondicional', 'pis', 'pisImportacao', 'cofins', 'cofinsImportacao', 'icms', 'iss'], CLASSE_CIBS);
  const baseCalculo = integra.sub(naoIntegra);
  validaValorFinalBaseCalculo(baseCalculo);
  return { baseCalculo };
}

/** BaseCalculoService.calcularISMercadorias → { baseCalculo } (exact). */
export function calcularISMercadorias(e) {
  const ano = e.anoFatoGerador;
  validaAnoInicioTributo(ano, ANO_INICIO_IS, MENSAGEM_ERRO_IS);
  validaValoresForaLimiteVigenciaPermitido(mapaDe([['ICMS', e.icms], ['ISS', e.iss]]), ano, ANO_EXTINCAO_ICMS_ISS);
  const integra = somarCadeia(e, ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'freteCobrado', 'outrosTributos', 'demaisImportancias'], CLASSE_IS);
  const naoIntegra = somarCadeia(e, ['cosip', 'ipi', 'descontoIncondicional', 'bonificacao', 'devolucaoVendas', 'icms', 'iss'], CLASSE_IS);
  const baseCalculo = integra.sub(naoIntegra);
  validaValorFinalBaseCalculo(baseCalculo);
  return { baseCalculo };
}

// ─── ElementoBaseCalculo ───────────────────────────────────────────────────

const RG = 'RG';
const IS = 'IS';
const SN = 'SN';
const SOMA = 'SOMA';
const SUBTRAI = 'SUBTRAI';
const BEM = 'BEM';
const SERVICO = 'SERVICO';

const elemento = (nome, tag, operacao, bases, natureza, anoInicioVigencia, anoFimVigencia, tiposDocumentoValidos) => Object.freeze({
  nome, tag, operacao, bases, natureza, anoInicioVigencia, anoFimVigencia, tiposDocumentoValidos,
});

/** ElementoBaseCalculo.values() in declaration order. */
export const ELEMENTOS = Object.freeze([
  elemento('V_PROD', 'vProd', SOMA, [RG, IS, SN], null, 2026, 2033, [55, 65]),
  elemento('V_FRETE', 'vFrete', SOMA, [RG, IS, SN], null, 2026, 2033, [55, 65]),
  elemento('V_SEG', 'vSeg', SOMA, [RG, IS, SN], null, 2026, 2033, [55, 65]),
  elemento('V_OUTRO', 'vOutro', SOMA, [RG, IS, SN], null, 2026, 2033, [55, 65]),
  elemento('V_II', 'vII', SOMA, [RG, IS], BEM, 2026, 2033, [55]),
  elemento('V_IS', 'vIS', SOMA, [RG, SN], null, 2027, 2033, [55, 65]),
  elemento('V_DESC', 'vDesc', SUBTRAI, [RG, IS, SN], null, 2026, 2033, [55, 65]),
  elemento('V_PIS', 'vPIS', SUBTRAI, [RG, IS], null, 2026, 2026, [55, 65]),
  elemento('V_COFINS', 'vCOFINS', SUBTRAI, [RG, IS], null, 2026, 2026, [55, 65]),
  elemento('V_ICMS', 'vICMS', SUBTRAI, [RG, IS], BEM, 2026, 2032, [55, 65]),
  elemento('V_ICMS_UF_DEST', 'vICMSUFDest', SUBTRAI, [RG, IS], BEM, 2026, 2032, [55]),
  elemento('V_FCP', 'vFCP', SUBTRAI, [RG, IS], BEM, 2026, 2032, [55, 65]),
  elemento('V_FCP_UF_DEST', 'vFCPUFDest', SUBTRAI, [RG, IS], BEM, 2026, 2032, [55]),
  elemento('V_ICMS_MONO', 'vICMSMono', SUBTRAI, [RG, IS], BEM, 2026, 2032, [55, 65]),
  elemento('V_ISSQN', 'vISSQN', SUBTRAI, [RG, IS], SERVICO, 2026, 2032, [55, 65]),
]);
export const ELEMENTO_POR_NOME = new Map(ELEMENTOS.map((x) => [x.nome, x]));

/**
 * ElementoBaseCalculo.todos() = Set.of(values()): its iteration order depends on the JVM's
 * random SALT. The port iterates in declaration order (sums are order-independent; only the
 * order of `avisos` differs, which the tests compare as a multiset).
 */
export const todos = () => ELEMENTOS;

export const isValidoParaTipoDocumento = (el, tpDoc) => el.tiposDocumentoValidos.includes(tpDoc);
export const aplicaBase = (el, base) => el.bases.includes(base);

/** campoCompoeBase(ano, natureza, tipoDocumento). */
export function campoCompoeBase(el, ano, natureza, tpDoc) {
  const anoValido = ano >= el.anoInicioVigencia && ano <= el.anoFimVigencia;
  const naturezaValida = el.natureza === null || (natureza != null && el.natureza === natureza);
  return anoValido && naturezaValida && el.tiposDocumentoValidos.includes(tpDoc);
}

/** motivoNaoComposicao: first failing condition (vigência, natureza, modelo) or null. */
export function motivoNaoComposicao(el, ano, natureza, tpDoc) {
  if (!(ano >= el.anoInicioVigencia && ano <= el.anoFimVigencia)) {
    return `Campo ${el.tag} não compõe as bases para o ano ${ano} (vigência ${el.anoInicioVigencia}–${el.anoFimVigencia}) e foi ignorado no cálculo`;
  }
  if (!(el.natureza === null || (natureza != null && el.natureza === natureza))) {
    return `Campo ${el.tag} não compõe as bases para a natureza ${natureza ?? 'null'} (aplicável apenas a ${el.natureza}) e foi ignorado no cálculo`;
  }
  if (!el.tiposDocumentoValidos.includes(tpDoc)) {
    return `Campo ${el.tag} não compõe as bases para o documento modelo ${tpDoc} e foi ignorado no cálculo`;
  }
  return null;
}

/** ComponentesBaseCalculoInput.getValor(elemento): the field named by the tag (null when absent). */
export const getValor = (componentes, el) => componentes?.[el.tag] ?? null;

/** ComponentesBaseCalculoInput.possuiComponentes(): any of the 15 fields non-null (zero counts). */
export const possuiComponentes = (componentes) => ELEMENTOS.some((el) => getValor(componentes, el) !== null);

/**
 * BaseCalculoUnificadaService.calcular(componentes, ano, natureza, tpDoc) → { baseRG, baseIS,
 * baseSN, avisos } with the EXACT bases (the caller rounds when publishing).
 */
export function calcularComponentes(componentes, ano, natureza, tpDoc) {
  if (tpDoc == null || (tpDoc !== 55 && tpDoc !== 65)) throw campoInvalido('Tipo de documento deve ser 55 (NF-e) ou 65 (NFC-e)');
  let rgSoma = Dec.ZERO, rgSubtrai = Dec.ZERO, isSoma = Dec.ZERO, isSubtrai = Dec.ZERO, snSoma = Dec.ZERO, snSubtrai = Dec.ZERO;
  const avisos = [];
  for (const el of todos()) {
    if (!campoCompoeBase(el, ano, natureza, tpDoc)) {
      const valor = getValor(componentes, el);
      if (valor !== null && valor.compareTo(Dec.ZERO) !== 0) {
        const motivo = motivoNaoComposicao(el, ano, natureza, tpDoc);
        if (motivo !== null) avisos.push(motivo);
      }
      continue;
    }
    const valor = getValor(componentes, el);
    if (valor === null || valor.compareTo(Dec.ZERO) === 0) continue;
    if (el.operacao === SOMA) {
      if (aplicaBase(el, RG)) rgSoma = rgSoma.add(valor);
      if (aplicaBase(el, IS)) isSoma = isSoma.add(valor);
      if (aplicaBase(el, SN)) snSoma = snSoma.add(valor);
    }
    if (el.operacao === SUBTRAI) {
      if (aplicaBase(el, RG)) rgSubtrai = rgSubtrai.add(valor);
      if (aplicaBase(el, IS)) isSubtrai = isSubtrai.add(valor);
      if (aplicaBase(el, SN)) snSubtrai = snSubtrai.add(valor);
    }
  }
  return {
    baseRG: subtrair(rgSoma, rgSubtrai),
    baseIS: subtrair(isSoma, isSubtrai),
    baseSN: subtrair(snSoma, snSubtrai),
    avisos,
  };
}

/** BaseCalculoUnificadaService.calcular(BaseCalculoUnificadaInput): bases published with 2 decimals. */
export function calcularUnificada(entrada) {
  const exato = calcularComponentes(entrada.componentes, entrada.anoFatoGerador, entrada.natureza, entrada.tipoDocumento);
  return {
    baseRG: arredondarValorFiscal(exato.baseRG),
    baseIS: arredondarValorFiscal(exato.baseIS),
    baseSN: arredondarValorFiscal(exato.baseSN),
    avisos: exato.avisos ?? [],
  };
}

/** JSON of BaseCalculoUnificadaOutput (getters, alphabetical): avisos, baseIS, baseRG, baseSN. */
export const saidaUnificada = (r) => ({ avisos: r.avisos, baseIS: r.baseIS, baseRG: r.baseRG, baseSN: r.baseSN });
