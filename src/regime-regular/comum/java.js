// Java semantics that leak into the HTTP contract of calculadora-rtc-regime-regular:
// String.trim/isBlank/equalsIgnoreCase, java.util.Formatter (%s/%d), Double/Float.toString,
// the JDK UTF-8 decoder (strict and REPLACE) and Character.isJavaIdentifierStart/Part.
import { Dec } from '../../core/decimal.js';

/** java.lang.String.trim(): removes code units <= U+0020 at both ends (JS trim() also removes NBSP/BOM). */
export const javaTrim = (s) => s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');

/** Character.isWhitespace(char): Unicode space separators except no-break ones, plus \t \n \u000B \f \r \u001C-\u001F. */
export function javaIsWhitespace(c) {
  const cp = typeof c === 'number' ? c : c.codePointAt(0);
  if ((cp >= 0x09 && cp <= 0x0d) || (cp >= 0x1c && cp <= 0x1f)) return true;
  if (cp === 0x00a0 || cp === 0x2007 || cp === 0x202f) return false;
  return /[\p{Zs}\p{Zl}\p{Zp}]/u.test(String.fromCodePoint(cp));
}

/** String.isBlank(). */
export function javaIsBlank(s) {
  for (const ch of s) if (!javaIsWhitespace(ch)) return false;
  return true;
}

/** String.equalsIgnoreCase: char by char, toUpperCase then toLowerCase of each UTF-16 unit. */
export function javaEqualsIgnoreCase(a, b) {
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    const ux = x.toUpperCase(), uy = y.toUpperCase();
    if (ux.length === 1 && uy.length === 1 && ux === uy) continue;
    if (ux.length === 1 && uy.length === 1 && ux.toLowerCase() === uy.toLowerCase()) continue;
    return false;
  }
  return true;
}

/** Character.isJavaIdentifierStart(int). */
export function javaIdentifierStart(cp) {
  return /[\p{L}\p{Nl}\p{Sc}\p{Pc}]/u.test(String.fromCodePoint(cp));
}

/** Character.isJavaIdentifierPart(int): letters, currency, connectors, digits, marks and identifier-ignorable chars. */
export function javaIdentifierPart(cp) {
  if ((cp >= 0 && cp <= 8) || (cp >= 0x0e && cp <= 0x1b) || (cp >= 0x7f && cp <= 0x9f)) return true;
  return /[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}]/u.test(String.fromCodePoint(cp));
}

/** Character.isISOControl(char). */
export const javaIsISOControl = (c) => (c >= 0 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f);

/** String.valueOf(x) as java.util.Formatter %s prints it. */
export function javaValueOf(x) {
  if (x === null || x === undefined) return 'null';
  if (x instanceof Dec) return x.toJavaString();
  if (Array.isArray(x) || x instanceof Set) return `[${[...x].map(javaValueOf).join(', ')}]`;
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : javaDoubleToString(x);
  return String(x);
}

/** java.util.Formatter subset used by the project (%s, %d, %%, %n). `% n` throws IllegalFormatFlagsException like the JDK. */
export function javaFormat(template, ...args) {
  let i = 0;
  let out = '';
  const re = /%([ #+0,(-]*)([sdn%])/g;
  let last = 0;
  let m;
  while ((m = re.exec(template))) {
    out += template.slice(last, m.index);
    last = re.lastIndex;
    const [, flags, conv] = m;
    if (conv === '%') { out += '%'; continue; }
    if (conv === 'n') {
      if (flags) { const e = new Error(`Flags = '${flags}'`); e.classeJava = 'IllegalFormatFlagsException'; throw e; }
      out += '\n';
      continue;
    }
    const a = args[i++];
    out += conv === 'd' ? (a === null || a === undefined ? 'null' : typeof a === 'bigint' ? a.toString() : a instanceof Dec ? a.toString() : String(a)) : javaValueOf(a);
  }
  return out + template.slice(last);
}

/** Double.toString(double) (JDK 19+: shortest repr; plain in [1e-3, 1e7), else d.dddE±n). */
export function javaDoubleToString(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  return formatarRepresentacaoJava(Math.abs(x).toExponential(), x < 0, Math.abs(x));
}

/** Float.toString(float) for a JS number (rounded to float32 first). */
export function javaFloatToString(x) {
  const f = Math.fround(x);
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return 'Infinity';
  if (f === -Infinity) return '-Infinity';
  if (f === 0) return Object.is(f, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(f);
  let s;
  for (let p = 1; p <= 9; p++) { s = abs.toPrecision(p); if (Math.fround(Number(s)) === abs) break; }
  return formatarRepresentacaoJava(Number(s).toExponential(), f < 0, abs);
}

function formatarRepresentacaoJava(exponencial, negativo, abs) {
  const [mant, ex] = exponencial.split('e');
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0';
  const e = Number(ex);
  const sinal = negativo ? '-' : '';
  if (abs >= 1e-3 && abs < 1e7) {
    let inteiro, frac;
    if (e >= 0) { const d = digits.padEnd(e + 1, '0'); inteiro = d.slice(0, e + 1); frac = d.slice(e + 1); } else { inteiro = '0'; frac = '0'.repeat(-e - 1) + digits; }
    return `${sinal}${inteiro}.${frac === '' ? '0' : frac}`;
  }
  return `${sinal}${digits[0]}.${digits.length > 1 ? digits.slice(1) : '0'}E${e}`;
}

const cont = (b) => (b & 0xc0) === 0x80;

/**
 * JDK UTF-8 decoder (sun.nio.cs.UTF_8). With `substituir` = CodingErrorAction.REPLACE each malformed
 * sequence becomes one U+FFFD with the JDK's malformed lengths; otherwise returns null on the first error
 * (CodingErrorAction.REPORT).
 */
export function decodificarUtf8Java(bytes, substituir = true) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  const falha = (len) => { if (!substituir) return false; out += '�'; i += len; return true; };
  while (i < n) {
    const b1 = bytes[i];
    if (b1 < 0x80) { out += String.fromCharCode(b1); i++; continue; }
    if ((b1 >> 5) === 0b110 && (b1 & 0x1e) !== 0) {
      if (n - i < 2) { if (!falha(n - i)) return null; continue; }
      const b2 = bytes[i + 1];
      if (!cont(b2)) { if (!falha(1)) return null; continue; }
      out += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
      i += 2;
      continue;
    }
    if ((b1 >> 4) === 0b1110) {
      const rest = n - i;
      if (rest < 3) {
        if (rest > 1 && ((b1 === 0xe0 && (bytes[i + 1] & 0xe0) === 0x80) || !cont(bytes[i + 1]))) { if (!falha(1)) return null; continue; }
        if (!falha(rest)) return null;
        continue;
      }
      const b2 = bytes[i + 1], b3 = bytes[i + 2];
      if ((b1 === 0xe0 && (b2 & 0xe0) === 0x80) || !cont(b2) || !cont(b3)) {
        const len = ((b1 === 0xe0 && (b2 & 0xe0) === 0x80) || !cont(b2)) ? 1 : 2;
        if (!falha(len)) return null;
        continue;
      }
      const c = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (c >= 0xd800 && c <= 0xdfff) { if (!falha(3)) return null; continue; }
      out += String.fromCharCode(c);
      i += 3;
      continue;
    }
    if ((b1 >> 3) === 0b11110) {
      const rest = n - i;
      const m42 = (b2) => (b1 === 0xf0 && (b2 < 0x90 || b2 > 0xbf)) || (b1 === 0xf4 && (b2 & 0xf0) !== 0x80) || !cont(b2);
      if (rest < 4) {
        if (b1 > 0xf4 || (rest > 1 && m42(bytes[i + 1]))) { if (!falha(1)) return null; continue; }
        if (rest > 2 && !cont(bytes[i + 2])) { if (!falha(2)) return null; continue; }
        if (!falha(rest)) return null;
        continue;
      }
      const b2 = bytes[i + 1], b3 = bytes[i + 2], b4 = bytes[i + 3];
      const uc = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      if (!cont(b2) || !cont(b3) || !cont(b4) || uc < 0x10000 || uc > 0x10ffff) {
        let len;
        if (b1 > 0xf4 || m42(b2)) len = 1; else if (!cont(b3)) len = 2; else len = 3;
        if (!falha(len)) return null;
        continue;
      }
      out += String.fromCodePoint(uc);
      i += 4;
      continue;
    }
    if (!falha(1)) return null;
  }
  return out;
}

/** ISO-8601 instant as Jackson 3 writes java.time.Instant (DateTimeFormatter.ISO_INSTANT, microsecond clock). */
export function instanteIso(agora = performance.timeOrigin + performance.now()) {
  const ms = Math.floor(agora);
  const base = new Date(ms).toISOString().slice(0, 19);
  const micros = Math.floor((agora - Math.floor(agora / 1000) * 1000) * 1000);
  if (micros === 0) return `${base}Z`;
  if (micros % 1000 === 0) return `${base}.${String(micros / 1000).padStart(3, '0')}Z`;
  return `${base}.${String(micros).padStart(6, '0')}Z`;
}

/** LocalDate validation (ISO_LOCAL_DATE, ResolverStyle STRICT) for a 'yyyy-MM-dd' text whose shape was already checked. */
export function dataIsoValida(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return false;
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || dia < 1) return false;
  const bissexto = (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];
  return dia <= dias;
}
