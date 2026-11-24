// Request-body reading as the official Simples API does it: Spring's Jackson 3 converter
// (UTF8StreamJsonParser + record deserialization, Spring Boot defaults: unknown properties
// ignored, trailing tokens ignored, scalar coercions allowed, StreamReadConstraints 500 deep /
// 1000-digit numbers). The parser is schema-directed, so type mismatches are raised at the same
// token Jackson raises them (before any later syntax error), with Jackson's original message.
// Any failure becomes HttpMessageNotReadableException("JSON parse error: <message>") → HTTP 400.
import { HttpMessageNotReadableException } from './spring.js';

/** A Jackson exception (StreamReadException / MismatchedInputException …): message = getOriginalMessage(). */
export class JacksonException extends Error {}

const LOC = '[Source: REDACTED (`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION` disabled); byte offset: #UNKNOWN]';
const VALORES_VALIDOS = "(JSON String, Number, Array, Object or token 'null', 'true' or 'false')";
const MAX_PROFUNDIDADE = 500;
const MAX_NUMERO = 1000;
const MAX_TOKEN_ERRO = 256;

const isISOControl = (cp) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
/** Character.isJavaIdentifierStart / isJavaIdentifierPart */
const ID_START = /^[\p{L}\p{Nl}\p{Sc}\p{Pc}]$/u;
const ID_PART = /^[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}\u0000-\u0008\u000E-\u001B\u007F-\u009F]$/u;
const idStart = (cp) => ID_START.test(String.fromCodePoint(cp));
const idPart = (cp) => ID_PART.test(String.fromCodePoint(cp));

/** ParserMinimalBase._getCharDesc */
function descreverChar(cp) {
  if (isISOControl(cp)) return `(CTRL-CHAR, code ${cp})`;
  const c = String.fromCodePoint(cp);
  return cp > 255 ? `'${c}' (code ${cp} / 0x${cp.toString(16)})` : `'${c}' (code ${cp})`;
}

const B = { ASPAS: 0x22, BARRA: 0x5c, VIRGULA: 0x2c, DOIS_PONTOS: 0x3a, ABRE_CH: 0x7b, FECHA_CH: 0x7d, ABRE_CO: 0x5b, FECHA_CO: 0x5d, MENOS: 0x2d, MAIS: 0x2b, PONTO: 0x2e, BARRA_N: 0x2f };
const digito = (b) => b >= 0x30 && b <= 0x39;

class Parser {
  constructor(bytes, inicio = 0) { this.b = bytes; this.i = inicio; this.token = null; this.profundidade = 0; }

  erro(msg) { return new JacksonException(msg); }
  /** _reportUnexpectedChar: `cp` is a decoded char in some call sites and the raw (first) byte in others, as in Jackson. */
  inesperado(cp, comentario) { return this.erro(`Unexpected character (${descreverChar(cp)}): ${comentario}`); }
  eof(msg) { return this.erro(`Unexpected end-of-input${msg}`); }
  eofToken() { return this.eof(` in ${this.token}`); }

  /** Code point at position (for error messages), decoding UTF-8 like _decodeCharForError. */
  cpEm(pos) {
    const b = this.b[pos];
    if (b < 0x80) return { cp: b, n: 1 };
    const r = this.utf8(pos);
    return { cp: r.cp, n: r.n };
  }

  /** Jackson's UTF-8 decoding of a multi-byte char (lead classes 2/3/4; no overlong/surrogate checks). */
  utf8(pos, eofMsg) {
    const c = this.b[pos];
    let n;
    if ((c & 0xe0) === 0xc0) n = 2; else if ((c & 0xf0) === 0xe0) n = 3; else if ((c & 0xf8) === 0xf0) n = 4;
    else throw this.erro(`Invalid UTF-8 start byte 0x${c.toString(16)}`);
    let cp = n === 2 ? c & 0x1f : n === 3 ? c & 0x0f : c & 0x07;
    for (let k = 1; k < n; k++) {
      if (pos + k >= this.b.length) throw eofMsg ? this.eof(eofMsg) : this.eofToken();
      const d = this.b[pos + k];
      if ((d & 0xc0) !== 0x80) throw this.erro(`Invalid UTF-8 middle byte 0x${d.toString(16)}`);
      cp = (cp << 6) | (d & 0x3f);
    }
    return { cp, n };
  }

  // ── whitespace (_skipWS / _skipWSOrEnd) ──
  pularEspacos() {
    while (this.i < this.b.length) {
      const c = this.b[this.i];
      if (c > 0x20) {
        if (c === B.BARRA_N) throw this.inesperado(c, "maybe a (non-standard) comment? (not recognized as one since Feature 'ALLOW_COMMENTS' not enabled for parser)");
        return c;
      }
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) {
        throw this.erro(`Illegal character (${descreverChar(c)}): only regular white space (\\r, \\n, \\t) is allowed between tokens`);
      }
      this.i++;
    }
    return -1;
  }
  pularEspacosOuErro(msg) {
    const c = this.pularEspacos();
    if (c < 0) throw this.eof(msg);
    return c;
  }

  // ── strings ──
  /** Reads after the opening quote; `onde` = 'string value' | 'name'. */
  lerString(onde) {
    const eofMsg = onde === 'name' ? ' in property name' : ' in VALUE_STRING';
    // _parseName: end of input right after the opening quote has its own message
    if (onde === 'name' && this.i >= this.b.length) throw this.eof(": was expecting closing '\"' for name");
    let out = '';
    for (;;) {
      if (this.i >= this.b.length) throw this.eof(eofMsg);
      const c = this.b[this.i];
      if (c === B.ASPAS) { this.i++; return out; }
      if (c === B.BARRA) { this.i++; out += this.lerEscape(); continue; }
      if (c < 0x20) throw this.erro(`Illegal unquoted character (${descreverChar(c)}): has to be escaped using backslash to be included in ${onde}`);
      if (c < 0x80) { out += String.fromCharCode(c); this.i++; continue; }
      const { cp, n } = this.utf8(this.i, eofMsg);
      this.i += n;
      if (cp > 0xffff) { const v = cp - 0x10000; out += String.fromCharCode(0xd800 | ((v >> 10) & 0x3ff), 0xdc00 | (v & 0x3ff)); } else out += String.fromCharCode(cp);
    }
  }
  lerEscape() {
    const eofEsc = ' in character escape sequence';
    if (this.i >= this.b.length) throw this.eof(eofEsc);
    const c = this.b[this.i++];
    switch (c) {
      case 0x62: return '\b';
      case 0x74: return '\t';
      case 0x6e: return '\n';
      case 0x66: return '\f';
      case 0x72: return '\r';
      case 0x22: case 0x2f: case 0x5c: return String.fromCharCode(c);
      case 0x75: {
        let v = 0;
        for (let k = 0; k < 4; k++) {
          if (this.i >= this.b.length) throw this.eof(eofEsc);
          const h = this.b[this.i++];
          const d = h >= 0x30 && h <= 0x39 ? h - 0x30 : h >= 0x41 && h <= 0x46 ? h - 55 : h >= 0x61 && h <= 0x66 ? h - 87 : -1;
          if (d < 0) throw this.inesperado(h, 'expected a hex-digit for character escape sequence');
          v = (v << 4) | d;
        }
        return String.fromCharCode(v);
      }
      default: {
        const { cp } = c < 0x80 ? { cp: c } : this.cpEm(this.i - 1);
        throw this.erro(`Unrecognized character escape ${descreverChar(cp)}`);
      }
    }
  }

  // ── literals and invalid tokens ──
  /** _reportInvalidToken: the matched part plus the following identifier chars. */
  tokenInvalido(parte) {
    let sb = parte;
    while (sb.length < MAX_TOKEN_ERRO && this.i < this.b.length) {
      const { cp, n } = this.cpEm(this.i);
      this.i += n;
      if (!idPart(cp)) break;
      sb += String.fromCodePoint(cp);
    }
    if (sb.length >= MAX_TOKEN_ERRO) sb += '...';
    return this.erro(`Unrecognized token '${sb}': was expecting ${VALORES_VALIDOS}`);
  }
  /** _matchToken(match, desde): the bytes after the first must spell `match`, not followed by an identifier char. */
  casar(match, desde) {
    for (let k = desde; k < match.length; k++) {
      if (this.i >= this.b.length || this.b[this.i] !== match.charCodeAt(k)) throw this.tokenInvalido(match.slice(0, k));
      this.i++;
    }
    if (this.i < this.b.length) {
      const c = this.b[this.i];
      if (c >= 0x30 && c !== B.FECHA_CO && c !== B.FECHA_CH && idPart(this.cpEm(this.i).cp)) throw this.tokenInvalido(match);
    }
  }

  // ── numbers ──
  numeroInvalido(cp, comentario) { return this.erro(`Unexpected character (${descreverChar(cp)}) in numeric value: ${comentario}`); }
  /** _handleInvalidNumberStart */
  inicioNumeroInvalido(ch, negativo, comSinal) {
    while (ch === 0x49) { // 'I'
      if (this.i >= this.b.length) throw this.eof(' in a Number value');
      ch = this.b[this.i++];
      let match;
      if (ch === 0x4e) match = negativo ? '-INF' : '+INF';
      else if (ch === 0x6e) match = negativo ? '-Infinity' : '+Infinity';
      else break;
      this.casar(match, 3);
      throw this.erro(`Non-standard token '${match}': enable \`JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS\` to allow`);
    }
    if (comSinal && !negativo) throw this.numeroInvalido(0x2b, 'JSON spec does not allow numbers to have plus signs: enable `JsonReadFeature.ALLOW_LEADING_PLUS_SIGN_FOR_NUMBERS` to allow');
    throw this.numeroInvalido(ch, negativo ? 'expected digit (0-9) to follow minus sign, for valid numeric value' : 'expected digit (0-9) for valid numeric value');
  }

  /** Number starting at this.i (first byte '-' or digit). Returns { t: INT|FLOAT, texto }. */
  lerNumero(raiz) {
    const inicio = this.i;
    let negativo = false;
    if (this.b[this.i] === B.MENOS) {
      negativo = true;
      this.i++;
      if (this.i >= this.b.length) throw this.eofToken();
      const c = this.b[this.i];
      if (!digito(c)) { this.i++; return this.inicioNumeroInvalido(c, true, true); }
    }
    let intLen = 0;
    if (this.b[this.i] === 0x30) {
      this.i++; intLen = 1;
      if (this.i < this.b.length && digito(this.b[this.i])) throw this.erro('Invalid numeric value: Leading zeroes not allowed');
    } else {
      while (this.i < this.b.length && digito(this.b[this.i])) { this.i++; intLen++; }
    }
    let flutuante = false, fracLen = 0, expLen = 0;
    if (this.i < this.b.length && this.b[this.i] === B.PONTO) {
      flutuante = true;
      this.i++;
      while (this.i < this.b.length && digito(this.b[this.i])) { this.i++; fracLen++; }
      if (fracLen === 0) {
        throw this.numeroInvalido(this.i < this.b.length ? this.b[this.i] : B.PONTO, 'Decimal point not followed by a digit');
      }
    }
    if (this.i < this.b.length && (this.b[this.i] === 0x65 || this.b[this.i] === 0x45)) {
      flutuante = true;
      this.i++;
      if (this.i >= this.b.length) throw this.eofToken();
      if (this.b[this.i] === B.MENOS || this.b[this.i] === B.MAIS) {
        this.i++;
        if (this.i >= this.b.length) throw this.eofToken();
      }
      while (this.i < this.b.length && digito(this.b[this.i])) { this.i++; expLen++; }
      if (expLen === 0) throw this.numeroInvalido(this.b[this.i], 'Exponent indicator not followed by a digit');
    }
    const comprimento = flutuante ? intLen + fracLen + expLen : intLen;
    if (comprimento > MAX_NUMERO) throw this.erro(`Number value length (${comprimento}) exceeds the maximum allowed (${MAX_NUMERO}, from \`StreamReadConstraints.getMaxNumberLength()\`)`);
    if (raiz && this.i < this.b.length) { // _verifyRootSpace
      const c = this.b[this.i];
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) throw this.inesperado(c, 'Expected space separating root-level values');
    }
    const texto = new TextDecoder().decode(this.b.subarray(inicio, this.i));
    this.token = flutuante ? 'VALUE_NUMBER_FLOAT' : 'VALUE_NUMBER_INT';
    return { t: this.token, texto };
  }

  // ── tokens ──
  abrir(t) {
    this.i++;
    this.profundidade++;
    if (this.profundidade > MAX_PROFUNDIDADE) throw this.erro(`Document nesting depth (${this.profundidade}) exceeds the maximum allowed (${MAX_PROFUNDIDADE}, from \`StreamReadConstraints.getMaxNestingDepth()\`)`);
    this.token = t;
    return { t };
  }
  /** Next value token starting at byte c; ctx = 'raiz' | 'objeto' | 'array'. Containers are only opened. */
  lerToken(c, ctx) {
    switch (c) {
      case B.ASPAS: this.i++; this.token = 'VALUE_STRING'; return { t: 'VALUE_STRING', texto: this.lerString('string value') };
      case B.ABRE_CO: return this.abrir('START_ARRAY');
      case B.ABRE_CH: return this.abrir('START_OBJECT');
      case 0x74: this.i++; this.casar('true', 1); this.token = 'VALUE_TRUE'; return { t: 'VALUE_TRUE' };
      case 0x66: this.i++; this.casar('false', 1); this.token = 'VALUE_FALSE'; return { t: 'VALUE_FALSE' };
      case 0x6e: this.i++; this.casar('null', 1); this.token = 'VALUE_NULL'; return { t: 'VALUE_NULL' };
      default:
        if (c === B.MENOS || digito(c)) return this.lerNumero(ctx === 'raiz');
        return this.valorEstranho(c, ctx);
    }
  }
  /** _handleOddValue / _handleUnexpectedValue */
  valorEstranho(c, ctx) {
    switch (c) {
      case B.FECHA_CO: if (ctx !== 'array') break; // falls through
      case B.VIRGULA: // falls through
      case B.FECHA_CH: throw this.inesperado(c, 'expected a value');
      case 0x27: break;
      case 0x4e: this.i++; this.casar('NaN', 1); throw this.erro("Non-standard token 'NaN': enable `JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS` to allow");
      case 0x49: this.i++; this.casar('Infinity', 1); throw this.erro("Non-standard token 'Infinity': enable `JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS` to allow");
      case B.MAIS:
        this.i++;
        if (this.i >= this.b.length) throw this.eof(' in a Number value');
        return this.inicioNumeroInvalido(this.b[this.i++], false, true);
      default: break;
    }
    const { cp, n } = this.cpEm(this.i);
    if (idStart(cp)) { this.i += n; throw this.tokenInvalido(String.fromCodePoint(cp)); }
    throw this.inesperado(cp, `expected a valid value ${VALORES_VALIDOS}`);
  }

  /** Object members after '{'; `campo(nome, c)` reads the value whose first byte is c. */
  lerMembros(campo) {
    for (let primeiro = true; ; primeiro = false) {
      let c = this.pularEspacos();
      if (c < 0) throw this.eof(`: expected close marker for Object (start marker at ${LOC})`);
      if (c === B.FECHA_CH) { this.i++; this.profundidade--; this.token = 'END_OBJECT'; return; }
      if (c === B.FECHA_CO) throw this.erro(`Unexpected close marker ']': expected '}' (for Object starting at ${LOC})`);
      if (!primeiro) {
        if (c !== B.VIRGULA) throw this.inesperado(c, 'was expecting comma to separate Object entries'); // raw byte, like _skipComma
        this.i++;
        c = this.pularEspacosOuErro(' within/between Object entries');
      }
      if (c !== B.ASPAS) throw this.inesperado(this.cpEm(this.i).cp, 'was expecting double-quote to start property name');
      this.i++;
      const nome = this.lerString('name');
      this.token = 'PROPERTY_NAME';
      c = this.pularEspacosOuErro(' within/between Object entries');
      if (c !== B.DOIS_PONTOS) throw this.inesperado(c, 'was expecting a colon to separate property name and value'); // raw byte
      this.i++;
      c = this.pularEspacosOuErro(' within/between Object entries');
      campo(nome, c);
    }
  }
  /** Array elements after '['; `elemento(c)` reads the value whose first byte is c. */
  lerElementos(elemento) {
    for (let primeiro = true; ; primeiro = false) {
      let c = this.pularEspacos();
      if (c < 0) throw this.eof(`: expected close marker for Array (start marker at ${LOC})`);
      if (c === B.FECHA_CO) { this.i++; this.profundidade--; this.token = 'END_ARRAY'; return; }
      if (c === B.FECHA_CH) throw this.erro(`Unexpected close marker '}': expected ']' (for Array starting at ${LOC})`);
      if (!primeiro) {
        if (c !== B.VIRGULA) throw this.inesperado(c, 'was expecting comma to separate Array entries'); // raw byte
        this.i++;
        c = this.pularEspacosOuErro(' within/between Array entries');
      }
      elemento(c);
    }
  }

  /** skipChildren of an ignored (unknown) property, validating the syntax like Jackson. */
  pular(c, ctx) {
    const tk = this.lerToken(c, ctx);
    if (tk.t === 'START_OBJECT') this.lerMembros((_, v) => this.pular(v, 'objeto'));
    else if (tk.t === 'START_ARRAY') this.lerElementos((v) => this.pular(v, 'array'));
  }

  // ── binding (schema-directed) ──
  ler(tipo, c, ctx) {
    if (tipo.k === 'ignorar') { this.pular(c, ctx); return undefined; }
    const tk = this.lerToken(c, ctx);
    if (tk.t === 'VALUE_NULL') return null;
    switch (tipo.k) {
      case 'string': return this.comoString(tk);
      case 'integer': return this.comoInteger(tk);
      case 'boolean': return this.comoBoolean(tk);
      case 'lista': return this.comoLista(tipo, tk);
      case 'registro': return this.comoRegistro(tipo, tk);
      default: throw new Error(`tipo desconhecido ${tipo.k}`);
    }
  }
  naoDesserializa(classe, tk) {
    const desc = { START_OBJECT: 'Object value', START_ARRAY: 'Array value', VALUE_STRING: 'String value', VALUE_NUMBER_INT: 'Integer value', VALUE_NUMBER_FLOAT: 'Floating-point value', VALUE_TRUE: 'Boolean value', VALUE_FALSE: 'Boolean value' }[tk.t];
    return this.erro(`Cannot deserialize value of type \`${classe}\` from ${desc} (token \`JsonToken.${tk.t}\`)`);
  }
  comoString(tk) {
    switch (tk.t) {
      case 'VALUE_STRING': case 'VALUE_NUMBER_INT': case 'VALUE_NUMBER_FLOAT': return tk.texto;
      case 'VALUE_TRUE': return 'true';
      case 'VALUE_FALSE': return 'false';
      default: throw this.naoDesserializa('java.lang.String', tk);
    }
  }
  comoInteger(tk) {
    const C = 'java.lang.Integer';
    const foraInt = (texto) => this.erro(`Numeric value (${texto}) out of range of \`int\` (-2147483648 - 2147483647)`);
    switch (tk.t) {
      case 'VALUE_NUMBER_INT': {
        const v = BigInt(tk.texto);
        if (v < -2147483648n || v > 2147483647n) throw foraInt(tk.texto);
        return Number(v);
      }
      case 'VALUE_NUMBER_FLOAT': {
        const d = Number(tk.texto);
        if (!(d >= -2147483648 && d <= 2147483647)) throw foraInt(tk.texto);
        return Math.trunc(d) + 0;
      }
      case 'VALUE_STRING': {
        if (brancoJackson(tk.texto)) return null;
        const t = javaTrim(tk.texto);
        if (t === 'null') return null;
        const invalido = () => this.erro(`Cannot deserialize value of type \`${C}\` from String "${t}": not a valid \`${C}\` value`);
        if (t.length > 9) {
          const l = parseInteiroJava(t, -(2n ** 63n), 2n ** 63n - 1n);
          if (l == null) throw invalido();
          if (l < -2147483648n || l > 2147483647n) throw this.erro(`Cannot deserialize value of type \`${C}\` from String "${t}": Overflow: numeric value (${t}) out of range of \`${C}\` (-2147483648 -2147483647)`);
          return Number(l);
        }
        const n = parseInteiroJava(t, -2147483648n, 2147483647n);
        if (n == null) throw invalido();
        return Number(n);
      }
      default: throw this.naoDesserializa(C, tk);
    }
  }
  comoBoolean(tk) {
    const C = 'java.lang.Boolean';
    switch (tk.t) {
      case 'VALUE_TRUE': return true;
      case 'VALUE_FALSE': return false;
      case 'VALUE_NUMBER_INT': return BigInt(tk.texto) !== 0n;
      case 'VALUE_STRING': {
        if (brancoJackson(tk.texto)) return null;
        const t = javaTrim(tk.texto);
        if (t === 'true' || t === 'TRUE' || t === 'True') return true;
        if (t === 'false' || t === 'FALSE' || t === 'False') return false;
        if (t === 'null') return null;
        throw this.erro(`Cannot deserialize value of type \`${C}\` from String "${t}": only "true" or "false" recognized`);
      }
      default: throw this.naoDesserializa(C, tk);
    }
  }
  comoLista(tipo, tk) {
    if (tk.t !== 'START_ARRAY') throw this.naoDesserializa(`java.util.ArrayList<${tipo.elemento.classe}>`, tk);
    const lista = [];
    this.lerElementos((c) => lista.push(this.ler(tipo.elemento, c, 'array')));
    return lista;
  }
  comoRegistro(tipo, tk) {
    const C = tipo.classe;
    const criador = (arg, valor) => this.erro(`Cannot construct instance of \`${C}\` (although at least one Creator exists): no ${arg}-argument constructor/factory method to deserialize from ${valor}`);
    switch (tk.t) {
      case 'START_OBJECT': {
        const r = Object.fromEntries(Object.keys(tipo.campos).map((k) => [k, null]));
        this.lerMembros((nome, c) => {
          const canonico = tipo.nomes[nome];
          if (canonico === undefined) { this.pular(c, 'objeto'); return; }
          r[canonico] = this.ler(tipo.campos[canonico], c, 'objeto');
        });
        return r;
      }
      case 'START_ARRAY': throw this.naoDesserializa(C, tk);
      case 'VALUE_STRING':
        if (brancoJackson(tk.texto)) throw this.erro(`Cannot coerce empty String ("") to \`${C}\` value (but could if coercion was enabled using \`CoercionConfig\`)`);
        throw criador('String', `String value ('${javaTrim(tk.texto)}')`);
      case 'VALUE_NUMBER_INT': {
        const v = BigInt(tk.texto);
        const arg = v >= -2147483648n && v <= 2147483647n ? 'int/Int' : v >= -(2n ** 63n) && v < 2n ** 63n ? 'long/Long' : 'BigInteger';
        throw criador(arg, `Number value (${v})`);
      }
      case 'VALUE_NUMBER_FLOAT': throw criador('double/Double', `Number value (${doubleJava(Number(tk.texto))})`);
      default: throw criador('boolean/Boolean', `boolean value (${tk.t === 'VALUE_TRUE'})`);
    }
  }
}

/** StdDeserializer._isBlank: every char <= U+0020 (empty included). */
const brancoJackson = (s) => [...s].every((c) => c.charCodeAt(0) <= 0x20);
const javaTrim = (s) => s.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');

/** Value of a Unicode decimal digit (Character.digit(c, 10)) or -1; Nd runs are 10 contiguous code points. */
function valorDigito(cp) {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  if (!/^\p{Nd}$/u.test(String.fromCodePoint(cp))) return -1;
  let zero = cp;
  while (zero > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return (cp - zero) % 10;
}
/** Integer.parseInt / Long.parseLong (radix 10, char-based): BigInt or null when Java would throw. */
export function parseInteiroJava(s, min, max) {
  if (s.length === 0) return null;
  let i = 0, neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; i = 1; if (s.length === 1) return null; }
  let n = 0n;
  for (; i < s.length; i++) {
    const d = valorDigito(s.charCodeAt(i));
    if (d < 0) return null;
    n = n * 10n + BigInt(d);
    if (n > -min) return null;
  }
  if (neg) n = -n;
  return n < min || n > max ? null : n;
}

/** Double.toString(double) */
export function doubleJava(d) {
  if (Number.isNaN(d)) return 'NaN';
  if (!Number.isFinite(d)) return d > 0 ? 'Infinity' : '-Infinity';
  if (d === 0) return Object.is(d, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(d);
  if (abs >= 1e-3 && abs < 1e7) {
    const s = String(d);
    return s.includes('.') ? s : `${s}.0`;
  }
  const [mantissa, expoente] = d.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(expoente)}`;
}

/**
 * Reads the @RequestBody of a POST: empty body or JSON null → "Required request body is missing";
 * any Jackson failure → "JSON parse error: …" (HttpMessageNotReadableException).
 * @param {Uint8Array} bytes raw request body
 * @param {object} tipoRaiz record schema (see TIPOS)
 * @param {string} assinatura Method.toGenericString() of the controller method
 */
export function lerCorpoJson(bytes, tipoRaiz, assinatura) {
  const ausente = () => new HttpMessageNotReadableException(`Required request body is missing: ${assinatura}`);
  if (bytes.length === 0) throw ausente();
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const p = new Parser(bytes, bom);
  let valor;
  try {
    const c = p.pularEspacos();
    if (c < 0) throw p.erro('No content to map due to end-of-input');
    if (c === B.FECHA_CO) throw p.erro("Unexpected close marker ']': no open Array to close");
    if (c === B.FECHA_CH) throw p.erro("Unexpected close marker '}': no open Object to close");
    valor = p.ler(tipoRaiz, c, 'raiz');
  } catch (e) {
    if (e instanceof JacksonException) throw new HttpMessageNotReadableException(`JSON parse error: ${e.message}`);
    throw e;
  }
  if (valor == null) throw ausente();
  return valor;
}

// ── DTO schemas of model/input (record components, @JsonProperty names and @JsonAlias) ──
const PKG = 'br.gov.serpro.rtc.api.simplesnacional.model.input.';
const S = { k: 'string' }, I = { k: 'integer' }, BOOL = { k: 'boolean' };
/** campos: canonical JSON name → type; aliases: alias → canonical. */
function registro(classe, campos, aliases = {}) {
  const nomes = Object.fromEntries(Object.keys(campos).map((k) => [k, k]));
  Object.assign(nomes, aliases);
  return { k: 'registro', classe, campos, nomes: Object.assign(Object.create(null), nomes) };
}
const lista = (elemento) => ({ k: 'lista', elemento });

const ParAliquotasInput = registro(`${PKG}AliquotasEfetivasInput$ParAliquotasInput`, { pCBSSN: S, pIBSSN: S });
const AnexoParUnicoInput = registro(`${PKG}AliquotasEfetivasInput$AnexoParUnicoInput`, { pCBSSN: S, pIBSSN: S });
const AnexoComIssInput = registro(`${PKG}AliquotasEfetivasInput$AnexoComIssInput`, { pCBSSN: S, pIBSSN: S, semRedistribuicaoISS: ParAliquotasInput });
const AliquotasEfetivasInput = registro(`${PKG}AliquotasEfetivasInput`, {
  fatorR: BOOL, impedimentoSublimite: BOOL, anexoI: AnexoParUnicoInput, anexoII: AnexoParUnicoInput,
  anexoIII: AnexoComIssInput, anexoIV: AnexoComIssInput, anexoV: AnexoComIssInput,
});
const ItemSimplesInput = registro(`${PKG}ItemSimplesInput`, {
  numero: I, cAtivSN: S, cClassTrib: S, nbs: S, ncm: S, baseCalculo: S, valorImpostoSeletivo: S, pIBSSN: S, pCBSSN: S,
}, { NBS: 'nbs', NCM: 'ncm' });
const ItemSimplesUnificadoInput = registro(`${PKG}ItemSimplesUnificadoInput`, {
  numero: I, cAtivSN: S, cClassTrib: S, nbs: S, ncm: S, baseCalculo: S, valorImpostoSeletivo: S, tribISSQN: S, tpRetISSQN: S, tpBM: S,
}, { NBS: 'nbs', NCM: 'ncm' });

export const TIPOS = Object.freeze({
  OperacaoSimplesInput: registro(`${PKG}OperacaoSimplesInput`, {
    id: S, versao: S, data: S, tpDoc: S, CRT: S, tpRegimeIBSCBS: S, tpEnteGov: S, itens: lista(ItemSimplesInput),
  }),
  OperacaoSimplesNaoAssistidaInput: registro(`${PKG}OperacaoSimplesNaoAssistidaInput`, {
    id: S, versao: S, data: S, tpDoc: S, CRT: S, tpRegimeIBSCBS: S, opSimpNac: S, regApIBSCBSSN: S, regApTribSN: S, tpEnteGov: S,
    aliquotasEfetivas: AliquotasEfetivasInput, itens: lista(ItemSimplesUnificadoInput),
  }),
  ItemSimplesUnificadoInput,
});

/** Method.toGenericString() of the two @RequestBody controller methods (SimplesNacionalController). */
export const ASSINATURAS = Object.freeze({
  classico: 'public org.springframework.http.ResponseEntity<br.gov.serpro.rtc.api.simplesnacional.model.output.ObservabilidadeSimplesDomain> br.gov.serpro.rtc.api.simplesnacional.controller.SimplesNacionalController.calcularTributosSimplesNacional(br.gov.serpro.rtc.api.simplesnacional.model.input.OperacaoSimplesInput)',
  naoAssistido: 'public org.springframework.http.ResponseEntity<br.gov.serpro.rtc.api.simplesnacional.model.output.ObservabilidadeSimplesDomain> br.gov.serpro.rtc.api.simplesnacional.controller.SimplesNacionalController.calcularTributosSimplesNacionalNaoAssistido(br.gov.serpro.rtc.api.simplesnacional.model.input.OperacaoSimplesNaoAssistidaInput)',
});
