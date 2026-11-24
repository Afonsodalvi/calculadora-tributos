// JSON with Jackson 3.1.7 parity (calculadora-rtc-regime-regular, Spring Boot 4.1.2).
//
// Reader: a port of the token rules of jackson-core's UTF8StreamJsonParser (byte input, the
// error texts the oracle returns, StreamReadConstraints limits) that builds a tree keeping
// - the number LEXEME and the token type (JsonNum: VALUE_NUMBER_INT / VALUE_NUMBER_FLOAT),
// - every object entry in document order, duplicates included (JsonObj.entradas),
// - a syntax error found after a value as a PENDING error on every container still open
//   (erroPendente): Jackson binds while it streams, so a coercion error that comes earlier in
//   the document wins over a later syntax error. The binders below walk the tree in document
//   order and throw the pending error when they reach the end of an incomplete container.
//
// Binders (comoString, comoInteger, comoLong, comoBigDecimal, comoEnumValor, comoObjeto,
// comoLista, comoDataHora, comoData...) reproduce Jackson's coercions and messages per Java
// target type. lerCorpoRequisicao() is Spring's @RequestBody pipeline (empty body, "JSON parse
// error: " prefix, trailing tokens, literal null).
//
// Writer: escreverJson() with Jackson's output (insertion order, no spaces, uppercase \uXXXX,
// lone surrogates escaped, '/' not escaped, BigDecimal (Dec) as a raw number via toString()).
import { Dec } from '../../core/decimal.js';
import { javaTrim, javaIdentifierStart, javaIdentifierPart, javaIsISOControl, javaDoubleToString, dataIsoValida } from './java.js';
import { ErroJava } from './problema.js';

// ─── Tree ──────────────────────────────────────────────────────────────────

/** Number token: exact lexeme + whether Jackson reports it as VALUE_NUMBER_INT. */
export class JsonNum {
  constructor(src, inteiro) { this.src = src; this.inteiro = inteiro; }
  toString() { return this.src; }
}

/** Object node: entries in document order (duplicate keys kept; Jackson binds each in turn, the last wins). */
export class JsonObj {
  constructor() { this.entradas = []; this.erroPendente = null; }
  /** Last value of the key (undefined when absent). */
  get(k) { for (let i = this.entradas.length - 1; i >= 0; i--) if (this.entradas[i][0] === k) return this.entradas[i][1]; return undefined; }
  has(k) { return this.entradas.some((e) => e[0] === k); }
}

/** Array node. */
export class JsonArr {
  constructor() { this.itens = []; this.erroPendente = null; }
}

/** A Jackson JacksonException: `message` is getOriginalMessage() (no location suffix). */
export class ErroJson extends Error {
  constructor(mensagem) { super(mensagem); this.name = 'ErroJson'; }
}

const LOCAL = '[Source: REDACTED (`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION` disabled); byte offset: #UNKNOWN]';
const LISTA_TOKENS = "(JSON String, Number, Array, Object or token 'null', 'true' or 'false')";
const MAX_PROFUNDIDADE = 500;
const MAX_NUMERO = 1000;
const MAX_NOME = 50000;
const MAX_TOKEN_ERRO = 256;

/** ParserMinimalBase._getCharDesc. */
function descricaoChar(ch) {
  const c = ch & 0xffff;
  const s = String.fromCharCode(c);
  if (javaIsISOControl(c)) return `(CTRL-CHAR, code ${ch})`;
  if (ch > 255) return `'${s}' (code ${ch} / 0x${ch.toString(16)})`;
  return `'${s}' (code ${ch})`;
}

const hex = (b) => b.toString(16);

class Leitor {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
    this.n = bytes.length;
    /** Jackson's _currToken (null at the root before the first token and after EOF). */
    this.atual = null;
    /** Contexts: { tipo: 'ROOT'|'ARRAY'|'OBJECT', indice } (TokenStreamContext). */
    this.ctx = [{ tipo: 'ROOT', indice: -1 }];
    /** Value parsed eagerly right after a property name (UTF8StreamJsonParser._nextToken). */
    this.pendente = null;
    this.texto = null;
  }

  erro(msg) { return new ErroJson(msg); }
  get topo() { return this.ctx[this.ctx.length - 1]; }
  descTipo(c = this.topo) { return c.tipo === 'ARRAY' ? 'Array' : c.tipo === 'OBJECT' ? 'Object' : 'root'; }

  inesperado(ch, comentario) {
    let msg = `Unexpected character (${descricaoChar(ch)})`;
    if (comentario != null) msg += `: ${comentario}`;
    return this.erro(msg);
  }
  inesperadoNumero(ch, comentario) { return this.erro(`Unexpected character (${descricaoChar(ch)}) in numeric value: ${comentario}`); }
  eof(sufixo) { return this.erro(`Unexpected end-of-input${sufixo}`); }
  eofAtual() { return this.eof(` in ${this.atual}`); }

  // _decodeCharForError
  decodificarParaErro(primeiro) {
    let c = primeiro & 0xff;
    if (c <= 0x7f) return c;
    let faltam;
    if ((c & 0xe0) === 0xc0) { c &= 0x1f; faltam = 1; }
    else if ((c & 0xf0) === 0xe0) { c &= 0x0f; faltam = 2; }
    else if ((c & 0xf8) === 0xf0) { c &= 0x07; faltam = 3; }
    else throw this.erro(`Invalid UTF-8 start byte 0x${hex(c)}`);
    for (let k = 0; k < faltam; k++) {
      if (this.p >= this.n) throw this.eofAtual();
      const d = this.b[this.p++];
      if ((d & 0xc0) !== 0x80) throw this.erro(`Invalid UTF-8 middle byte 0x${hex(d)}`);
      c = (c << 6) | (d & 0x3f);
    }
    return c;
  }

  // _reportInvalidToken(matchedPart, msg)
  tokenInvalido(parcial) {
    let sb = parcial;
    while (this.p < this.n) {
      const i = this.b[this.p++];
      const c = this.decodificarParaErro(i) & 0xffff;
      if (!javaIdentifierPart(c)) break;
      sb += String.fromCharCode(c);
      if (sb.length >= MAX_TOKEN_ERRO) { sb += '...'; break; }
    }
    return this.erro(`Unrecognized token '${sb}': was expecting ${LISTA_TOKENS}`);
  }

  // _skipWSOrEnd: -1 at EOF (after _handleEOF)
  pularEspacosOuFim() {
    while (this.p < this.n) {
      const i = this.b[this.p++];
      if (i > 0x20) {
        if (i === 0x2f) throw this.inesperado(i, "maybe a (non-standard) comment? (not recognized as one since Feature 'ALLOW_COMMENTS' not enabled for parser)");
        return i;
      }
      if (i !== 0x20 && i !== 0x0a && i !== 0x0d && i !== 0x09) throw this.espacoInvalido(i);
    }
    if (this.topo.tipo !== 'ROOT') {
      throw this.eof(`: expected close marker for ${this.topo.tipo === 'ARRAY' ? 'Array' : 'Object'} (start marker at ${LOCAL})`);
    }
    return -1;
  }

  // _skipWS (EOF = error "within/between ... entries")
  pularEspacos() {
    while (this.p < this.n) {
      const i = this.b[this.p++];
      if (i > 0x20) {
        if (i === 0x2f) throw this.inesperado(i, "maybe a (non-standard) comment? (not recognized as one since Feature 'ALLOW_COMMENTS' not enabled for parser)");
        return i;
      }
      if (i !== 0x20 && i !== 0x0a && i !== 0x0d && i !== 0x09) throw this.espacoInvalido(i);
    }
    throw this.eof(` within/between ${this.descTipo()} entries`);
  }

  // _throwInvalidSpace (the RS hint is appended for U+001E)
  espacoInvalido(i) {
    let msg = `Illegal character (${descricaoChar(i)}): only regular white space (\\r, \\n, \\t) is allowed between tokens`;
    if (i === 0x1e) msg += ' (consider enabling `JsonReadFeature.ALLOW_RS_CONTROL_CHAR` to allow use of Record Separators (\\u001E))';
    return this.erro(msg);
  }

  expectComma() {
    const c = this.topo;
    const ix = ++c.indice;
    return c.tipo !== 'ROOT' && ix > 0;
  }

  abrir(tipo) {
    this.ctx.push({ tipo, indice: -1 });
    const prof = this.ctx.length - 1;
    if (prof > MAX_PROFUNDIDADE) throw this.erro(`Document nesting depth (${prof}) exceeds the maximum allowed (${MAX_PROFUNDIDADE}, from \`StreamReadConstraints.getMaxNestingDepth()\`)`);
  }

  fecharEscopo(i) {
    const c = this.topo;
    if (i === 0x5d) {
      if (c.tipo !== 'ARRAY') this.marcadorFinalErrado(i, '}');
      this.ctx.pop();
      this.atual = 'END_ARRAY';
    } else {
      if (c.tipo !== 'OBJECT') this.marcadorFinalErrado(i, ']');
      this.ctx.pop();
      this.atual = 'END_OBJECT';
    }
  }

  marcadorFinalErrado(i, esperado) {
    const c = this.topo;
    if (c.tipo === 'ROOT') throw this.erro(`Unexpected close marker '${String.fromCharCode(i)}': no open ${i === 0x7d ? 'Object' : 'Array'} to close`);
    throw this.erro(`Unexpected close marker '${String.fromCharCode(i)}': expected '${esperado}' (for ${this.descTipo(c)} starting at ${LOCAL})`);
  }

  /** JsonParser.nextToken(): returns the token name or null at EOF. Scalar text in this.texto. */
  proximoToken() {
    if (this.atual === 'PROPERTY_NAME') return this.depoisDoNome();
    let i = this.pularEspacosOuFim();
    if (i < 0) { this.atual = null; return null; }
    if (i === 0x5d || i === 0x7d) { this.fecharEscopo(i); return this.atual; }
    if (this.expectComma()) {
      if (i !== 0x2c) throw this.inesperado(i, `was expecting comma to separate ${this.descTipo()} entries`);
      i = this.pularEspacos();
    }
    if (this.topo.tipo !== 'OBJECT') return this.tokenForaDeObjeto(i);
    // property name, then the value (eager for everything but strings)
    const nome = this.lerNome(i);
    this.topo.nome = nome;
    this.atual = 'PROPERTY_NAME';
    i = this.pularDoisPontos();
    switch (i) {
      case 0x22: this.pendente = 'VALUE_STRING'; break;
      case 0x5b: this.pendente = 'START_ARRAY'; break;
      case 0x7b: this.pendente = 'START_OBJECT'; break;
      case 0x7d: throw this.inesperado(i, 'expected a value');
      case 0x74: this.casarLiteral('true'); this.pendente = 'VALUE_TRUE'; break;
      case 0x66: this.casarLiteral('false'); this.pendente = 'VALUE_FALSE'; break;
      case 0x6e: this.casarLiteral('null'); this.pendente = 'VALUE_NULL'; break;
      case 0x2d: this.pendente = this.numeroComSinal(); break;
      case 0x2e: this.pendente = this.valorInesperado(i); break;
      default:
        if (i >= 0x30 && i <= 0x39) this.pendente = this.numeroSemSinal(i);
        else this.pendente = this.valorInesperado(i);
    }
    return 'PROPERTY_NAME';
  }

  depoisDoNome() {
    const t = this.pendente;
    this.pendente = null;
    if (t === 'START_ARRAY') this.abrir('ARRAY');
    else if (t === 'START_OBJECT') this.abrir('OBJECT');
    this.atual = t;
    if (t === 'VALUE_STRING') this.texto = this.lerString();
    return t;
  }

  tokenForaDeObjeto(i) {
    switch (i) {
      case 0x22: this.atual = 'VALUE_STRING'; this.texto = this.lerString(); return this.atual;
      case 0x5b: this.abrir('ARRAY'); this.atual = 'START_ARRAY'; return this.atual;
      case 0x7b: this.abrir('OBJECT'); this.atual = 'START_OBJECT'; return this.atual;
      case 0x74: this.casarLiteral('true'); this.atual = 'VALUE_TRUE'; return this.atual;
      case 0x66: this.casarLiteral('false'); this.atual = 'VALUE_FALSE'; return this.atual;
      case 0x6e: this.casarLiteral('null'); this.atual = 'VALUE_NULL'; return this.atual;
      case 0x2d: this.atual = this.numeroComSinal(); return this.atual;
      default:
        if (i >= 0x30 && i <= 0x39) { this.atual = this.numeroSemSinal(i); return this.atual; }
        this.atual = this.valorInesperado(i);
        return this.atual;
    }
  }

  // _handleUnexpectedValue
  valorInesperado(c) {
    switch (c) {
      case 0x5d: if (this.topo.tipo !== 'ARRAY') break; // falls through
      case 0x2c: case 0x7d: throw this.inesperado(c, 'expected a value');
      case 0x4e: this.casarToken('NaN', 1); throw this.erro("Non-standard token 'NaN': enable `JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS` to allow");
      case 0x49: this.casarToken('Infinity', 1); throw this.erro("Non-standard token 'Infinity': enable `JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS` to allow");
      case 0x2b:
        if (this.p >= this.n) throw this.eof(' in a Number value');
        return this.inicioNumeroInvalido(this.b[this.p++], false, true);
      default:
    }
    if (c >= 0x80) c = this.decodificarParaErro(c);
    if (javaIdentifierStart(c)) throw this.tokenInvalido(String.fromCharCode(c & 0xffff));
    throw this.inesperado(c, `expected a valid value ${LISTA_TOKENS}`);
  }

  // _matchTrue/_matchFalse/_matchNull (+ _matchToken2/_checkMatchEnd); the first char was consumed
  casarLiteral(lit) { this.casarToken(lit, 1); }

  casarToken(lit, i) {
    for (; i < lit.length; i++) {
      if (this.p >= this.n || this.b[this.p] !== lit.charCodeAt(i)) throw this.tokenInvalido(lit.slice(0, i));
      this.p++;
    }
    if (this.p >= this.n) return;
    const ch = this.b[this.p];
    if (ch >= 0x30 && ch !== 0x5d && ch !== 0x7d) {
      const salvo = this.p;
      this.p++;
      const c = this.decodificarParaErro(ch) & 0xffff;
      this.p = salvo;
      if (javaIdentifierPart(c)) throw this.tokenInvalido(lit);
    }
  }

  // _handleInvalidNumberStart
  inicioNumeroInvalido(ch, neg, temSinal) {
    while (ch === 0x49) {
      if (this.p >= this.n) throw this.eof(' in a Number value');
      ch = this.b[this.p++];
      let lit;
      if (ch === 0x4e) lit = neg ? '-INF' : '+INF';
      else if (ch === 0x6e) lit = neg ? '-Infinity' : '+Infinity';
      else break;
      this.casarToken(lit, 3);
      throw this.erro(`Non-standard token '${lit}': enable \`JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS\` to allow`);
    }
    if (temSinal && !neg) throw this.inesperadoNumero(0x2b, 'JSON spec does not allow numbers to have plus signs: enable `JsonReadFeature.ALLOW_LEADING_PLUS_SIGN_FOR_NUMBERS` to allow');
    throw this.inesperadoNumero(ch, neg ? 'expected digit (0-9) to follow minus sign, for valid numeric value' : 'expected digit (0-9) for valid numeric value');
  }

  // _verifyNoLeadingZeroes (the '0' was consumed)
  semZerosAEsquerda() {
    if (this.p >= this.n) return;
    const ch = this.b[this.p];
    if (ch < 0x30 || ch > 0x39) return;
    throw this.erro('Invalid numeric value: Leading zeroes not allowed');
  }

  numeroComSinal() {
    const inicio = this.p - 1;
    if (this.p >= this.n) throw this.eofAtual();
    const c = this.b[this.p++];
    if (c <= 0x30) {
      if (c !== 0x30) {
        if (c === 0x2e) return this.valorInesperado(0x2e);
        return this.inicioNumeroInvalido(c, true, true);
      }
      this.semZerosAEsquerda();
    } else if (c > 0x39) {
      return this.inicioNumeroInvalido(c, true, true);
    }
    return this.restoNumero(inicio);
  }

  numeroSemSinal(c) {
    const inicio = this.p - 1;
    if (c === 0x30) this.semZerosAEsquerda();
    return this.restoNumero(inicio);
  }

  /** Digits after the first one, fraction and exponent (_parseUnsignedNumber + _parseFloat). */
  restoNumero(inicio) {
    let intLen = 1;
    let c = -1;
    let fim = false;
    while (true) {
      if (this.p >= this.n) { fim = true; break; }
      c = this.b[this.p++];
      if (c < 0x30 || c > 0x39) break;
      intLen++;
    }
    if (fim || (c !== 0x2e && (c | 0x20) !== 0x65)) {
      if (!fim) {
        this.p--;
        if (this.topo.tipo === 'ROOT') this.espacoRaiz(c);
      }
      if (intLen > MAX_NUMERO) throw this.tamanhoNumero(intLen);
      this.texto = this.b.toString('latin1', inicio, this.p);
      return 'VALUE_NUMBER_INT';
    }
    let fracLen = 0;
    let eof = false;
    if (c === 0x2e) {
      while (true) {
        if (this.p >= this.n) { eof = true; break; }
        c = this.b[this.p++];
        if (c < 0x30 || c > 0x39) break;
        fracLen++;
      }
      if (fracLen === 0) throw this.inesperadoNumero(c, 'Decimal point not followed by a digit');
    }
    let expLen = 0;
    if (!eof && (c | 0x20) === 0x65) {
      if (this.p >= this.n) throw this.eofAtual();
      c = this.b[this.p++];
      if (c === 0x2d || c === 0x2b) {
        if (this.p >= this.n) throw this.eofAtual();
        c = this.b[this.p++];
      }
      while (c >= 0x30 && c <= 0x39) {
        expLen++;
        if (this.p >= this.n) { eof = true; break; }
        c = this.b[this.p++];
      }
      if (expLen === 0) throw this.inesperadoNumero(c, 'Exponent indicator not followed by a digit');
    }
    if (!eof) {
      this.p--;
      if (this.topo.tipo === 'ROOT') this.espacoRaiz(c);
    }
    const total = intLen + fracLen + expLen;
    if (total > MAX_NUMERO) throw this.tamanhoNumero(total);
    this.texto = this.b.toString('latin1', inicio, this.p);
    return 'VALUE_NUMBER_FLOAT';
  }

  tamanhoNumero(n) {
    return this.erro(`Number value length (${n}) exceeds the maximum allowed (${MAX_NUMERO}, from \`StreamReadConstraints.getMaxNumberLength()\`)`);
  }

  // _verifyRootSpace (the char was pushed back)
  espacoRaiz(ch) {
    this.p++;
    if (ch === 0x20 || ch === 0x09 || ch === 0x0d || ch === 0x0a) return;
    throw this.inesperado(ch, 'Expected space separating root-level values');
  }

  pularDoisPontos() {
    let i = this.pularEspacos();
    if (i !== 0x3a) throw this.inesperado(i, 'was expecting a colon to separate property name and value');
    i = this.pularEspacos();
    return i;
  }

  lerNome(i) {
    if (i !== 0x22) {
      const c = this.decodificarParaErro(i) & 0xffff;
      throw this.inesperado(c, 'was expecting double-quote to start property name');
    }
    // parseEscapedName: raw bytes (escapes re-encoded as UTF-8) are packed first; UTF-8 is only
    // decoded afterwards (addName), with Jackson's quad-based error texts.
    if (this.p >= this.n) throw this.eof(": was expecting closing '\"' for name");
    const bytes = [];
    while (true) {
      if (this.p >= this.n) throw this.eof(' in property name');
      const c = this.b[this.p++];
      if (c === 0x22) break;
      if (c === 0x5c) {
        const ch = this.escape().charCodeAt(0);
        if (ch < 0x80) bytes.push(ch);
        else if (ch < 0x800) bytes.push(0xc0 | (ch >> 6), 0x80 | (ch & 0x3f));
        else bytes.push(0xe0 | (ch >> 12), 0x80 | ((ch >> 6) & 0x3f), 0x80 | (ch & 0x3f));
      } else if (c < 0x20) {
        throw this.erro(`Illegal unquoted character (${descricaoChar(c)}): has to be escaped using backslash to be included in name`);
      } else bytes.push(c);
    }
    if (bytes.length > MAX_NOME) throw this.erro(`Name length (${bytes.length}) exceeds the maximum allowed (${MAX_NOME}, from \`StreamReadConstraints.getMaxNameLength()\`)`);
    return this.decodificarNome(bytes);
  }

  /** UTF8StreamJsonParser.addName: UTF-8 decoding over big-endian quads (error texts show the shifted quad). */
  decodificarNome(bytes) {
    const len = bytes.length;
    const quad = (k) => ((bytes[k] ?? 0) << 24) | ((bytes[k + 1] ?? 0) << 16) | ((bytes[k + 2] ?? 0) << 8) | (bytes[k + 3] ?? 0);
    const lerParcial = (ix) => quad(ix & ~3) >> ((3 - (ix & 3)) << 3);
    let out = '';
    for (let ix = 0; ix < len;) {
      let ch = bytes[ix++];
      if (ch > 127) {
        let faltam;
        if ((ch & 0xe0) === 0xc0) { ch &= 0x1f; faltam = 1; }
        else if ((ch & 0xf0) === 0xe0) { ch &= 0x0f; faltam = 2; }
        else if ((ch & 0xf8) === 0xf0) { ch &= 0x07; faltam = 3; }
        else throw this.erro(`Invalid UTF-8 start byte 0x${hex(ch)}`);
        if (ix + faltam > len) throw this.eof(' in property name');
        for (let k = 0; k < faltam; k++) {
          const ch2 = lerParcial(ix++);
          if ((ch2 & 0xc0) !== 0x80) throw this.erro(`Invalid UTF-8 middle byte 0x${((k === 2 ? ch2 & 0xff : ch2) >>> 0).toString(16)}`);
          ch = (ch << 6) | (ch2 & 0x3f);
        }
        if (faltam > 2) {
          ch -= 0x10000;
          out += String.fromCharCode((0xd800 + (ch >> 10)) & 0xffff);
          ch = 0xdc00 | (ch & 0x3ff);
        }
      }
      out += String.fromCharCode(ch & 0xffff);
    }
    return out;
  }

  lerString() {
    // ReaderBasedJsonParser (char input: UTF-16/32 or a non-Unicode charset) words the EOF differently
    return this.lerConteudo('string value', this.modoTexto ? ': was expecting closing quote for a string value' : ` in ${this.atual}`);
  }

  /** String / name content after the opening quote (_finishString2, _decodeEscaped, _decodeUtf8_N). */
  lerConteudo(descricao, sufixoEof) {
    const b = this.b;
    let out = '';
    let ini = this.p;
    const eof = () => this.eof(sufixoEof);
    while (true) {
      if (this.p >= this.n) throw eof();
      const c = b[this.p];
      if (c >= 0x20 && c < 0x80 && c !== 0x22 && c !== 0x5c) { this.p++; continue; }
      if (this.p > ini) out += b.toString('latin1', ini, this.p);
      this.p++;
      if (c === 0x22) break;
      if (c === 0x5c) out += this.escape(descricao);
      else if (c < 0x20) throw this.erro(`Illegal unquoted character (${descricaoChar(c)}): has to be escaped using backslash to be included in ${descricao}`);
      else out += this.multibyte(c, eof);
      ini = this.p;
    }
    return out;
  }

  multibyte(c, eof) {
    const prox = () => {
      if (this.p >= this.n) throw eof();
      const d = this.b[this.p++];
      if ((d & 0xc0) !== 0x80) throw this.erro(`Invalid UTF-8 middle byte 0x${hex(d)}`);
      return d & 0x3f;
    };
    if ((c & 0xe0) === 0xc0) return String.fromCharCode(((c & 0x1f) << 6) | prox());
    if ((c & 0xf0) === 0xe0) {
      let v = c & 0x0f;
      v = (v << 6) | prox();
      v = (v << 6) | prox();
      if (v >= 0xd800 && v <= 0xdfff) throw this.erro(`Invalid UTF-8: Illegal surrogate character 0x${hex(v)}`);
      return String.fromCharCode(v);
    }
    if ((c & 0xf8) === 0xf0) {
      let v = c & 0x07;
      v = (v << 6) | prox();
      v = (v << 6) | prox();
      v = ((v << 6) | prox()) - 0x10000;
      return String.fromCharCode((0xd800 | (v >> 10)) & 0xffff, 0xdc00 | (v & 0x3ff));
    }
    if (c < 0x20) throw this.erro(`Illegal character (${descricaoChar(c)}): only regular white space (\\r, \\n, \\t) is allowed between tokens`);
    throw this.erro(`Invalid UTF-8 start byte 0x${hex(c)}`);
  }

  escape() {
    if (this.p >= this.n) throw this.eof(' in character escape sequence');
    const c = this.b[this.p++];
    switch (c) {
      case 0x62: return '\b';
      case 0x74: return '\t';
      case 0x6e: return '\n';
      case 0x66: return '\f';
      case 0x72: return '\r';
      case 0x22: case 0x2f: case 0x5c: return String.fromCharCode(c);
      case 0x75: break;
      default: {
        const ch = this.decodificarParaErro(c) & 0xffff;
        throw this.erro(`Unrecognized character escape ${descricaoChar(ch)}`);
      }
    }
    let v = 0;
    for (let k = 0; k < 4; k++) {
      if (this.p >= this.n) throw this.eof(' in character escape sequence');
      const ch = this.b[this.p++];
      const d = ch >= 0x30 && ch <= 0x39 ? ch - 0x30 : ch >= 0x41 && ch <= 0x46 ? ch - 0x37 : ch >= 0x61 && ch <= 0x66 ? ch - 0x57 : -1;
      if (d < 0) throw this.inesperado(ch, 'expected a hex-digit for character escape sequence');
      v = (v << 4) | d;
    }
    return String.fromCharCode(v);
  }
}

/**
 * Builds the node for the token just returned. A container is attached to its parent (via `anexar`)
 * BEFORE its children are read, so that after a syntax error the partial tree still holds every
 * value Jackson would have bound before reaching the error; open containers stay on `abertos`.
 */
function lerValor(L, token, abertos, anexar) {
  switch (token) {
    case 'START_OBJECT': {
      const o = new JsonObj();
      anexar(o);
      abertos.push(o);
      while (true) {
        const t = L.proximoToken();
        if (t === 'END_OBJECT') break;
        const nome = L.topo.nome;
        const tv = L.proximoToken();
        lerValor(L, tv, abertos, (v) => o.entradas.push([nome, v]));
      }
      abertos.pop();
      return o;
    }
    case 'START_ARRAY': {
      const a = new JsonArr();
      anexar(a);
      abertos.push(a);
      while (true) {
        const t = L.proximoToken();
        if (t === 'END_ARRAY') break;
        lerValor(L, t, abertos, (v) => a.itens.push(v));
      }
      abertos.pop();
      return a;
    }
    default: {
      const v = escalar(L, token);
      anexar(v);
      return v;
    }
  }
}

function escalar(L, token) {
  switch (token) {
    case 'VALUE_STRING': return L.texto;
    case 'VALUE_NUMBER_INT': return new JsonNum(L.texto, true);
    case 'VALUE_NUMBER_FLOAT': return new JsonNum(L.texto, false);
    case 'VALUE_TRUE': return true;
    case 'VALUE_FALSE': return false;
    case 'VALUE_NULL': return null;
    default: throw new Error(`token inesperado ${token}`);
  }
}

const UNICODE = new Set(['utf-8', 'utf8', 'utf-16', 'utf-16be', 'utf-16le', 'utf-32', 'utf-32be', 'utf-32le', 'unicode']);

/** ByteSourceJsonBootstrapper: BOM / UTF-16 / UTF-32 detection. Returns UTF-8 bytes. */
function bytesUtf8(bytes) {
  const b = bytes;
  const n = b.length;
  const transcodificar = (rotulo, pular) => Buffer.from(new TextDecoder(rotulo).decode(b.subarray(pular)), 'utf8');
  if (n >= 4) {
    const quad = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    if (quad === 0x0000feff) return Buffer.from(decodificarUtf32(b.subarray(4), false), 'utf8');
    if (quad === 0xfffe0000) return Buffer.from(decodificarUtf32(b.subarray(4), true), 'utf8');
    if (quad === 0x0000fffe) throw new ErroJson('Unsupported UCS-4 endianness (2143) detected');
    if (quad === 0xfeff0000) throw new ErroJson('Unsupported UCS-4 endianness (3412) detected');
    const msw = quad >>> 16;
    if (msw === 0xfeff) return transcodificar('utf-16be', 2);
    if (msw === 0xfffe) return transcodificar('utf-16le', 2);
    if ((quad >>> 8) === 0xefbbbf) return b.subarray(3);
    if ((quad >>> 8) === 0) return Buffer.from(decodificarUtf32(b, false), 'utf8');
    if ((quad & 0x00ffffff) === 0) return Buffer.from(decodificarUtf32(b, true), 'utf8');
    if ((quad & ~0x00ff0000) === 0) throw new ErroJson('Unsupported UCS-4 endianness (3412) detected');
    if ((quad & ~0x0000ff00) === 0) throw new ErroJson('Unsupported UCS-4 endianness (2143) detected');
    if (((msw & 0xff00) >>> 0) === 0) return transcodificar('utf-16be', 0);
    if ((msw & 0x00ff) === 0) return transcodificar('utf-16le', 0);
  } else if (n >= 2) {
    const i16 = (b[0] << 8) | b[1];
    if ((i16 & 0xff00) === 0) return transcodificar('utf-16be', 0);
    if ((i16 & 0x00ff) === 0) return transcodificar('utf-16le', 0);
    if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3);
  }
  return b;
}

function decodificarUtf32(b, le) {
  let s = '';
  for (let i = 0; i + 3 < b.length; i += 4) {
    const cp = le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  }
  return s;
}

/**
 * Reads a JSON document. `charset` = the Content-Type charset (undefined = UTF-8 with Jackson's
 * byte autodetection; a non-Unicode charset is decoded first, like Spring's InputStreamReader).
 * Returns { vazio: true } when there is no token, or { raiz, verificarFim(tipoJava) }.
 * Throws ErroJson when the very first token is invalid.
 */
export function lerDocumentoJson(bytes, { charset } = {}) {
  const original = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let buf;
  const cs = charset ? String(charset).toLowerCase() : null;
  if (cs && !UNICODE.has(cs)) {
    const texto = cs === 'iso-8859-1' || cs === 'latin1' || cs === 'us-ascii' ? original.toString('latin1') : new TextDecoder(cs).decode(original);
    buf = Buffer.from(texto, 'utf8');
  } else {
    buf = bytesUtf8(original);
  }
  const L = new Leitor(buf);
  // UTF-8 input keeps the byte parser; anything transcoded went through a java.io.Reader in Jackson
  L.modoTexto = (cs && !UNICODE.has(cs)) || (buf !== original && buf.buffer !== original.buffer);
  const primeiro = L.proximoToken();
  if (primeiro === null) return { vazio: true };
  const abertos = [];
  let raiz;
  try {
    lerValor(L, primeiro, abertos, (v) => { raiz = v; });
  } catch (e) {
    if (!(e instanceof ErroJson) || abertos.length === 0) throw e;
    for (const c of abertos) c.erroPendente = e;
    raiz = abertos[0];
  }
  return {
    raiz,
    /** DeserializationFeature.FAIL_ON_TRAILING_TOKENS after binding the root as `tipoJava`. */
    verificarFim(tipoJava) {
      if (raiz instanceof JsonObj || raiz instanceof JsonArr) if (raiz.erroPendente) throw raiz.erroPendente;
      const t = L.proximoToken();
      if (t !== null) {
        throw new ErroJson(`Trailing token (\`JsonToken.${t}\`) found after value (bound as \`${tipoJava}\`): not allowed as per \`DeserializationFeature.FAIL_ON_TRAILING_TOKENS\``);
      }
    },
  };
}

/** Plain JSON text (JSON.parse-like) with the Jackson rules; throws ErroJson. Numbers stay JsonNum. */
export function lerJsonTexto(texto) {
  const doc = lerDocumentoJson(Buffer.from(texto, 'utf8'));
  if (doc.vazio) throw new ErroJson('No content to map due to end-of-input');
  doc.verificarFim('java.lang.Object');
  return doc.raiz;
}

// ─── Spring @RequestBody pipeline ───────────────────────────────────────────

/**
 * Spring MVC + Jackson for `@RequestBody T` on a JSON endpoint:
 * - 0 bytes or literal null → HttpMessageNotReadableException "Required request body is missing: <assinatura>";
 * - only whitespace → "JSON parse error: No content to map due to end-of-input";
 * - Jackson errors (syntax, coercion in `vincular`, trailing tokens) → "JSON parse error: " + message.
 * `assinatura` = Method.toGenericString() of the controller method; `tipoJava` = FQCN of T;
 * `vincular(raiz)` = binder for T (use the como* helpers). Returns the bound value.
 */
export function lerCorpoRequisicao(bytes, { charset, assinatura, tipoJava, vincular }) {
  const ausente = () => new ErroJava('HttpMessageNotReadableException', `Required request body is missing: ${assinatura}`);
  if (!bytes || bytes.length === 0) throw ausente();
  try {
    const doc = lerDocumentoJson(bytes, { charset });
    if (doc.vazio) throw new ErroJson('No content to map due to end-of-input');
    const valor = doc.raiz === null ? null : vincular(doc.raiz);
    doc.verificarFim(tipoJava);
    if (valor === null || valor === undefined) throw ausente();
    return valor;
  } catch (e) {
    if (e instanceof ErroJson) throw new ErroJava('HttpMessageNotReadableException', `JSON parse error: ${e.message}`);
    throw e;
  }
}

// ─── Binders (Jackson 3 coercions per Java target type) ────────────────────

export const T = {
  STRING: 'java.lang.String',
  INTEGER: 'java.lang.Integer',
  LONG: 'java.lang.Long',
  BIGDECIMAL: 'java.math.BigDecimal',
  BOOLEAN: 'java.lang.Boolean',
};

/** JsonToken of a node. */
export function tokenDe(no) {
  if (no === null) return 'VALUE_NULL';
  if (typeof no === 'string') return 'VALUE_STRING';
  if (no === true) return 'VALUE_TRUE';
  if (no === false) return 'VALUE_FALSE';
  if (no instanceof JsonNum) return no.inteiro ? 'VALUE_NUMBER_INT' : 'VALUE_NUMBER_FLOAT';
  if (no instanceof JsonObj) return 'START_OBJECT';
  if (no instanceof JsonArr) return 'START_ARRAY';
  throw new TypeError('nó JSON inválido');
}

const FORMA = {
  START_OBJECT: 'Object value', START_ARRAY: 'Array value', VALUE_STRING: 'String value', VALUE_NUMBER_INT: 'Integer value',
  VALUE_NUMBER_FLOAT: 'Floating-point value', VALUE_TRUE: 'Boolean value', VALUE_FALSE: 'Boolean value', VALUE_NULL: 'Null value',
};

/** "Cannot deserialize value of type `T` from <shape> (token `JsonToken.X`)". */
export function erroForma(tipoJava, no) {
  const t = tokenDe(no);
  return new ErroJson(`Cannot deserialize value of type \`${tipoJava}\` from ${FORMA[t]} (token \`JsonToken.${t}\`)`);
}

/** "Cannot deserialize value of type `T` from String "x": <motivo>". */
export const erroStringEstranha = (tipoJava, texto, motivo) => new ErroJson(`Cannot deserialize value of type \`${tipoJava}\` from String "${texto}": ${motivo}`);

const erroCoercaoVazia = (tipoJava) => new ErroJson(`Cannot coerce empty String ("") to \`${tipoJava}\` value (but could if coercion was enabled using \`CoercionConfig\`)`);

/** p.getText() of the current token (what custom deserializers see). */
export function textoDoToken(no) {
  if (typeof no === 'string') return no;
  if (no instanceof JsonNum) return no.src;
  if (no === true) return 'true';
  if (no === false) return 'false';
  if (no === null) return 'null';
  if (no instanceof JsonObj) return '{';
  return '[';
}

/** String field: string as is (no trim); number → lexeme; boolean → "true"/"false"; object/array → error. */
export function comoString(no) {
  if (no === null || typeof no === 'string') return no;
  if (no instanceof JsonNum) return no.src;
  if (no === true || no === false) return String(no);
  throw erroForma(T.STRING, no);
}

const digitoJava = (cp) => {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  const c = String.fromCodePoint(cp);
  if (!/\p{Nd}/u.test(c)) return -1;
  let inicio = cp;
  while (inicio > 0 && /\p{Nd}/u.test(String.fromCodePoint(inicio - 1))) inicio--;
  return (cp - inicio) % 10;
};

/** Long.parseLong / Integer.parseInt (radix 10, '+'/'-', Unicode digits). BigInt or null when invalid/out of range. */
export function parseInteiroJava(s, min, max) {
  if (!s || s.length === 0) return null;
  let i = 0;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; i = 1; if (s.length === 1) return null; }
  let v = 0n;
  for (const ch of s.slice(i)) {
    const d = digitoJava(ch.codePointAt(0));
    if (d < 0) return null;
    v = v * 10n + BigInt(d);
    if (v > (neg ? -min : max)) return null;
  }
  return neg ? -v : v;
}

const INT_MIN = -2147483648n, INT_MAX = 2147483647n;
const LONG_MIN = -9223372036854775808n, LONG_MAX = 9223372036854775807n;
const textoNulo = (t) => t === '' || t === 'null';

/** Integer field (java.lang.Integer): ACCEPT_FLOAT_AS_INT truncation, string coercion, Jackson messages. */
export function comoInteger(no) {
  if (no === null) return null;
  if (no instanceof JsonNum) {
    if (no.inteiro) {
      const v = BigInt(no.src);
      if (v < INT_MIN || v > INT_MAX) throw new ErroJson(`Numeric value (${no.src}) out of range of \`int\` (-2147483648 - 2147483647)`);
      return Number(v);
    }
    const d = Number(no.src);
    if (!(d >= -2147483648 && d <= 2147483647)) throw new ErroJson(`Numeric value (${no.src}) out of range of \`int\` (-2147483648 - 2147483647)`);
    return Math.trunc(d) + 0;
  }
  if (typeof no === 'string') {
    const t = javaTrim(no);
    if (textoNulo(t)) return null;
    if (t.length > 9) {
      const l = parseInteiroJava(t, LONG_MIN, LONG_MAX);
      if (l === null) throw erroStringEstranha(T.INTEGER, t, 'not a valid `java.lang.Integer` value');
      if (l < INT_MIN || l > INT_MAX) throw erroStringEstranha(T.INTEGER, t, `Overflow: numeric value (${t}) out of range of \`java.lang.Integer\` (-2147483648 -2147483647)`);
      return Number(l);
    }
    const v = parseInteiroJava(t, INT_MIN, INT_MAX);
    if (v === null) throw erroStringEstranha(T.INTEGER, t, 'not a valid `java.lang.Integer` value');
    return Number(v);
  }
  throw erroForma(T.INTEGER, no);
}

/** Long field (java.lang.Long). Returns a number when safe, else a BigInt. */
export function comoLong(no) {
  const saida = (v) => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
  if (no === null) return null;
  if (no instanceof JsonNum) {
    if (no.inteiro) {
      const v = BigInt(no.src);
      if (v < LONG_MIN || v > LONG_MAX) throw new ErroJson(`Numeric value (${no.src}) out of range of \`long\` (-9223372036854775808 - 9223372036854775807)`);
      return saida(v);
    }
    const d = Number(no.src);
    if (!(d >= -9223372036854775808 && d <= 9223372036854775807)) throw new ErroJson(`Numeric value (${no.src}) out of range of \`long\` (-9223372036854775808 - 9223372036854775807)`);
    let v = BigInt(Math.trunc(d));
    if (v > LONG_MAX) v = LONG_MAX;
    if (v < LONG_MIN) v = LONG_MIN;
    return saida(v);
  }
  if (typeof no === 'string') {
    const t = javaTrim(no);
    if (textoNulo(t)) return null;
    const v = parseInteiroJava(t, LONG_MIN, LONG_MAX);
    if (v === null) throw erroStringEstranha(T.LONG, t, 'not a valid `java.lang.Long` value');
    return saida(v);
  }
  throw erroForma(T.LONG, no);
}

/** BigDecimal field: number → exact lexeme (value AND scale); string → trim, ""/"null" → null, FastDoubleParser grammar. */
export function comoBigDecimal(no) {
  if (no === null) return null;
  if (no instanceof JsonNum) {
    const d = Dec.parseAscii(no.src);
    if (!d) throw new ErroJson(`Value "${no.src}" cannot be deserialized as \`java.math.BigDecimal\`, reason:  value exceeds limits`);
    return d;
  }
  if (typeof no === 'string') {
    const t = javaTrim(no);
    if (textoNulo(t)) return null;
    if (t.length > MAX_NUMERO) throw new ErroJson(`Number value length (${t.length}) exceeds the maximum allowed (${MAX_NUMERO}, from \`StreamReadConstraints.getMaxNumberLength()\`)`);
    const d = Dec.parseAscii(t);
    if (!d) throw erroStringEstranha(T.BIGDECIMAL, t, 'not a valid representation');
    return d;
  }
  throw erroForma(T.BIGDECIMAL, no);
}

/** Boolean field (best effort; no request field of the API is Boolean). */
export function comoBoolean(no) {
  if (no === null || no === true || no === false) return no;
  if (typeof no === 'string') {
    const t = javaTrim(no);
    if (t === 'true' || t === 'True' || t === 'TRUE') return true;
    if (t === 'false' || t === 'False' || t === 'FALSE') return false;
    if (textoNulo(t)) return null;
    throw erroStringEstranha(T.BOOLEAN, t, 'only "true" or "false" recognized');
  }
  if (no instanceof JsonNum && no.inteiro) throw new ErroJson(`Cannot coerce Integer value (${no.src}) to \`java.lang.Boolean\` value (but could if coercion was enabled using \`CoercionConfig\`)`);
  throw erroForma(T.BOOLEAN, no);
}

/**
 * Enum with @JsonValue (lookup by the JSON value text, ordinal never used): `valores` = Map from the
 * JSON text ('1', '2'…) to the JS value. Returns the mapped value or null.
 */
export function comoEnumValor(no, { tipoJava, valores }) {
  if (no === null) return null;
  let texto;
  if (typeof no === 'string') texto = no;
  else if (no instanceof JsonNum && no.inteiro) texto = no.src;
  else throw erroForma(tipoJava, no);
  if (valores.has(texto)) return valores.get(texto);
  const t = javaTrim(texto);
  if (t !== texto && valores.has(t)) return valores.get(t);
  if (t === '') throw erroCoercaoVazia(tipoJava);
  throw erroStringEstranha(tipoJava, t, `not one of the values accepted for Enum class: [${[...valores.keys()].join(', ')}]`);
}

/** Java number text Jackson prints for a scalar that cannot build a POJO. */
function descricaoNumero(no) {
  if (no.inteiro) {
    const v = BigInt(no.src);
    const tipo = v >= INT_MIN && v <= INT_MAX ? 'int/Int' : v >= LONG_MIN && v <= LONG_MAX ? 'long/Long' : 'BigInteger';
    return [tipo, v.toString()];
  }
  return ['double/Double', javaDoubleToString(Number(no.src))];
}

/** Error for a scalar where a POJO (bean with a default constructor) was expected. */
export function erroEscalarParaObjeto(tipoJava, no) {
  if (typeof no === 'string') {
    const t = javaTrim(no);
    if (t === '') return erroCoercaoVazia(tipoJava);
    return new ErroJson(`Cannot construct instance of \`${tipoJava}\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${t}')`);
  }
  if (no instanceof JsonNum) {
    const [tipo, texto] = descricaoNumero(no);
    return new ErroJson(`Cannot construct instance of \`${tipoJava}\` (although at least one Creator exists): no ${tipo}-argument constructor/factory method to deserialize from Number value (${texto})`);
  }
  if (no === true || no === false) return new ErroJson(`Cannot construct instance of \`${tipoJava}\` (although at least one Creator exists): no boolean/Boolean-argument constructor/factory method to deserialize from boolean value (${no})`);
  return erroForma(tipoJava, no);
}

/**
 * POJO (BeanDeserializer, FAIL_ON_UNKNOWN_PROPERTIES=false): entries bound in document order,
 * duplicates applied in turn (the last wins), unknown keys ignored. `campos` = { nome: (no, nome) => valor }.
 * Returns an object with every known field (null when absent), or null for JSON null.
 */
export function comoObjeto(no, tipoJava, campos) {
  if (no === null) return null;
  if (!(no instanceof JsonObj)) throw erroEscalarParaObjeto(tipoJava, no);
  const r = {};
  for (const k of Object.keys(campos)) r[k] = null;
  for (const [k, v] of no.entradas) {
    if (Object.hasOwn(campos, k)) r[k] = campos[k](v, k);
  }
  if (no.erroPendente) throw no.erroPendente;
  return r;
}

/** List<E> (CollectionDeserializer): `tipoJava` like 'java.util.ArrayList<br.gov...ItemOperacaoInput>'; null elements kept. */
export function comoLista(no, tipoJava, elemento) {
  if (no === null) return null;
  if (!(no instanceof JsonArr)) throw erroForma(tipoJava, no);
  const r = no.itens.map((v, i) => (v === null ? null : elemento(v, i)));
  if (no.erroPendente) throw no.erroPendente;
  return r;
}

/** Skips a value (unknown property): only its pending syntax error matters. */
export function ignorar(no) {
  if ((no instanceof JsonObj || no instanceof JsonArr) && no.erroPendente) throw no.erroPendente;
}

const PADRAO_ODT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/;

/** OffsetDateTimeCustomDeserializer: returns the validated text (its first 10 chars are the LocalDate). */
export function comoDataHora(no, nomeCampo) {
  if (no === null) return null;
  const texto = textoDoToken(no);
  const erro = () => new ErroJson(`Campo '${nomeCampo}' [${texto}] inválido. Formato esperado: 'yyyy-MM-dd'T'HH:mm:ssXXX'. Exemplo de valor: '2026-01-05T13:45:00-03:00 ou 2026-05-22T10:57:23Z'`);
  if (!PADRAO_ODT.test(texto)) throw erro();
  if (!dataIsoValida(texto.slice(0, 10))) throw erro();
  const [h, m, s] = [Number(texto.slice(11, 13)), Number(texto.slice(14, 16)), Number(texto.slice(17, 19))];
  if (h > 23 || m > 59 || s > 59) throw erro();
  if (texto[19] !== 'Z') {
    const oh = Number(texto.slice(20, 22)), om = Number(texto.slice(23, 25));
    if (om > 59 || oh > 18 || (oh === 18 && om > 0)) throw erro();
  }
  return texto;
}

/** LocalDateCustomDeserializer ('yyyy-MM-dd', STRICT). */
export function comoData(no, nomeCampo) {
  if (no === null) return null;
  const texto = textoDoToken(no);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto) || !dataIsoValida(texto)) {
    throw new ErroJson(`Campo '${nomeCampo}' [${texto}] inválido. Formato esperado: 'yyyy-MM-dd'. Exemplo de valor: '2026-01-05'`);
  }
  return texto;
}

// ─── Writer ─────────────────────────────────────────────────────────────────

/** A raw JSON number written verbatim (e.g. a Double already formatted by javaDoubleToString). */
export class NumeroCru {
  constructor(texto) { this.texto = String(texto); }
}

/** Writes `null` even where nulls are omitted (@JsonInclude(ALWAYS) fields). */
export const NULO = Object.freeze({ nuloExplicito: true });

const HEX = '0123456789ABCDEF';
const u4 = (c) => `\\u${HEX[(c >> 12) & 15]}${HEX[(c >> 8) & 15]}${HEX[(c >> 4) & 15]}${HEX[c & 15]}`;

/** JSON string as jackson-core writes it (uppercase hex escapes, lone surrogates escaped, '/' raw). */
export function textoJson(s) {
  let out = '"';
  let ini = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc = null;
    if (c === 0x22) esc = '\\"';
    else if (c === 0x5c) esc = '\\\\';
    else if (c < 0x20) esc = c === 8 ? '\\b' : c === 9 ? '\\t' : c === 10 ? '\\n' : c === 12 ? '\\f' : c === 13 ? '\\r' : u4(c);
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { i++; continue; }
    else if (c >= 0xd800 && c <= 0xdfff) esc = u4(c);
    if (esc !== null) { out += s.slice(ini, i) + esc; ini = i + 1; }
  }
  return `${out}${s.slice(ini)}"`;
}

/**
 * Jackson output: objects in insertion order (null/undefined properties omitted unless
 * `nulos: true` or the value is NULO), arrays keep null elements, Dec = BigDecimal written as a
 * JSON number (toString, may be scientific), JsonNum/NumeroCru = raw text, integers as numbers.
 */
export function escreverJson(v, { nulos = false } = {}) {
  if (v === null || v === undefined || v === NULO) return 'null';
  if (typeof v === 'string') return textoJson(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`número não finito na saída JSON: ${v}`);
    return Number.isInteger(v) ? String(v) : javaDoubleToString(v);
  }
  if (v instanceof Dec) return v.toJavaString();
  if (v instanceof JsonNum) return v.src;
  if (v instanceof NumeroCru) return v.texto;
  if (Array.isArray(v)) return `[${v.map((x) => escreverJson(x, { nulos })).join(',')}]`;
  if (v instanceof JsonArr) return escreverJson(v.itens, { nulos });
  const entradas = v instanceof Map ? [...v.entries()] : v instanceof JsonObj ? v.entradas : Object.entries(v);
  const partes = [];
  for (const [k, x] of entradas) {
    if (x === undefined) continue;
    if (x === null && !nulos) continue;
    partes.push(`${textoJson(String(k))}:${escreverJson(x, { nulos })}`);
  }
  return `{${partes.join(',')}}`;
}
