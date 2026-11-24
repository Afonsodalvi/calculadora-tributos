// Exact decimal arithmetic mirroring java.math.BigDecimal semantics used by the
// Receita Federal calculators (ArredondamentoUtils): exact add/sub/mul, movePoint,
// setScale, divide with MathContext, toString/toPlainString. Value = unscaled * 10^-scale.
// No floating point anywhere. The scale may be negative (1E+3 = unscaled 1, scale -3).
//
// Naming: the original Simples API (of, add, sub, mul, cmp, div, toString = plain) is kept
// unchanged; the BigDecimal-parity additions use the Java method names (precision, scale,
// toJavaString = BigDecimal.toString, toPlainString, divideMC, compareTo, equalsJava...).

const TEN = 10n;
const pow10 = (n) => TEN ** BigInt(n);
const INT_MIN = -2147483648n;
const INT_MAX = 2147483647n;

/** java.lang.ArithmeticException (message as the JDK writes it). */
export class ArithmeticException extends RangeError {
  constructor(message) { super(message); this.name = 'ArithmeticException'; this.classeJava = 'ArithmeticException'; }
}

/** java.lang.NumberFormatException thrown by Dec.parse (message as JDK 25 writes it; may be null). */
export class NumberFormatException extends Error {
  constructor(message) { super(message ?? 'null'); this.name = 'NumberFormatException'; this.classeJava = 'NumberFormatException'; this.mensagemJava = message; }
}

const digitos = (n) => (n < 0n ? -n : n).toString().length;

/**
 * Exponent k of the divisor 10^k when only q = trunc(u / 10^k) and the rounding of the remainder
 * matter: for k > digits(u) + 1, q = 0, r = u and 2|u| < 10^(digits+1) ≤ 10^k, so 10^(digits+1)
 * gives the same quotient, remainder and rounding decision without building a huge power of ten.
 */
const digitosDescartados = (u, k) => (k <= 20 ? k : Math.min(k, digitos(u) + 1));

/** Value of a Unicode decimal digit (Character.digit(c, 10)) or -1. Decimal digits come in runs of ten. */
function valorDigito(cp) {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  const c = String.fromCodePoint(cp);
  if (!/\p{Nd}/u.test(c)) return -1;
  let inicio = cp;
  while (inicio > 0 && /\p{Nd}/u.test(String.fromCodePoint(inicio - 1))) inicio--;
  return (cp - inicio) % 10;
}

/**
 * Parses the `new BigDecimal(String)` grammar: [+-] (digits [. digits?] | . digits) [(e|E) [+-] digits].
 * opts.ascii = only ASCII digits (FastDoubleParser, used by Jackson); otherwise Unicode digits like the JDK.
 * opts.limiteExpoente = exponent must fit an int (FastDoubleParser).
 * Returns { u, s } or { erro: message|null } (JDK 25 messages).
 */
function lerBigDecimal(texto, { ascii = false, limiteExpoente = false } = {}) {
  const t = String(texto);
  const n = t.length;
  if (n === 0) return { erro: null };
  let i = 0;
  let neg = false;
  if (t[0] === '-' || t[0] === '+') { neg = t[0] === '-'; i = 1; }
  let coef = '';
  let fracLen = 0;
  let ponto = false;
  let temDigito = false;
  let expoente = 0n;
  for (; i < n; i++) {
    const cp = t.codePointAt(i);
    if (cp > 0xffff) { return { erro: `Character ${String.fromCodePoint(cp)} is neither a decimal digit number, decimal point, nor "e" notation exponential mark.` }; }
    const ch = t[i];
    if (ch === '.') {
      if (ponto) return { erro: 'Character array contains more than one decimal point.' };
      ponto = true;
      continue;
    }
    if (ch === 'e' || ch === 'E') {
      if (!temDigito) return { erro: 'No digits found.' };
      // exponent
      let j = i + 1;
      let negExp = false;
      if (j < n && (t[j] === '-' || t[j] === '+')) { negExp = t[j] === '-'; j++; }
      if (j >= n) return { erro: null };
      let exp = 0n;
      for (; j < n; j++) {
        const v = ascii ? (t.charCodeAt(j) >= 0x30 && t.charCodeAt(j) <= 0x39 ? t.charCodeAt(j) - 0x30 : -1) : valorDigito(t.codePointAt(j));
        if (v < 0) return { erro: 'Not a digit.' };
        exp = exp * 10n + BigInt(v);
      }
      expoente = negExp ? -exp : exp;
      i = n;
      break;
    }
    const v = ascii ? (cp >= 0x30 && cp <= 0x39 ? cp - 0x30 : -1) : valorDigito(cp);
    if (v < 0) return { erro: `Character ${ch} is neither a decimal digit number, decimal point, nor "e" notation exponential mark.` };
    temDigito = true;
    coef += String(v);
    if (ponto) fracLen++;
  }
  if (!temDigito) return { erro: 'No digits found.' };
  if (limiteExpoente && (expoente < INT_MIN || expoente > INT_MAX)) return { erro: 'Exponent overflow.' };
  const escala = BigInt(fracLen) - expoente;
  if (escala < INT_MIN || escala > INT_MAX) return { erro: 'Exponent overflow.' };
  const u = BigInt(coef);
  return { u: neg ? -u : u, s: Number(escala) };
}

/** Rounding decision shared by setScale/divide: q truncated toward zero, r remainder, den > 0 divisor of |r|. */
function precisaIncrementar(mode, q, r, den, sinal) {
  if (r === 0n) return false;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'DOWN': return false;
    case 'UP': return true;
    case 'CEILING': return sinal > 0;
    case 'FLOOR': return sinal < 0;
    case 'HALF_UP': return twice >= den;
    case 'HALF_DOWN': return twice > den;
    case 'HALF_EVEN': return twice > den || (twice === den && (q % 2n !== 0n));
    case 'UNNECESSARY': throw new ArithmeticException('Rounding necessary');
    default: throw new Error(`Modo de arredondamento não suportado: ${mode}`);
  }
}

export class Dec {
  constructor(unscaled, scale) {
    this.u = BigInt(unscaled);
    this.s = scale;
  }

  /** Parse a plain decimal string ("123", "-1.50", "0.0125"). Throws on anything else. Trims (JS). */
  static of(text) {
    if (text instanceof Dec) return text;
    if (typeof text === 'bigint') return new Dec(text, 0);
    if (typeof text === 'number') {
      if (!Number.isInteger(text)) throw new TypeError('Dec.of(number) only accepts integers; pass a string');
      return new Dec(BigInt(text), 0);
    }
    const t = String(text).trim();
    const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(t);
    if (!m) throw new TypeError(`Decimal inválido: '${text}'`);
    const frac = m[3] ?? '';
    const u = BigInt(m[2] + frac) * (m[1] === '-' ? -1n : 1n);
    return new Dec(u, frac.length);
  }

  /** `new BigDecimal(String)`: full JDK grammar (sign, '.5', '5.', exponents, Unicode digits), no trim. Throws NumberFormatException. */
  static parse(text) {
    const r = lerBigDecimal(text);
    if (r.erro !== undefined) throw new NumberFormatException(r.erro);
    return new Dec(r.u, r.s);
  }

  /** Same grammar restricted to ASCII digits and an int exponent (FastDoubleParser, used by Jackson). null when invalid. */
  static parseAscii(text) {
    const r = lerBigDecimal(text, { ascii: true, limiteExpoente: true });
    return r.erro !== undefined ? null : new Dec(r.u, r.s);
  }

  /** BigDecimal.valueOf(unscaled, scale). */
  static valueOf(unscaled, scale = 0) { return new Dec(BigInt(unscaled), scale); }

  static get ZERO() { return new Dec(0n, 0); }
  static get ONE() { return new Dec(1n, 0); }
  static get TEN() { return new Dec(10n, 0); }

  #align(o) {
    const s = Math.max(this.s, o.s);
    // 0·10^k = 0: a zero never pays for 10^|Δscale| (the JDK's longMultiplyPowerTen(0, n) is O(1) too)
    return [this.u === 0n ? 0n : this.u * pow10(s - this.s), o.u === 0n ? 0n : o.u * pow10(s - o.s), s];
  }

  add(o) { o = Dec.of(o); const [a, b, s] = this.#align(o); return new Dec(a + b, s); }
  sub(o) { o = Dec.of(o); const [a, b, s] = this.#align(o); return new Dec(a - b, s); }
  mul(o) { o = Dec.of(o); return new Dec(this.u * o.u, this.s + o.s); }
  neg() { return new Dec(-this.u, this.s); }
  negate() { return this.neg(); }
  abs() { return this.u < 0n ? this.neg() : this; }
  /** Java aliases. */
  subtract(o) { return this.sub(o); }
  multiply(o) { return this.mul(o); }

  /** BigDecimal.movePointLeft(n): exact, scale = max(scale + n, 0). */
  movePointLeft(n) {
    const ns = this.s + n;
    return ns >= 0 ? new Dec(this.u, ns) : new Dec(this.u === 0n ? 0n : this.u * pow10(-ns), 0);
  }
  movePointRight(n) { return this.movePointLeft(-n); }
  /** BigDecimal.scaleByPowerOfTen(n): same unscaled value, scale - n. */
  scaleByPowerOfTen(n) { return new Dec(this.u, this.s - n); }

  /**
   * Like BigDecimal.compareTo/compareMagnitude: signs first, then the adjusted exponents
   * (precision − scale); the scales are aligned only for equal magnitudes, where |Δscale| is at
   * most the digit count. Never builds 10^|Δscale| (1E-300000000 vs 100.00 is O(1)).
   */
  cmp(o) {
    o = Dec.of(o);
    const sa = this.signum(), sb = o.signum();
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (sa === 0) return 0;
    if (this.s !== o.s) {
      const ea = this.precision() - this.s, eb = o.precision() - o.s;
      if (ea !== eb) return ea > eb ? sa : -sa;
    }
    const [a, b] = this.#align(o);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  /** BigDecimal.compareTo: numeric value only (2.0 == 2.00). */
  compareTo(o) { return this.cmp(o); }
  /** BigDecimal.equals: value AND scale (2.0 != 2.00). */
  equalsJava(o) { o = Dec.of(o); return this.u === o.u && this.s === o.s; }
  max(o) { o = Dec.of(o); return this.cmp(o) >= 0 ? this : o; }
  min(o) { o = Dec.of(o); return this.cmp(o) <= 0 ? this : o; }
  signum() { return this.u < 0n ? -1 : this.u > 0n ? 1 : 0; }
  isZero() { return this.u === 0n; }

  /** BigDecimal.scale() / unscaledValue() / precision() (digits of |unscaled|; zero has precision 1). */
  scale() { return this.s; }
  unscaledValue() { return this.u; }
  precision() { return digitos(this.u); }

  /** BigDecimal.setScale(newScale, mode). Modes: HALF_EVEN (default), HALF_UP, HALF_DOWN, UP, DOWN, CEILING, FLOOR, UNNECESSARY. */
  setScale(ns, mode = 'HALF_EVEN') {
    if (this.u === 0n) return new Dec(0n, ns); // the JDK's zeroValueOf(newScale)
    if (ns >= this.s) return new Dec(this.u * pow10(ns - this.s), ns);
    const div = pow10(digitosDescartados(this.u, this.s - ns));
    const q = this.u / div; // truncates toward zero
    const r = this.u % div;
    const sinal = this.u < 0n ? -1 : 1;
    if (r === 0n) return new Dec(q, ns);
    return new Dec(precisaIncrementar(mode, q, r, div, sinal) ? q + BigInt(sinal) : q, ns);
  }

  /** BigDecimal.round(new MathContext(precision, mode)). */
  round(precisao, mode = 'HALF_EVEN') {
    if (precisao <= 0) return this;
    let r = this;
    while (r.precision() > precisao) {
      const drop = r.precision() - precisao;
      r = r.setScale(r.s - drop, mode);
    }
    return r;
  }

  /** Division rounded to `scale` decimals = BigDecimal.divide(divisor, scale, mode). */
  div(o, scale, mode = 'HALF_EVEN') {
    o = Dec.of(o);
    if (o.u === 0n) throw new ArithmeticException(this.u === 0n ? 'Division undefined' : 'Division by zero');
    if (this.u === 0n) return new Dec(0n, scale);
    // (this.u·10^-this.s) / (o.u·10^-o.s) = q·10^-scale  ⇒  q = this.u·10^(scale+o.s-this.s) / o.u
    const e = scale + o.s - this.s;
    let num = this.u, den = o.u;
    if (e >= 0) num *= pow10(e); else den *= pow10(digitosDescartados(num, -e));
    if (den < 0n) { num = -num; den = -den; }
    const q = num / den;
    const r = num % den;
    const sinal = num < 0n ? -1 : 1;
    return new Dec(precisaIncrementar(mode, q, r, den, sinal) ? q + BigInt(sinal) : q, scale);
  }

  /**
   * BigDecimal.divide(divisor, new MathContext(precisao, mode)) — the JDK algorithm: quotient with
   * `precisao` significant digits; an exact quotient keeps its trailing zeros removed down to the
   * preferred scale (this.scale - divisor.scale).
   */
  divideMC(o, precisao = 34, mode = 'HALF_EVEN') {
    o = Dec.of(o);
    if (o.u === 0n) throw new ArithmeticException(this.u === 0n ? 'Division undefined' : 'Division by zero');
    const preferida = this.s - o.s;
    if (this.u === 0n) return new Dec(0n, preferida);
    const xs = this.u, ys = o.u;
    const xprec = digitos(xs);
    let yprec = digitos(ys);
    // compareMagnitudeNormalized(0.xs, 0.ys) > 0  ⇒  divisor *= 10
    const ax = xs < 0n ? -xs : xs, ay = ys < 0n ? -ys : ys;
    const dif = xprec - yprec;
    const cmpNorm = dif < 0 ? (ax * pow10(-dif) > ay) : (ax > ay * pow10(dif));
    if (cmpNorm) yprec -= 1;
    const escala = preferida + yprec - xprec + precisao;
    const e = precisao + yprec - xprec;
    let num = xs, den = ys;
    if (e > 0) num *= pow10(e); else if (e < 0) den *= pow10(-e);
    if (den < 0n) { num = -num; den = -den; }
    const q = num / den;
    const r = num % den;
    const sinal = num < 0n ? -1 : 1;
    let res;
    if (r !== 0n) {
      res = new Dec(precisaIncrementar(mode, q, r, den, sinal) ? q + BigInt(sinal) : q, escala);
    } else {
      let qq = q, s = escala;
      while (s > preferida && qq !== 0n && qq % TEN === 0n) { qq /= TEN; s--; }
      res = new Dec(qq, s);
    }
    return res.round(precisao, mode); // doRound: only the 10^k carry case
  }

  /** BigDecimal.divide(divisor) without context: exact quotient or ArithmeticException. */
  divideExact(o) {
    o = Dec.of(o);
    if (o.u === 0n) throw new ArithmeticException(this.u === 0n ? 'Division undefined' : 'Division by zero');
    const preferida = this.s - o.s;
    if (this.u === 0n) return new Dec(0n, Math.max(Math.min(preferida, 2147483647), -2147483648));
    // exact iff the reduced denominator has only factors 2 and 5
    let num = this.u, den = o.u;
    const g = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
    const d = g(num, den);
    let dd = (den / d < 0n ? -(den / d) : den / d);
    let k2 = 0, k5 = 0;
    while (dd % 2n === 0n) { dd /= 2n; k2++; }
    while (dd % 5n === 0n) { dd /= 5n; k5++; }
    if (dd !== 1n) throw new ArithmeticException('Non-terminating decimal expansion; no exact representable decimal result.');
    const extra = Math.max(k2, k5);
    const q = this.div(o, preferida + extra + 0, 'UNNECESSARY');
    let qq = q.u, s = q.s;
    while (s > preferida && qq % TEN === 0n) { qq /= TEN; s--; }
    return new Dec(qq, s);
  }

  stripTrailingZeros() {
    if (this.u === 0n) return new Dec(0n, 0);
    let u = this.u, s = this.s;
    while (u % TEN === 0n) { u /= TEN; s -= 1; }
    return new Dec(u, s);
  }

  /** BigDecimal.toBigInteger(): truncation toward zero. */
  toBigInteger() {
    if (this.u === 0n) return 0n;
    return this.s >= 0 ? this.u / pow10(digitosDescartados(this.u, this.s)) : this.u * pow10(-this.s);
  }

  /** BigDecimal.intValueExact() = longValueExact() (with its fast paths, in the JDK order) + int range. */
  intValueExact() {
    if (this.u === 0n) return 0;
    const inteiros = this.precision() - this.s;
    if (inteiros <= 0) throw new ArithmeticException('Rounding necessary'); // |value| < 1
    if (inteiros > 19) throw new ArithmeticException('Overflow'); // cannot fit a long
    const v = this.setScale(0, 'UNNECESSARY').u;
    if (v < INT_MIN || v > INT_MAX) throw new ArithmeticException('Overflow');
    return Number(v);
  }

  /** BigDecimal.toPlainString(). */
  toString() {
    const neg = this.u < 0n;
    let digits = (neg ? -this.u : this.u).toString();
    if (this.s <= 0) return (neg ? '-' : '') + digits + (this.u === 0n ? '' : '0'.repeat(-this.s));
    if (digits.length <= this.s) digits = '0'.repeat(this.s - digits.length + 1) + digits;
    const i = digits.length - this.s;
    return (neg ? '-' : '') + digits.slice(0, i) + '.' + digits.slice(i);
  }

  toPlainString() { return this.toString(); }

  /** BigDecimal.toString(): scientific notation when scale < 0 or the adjusted exponent < -6. */
  toJavaString() {
    if (this.s === 0) return this.u.toString();
    const neg = this.u < 0n;
    const coef = (neg ? -this.u : this.u).toString();
    const adj = -this.s + (coef.length - 1);
    if (this.s > 0 && adj >= -6) return this.toString();
    const mant = coef.length > 1 ? `${coef[0]}.${coef.slice(1)}` : coef;
    return `${neg ? '-' : ''}${mant}E${adj >= 0 ? '+' : ''}${adj}`;
  }

  toNumber() { return Number(this.toString()); }
  toJSON() { return this.toString(); }
}

export const D = (x) => Dec.of(x);
export const sum = (list) => list.reduce((acc, v) => (v == null ? acc : acc.add(v)), Dec.ZERO);
