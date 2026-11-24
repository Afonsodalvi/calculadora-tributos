// Port of shared/util/ArredondamentoUtils (byte-identical in the regime-regular and Simples APIs):
// exact internal arithmetic, one HALF_EVEN rounding per published number, division with
// MathContext(34, HALF_EVEN), the fiscal-value apportionment and the serializer formatters.
// Values are Dec (src/core/decimal.js); null in → null out where the Java returns null.
import { Dec } from '../../core/decimal.js';

/** RoundingMode.HALF_EVEN (ABNT NBR 5891). */
export const MODO = 'HALF_EVEN';
export const ESCALA_VALOR_FISCAL = 2;
export const ESCALA_ALIQUOTA_MIN = 2;
export const ESCALA_ALIQUOTA_MAX = 4;
/** CONTEXTO_DIVISAO = new MathContext(34, MODO): 34 significant digits. */
export const CONTEXTO_DIVISAO = Object.freeze({ precision: 34, roundingMode: MODO });
export const DIGITOS_INTEIROS_ALIQUOTA_ENTRADA = 3;
export const CASAS_ALIQUOTA_ENTRADA = 34;
export const DIGITOS_INTEIROS_VALOR_ENTRADA = 13;
const ESCALA_QUANTIDADE = 4;

/** Exact product (scale = sum of scales); null if any operand is null. */
export function multiplicar(v1, v2) {
  if (v1 == null || v2 == null) return null;
  return v1.mul(v2);
}

/** Exact difference (scale = max); null if any operand is null. */
export function subtrair(v1, v2) {
  if (v1 == null || v2 == null) return null;
  return v1.sub(v2);
}

/** dividendo.divide(divisor, CONTEXTO_DIVISAO); null if any operand is null. ArithmeticException on zero divisor. */
export function dividir(dividendo, divisor) {
  if (dividendo == null || divisor == null) return null;
  return dividendo.divideMC(divisor, CONTEXTO_DIVISAO.precision, CONTEXTO_DIVISAO.roundingMode);
}

/** stream.reduce(BigDecimal.ZERO, BigDecimal::add): exact; empty → 0 (scale 0). Accepts any iterable. */
export function totalizar(valores) {
  let total = Dec.ZERO;
  for (const v of valores) total = total.add(v); // a null element throws, as BigDecimal::add would (NPE)
  return total;
}

/** Percentage points → fraction (1.25 → 0.0125): movePointLeft(2), exact. */
export const percentualParaFracao = (p) => (p == null ? null : p.movePointLeft(2));

/** Fraction → percentage points (0.006132 → 0.6132): movePointRight(2), exact. */
export const fracaoParaPercentual = (f) => (f == null ? null : f.movePointRight(2));

/** Fiscal value: setScale(2, HALF_EVEN). */
export const arredondarValorFiscal = (v) => (v == null ? null : v.setScale(ESCALA_VALOR_FISCAL, MODO));

/** Published rate (percentage points): setScale(4, HALF_EVEN). */
export const arredondarAliquotaPublicada = (a) => (a == null ? null : a.setScale(ESCALA_ALIQUOTA_MAX, MODO));

/** Rate with the document's number of decimals; `casas` null = unchanged. */
export const arredondarAliquota = (a, casas) => (a == null || casas == null ? a : a.setScale(casas, MODO));

/**
 * Apportionment of a fiscal value: total = round2(sum of exact parts); each part truncated to the cent
 * (RoundingMode.DOWN); the missing cents go one by one to the largest remainders (stable sort: ties to
 * the lowest position). Result in input order, all with scale 2.
 */
export function ratearValorFiscal(parcelasExatas) {
  const total = arredondarValorFiscal(totalizar(parcelasExatas));
  const parcelas = [];
  const restos = [];
  const ordem = [];
  let distribuido = Dec.ZERO;
  parcelasExatas.forEach((exata, i) => {
    const truncada = exata.setScale(ESCALA_VALOR_FISCAL, 'DOWN');
    parcelas.push(truncada);
    restos.push(exata.sub(truncada));
    ordem.push(i);
    distribuido = distribuido.add(truncada);
  });
  ordem.sort((a, b) => restos[b].compareTo(restos[a])); // Array.prototype.sort is stable
  const centavo = Dec.ONE.movePointLeft(ESCALA_VALOR_FISCAL);
  const centavosFaltantes = total.sub(distribuido).movePointRight(ESCALA_VALOR_FISCAL).intValueExact();
  for (let k = 0; k < centavosFaltantes; k++) {
    const posicao = ordem[k % ordem.length];
    parcelas[posicao] = parcelas[posicao].add(centavo);
  }
  return parcelas;
}

/** Money with exactly 2 decimals (BigDecimalTDec1302Serializer): setScale(2, HALF_EVEN).toPlainString(). */
export const formatarMoeda = (v) => v.setScale(ESCALA_VALOR_FISCAL, MODO).toPlainString();

/** Rate with 2 to 4 decimals (BigDecimalTDec0302_04Serializer). */
export function formatarAliquota(v) {
  let s = v.setScale(ESCALA_ALIQUOTA_MAX, MODO).stripTrailingZeros();
  if (s.scale() < ESCALA_ALIQUOTA_MIN) s = s.setScale(ESCALA_ALIQUOTA_MIN, 'UNNECESSARY');
  return s.toPlainString();
}

/** Quantity: integer when possible, else 4 decimals HALF_EVEN (BigDecimalTDec1104OpRTCSerializer). */
export function formatarQuantidade(v) {
  if (v.stripTrailingZeros().scale() <= 0) return v.toBigInteger().toString();
  return v.setScale(ESCALA_QUANTIDADE, MODO).toPlainString();
}
