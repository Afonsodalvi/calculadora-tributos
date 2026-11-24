// HTTP behaviour of the official Simples API (api-simples-nacional 1.0.2: Spring Boot 4.1.2,
// Spring MVC 7, Spring Security, Tomcat 11.0.27, Jackson 3) that our /api/calculadora/... routes
// reproduce: response headers, ProblemDetail bodies of shared/exceptionhandler/ApiExceptionHandler,
// Tomcat query-string decoding, @RequestParam conversion (Spring ConversionService) and the
// consumes/produces conditions of the controllers. Every rule here was checked against the
// running oracle (http://127.0.0.1:8082/api); comments name the Java piece being mirrored.

// ── Response headers ─────────────────────────────────────────────────────────
/** Spring Security default headers (HeadersConfigurer; frameOptions = SAMEORIGIN in WebSecurityConfig). */
const SEGURANCA = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-xss-protection': '0',
  'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'x-frame-options': 'SAMEORIGIN',
});
/** CorsFilter adds three Vary headers; Tomcat compression (mime application/json) merges them, lower-cased, + accept-encoding. */
const VARY_CORS = Object.freeze(['Origin', 'Access-Control-Request-Method', 'Access-Control-Request-Headers']);
const VARY_JSON = 'origin,access-control-request-method,access-control-request-headers,accept-encoding';

export const TIPO_JSON = 'application/json';
export const TIPO_PROBLEMA = 'application/problem+json';

/** 200 written by MappingJackson (Content-Type application/json, no charset). */
export function respostaJson(status, corpo, extras = {}) {
  return { status, body: corpo, tipo: TIPO_JSON, headers: { vary: VARY_JSON, ...extras, ...SEGURANCA } };
}
/** ProblemDetail (application/problem+json is not compressible, so Vary stays as three headers). */
export function respostaProblema(status, corpo, extras = {}) {
  return { status, body: corpo, tipo: TIPO_PROBLEMA, headers: { vary: [...VARY_CORS], ...extras, ...SEGURANCA } };
}
/** ResponseEntity.notFound().build(): no body (Content-Length: 0). */
export function respostaVazia(status) {
  return { status, body: '', tipo: null, headers: { vary: [...VARY_CORS], ...SEGURANCA } };
}

// ── Jackson writer ───────────────────────────────────────────────────────────
/** JSON text as Jackson writes it: compact, insertion order, \uXXXX with UPPER-case hex for control chars. */
export function escreverJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return textoJson(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(escreverJson).join(',')}]`;
  if (typeof v.toJSON === 'function') return escreverJson(v.toJSON());
  return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${textoJson(k)}:${escreverJson(x)}`).join(',')}}`;
}
const CURTOS = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
function textoJson(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (CURTOS[c]) out += CURTOS[c];
    else if (c < 0x20) out += '\\u00' + c.toString(16).toUpperCase().padStart(2, '0');
    else out += s[i];
  }
  return out + '"';
}

// ── ProblemDetail (ApiExceptionHandler) ──────────────────────────────────────
/** java.time.Instant.now() as Jackson writes it (ISO_INSTANT, microseconds on the JDK 25 clock). */
export function instanteAgora() {
  const agora = new Date();
  const micro = String(agora.getUTCMilliseconds() * 1000 + Number(process.hrtime.bigint() % 1000n)).padStart(6, '0');
  return `${agora.toISOString().slice(0, 19)}.${micro}Z`;
}

/** ProblemDetailJacksonMixin: @JsonInclude(NON_EMPTY), order type,title,status,detail,instance, then properties. */
export function problemDetail({ type, title, status, detail, instance, ...propriedades }) {
  const o = {};
  if (type) o.type = type;
  if (title) o.title = title;
  o.status = status;
  if (detail) o.detail = detail;
  if (instance) o.instance = instance;
  for (const [k, v] of Object.entries(propriedades)) if (v !== undefined) o[k] = v;
  return escreverJson(o);
}

/** HttpStatus reason phrases used as the default ProblemDetail title. */
const REASON = { 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 500: 'Internal Server Error' };

/** shared/exceptionhandler/enumeration/ProblemType: {baseURL}/errors/{path}. */
export const ProblemType = Object.freeze({
  MENSAGEM_INCOMPREENSIVEL: { titulo: 'Mensagem incompreensível', path: 'mensagem-incompreensivel' },
  METHOD_ARGUMENT_TYPE_MISMATCH: { titulo: 'Tipo de argumento inválido', path: 'tipo-argumento-invalido' },
  PARAMETRO_OBRIGATORIO_AUSENTE: { titulo: 'Parâmetro obrigatório ausente', path: 'parametro-obrigatorio-ausente' },
  CAMPOS_INVALIDOS: { titulo: 'Campos inválidos.', path: 'campos-invalidos' },
  ERRO_SISTEMA: { titulo: 'Erro de sistema não previsto', path: 'erro-de-sistema-nao-previsto' },
});

// Spring exceptions that the handler maps (constructed by the code that emulates Spring).
export class MissingServletRequestParameterException extends Error {
  constructor(nome, tipo) { super(`Required request parameter '${nome}' for method parameter type ${tipo} is not present`); this.nome = nome; this.tipo = tipo; }
}
export class MethodArgumentTypeMismatchException extends Error {
  constructor(nome, valor) { super(`Method parameter '${nome}': Failed to convert value`); this.nome = nome; this.valor = valor; }
}
export class HttpMessageNotReadableException extends Error {}
export class HttpMediaTypeNotSupportedException extends Error {}
export class HttpMediaTypeNotAcceptableException extends Error {
  /** semCorpo: the Accept header itself is unparsable, so not even the ProblemDetail can be written. */
  constructor(mensagem, semCorpo = false) { super(mensagem); this.semCorpo = semCorpo; }
}

/**
 * ApiExceptionHandler + ResponseEntityExceptionHandler for the exceptions our routes can raise.
 * `ctx` gives baseURL (HttpUtils.getBaseURL) and the raw request URI (ProblemDetail.instance).
 * Exceptions with `.status` and `.reason` are ResponseStatusException.
 */
export function respostaDeExcecao(ex, ctx) {
  const instance = requestUri(ctx);
  const base = ctx.baseURL;
  const comTipo = (pt, status, detail, extra = {}) => problemDetail({ type: `${base}/errors/${pt.path}`, title: pt.titulo, status, detail, instance, timestamp: instanteAgora(), ...extra });
  const erroSemCatalogo = (title, campo, detail) => ({ title, pointer: `#/${campo}`, detail });

  if (ex instanceof MissingServletRequestParameterException) {
    const detail = `O parâmetro obrigatório '${ex.nome}' (${ex.tipo}) não foi informado.`;
    return respostaProblema(400, comTipo(ProblemType.PARAMETRO_OBRIGATORIO_AUSENTE, 400, detail, { errors: [erroSemCatalogo('Parâmetro obrigatório ausente', ex.nome, detail)] }));
  }
  if (ex instanceof MethodArgumentTypeMismatchException) {
    const detail = `Parâmetro inválido [${ex.nome}: ${ex.valor}] `;
    return respostaProblema(400, comTipo(ProblemType.METHOD_ARGUMENT_TYPE_MISMATCH, 400, detail, { errors: [erroSemCatalogo('Tipo de argumento inválido', ex.nome, detail.trim())] }));
  }
  if (ex instanceof HttpMessageNotReadableException) {
    return respostaProblema(400, comTipo(ProblemType.MENSAGEM_INCOMPREENSIVEL, 400, ex.message));
  }
  if (ex instanceof HttpMediaTypeNotSupportedException) {
    // the ProblemDetail is negotiated against the Accept header: an unparsable one leaves the 415 without body
    if (acceptIlegivel(ctx.req)) { const r = respostaVazia(415); r.headers.accept = TIPO_JSON; return r; }
    return respostaProblema(415, problemDetail({ type: 'about:blank', title: REASON[415], status: 415, detail: ex.message, instance }), { accept: TIPO_JSON });
  }
  if (ex instanceof HttpMediaTypeNotAcceptableException) {
    if (ex.semCorpo) { const r = respostaVazia(406); r.headers.accept = TIPO_JSON; return r; }
    return respostaProblema(406, problemDetail({ type: 'about:blank', title: REASON[406], status: 406, detail: ex.message, instance }), { accept: TIPO_JSON });
  }
  if (typeof ex?.status === 'number' && 'reason' in ex) { // ResponseStatusException
    return respostaProblema(ex.status, problemDetail({ type: 'about:blank', title: REASON[ex.status], status: ex.status, detail: ex.reason, instance }));
  }
  return respostaProblema(500, comTipo(ProblemType.ERRO_SISTEMA, 500, ex?.message ?? null));
}

/** request.getRequestURI(): raw path (not decoded), with the context path, without query. */
export function requestUri(ctx) {
  const url = String(ctx.req?.url ?? ctx.url.pathname);
  if (!url.startsWith('/')) return ctx.url.pathname;
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/** Raw query string (without '?') as Tomcat sees it. */
export function queryCrua(ctx) {
  const url = String(ctx.req?.url ?? '');
  const q = url.indexOf('?');
  if (q >= 0) return url.slice(q + 1);
  return ctx.url.search.replace(/^\?/, '');
}

// ── Tomcat 11 query-string parsing (org.apache.tomcat.util.http.Parameters) ──
const hexDigito = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
const hexValor = (b) => (b <= 0x39 ? b - 0x30 : (b & 0x5f) - 0x41 + 10);

/** UDecoder.convert(ByteChunk, query=true), in place: returns { bytes, ok }; on failure the partially rewritten buffer. */
function udecode(bytes) {
  const buff = Uint8Array.from(bytes);
  let idx = buff.indexOf(0x25); // '%'
  const idx2 = buff.subarray(0, idx >= 0 ? idx : buff.length).indexOf(0x2b); // '+'
  if (idx < 0 && idx2 < 0) return { bytes: buff, ok: true };
  if ((idx2 >= 0 && idx2 < idx) || idx < 0) idx = idx2;
  for (let j = idx; j < buff.length; j++, idx++) {
    if (buff[j] === 0x2b) buff[idx] = 0x20;
    else if (buff[j] !== 0x25) buff[idx] = buff[j];
    else {
      if (j + 2 >= buff.length) return { bytes: buff, ok: false };
      const b1 = buff[j + 1], b2 = buff[j + 2];
      if (!hexDigito(b1) || !hexDigito(b2)) return { bytes: buff, ok: false };
      j += 2;
      buff[idx] = hexValor(b1) * 16 + hexValor(b2);
    }
  }
  return { bytes: buff.subarray(0, idx), ok: true };
}

const utf8Estrito = new TextDecoder('utf-8', { fatal: true });
/**
 * new String(bytes, UTF_8): JDK decoder with REPLACE (one U+FFFD per malformed sequence as the
 * JDK measures it — e.g. an encoded surrogate ED A0 80 is a single malformed unit of 3 bytes).
 */
export function utf8Java(b) {
  let out = '';
  const cont = (x) => (x & 0xc0) === 0x80;
  for (let sp = 0; sp < b.length;) {
    const b1 = b[sp];
    const resto = b.length - sp;
    if (b1 < 0x80) { out += String.fromCharCode(b1); sp += 1; continue; }
    if (b1 >= 0xc2 && b1 <= 0xdf) {
      if (resto < 2) { out += '\uFFFD'; break; }
      if (!cont(b[sp + 1])) { out += '\uFFFD'; sp += 1; continue; }
      out += String.fromCharCode(((b1 & 0x1f) << 6) | (b[sp + 1] & 0x3f)); sp += 2; continue;
    }
    if (b1 >= 0xe0 && b1 <= 0xef) {
      const mal32 = (x) => (b1 === 0xe0 && (x & 0xe0) === 0x80) || !cont(x);
      if (resto < 3) {
        if (resto > 1 && mal32(b[sp + 1])) { out += '\uFFFD'; sp += 1; continue; }
        out += '\uFFFD'; break;
      }
      const b2 = b[sp + 1], b3 = b[sp + 2];
      if (mal32(b2) || !cont(b3)) { out += '\uFFFD'; sp += mal32(b2) ? 1 : 2; continue; }
      const c = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      out += c >= 0xd800 && c <= 0xdfff ? '\uFFFD' : String.fromCharCode(c);
      sp += 3; continue;
    }
    if (b1 >= 0xf0 && b1 <= 0xf7) {
      const mal42 = (x) => (b1 === 0xf0 && (x < 0x90 || x > 0xbf)) || (b1 === 0xf4 && (x & 0xf0) !== 0x80) || !cont(x);
      if (resto < 4) {
        if (b1 > 0xf4 || (resto > 1 && mal42(b[sp + 1]))) { out += '\uFFFD'; sp += 1; continue; }
        if (resto > 2 && !cont(b[sp + 2])) { out += '\uFFFD'; sp += 2; continue; }
        out += '\uFFFD'; break;
      }
      const b2 = b[sp + 1], b3 = b[sp + 2], b4 = b[sp + 3];
      const uc = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      if (!cont(b2) || !cont(b3) || !cont(b4) || uc < 0x10000 || uc > 0x10ffff) {
        let n = 3;
        if (b1 > 0xf4 || mal42(b2)) n = 1; else if (!cont(b3)) n = 2;
        out += '\uFFFD'; sp += n; continue;
      }
      out += String.fromCodePoint(uc); sp += 4; continue;
    }
    out += '\uFFFD'; sp += 1;
  }
  return out;
}

const bytesLatin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export class ParametroInvalidoTomcat extends Error {}

/**
 * Parameters.processParameters(query, UTF-8) as Tomcat 11 does it: '&'-separated, '=' splits
 * name/value, '+' is a space, %XX decoded, strict UTF-8. The FIRST malformed chunk makes every
 * getParameter*() throw (Spring answers 500 with the message) — returned in `falha`.
 */
export function lerParametrosTomcat(query) {
  const mapa = new Map();
  const bytes = bytesLatin1(query ?? '');
  let pos = 0;
  while (pos < bytes.length) {
    const inicio = pos;
    let fimNome = -1, inicioValor = -1;
    while (pos < bytes.length && bytes[pos] !== 0x26) {
      if (bytes[pos] === 0x3d && fimNome < 0) { fimNome = pos; inicioValor = pos + 1; }
      pos++;
    }
    const fim = pos;
    pos++; // skip '&'
    if (fimNome < 0) fimNome = fim;
    if (fimNome <= inicio) {
      if (inicioValor < 0) continue; // "&&"
      const chunk = new TextDecoder('latin1').decode(bytes.subarray(inicio, fim));
      return { mapa, falha: `Invalid chunk starting at byte [${inicio}] and ending at byte [${fim}] with a value of [${chunk}] ignored` };
    }
    const nomeBruto = bytes.subarray(inicio, fimNome);
    const valorBruto = inicioValor >= 0 ? bytes.subarray(inicioValor, fim) : new Uint8Array(0);
    const n = udecode(nomeBruto);
    let nome = null;
    if (n.ok) { try { nome = utf8Estrito.decode(n.bytes); } catch { nome = null; } }
    if (nome == null) return { mapa, falha: falhaDecodificacao(n.bytes, valorBruto) };
    let valor = '';
    if (inicioValor >= 0) {
      const v = udecode(valorBruto);
      valor = null;
      if (v.ok) { try { valor = utf8Estrito.decode(v.bytes); } catch { valor = null; } }
      if (valor == null) return { mapa, falha: falhaDecodificacao(udecode(nomeBruto).bytes, v.bytes) };
    }
    if (!mapa.has(nome)) mapa.set(nome, []);
    mapa.get(nome).push(valor);
  }
  return { mapa, falha: null };
}
const falhaDecodificacao = (nome, valor) => `Character decoding failed. Parameter [${utf8Java(nome)}] with value [${utf8Java(valor)}] has been ignored. Note that the name and value quoted here may be corrupted due to the failed decoding. Use debug level logging to see the original, non-corrupted values.`;

/** Wraps the parsed query: getParameterValues() throws like Tomcat when the query was malformed. */
export function parametros(ctx) {
  const { mapa, falha } = lerParametrosTomcat(queryCrua(ctx));
  return {
    valores(nome) {
      if (falha) throw new ParametroInvalidoTomcat(falha);
      return mapa.get(nome) ?? null;
    },
  };
}

// ── @RequestParam conversion (RequestParamMethodArgumentResolver + DefaultConversionService) ──
/** Character.isWhitespace */
const JAVA_WS_CHAR = /[\t\n\u000B\f\r\u001C-\u001F\u0020\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]/;
const hasText = (s) => s != null && [...s].some((c) => !JAVA_WS_CHAR.test(c));

/** String param: one value as is; several joined by ',' (ArrayToStringConverter). */
export function paramString(params, nome) {
  const v = params.valores(nome);
  return v == null ? null : v.join(',');
}

/** List<String> param: one value → StringToCollectionConverter (comma split + trim); several → as they are. */
export function paramLista(params, nome) {
  const v = params.valores(nome);
  if (v == null) return null;
  if (v.length > 1) return [...v];
  return v[0] === '' ? [] : v[0].split(',').map((s) => s.trim());
}

/** Required String param (missing only when absent). */
export function paramStringObrigatorio(params, nome) {
  const v = paramString(params, nome);
  if (v == null) throw new MissingServletRequestParameterException(nome, 'String');
  return v;
}

/**
 * Required @DateTimeFormat(iso = DATE) LocalDate: absent or blank → missing; otherwise
 * DateTimeFormatter.ISO_DATE (strict) on the first value; failure → type mismatch with the raw value.
 */
export function paramDataObrigatoria(params, nome) {
  const v = params.valores(nome);
  if (v == null) throw new MissingServletRequestParameterException(nome, 'LocalDate');
  const texto = v[0];
  if (!hasText(texto)) throw new MissingServletRequestParameterException(nome, 'LocalDate');
  const data = parseIsoDate(texto);
  if (data == null) throw new MethodArgumentTypeMismatchException(nome, v.length === 1 ? texto : stringArrayToString());
  return data;
}
/** Object.toString() of a String[] (non-deterministic identity hash, as in the JVM). */
const stringArrayToString = () => `[Ljava.lang.String;@${Math.floor(Math.random() * 0x7fffffff).toString(16)}`;

/**
 * DateTimeFormatter.ISO_DATE, STRICT: year 4..10 digits (sign rules of SignStyle.EXCEEDS_PAD),
 * '-MM-dd', optional offset (Z, case-insensitive, or ±HH:MM[:ss] with HH ≤ 23). Returns a LocalDate
 * { ano, mes, dia } or null.
 */
export function parseIsoDate(texto) {
  const m = /^([+-]?)(\d{4,10})-(\d{2})-(\d{2})(?:[zZ]|[+-](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(texto);
  if (!m) return null;
  const [, sinal, digitos, mm, dd, oh, om, os] = m;
  if (sinal === '+' && digitos.length <= 4) return null; // '+' only when the pad width is exceeded
  if (sinal === '' && digitos.length > 4) return null; // more than 4 digits require the sign
  if (sinal === '-' && /^0+$/.test(digitos)) return null; // minus zero
  if (oh != null && (Number(oh) > 23 || Number(om) > 59 || (os != null && Number(os) > 59))) return null;
  const ano = Number(sinal === '-' ? -digitos : digitos);
  if (Math.abs(ano) > 999_999_999) return null;
  const mes = Number(mm), dia = Number(dd);
  if (mes < 1 || mes > 12 || dia < 1) return null;
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];
  if (dia > dias) return null;
  return { ano, mes, dia };
}

/**
 * The text the SQLite driver binds for a LocalDate (java.sql.Date formatted "yyyy-MM-dd": year of
 * era, so year 0 → 0001 and -2027 → 2028). Years of era above 9999 fail inside the driver.
 */
export function dataSql(d) {
  const anoEra = d.ano <= 0 ? 1 - d.ano : d.ano;
  if (anoEra > 9999) throw new Error('Index -1 out of bounds for length 4');
  const p2 = (n) => String(n).padStart(2, '0');
  return `${String(anoEra).padStart(4, '0')}-${p2(d.mes)}-${p2(d.dia)}`;
}

// ── consumes / produces (RequestMappingInfoHandlerMapping.handleNoMatch) ─────
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** MimeTypeUtils.parseMimeType (simplified to what matters): null when Spring would throw. */
export function parseMediaType(texto) {
  const partes = [];
  let atual = '', aspas = false;
  for (const c of texto) {
    if (c === '"') aspas = !aspas;
    if (c === ';' && !aspas) { partes.push(atual); atual = ''; } else atual += c;
  }
  partes.push(atual);
  let full = partes[0].trim();
  if (full === '') return null;
  if (full === '*') full = '*/*';
  const barra = full.indexOf('/');
  if (barra < 0 || barra === full.length - 1) return null;
  const tipo = full.slice(0, barra).toLowerCase(), sub = full.slice(barra + 1).toLowerCase();
  if (!TOKEN.test(tipo) || !TOKEN.test(sub)) return null;
  if (tipo === '*' && sub !== '*') return null;
  const parametros = [];
  for (const p of partes.slice(1)) {
    const t = p.trim();
    if (t === '') continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue; // a parameter without '=' is ignored by the parser
    const k = t.slice(0, eq).trim(), val = t.slice(eq + 1).trim();
    if (!TOKEN.test(k)) return null;
    if (!(TOKEN.test(val) || /^"([^"\\]|\\.)*"$/.test(val))) return null;
    const semAspas = val.replace(/^"|"$/g, '');
    if (k.toLowerCase() === 'charset' && !charsetValido(semAspas)) return null;
    if (k.toLowerCase() === 'q') { // MediaType.checkParameters: Double.parseDouble in [0, 1]
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[dDfF]?$/.test(semAspas)) return null;
      const q = Number.parseFloat(semAspas);
      if (!(q >= 0 && q <= 1)) return null;
    }
    parametros.push(`${k}=${val}`);
  }
  return { tipo, sub, texto: `${tipo}/${sub}${parametros.map((p) => ';' + p).join('')}` };
}
function charsetValido(nome) {
  try { new TextDecoder(nome); return true; } catch { return /^(utf-?32(be|le)?|x-.*)$/i.test(nome); }
}

/** consumes = application/json: absent/invalid/other Content-Type → 415. */
export function verificarConsumes(req) {
  const ct = req.headers['content-type'];
  if (ct == null || ct === '') throw new HttpMediaTypeNotSupportedException("Content-Type 'null' is not supported.");
  const mt = parseMediaType(String(ct));
  if (mt == null) throw new HttpMediaTypeNotSupportedException('Could not parse Content-Type.');
  if (!(mt.tipo === 'application' && mt.sub === 'json')) throw new HttpMediaTypeNotSupportedException(`Content-Type '${mt.texto}' is not supported.`);
}

/** Accept header items (MediaType.parseMediaTypes); null entries are unparsable. */
function tiposAceitos(req) {
  const accept = req.headers.accept;
  if (accept == null) return [];
  return String(accept).split(',').map((s) => s.trim()).filter(Boolean).map(parseMediaType);
}
const acceptIlegivel = (req) => tiposAceitos(req).some((t) => t == null);

/** produces = application/json: an Accept that is unparsable or has no compatible type → 406. */
export function verificarProduces(req) {
  const tipos = tiposAceitos(req);
  if (tipos.length === 0) return;
  const naoAceitavel = (semCorpo) => new HttpMediaTypeNotAcceptableException('Acceptable representations: [application/json].', semCorpo);
  if (tipos.some((t) => t == null)) throw naoAceitavel(true);
  const compativel = (t) => (t.tipo === '*' || t.tipo === 'application')
    && (t.sub === '*' || t.sub === 'json' || (t.sub.startsWith('*+') && t.sub.slice(2) === 'json'));
  if (!tipos.some(compativel)) throw naoAceitavel(false);
}
