// Errors of calculadora-rtc-regime-regular as the Java API answers them:
// - ProblemType catalogue (api/exceptionhandler/enumeration/ProblemType + CodigoValidacao), from codigos-regreg.json;
// - ErroJava(classeJava, mensagem): a Java exception by simple class name → status by the
//   ApiExceptionHandler hierarchy, ProblemType by EXACT class (else ERRO_SISTEMA);
// - ProblemDetail JSON with the key order of this project (Jackson 3 defaults: alphabetical
//   detail, instance, status, title, type, then the properties map: timestamp, errors);
//   `type` is omitted when Spring never set it (the oracle omits the default about:blank);
// - the Spring MVC standard errors (404 No static resource, 405 + Allow, 406, 415 + Accept,
//   missing/invalid request parameter, HandlerMethodValidation, Failed to write request);
// - ErrosCalculo (ObservabilidadeExceptionHandler 422 envelope) and ErroDetalhe;
// - response headers: Spring Security set, X-CALC-APP-VERSION / X-CALC-DB-VERSION.
import CATALOGO from './codigos-regreg.json' with { type: 'json' };
import { escreverJson } from './json.js';
import { instanteIso } from './java.js';

/** info.app.version of the official package (X-CALC-APP-VERSION, versao/status). */
export const VERSAO_APLICACAO = '1.7.2';

/** ProblemType values in declaration order (ProblemType.from / fromCodigo take the first match). */
export const PROBLEM_TYPES = CATALOGO.ordemProblemType.map((nome) => ({ nome, ...CATALOGO.problemType[nome] }));
const PT_POR_NOME = new Map(PROBLEM_TYPES.map((p) => [p.nome, p]));
export const ERRO_SISTEMA = PT_POR_NOME.get('ERRO_SISTEMA');

/** CodigoValidacao (VAL-xxx) by code and by annotation simple name. */
export const CODIGOS_VALIDACAO = Object.entries(CATALOGO.codigoValidacao).map(([nome, v]) => ({ nome, ...v }));
const CV_POR_CODIGO = new Map(CODIGOS_VALIDACAO.map((c) => [c.code, c]));
const CV_POR_ANOTACAO = new Map(CODIGOS_VALIDACAO.map((c) => [c.annotation, c]));

/** ProblemType.from(ex): exact class match in declaration order, else ERRO_SISTEMA. */
export function problemTypePorClasse(classeJava) {
  return PROBLEM_TYPES.find((p) => p.exception === classeJava) ?? ERRO_SISTEMA;
}

/** ProblemType.fromCodigo: first with that code (codes are unique). */
export const problemTypePorCodigo = (codigo) => PROBLEM_TYPES.find((p) => p.code != null && p.code === codigo) ?? null;

/** CodigoValidacao.codeFrom(annotationSimpleName): unknown → VAL-000. */
export const codigoValidacaoDaAnotacao = (anotacao) => (CV_POR_ANOTACAO.get(anotacao) ?? CV_POR_CODIGO.get('VAL-000')).code;
export const codigoValidacaoPorCodigo = (codigo) => CV_POR_CODIGO.get(codigo) ?? null;

/** ErroService.buscarPorCodigo: { codigo, titulo, descricao } (record order) or null. */
export function erroDescricao(codigo) {
  if (codigo == null) return null;
  const pt = problemTypePorCodigo(codigo);
  if (pt) return { codigo, titulo: pt.title, descricao: pt.detail };
  const cv = codigoValidacaoPorCodigo(codigo);
  return cv ? { codigo, titulo: cv.title, descricao: cv.detail } : null;
}

// Superclass chain of the 61 domain exceptions (+ the few Spring/JDK classes that matter).
const SUPER = new Map(Object.entries(CATALOGO.excecoes).map(([k, v]) => [k, v.superclasse]));
/** Status of each @ExceptionHandler of ApiExceptionHandler (nearest declared type wins). */
const STATUS_HANDLER = new Map([
  ['ValidacaoException', 422],
  ['CampoInvalidoException', 400],
  ['EntidadeNaoEncontradaException', 404],
  ['PlataformaDownloadNaoEncontradaException', 404],
  ['EstruturaInconsistenteException', 400],
  ['ErroInternoSistemaException', 500],
  ['MethodArgumentTypeMismatchException', 400],
  ['HttpMessageNotReadableException', 400],
  ['MethodArgumentNotValidException', 400],
]);

/** Status the ApiExceptionHandler gives an exception class (walks the superclass chain; default 500). */
export function statusPorClasse(classeJava) {
  let c = classeJava;
  const vistos = new Set();
  while (c && !vistos.has(c)) {
    vistos.add(c);
    if (STATUS_HANDLER.has(c)) return STATUS_HANDLER.get(c);
    c = SUPER.get(c);
  }
  return 500;
}

/**
 * A Java exception thrown by the port: `classeJava` = simple class name (e.g. 'NcmNaoEncontradaException',
 * 'IllegalStateException'), `mensagem` = getMessage() (may be null).
 */
export class ErroJava extends Error {
  constructor(classeJava, mensagem = null) {
    // TributoSituacaoTributariaNaoEncontradoException can never be built: its template "s% n" makes
    // String.format throw IllegalFormatFlagsException("Flags = ' '") (errors-config.md §3.1).
    if (classeJava === 'TributoSituacaoTributariaNaoEncontradoException') { classeJava = 'IllegalFormatFlagsException'; mensagem = "Flags = ' '"; }
    super(mensagem ?? classeJava);
    this.name = 'ErroJava';
    this.classeJava = classeJava;
    this.mensagem = mensagem;
  }
  get status() { return statusPorClasse(this.classeJava); }
  get problemType() { return problemTypePorClasse(this.classeJava); }
}

/**
 * Exception thrown by a project serializer (IllegalArgumentException "Números negativos não são
 * permitidos para TDec1302", DatabindException "TCST deve ser…"). Spring answers it with the
 * standard 500 "Failed to write request" (HttpMessageNotWritableException), keeping the headers
 * already set (X-CALC-*). Use respostaFalhaEscrita().
 */
export class ErroSerializacao extends ErroJava {
  constructor(mensagem, classeJava = 'IllegalArgumentException') { super(classeJava, mensagem); this.name = 'ErroSerializacao'; }
}

/** ErrosCalculoException(List<ErroDetalhe>) → 422 of ObservabilidadeExceptionHandler. */
export class ErrosCalculo extends ErroJava {
  constructor(erros) { super('ErrosCalculoException', 'Erros de cálculo encontrados'); this.name = 'ErrosCalculo'; this.erros = [...erros]; }
  get status() { return 422; }
}

/** MethodArgumentTypeMismatchException (request param/path conversion): 400 "Parâmetro inválido [nome: valor] ". */
export class ErroTipoArgumento extends ErroJava {
  constructor(nome, valor) { super('MethodArgumentTypeMismatchException', `Method parameter '${nome}': Failed to convert value`); this.nome = nome; this.valor = valor; }
}

/** MethodArgumentNotValidException (@Valid @RequestBody): 400 "Campos inválidos." with [campo: mensagem] segments. */
export class ErroValidacaoCorpo extends ErroJava {
  constructor(violacoes) { super('MethodArgumentNotValidException', 'Validation failed'); this.violacoes = violacoes; }
}

/** Spring MVC exception answered by ResponseEntityExceptionHandler defaults (no timestamp, no type). */
export class ErroSpring extends Error {
  constructor(status, detail, headers = {}, classeJava = 'ErrorResponseException') {
    super(detail ?? String(status));
    this.name = 'ErroSpring';
    this.status = status;
    this.detail = detail;
    this.headers = headers;
    this.classeJava = classeJava;
  }
}

export const erroParametroAusente = (nome) => new ErroSpring(400, `Required parameter '${nome}' is not present.`, {}, 'MissingServletRequestParameterException');
export const erroValidacaoMetodo = () => new ErroSpring(400, 'Validation failure', {}, 'HandlerMethodValidationException');
export const erroRecursoInexistente = (caminho) => new ErroSpring(404, `No static resource ${caminho}.`, {}, 'NoResourceFoundException');
export const erroMetodo = (metodo, permitidos) => new ErroSpring(405, `Method '${metodo}' is not supported.`, permitidos?.length ? { Allow: permitidos.join(', ') } : {}, 'HttpRequestMethodNotSupportedException');
export const erroTipoMidia = (contentType, aceitos) => new ErroSpring(415, contentType === undefined ? 'Could not parse Content-Type.' : `Content-Type '${contentType}' is not supported.`, { Accept: aceitos.join(', ') }, 'HttpMediaTypeNotSupportedException');
export const erroNaoAceitavel = (produziveis) => new ErroSpring(406, `Acceptable representations: [${produziveis.join(', ')}].`, { Accept: produziveis.join(', ') }, 'HttpMediaTypeNotAcceptableException');
export const erroConversao = (nome, valor) => new ErroSpring(400, `Failed to convert '${nome}' with value: '${valor}'`, {}, 'TypeMismatchException');

const FRASES = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  409: 'Conflict', 413: 'Content Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 500: 'Internal Server Error', 503: 'Service Unavailable',
};
export const frase = (status) => FRASES[status] ?? '';

/**
 * ProblemDetail as this project's Jackson writes it: alphabetical detail?, instance, status, title, type?,
 * then the properties map in insertion order (timestamp, errors). NON_EMPTY: null/"" detail omitted.
 */
export function problemDetail({ detail, instance, status, title, type, propriedades }) {
  const o = {};
  if (detail != null && detail !== '') o.detail = detail;
  if (instance != null) o.instance = instance;
  o.status = status;
  o.title = title ?? frase(status);
  if (type != null && type !== '') o.type = type;
  for (const [k, v] of Object.entries(propriedades ?? {})) if (v != null) o[k] = v;
  return escreverJson(o);
}

/** ProblemDetail in the Simples style (Jackson 2 order type, title, status, detail, instance; type about:blank). */
export function problemDetailSimples({ detail, instance, status, title, type = 'about:blank' }) {
  const o = { type, title: title ?? frase(status), status };
  if (detail != null && detail !== '') o.detail = detail;
  if (instance != null) o.instance = instance;
  return escreverJson(o);
}

export const TIPO_PROBLEMA = 'application/problem+json';

/** ApiExceptionHandler.createProblem(ex, status): type {baseURL}/errors/{path}, title of the ProblemType, timestamp. */
export function criarProblema(erro, status, { baseURL, instance }, ajustes = {}) {
  const pt = problemTypePorClasse(erro.classeJava);
  return problemDetail({
    detail: ajustes.detail !== undefined ? ajustes.detail : erro.mensagem,
    instance,
    status,
    title: ajustes.title ?? pt.title,
    type: `${baseURL}/errors/${pt.path}`,
    propriedades: { timestamp: instanteIso() },
  });
}

/** ErroDetalhe record (type, title, code, pointer, detail?) in component order, nulls omitted. */
export function erroDetalhe({ type, title, code, pointer, detail }) {
  return { type, title, code, pointer, detail: detail ?? undefined };
}

/**
 * Response for any error raised by an official handler, following ObservabilidadeExceptionHandler
 * (422 ErrosCalculo) and ApiExceptionHandler. `ctx` = { baseURL, instance }. Returns
 * { status, body, tipo, headers }. Unknown JS errors become ERRO_SISTEMA/500 with their message.
 */
export function respostaErro(erro, ctx) {
  const { instance } = ctx;
  if (erro instanceof ErrosCalculo) {
    return {
      status: 422,
      tipo: TIPO_PROBLEMA,
      headers: {},
      body: problemDetail({
        detail: `O cálculo contém ${erro.erros.length} erro(s).`, instance, status: 422, title: 'Erros no processamento do cálculo', type: 'about:blank',
        propriedades: { timestamp: instanteIso(), errors: erro.erros.map(erroDetalhe) },
      }),
    };
  }
  if (erro instanceof ErroSpring) {
    return { status: erro.status, tipo: TIPO_PROBLEMA, headers: { ...erro.headers }, body: problemDetail({ detail: erro.detail, instance, status: erro.status }) };
  }
  // serializer failure after the 200 headers were set: the caller re-adds X-CALC-* (they survive in Java)
  if (erro instanceof ErroSerializacao) return respostaFalhaEscrita(instance);
  if (erro instanceof ErroTipoArgumento) {
    return { status: 400, tipo: TIPO_PROBLEMA, headers: {}, body: criarProblema(erro, 400, ctx, { detail: `Parâmetro inválido [${erro.nome}: ${erro.valor}] ` }) };
  }
  if (erro instanceof ErroValidacaoCorpo) {
    const detail = `Um ou mais campos são inválidos - ${erro.violacoes.map(([campo, msg]) => `[${campo}: ${msg}] `).join('')}`;
    return { status: 400, tipo: TIPO_PROBLEMA, headers: {}, body: criarProblema(erro, 400, ctx, { title: 'Campos inválidos.', detail }) };
  }
  const java = erro instanceof ErroJava ? erro : new ErroJava(erro?.classeJava ?? 'RuntimeException', erro?.mensagemJava !== undefined ? erro.mensagemJava : (erro?.message ?? null));
  const status = java.status;
  return { status, tipo: TIPO_PROBLEMA, headers: {}, body: criarProblema(java, status, ctx) };
}

/** 500 for a serializer failure (HttpMessageNotWritableException): Spring default body, headers kept. */
export function respostaFalhaEscrita(instance, headers = {}) {
  return { status: 500, tipo: TIPO_PROBLEMA, headers, body: problemDetail({ detail: 'Failed to write request', instance, status: 500 }) };
}

// ─── Headers ────────────────────────────────────────────────────────────────

/**
 * Spring Security default headers of the official APIs. The three cache headers are dropped when
 * the controller set its own Cache-Control. estilo 'simples' adds the three CORS Vary headers that
 * the Simples API (Spring Security with a CorsConfigurationSource) emits.
 */
export function cabecalhosSeguranca({ estilo = 'regime-regular', cacheControl } = {}) {
  const h = {};
  if (estilo === 'simples') h.Vary = ['Origin', 'Access-Control-Request-Method', 'Access-Control-Request-Headers'];
  h['X-Content-Type-Options'] = 'nosniff';
  h['X-XSS-Protection'] = '0';
  if (cacheControl) h['Cache-Control'] = cacheControl;
  else { h['Cache-Control'] = 'no-cache, no-store, max-age=0, must-revalidate'; h.Pragma = 'no-cache'; h.Expires = '0'; }
  h['X-Frame-Options'] = 'SAMEORIGIN';
  return h;
}

/** VersaoBaseDadosService.getUltimaVersao() (cached forever like the @Cacheable). */
const cacheVersao = new WeakMap();
export function ultimaVersaoBase(base) {
  if (cacheVersao.has(base)) return cacheVersao.get(base);
  const v = base.get('SELECT v.VRBD_ID id, v.VRBD_DATA data, v.VRBD_DESCRICAO descricao, v.VRBD_VERSAO_BASE_DADO versao FROM VERSAO_BASE_DADO v ORDER BY v.VRBD_ID DESC LIMIT 1');
  if (!v) throw new ErroJava('IllegalStateException', 'Nenhuma versão de base de dados encontrada');
  const r = { id: v.id, numeroVersao: v.versao, data: String(v.data).slice(0, 10), descricao: v.descricao };
  cacheVersao.set(base, r);
  return r;
}

/** VersaoAplicacaoService.getHeaders(): X-CALC-APP-VERSION, X-CALC-DB-VERSION (200 of the calculation endpoints). */
export function cabecalhosVersao(base) {
  return { 'X-CALC-APP-VERSION': VERSAO_APLICACAO, 'X-CALC-DB-VERSION': ultimaVersaoBase(base).numeroVersao };
}
