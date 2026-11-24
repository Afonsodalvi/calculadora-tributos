// Port of shared/util/ArredondamentoUtils of calculadora-rtc-simples-nacional 1.0.2: exact internal
// arithmetic, one HALF_EVEN rounding per published number, division with MathContext(34, HALF_EVEN),
// largest-remainder apportionment and the presentation formats used by the serializers.
// Values are Dec (src/core/decimal.js: unscaled BigInt + scale, BigDecimal semantics).
import { Dec } from '../../core/decimal.js';

export const MODO = 'HALF_EVEN';
export const ESCALA_VALOR_FISCAL = 2;
export const ESCALA_ALIQUOTA_MIN = 2;
export const ESCALA_ALIQUOTA_MAX = 4;
/** MathContext(34, HALF_EVEN) */
export const CONTEXTO_DIVISAO = Object.freeze({ precision: 34, roundingMode: MODO });
export const DIGITOS_INTEIROS_ALIQUOTA_ENTRADA = 3;
export const CASAS_ALIQUOTA_ENTRADA = 34;
export const DIGITOS_INTEIROS_VALOR_ENTRADA = 13;
const ESCALA_QUANTIDADE = 4;

const abs = (n) => (n < 0n ? -n : n);
const digitos = (n) => (n === 0n ? 1 : abs(n).toString().length);
/** BigDecimal.precision() */
export const precisao = (v) => digitos(v.u);

// ── exact internal arithmetic ────────────────────────────────────────────────
export const multiplicar = (v1, v2) => (v1 == null || v2 == null ? null : v1.mul(v2));
export const subtrair = (v1, v2) => (v1 == null || v2 == null ? null : v1.sub(v2));
/** Stream.reduce(BigDecimal.ZERO, BigDecimal::add) */
export const totalizar = (valores) => valores.reduce((acc, v) => acc.add(v), Dec.ZERO);
export const percentualParaFracao = (p) => (p == null ? null : p.movePointLeft(2));
export const fracaoParaPercentual = (f) => (f == null ? null : f.movePointRight(2));

/**
 * dividendo.divide(divisor, MathContext(34, HALF_EVEN)): quotient rounded to 34 significant digits,
 * then trailing zeros stripped while the scale is above the preferred one (dividend − divisor scales).
 */
export function dividir(dividendo, divisor) {
  if (dividendo == null || divisor == null) return null;
  if (divisor.u === 0n) throw new RangeError(dividendo.u === 0n ? 'Division undefined' : 'Division by zero');
  const preferida = dividendo.s - divisor.s;
  if (dividendo.u === 0n) return new Dec(0n, preferida);
  const negativo = (dividendo.u < 0n) !== (divisor.u < 0n);
  const num = abs(dividendo.u), den = abs(divisor.u);
  const p = CONTEXTO_DIVISAO.precision;
  // scale with 2–3 guard digits beyond the precision
  const escala = p + 2 - (digitos(num) - digitos(den)) - (divisor.s - dividendo.s);
  const e = escala + divisor.s - dividendo.s; // quotient·10^escala = num·10^e / den
  let n = num, d = den;
  if (e >= 0) n *= 10n ** BigInt(e); else d *= 10n ** BigInt(-e);
  let q = n / d;
  const resto = n % d;
  let s = escala;
  const k = digitos(q) - p;
  if (k > 0) {
    const div = 10n ** BigInt(k);
    const cauda = q % div;
    q /= div;
    s -= k;
    const dobro = cauda * 2n;
    if (dobro > div || (dobro === div && (resto !== 0n || q % 2n === 1n))) q += 1n;
    if (digitos(q) > p) { q /= 10n; s -= 1; } // carry: 10^34 → 10^33 one scale lower
  }
  let r = new Dec(negativo ? -q : q, s);
  while (r.s > preferida && r.u % 10n === 0n && r.u !== 0n) r = new Dec(r.u / 10n, r.s - 1);
  return r;
}

// ── published numbers (one rounding per number) ──────────────────────────────
export const arredondarValorFiscal = (v) => (v == null ? null : v.setScale(ESCALA_VALOR_FISCAL, MODO));
export const arredondarAliquotaPublicada = (a) => (a == null ? null : a.setScale(ESCALA_ALIQUOTA_MAX, MODO));
export const arredondarAliquota = (a, casas) => (a == null || casas == null ? a : a.setScale(casas, MODO));

/** Largest-remainder apportionment of exact parts into cents (stable: ties go to the lower index). */
export function ratearValorFiscal(parcelasExatas) {
  const total = arredondarValorFiscal(totalizar(parcelasExatas));
  const parcelas = [], restos = [], ordem = [];
  let distribuido = Dec.ZERO;
  parcelasExatas.forEach((exata, i) => {
    const truncada = exata.setScale(ESCALA_VALOR_FISCAL, 'DOWN');
    parcelas.push(truncada);
    restos.push(exata.sub(truncada));
    ordem.push(i);
    distribuido = distribuido.add(truncada);
  });
  ordem.sort((a, b) => restos[b].cmp(restos[a]));
  const centavo = Dec.ONE.movePointLeft(ESCALA_VALOR_FISCAL);
  const faltantes = Number(total.sub(distribuido).movePointRight(ESCALA_VALOR_FISCAL).setScale(0).u);
  for (let k = 0; k < faltantes; k++) {
    const posicao = ordem[k % ordem.length];
    parcelas[posicao] = parcelas[posicao].add(centavo);
  }
  return parcelas;
}

// ── presentation (serializers) ───────────────────────────────────────────────
export const formatarMoeda = (v) => v.setScale(ESCALA_VALOR_FISCAL, MODO).toString();
export function formatarAliquota(v) {
  let s = v.setScale(ESCALA_ALIQUOTA_MAX, MODO).stripTrailingZeros();
  if (s.s < ESCALA_ALIQUOTA_MIN) s = s.setScale(ESCALA_ALIQUOTA_MIN);
  return s.toString();
}
export function formatarQuantidade(v) {
  if (v.stripTrailingZeros().s <= 0) return (v.s <= 0 ? v.u * 10n ** BigInt(-v.s) : v.u / 10n ** BigInt(v.s)).toString(); // toBigInteger
  return v.setScale(ESCALA_QUANTIDADE, MODO).toString();
}
