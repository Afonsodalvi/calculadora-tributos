// Spring MVC / Spring Security / Tomcat behaviour of the official APIs for the paths under their
// prefixes (/api/calculadora/**, /api/versao/**): request firewall, mapping by decoded path,
// HEAD/OPTIONS/preflight, 404 "No static resource", 405 + Allow, 415 consumes, 406 produces,
// Tomcat query-parameter parsing (with its 500s), content negotiation, and the response writer
// with the Spring Security header set. Two styles: 'regime-regular' (this port; Jackson 3 order)
// and 'simples' (calculadora-rtc-simples-nacional, Jackson 2 order + CORS Vary headers).
import { decodificarUtf8Java, javaTrim, javaIsWhitespace } from './java.js';
import { parseInteiroJava } from './json.js';
import {
  cabecalhosSeguranca, problemDetail, problemDetailSimples, respostaErro, ErroJava, ErroSpring, TIPO_PROBLEMA,
  erroRecursoInexistente, erroMetodo, erroTipoMidia, erroNaoAceitavel, frase, erroParametroAusente, ErroTipoArgumento,
} from './problema.js';
import { escreverJson } from './json.js';
import { registrarErro } from '../../http/seguranca.js';
// spring-web mime.types extensions whose type is audio/*, image/*, video/* or */*+xml (safe for RFD)
import SEGUROS_MIME from './extensoes-seguras.json' with { type: 'json' };

export const PREFIXOS_OFICIAIS = ['/api/calculadora', '/api/versao'];
export const CONTEXTO = '/api';

/** Raw path (no query) of req.url; absolute-form request targets are reduced to their path. */
export function caminhoCru(urlCru) {
  let u = String(urlCru ?? '/');
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/.exec(u);
  if (m) u = u.slice(m[0].length) || '/';
  const q = u.indexOf('?');
  return q < 0 ? u : u.slice(0, q);
}

export function consultaCrua(urlCru) {
  const u = String(urlCru ?? '');
  const q = u.indexOf('?');
  return q < 0 ? null : u.slice(q + 1);
}

/** Which official API owns the raw path: 'simples' (paths with simples-nacional), 'regime-regular', or null. */
export function estiloOficial(urlCru) {
  const p = caminhoCru(urlCru);
  if (!PREFIXOS_OFICIAIS.some((x) => p === x || p.startsWith(`${x}/`) || p.startsWith(`${x};`))) return null;
  return p.includes('simples-nacional') ? 'simples' : 'regime-regular';
}

// ─── Media types (org.springframework.util.MimeType / MediaType) ───────────────

const SEPARADORES = new Set('()<>@,;:\\"/[]?={} \t'.split(''));
const token = (s) => s.length > 0 && [...s].every((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) < 0x7f && !SEPARADORES.has(c));
const aspas = (v) => v.length >= 2 && v.startsWith('"') && v.endsWith('"');
const semAspas = (v) => (aspas(v) ? v.slice(1, -1) : v);

function charsetSuportado(nome) {
  try { new TextDecoder(nome); return true; } catch { return /^(utf-32|utf-32be|utf-32le|us-ascii|iso-8859-1|latin1)$/i.test(nome); }
}

/** MimeTypeUtils.parseMimeType: { tipo, subtipo, params: [[nome, valor]] } or null when invalid. */
export function lerMediaType(texto) {
  if (texto == null) return null;
  const s = String(texto);
  if (!s.trim()) return null;
  const partes = [];
  let atual = '';
  let emAspas = false;
  for (const c of s) {
    if (c === '"') emAspas = !emAspas;
    if (c === ';' && !emAspas) { partes.push(atual); atual = ''; } else atual += c;
  }
  partes.push(atual);
  let completo = partes[0].trim();
  if (completo === '*') completo = '*/*';
  const barra = completo.indexOf('/');
  if (barra < 0 || barra === completo.length - 1) return null;
  const tipo = completo.slice(0, barra).toLowerCase();
  const subtipo = completo.slice(barra + 1).toLowerCase();
  if (!token(tipo) || !token(subtipo)) return null;
  if (tipo === '*' && subtipo !== '*') return null;
  const params = [];
  for (const p of partes.slice(1)) {
    const t = p.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const nome = t.slice(0, eq).trim();
    const valor = t.slice(eq + 1).trim();
    if (!token(nome)) return null;
    if (!aspas(valor) && !token(valor)) return null;
    if (nome.toLowerCase() === 'charset' && !charsetSuportado(semAspas(valor))) return null;
    if (nome.toLowerCase() === 'q') { const q = Number(semAspas(valor)); if (!(q >= 0 && q <= 1)) return null; }
    params.push([nome, valor]);
  }
  return { tipo, subtipo, params };
}

export const mediaTypeTexto = (m) => `${m.tipo}/${m.subtipo}${m.params.map(([k, v]) => `;${k}=${v}`).join('')}`;
export const charsetDe = (m) => { const p = m?.params.find(([k]) => k.toLowerCase() === 'charset'); return p ? semAspas(p[1]) : undefined; };

/** MediaType.parseMediaTypes(Accept): list, [] when blank, null when unparseable. */
export function lerAccept(texto) {
  if (texto == null || !String(texto).trim()) return [];
  const itens = [];
  let atual = '';
  let emAspas = false;
  for (const c of String(texto)) {
    if (c === '"') emAspas = !emAspas;
    if (c === ',' && !emAspas) { itens.push(atual); atual = ''; } else atual += c;
  }
  itens.push(atual);
  const r = [];
  for (const i of itens) {
    if (!i.trim()) continue;
    const m = lerMediaType(i);
    if (!m) return null;
    r.push(m);
  }
  return r;
}

const sufixo = (s) => { const i = s.indexOf('+'); return i < 0 ? null : s.slice(i + 1); };
const curinga = (m) => m.tipo === '*';
const subCuringa = (m) => m.subtipo === '*' || m.subtipo.startsWith('*+');

/** MimeType.includes(other). */
export function inclui(a, b) {
  if (curinga(a)) return true;
  if (a.tipo !== b.tipo) return false;
  if (a.subtipo === b.subtipo) return true;
  if (subCuringa(a)) {
    if (a.subtipo === '*') return true;
    const sa = sufixo(a.subtipo);
    return sa != null && (b.subtipo === sa || sufixo(b.subtipo) === sa);
  }
  return false;
}

/** MimeType.isCompatibleWith(other). */
export function compativel(a, b) {
  if (curinga(a) || curinga(b)) return true;
  if (a.tipo !== b.tipo) return false;
  if (a.subtipo === b.subtipo) return true;
  if (subCuringa(a) || subCuringa(b)) {
    const sa = sufixo(a.subtipo), sb = sufixo(b.subtipo);
    if (a.subtipo === '*' || b.subtipo === '*') return true;
    if (subCuringa(a) && sa != null && (sa === b.subtipo || sa === sb)) return true;
    if (subCuringa(b) && sb != null && (sb === a.subtipo || sb === sa)) return true;
  }
  return false;
}

const qualidade = (m) => { const p = m.params.find(([k]) => k.toLowerCase() === 'q'); return p ? Number(semAspas(p[1])) : 1; };

/**
 * AbstractMessageConverterMethodProcessor content negotiation for a handler without `produces`:
 * returns the media type text to write, or throws the 406 Spring raises.
 */
export function negociar(acceito, produziveis) {
  const pedidos = acceito.length ? acceito : [lerMediaType('*/*')];
  const prod = produziveis.map(lerMediaType);
  const usar = [];
  for (const p of pedidos) {
    for (const q of prod) {
      if (compativel(p, q)) {
        const especifico = (curinga(p) || (subCuringa(p) && !subCuringa(q))) ? { ...q, params: [] } : p.subtipo === '*' || subCuringa(p) ? q : p;
        usar.push({ m: especifico, q: qualidade(p) });
      }
    }
  }
  if (!usar.length) throw erroNaoAceitavel(produziveis);
  usar.sort((x, y) => {
    const ex = (curinga(x.m) ? 0 : subCuringa(x.m) ? 1 : 2), ey = (curinga(y.m) ? 0 : subCuringa(y.m) ? 1 : 2);
    if (ex !== ey) return ey - ex;
    return y.q - x.q;
  });
  for (const u of usar) if (!curinga(u.m) && !subCuringa(u.m)) return `${u.m.tipo}/${u.m.subtipo}`;
  return produziveis[0];
}

// ─── Tomcat query parameters (org.apache.tomcat.util.http.Parameters) ──────────

const MAX_PARAMETROS = 1000;
const ehHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
const valorHex = (b) => (b <= 0x39 ? b - 0x30 : (b | 0x20) - 0x57);

/** UDecoder.convert(bc, query=true) in place: returns { ok, bytes } (bytes = buffer state, also on failure). */
function decodificarUrl(bytes) {
  const buf = Uint8Array.from(bytes);
  const fim = buf.length;
  let idx = 0;
  for (let j = 0; j < fim; j++, idx++) {
    const b = buf[j];
    if (b === 0x2b) { buf[idx] = 0x20; continue; }
    if (b !== 0x25) { buf[idx] = b; continue; }
    if (j + 2 >= fim) return { ok: false, bytes: buf };
    const b1 = buf[j + 1], b2 = buf[j + 2];
    if (!ehHex(b1) || !ehHex(b2)) return { ok: false, bytes: buf };
    j += 2;
    buf[idx] = (valorHex(b1) << 4) + valorHex(b2);
  }
  return { ok: true, bytes: buf.subarray(0, idx) };
}

/**
 * Parameters.processParameters over the raw query string (UTF-8). Returns { mapa: Map<nome, valores[]>, erro }
 * where `erro` is the message Tomcat throws on the first invalid chunk / decoding failure / count overflow.
 */
export function lerParametrosTomcat(consulta) {
  const mapa = new Map();
  if (consulta == null || consulta === '') return { mapa, erro: null };
  const bytes = Buffer.from(consulta, 'latin1');
  const fim = bytes.length;
  let pos = 0;
  let total = 0;
  while (pos < fim) {
    const ini = pos;
    let fimNome = -1, iniValor = -1, fimValor = -1;
    let nomeDec = false, valorDec = false, completo = false, lendoNome = true;
    do {
      const b = bytes[pos];
      if (b === 0x3d) { if (lendoNome) { fimNome = pos; lendoNome = false; iniValor = ++pos; } else pos++; }
      else if (b === 0x26) { if (lendoNome) fimNome = pos; else fimValor = pos; completo = true; pos++; }
      else if (b === 0x25 || b === 0x2b) { if (lendoNome) nomeDec = true; else valorDec = true; pos++; }
      else pos++;
    } while (!completo && pos < fim);
    if (pos === fim) {
      if (fimNome === -1) fimNome = pos;
      else if (iniValor > -1 && fimValor === -1) fimValor = pos;
    }
    if (fimNome <= ini) {
      if (iniValor === -1) continue;
      const trecho = fimValor > ini ? bytes.toString('latin1', ini, fimValor) : '';
      return { mapa, erro: `Invalid chunk starting at byte [${ini}] and ending at byte [${fimValor}] with a value of [${trecho}] ignored` };
    }
    // ByteChunk state as Tomcat leaves it: the charset is only set (UTF-8) after a successful
    // %-decoding; before that toString() uses ISO-8859-1. The failure message prints both chunks.
    let nomeB = bytes.subarray(ini, fimNome), nomeUtf8 = false;
    let valorB = iniValor >= 0 ? bytes.subarray(iniValor, fimValor) : Buffer.alloc(0), valorUtf8 = false;
    const texto = (b, utf8) => (utf8 ? decodificarUtf8Java(Buffer.from(b)) : Buffer.from(b).toString('latin1'));
    const falha = () => ({ mapa, erro: `Character decoding failed. Parameter [${texto(nomeB, nomeUtf8)}] with value [${texto(valorB, valorUtf8)}] has been ignored. Note that the name and value quoted here may be corrupted due to the failed decoding. Use debug level logging to see the original, non-corrupted values.` });
    let nome, valor;
    if (nomeDec) { const d = decodificarUrl(nomeB); if (!d.ok) { nomeB = d.bytes; return falha(); } nomeB = d.bytes; }
    nomeUtf8 = true;
    nome = decodificarUtf8Java(Buffer.from(nomeB), false);
    if (nome === null) return falha();
    if (iniValor >= 0) {
      if (valorDec) { const d = decodificarUrl(valorB); if (!d.ok) { valorB = d.bytes; return falha(); } valorB = d.bytes; }
      valorUtf8 = true;
      valor = decodificarUtf8Java(Buffer.from(valorB), false);
      if (valor === null) return falha();
    } else valor = '';
    if (++total > MAX_PARAMETROS) {
      return { mapa, erro: `More than the maximum number of request parameters (GET plus POST) for a single request ([${MAX_PARAMETROS.toLocaleString('en-US')}]) were detected. Any parameters beyond this limit have been ignored. To change this limit, set the maxParameterCount attribute on the Connector.` };
    }
    if (!mapa.has(nome)) mapa.set(nome, []);
    mapa.get(nome).push(valor);
  }
  return { mapa, erro: null };
}

/**
 * request.getParameter* as the controllers see them. Any access throws Tomcat's parsing failure
 * (500 ERRO_SISTEMA in the ApiExceptionHandler). `texto(nome)` = @RequestParam String (values joined by ',').
 */
export function parametrosTomcat(consulta) {
  let lido = null;
  const ler = () => {
    lido ??= lerParametrosTomcat(consulta);
    if (lido.erro) throw new ErroJava('InvalidParameterException', lido.erro);
    return lido.mapa;
  };
  return {
    tem: (nome) => ler().has(nome),
    valores: (nome) => ler().get(nome) ?? null,
    primeiro: (nome) => ler().get(nome)?.[0] ?? null,
    texto: (nome) => { const v = ler().get(nome); return v ? v.join(',') : null; },
    nomes: () => [...ler().keys()],
  };
}

// ─── @RequestParam conversion (Spring DefaultConversionService) ───────────────

/** @RequestParam String: values joined by ','; absent → 400 "Required parameter" (or null when optional). */
export function parametroTexto(parametros, nome, { obrigatorio = true } = {}) {
  const v = parametros.texto(nome);
  if (v === null && obrigatorio) throw erroParametroAusente(nome);
  return v;
}

const ARRAY_JAVA = () => `[Ljava.lang.String;@${Math.floor(Math.random() * 0x7fffffff).toString(16)}`;

/**
 * @RequestParam Long/Integer: the first value; blank → absent; StringUtils.trimAllWhitespace; hex
 * (0x, 0X, #) through Long.decode, else Long.valueOf (Unicode digits accepted, no octal).
 * Failure → MethodArgumentTypeMismatchException 400 "Parâmetro inválido [nome: valor] " (with 2+
 * values Java prints the String[] identity, which is not deterministic).
 */
export function parametroInteiro(parametros, nome, { obrigatorio = true, bits = 64 } = {}) {
  const valores = parametros.valores(nome);
  const v0 = valores?.[0];
  if (v0 == null || javaTrim(v0) === '') {
    if (obrigatorio) throw erroParametroAusente(nome);
    return null;
  }
  const t = [...v0].filter((c) => !javaIsWhitespace(c)).join('');
  const min = bits === 32 ? -2147483648n : -9223372036854775808n;
  const max = bits === 32 ? 2147483647n : 9223372036854775807n;
  let n = null;
  const m = /^([-+]?)(0x|0X|#)(.*)$/.exec(t);
  if (m) {
    if (/^[0-9a-fA-F]+$/.test(m[3])) { n = BigInt(`0x${m[3]}`) * (m[1] === '-' ? -1n : 1n); if (n < min || n > max) n = null; }
  } else n = parseInteiroJava(t, min, max);
  if (n === null) throw new ErroTipoArgumento(nome, valores.length > 1 ? ARRAY_JAVA() : v0);
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

// ─── Firewall (Tomcat + Spring Security StrictHttpFirewall) ───────────────────

const HTML_400 = '<!doctype html><html lang="en"><head><title>HTTP Status 400 – Bad Request</title><style type="text/css">body {font-family:Tahoma,Arial,sans-serif;} h1, h2, h3, b {color:white;background-color:#525D76;} h1 {font-size:22px;} h2 {font-size:16px;} h3 {font-size:14px;} p {font-size:12px;} a {color:black;} .line {height:1px;background-color:#525D76;border:none;}</style></head><body><h1>HTTP Status 400 – Bad Request</h1></body></html>';

const instanteSegundos = () => `${new Date().toISOString().slice(0, 19)}Z`;

/** Spring Boot /error JSON (BasicErrorController): timestamp, status, error, path. */
export function respostaErroBoot(status, caminho, headers = {}) {
  const body = escreverJson({ timestamp: instanteSegundos(), status, error: frase(status), path: caminho });
  return { status, tipo: 'application/json', headers: { Vary: 'accept-encoding', ...headers }, body, semSeguranca: true, erroBoot: true };
}

const respostaTomcat400 = () => ({ status: 400, tipo: 'text/html;charset=utf-8', headers: { 'Content-Language': 'en' }, body: HTML_400, semSeguranca: true });

/** Returns the response of Tomcat/StrictHttpFirewall for a rejected request line, or null. */
export function verificarFirewall(metodo, urlCru) {
  const caminho = caminhoCru(urlCru);
  if (metodo === 'TRACE') return respostaErroBoot(405, caminho, { Allow: 'HEAD, DELETE, POST, GET, OPTIONS, PUT' });
  // Tomcat: raw characters outside RFC 7230 request-target chars (path or query), encoded '/', '\', NUL,
  // bad %-escapes or UTF-8 in the path
  if (/["<>\\^`{|}#\x00-\x20\x7f]/.test(String(urlCru))) return respostaTomcat400();
  if (/%(2f|5c|00)/i.test(caminho)) return respostaTomcat400();
  const bytes = [];
  for (let i = 0; i < caminho.length; i++) {
    const c = caminho.charCodeAt(i);
    if (c === 0x25) {
      const h = caminho.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return respostaTomcat400();
      bytes.push(parseInt(h, 16));
      i += 2;
    } else bytes.push(c & 0xff);
  }
  if (decodificarUtf8Java(Buffer.from(bytes), false) === null) return respostaTomcat400();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'].includes(metodo)) return respostaErroBoot(400, caminho);
  // StrictHttpFirewall
  if (/;|%3b/i.test(caminho)) return respostaErroBoot(400, caminho);
  if (/%25|%2e|%0a|%0d|%e2%80%a8|%e2%80%a9/i.test(caminho)) return respostaErroBoot(400, caminho);
  if (caminho.includes('//')) return respostaErroBoot(400, caminho);
  if (/[^\x21-\x7e]/.test(caminho)) return respostaErroBoot(400, caminho);
  const segs = caminho.split('/');
  if (segs.some((s) => s === '.' || s === '..')) {
    // Tomcat normalizes first; a path that collapses onto the context root is redirected
    const pilha = [];
    for (const s of segs.slice(1)) { if (s === '.') continue; if (s === '..') { if (!pilha.length) return respostaTomcat400(); pilha.pop(); } else pilha.push(s); }
    const norm = `/${pilha.join('/')}`;
    if (norm === CONTEXTO || norm === `${CONTEXTO}/`) return { status: 302, tipo: null, headers: { Location: `${CONTEXTO}/` }, body: null, semSeguranca: true };
    return respostaErroBoot(400, caminho);
  }
  return null;
}

// ─── Mapping ────────────────────────────────────────────────────────────────────

/** Path decoded per segment, as PathPatternParser compares it. */
export function caminhoDecodificado(caminho) {
  return caminho.split('/').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/');
}

function casar(rota, caminho) {
  if (typeof rota.path === 'string') return rota.path === caminho ? [] : null;
  const m = rota.path.exec(caminho);
  return m && m[0] === caminho ? m.slice(1) : null;
}

const SEGUROS = new Set(['txt', 'text', 'yml', 'properties', 'csv', 'json', 'xml', 'atom', 'rss', 'png', 'jpe', 'jpeg', 'jpg', 'gif', 'wbmp', 'bmp']);
const SEGUROS_MIME_SET = new Set(SEGUROS_MIME);

/** AbstractMessageConverterMethodProcessor.addContentDispositionHeader (RFD protection). */
export function contentDisposition(caminho) {
  let nome = caminho.slice(caminho.lastIndexOf('/') + 1);
  let pathParams = '';
  const pv = nome.indexOf(';');
  if (pv >= 0) { pathParams = nome.slice(pv); nome = nome.slice(0, pv); }
  const decod = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const ext = (s) => { const i = s.lastIndexOf('.'); if (i < 0) return null; const sep = s.lastIndexOf('/'); return sep > i ? null : s.slice(i + 1); };
  const seguro = (e) => !e || SEGUROS.has(e.toLowerCase()) || SEGUROS_MIME_SET.has(e.toLowerCase());
  return seguro(ext(decod(nome))) && seguro(ext(decod(pathParams))) ? null : 'inline;filename=f.txt';
}

/** Path inside the context for "No static resource {path}." (raw, without the leading and trailing slashes). */
export function caminhoRecurso(caminho) {
  return caminho.slice(CONTEXTO.length).replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Decides what Spring does with a request under an official prefix. Returns one of:
 *  { tipo: 'resposta', resposta }                 — answered here (firewall, 404, 405, 415, 406, OPTIONS, preflight);
 *  { tipo: 'rota', rota, params, contentType, aceito } — call the handler.
 * `rotas` = the router's route list; routes of the style are the ones flagged `oficial`.
 */
export function mapear(req, rotas, estilo) {
  const metodo = req.method;
  const caminho = caminhoCru(req.url);
  const fw = verificarFirewall(metodo, req.url);
  if (fw) return { tipo: 'resposta', resposta: fw };
  const preflight = metodo === 'OPTIONS' && req.headers.origin != null && req.headers['access-control-request-method'] != null;
  if (preflight) return { tipo: 'resposta', resposta: { status: 200, tipo: null, headers: {}, body: null } };
  const decodificado = caminhoDecodificado(caminho);
  const candidatas = [];
  for (const r of rotas) {
    const params = casar(r, decodificado);
    if (params) candidatas.push({ rota: r, params });
  }
  // a path that exists in one API answers in that API's style (e.g. /api/versao is the Simples' route)
  if (candidatas.some((c) => c.rota.oficial === 'simples')) estilo = 'simples';
  else if (candidatas.some((c) => c.rota.oficial === 'regime-regular')) estilo = 'regime-regular';
  const problema = (erro) => ({ tipo: 'resposta', estilo, resposta: respostaPadrao(erro, estilo, caminho) });
  if (!candidatas.length) return problema(erroRecursoInexistente(caminhoRecurso(caminho)));
  const procurado = metodo === 'HEAD' ? 'GET' : metodo;
  const daRota = candidatas.find((c) => c.rota.method === procurado);
  const metodos = [...new Set(candidatas.map((c) => c.rota.method))];
  if (!daRota) {
    if (metodo === 'OPTIONS') {
      const allow = [];
      for (const m of metodos) { allow.push(m); if (m === 'GET') allow.push('HEAD'); }
      allow.push('OPTIONS');
      return { tipo: 'resposta', estilo, resposta: { status: 200, tipo: null, headers: { Allow: allow.join(','), 'Accept-Patch': '' }, body: null } };
    }
    return problema(erroMetodo(metodo, metodos));
  }
  const { rota, params } = daRota;
  // consumes (415)
  const ctHeader = req.headers['content-type'];
  const temCt = ctHeader != null && String(ctHeader) !== '';
  const ct = temCt ? lerMediaType(ctHeader) : null;
  const consome = rota.consome ?? (rota.method === 'POST' ? ['application/json'] : null);
  if (consome) {
    if (temCt && !ct) return problema(erroTipoMidia(undefined, consome));
    const efetivo = ct ?? lerMediaType('application/octet-stream');
    if (!consome.some((c) => inclui(lerMediaType(c), efetivo))) return problema(erroTipoMidia(temCt ? mediaTypeTexto(ct) : 'null', consome));
  }
  // produces (406)
  const aceito = lerAccept(req.headers.accept);
  if (rota.produz) {
    if (aceito === null) return { tipo: 'resposta', estilo, resposta: { status: 406, tipo: null, headers: { Accept: rota.produz.join(', ') }, body: null } };
    const pedidos = aceito.length ? aceito : [lerMediaType('*/*')];
    if (!rota.produz.some((p) => pedidos.some((a) => compativel(lerMediaType(p), a)))) return problema(erroNaoAceitavel(rota.produz));
  }
  return { tipo: 'rota', estilo, rota, params, contentType: ct, aceito };
}

/** Spring default ProblemDetail response for an ErroSpring in the given style. */
export function respostaPadrao(erro, estilo, caminho) {
  if (estilo === 'simples') {
    return { status: erro.status, tipo: TIPO_PROBLEMA, headers: { ...erro.headers }, body: problemDetailSimples({ detail: erro.detail, instance: caminho, status: erro.status }) };
  }
  return { status: erro.status, tipo: TIPO_PROBLEMA, headers: { ...erro.headers }, body: problemDetail({ detail: erro.detail, instance: caminho, status: erro.status }) };
}

/**
 * Writes an official response: Spring Security headers of the style (unless `semSeguranca`), the
 * handler headers, Content-Type `tipo` (none when the body is null), RFD Content-Disposition,
 * HEAD without body. `body` string = sent verbatim; other values are written with escreverJson.
 */
export function enviarOficial(req, res, resposta, estilo) {
  const { status, body, tipo } = resposta;
  const extras = resposta.headers ?? {};
  const cache = Object.keys(extras).find((k) => k.toLowerCase() === 'cache-control');
  const h = resposta.semSeguranca ? {} : cabecalhosSeguranca({ estilo, cacheControl: cache ? extras[cache] : undefined });
  for (const [k, v] of Object.entries(extras)) if (k !== cache) h[k] = v;
  let texto = body == null ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : escreverJson(body);
  // Spring cannot render a ProblemDetail (nor Boot's /error JSON) when the Accept header is unparseable
  if (texto != null && (tipo === TIPO_PROBLEMA || resposta.erroBoot) && lerAccept(req.headers.accept) === null) {
    texto = null;
    // nothing committed: FrameworkServlet.doOptions falls back to HttpServlet.doOptions (+ PATCH)
    if (req.method === 'OPTIONS' && !resposta.erroBoot) h.Allow = 'GET, HEAD, POST, PUT, DELETE, OPTIONS, TRACE, PATCH';
  }
  if (texto != null && tipo) h['Content-Type'] = tipo;
  if (status >= 200 && status !== 304 && !(status >= 300 && status < 400)) {
    const cd = contentDisposition(caminhoCru(req.url));
    if (cd && texto != null) h['Content-Disposition'] = cd;
  }
  if (texto == null && status !== 204 && status !== 304) h['Content-Length'] = '0';
  res.writeHead(status, h);
  res.end(texto == null || req.method === 'HEAD' ? undefined : texto);
}

/** Error raised by an official handler → response of the official exception handlers. */
export function respostaDeErro(erro, ctx) {
  if (erro instanceof ErroSpring) return respostaPadrao(erro, ctx.estilo ?? 'regime-regular', ctx.instance);
  return respostaErro(erro, ctx);
}

/**
 * Entry point used by src/app.js for every request under an official prefix (after the app's
 * Host/Origin/rate-limit/token guards). Routes flagged `oficial: 'regime-regular'` get the Spring
 * pipeline end to end (context below, errors → official problem bodies, Spring headers); other
 * official routes (the Simples port) only get Spring's mapping fallback and keep the app sender.
 *
 * Handler context for regime-regular routes = criarContexto(...) plus:
 *   estilo, instance (raw request path), contentType (parsed MediaType or null), charset,
 *   aceito (parsed Accept list, null when unparseable), parametros (Tomcat request parameters).
 * Route options: `consome` (default ['application/json'] for POST), `produz` (e.g. ['application/json']).
 */
export async function tratarOficial(req, res, { rotas, estilo, cors = {}, criarContexto, enviarApp }) {
  const decisao = mapear(req, rotas, estilo);
  estilo = decisao.estilo ?? estilo;
  // CORS headers only exist when the app's CORS_ORIGINS allows the caller (never in the default setup)
  const comCors = (r) => (Object.keys(cors).length ? { ...r, headers: { ...cors, ...(r.headers ?? {}) } } : r);
  if (decisao.tipo === 'resposta') return enviarOficial(req, res, comCors(decisao.resposta), estilo);
  const { rota, params } = decisao;
  const url = new URL(req.url, 'http://localhost');
  if (rota.oficial !== 'regime-regular') {
    const saida = await rota.handler(criarContexto(req, url, params));
    return enviarApp(res, saida.status, saida.body, { ...cors, ...saida.headers }, saida.tipo);
  }
  const ctx = {
    ...criarContexto(req, url, params),
    estilo,
    instance: caminhoCru(req.url),
    contentType: decisao.contentType,
    charset: charsetDe(decisao.contentType),
    aceito: decisao.aceito,
    parametros: parametrosTomcat(consultaCrua(req.url)),
  };
  let saida;
  try {
    saida = await rota.handler(ctx);
  } catch (e) {
    if (!(e instanceof ErroJava) && !(e instanceof ErroSpring) && e?.status !== 413) registrarErro(e);
    saida = e?.status === 413 && !(e instanceof ErroJava) ? { status: 413, tipo: 'application/json', body: escreverJson({ erro: e.message }), headers: {} } : respostaDeErro(e, ctx);
  }
  return enviarOficial(req, res, comCors(saida), estilo);
}
