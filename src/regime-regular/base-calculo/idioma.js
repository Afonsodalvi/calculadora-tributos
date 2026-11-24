// Request locale of calculadora-rtc-regime-regular as Spring sees it (LocaleContextHolder):
// - Tomcat 11.0.27 Request.getLocale(): the Accept-Language headers parsed by AcceptLanguage2
//   (the default "legacy" parser: toLegacyLocale builds new Locale(language, country, variant) and
//   keeps a script subtag as an upper-case VARIANT), ordered by quality; no header or no usable
//   entry → the JVM default locale (the official package runs with -Duser.language=pt
//   -Duser.country=BR, i.e. pt_BR);
// - java.util.ResourceBundle candidate lookup (Control.getCandidateLocales + fallback to the
//   default locale), used to pick the Hibernate Validator message bundle.
// Locales are plain objects { idioma, pais, variante } (Java's language/country/variant).
// Not reproduced: Connector.maxLocaleCount (an Accept-Language with more than 1000 entries).

/** Locale.getDefault() of the official package. */
export const LOCALE_PADRAO = Object.freeze({ idioma: 'pt', pais: 'BR', variante: '' });
export const LOCALE_RAIZ = Object.freeze({ idioma: '', pais: '', variante: '' });

const ehRaiz = (l) => !l.idioma && !l.pais && !l.variante;
const iguais = (a, b) => a.idioma === b.idioma && a.pais === b.pais && a.variante === b.variante;

// ─── HttpParser primitives (org.apache.tomcat.util.http.parser.HttpParser) ───────

const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

class Leitor {
  constructor(texto) { this.t = texto; this.p = 0; }
  ler() { return this.p < this.t.length ? this.t.charCodeAt(this.p++) : -1; }
  espiar() { return this.p < this.t.length ? this.t.charCodeAt(this.p) : -1; }
}

/** HttpParser.skipLws: spaces and tabs. */
function pularLws(r) {
  while (r.espiar() === 0x20 || r.espiar() === 0x09) r.p++;
}

/** HttpParser.readToken: '' at EOF, null when the next char is not a token char. */
function lerToken(r) {
  pularLws(r);
  let s = '';
  while (r.p < r.t.length && TCHAR.test(r.t[r.p])) s += r.t[r.p++];
  if (r.p < r.t.length && s.length === 0) return null;
  return s;
}

/** HttpParser.skipUntil(input, c, target): consumes up to and including `alvo`. */
function pularAte(r, c, alvo) {
  while (c !== -1 && c !== alvo) c = r.ler();
}

/** HttpParser.skipConstant(input, ";"): 'FOUND' | 'NOT_FOUND' | 'EOF'. */
function pularConstante(r, ch) {
  pularLws(r);
  const c = r.espiar();
  if (c === -1) return 'EOF';
  if (c !== ch.charCodeAt(0)) return 'NOT_FOUND';
  r.p++;
  return 'FOUND';
}

/** HttpParser.readWeight(input, ','): quality value; 0 drops the entry. */
function lerPeso(r, delim) {
  const D = delim.charCodeAt(0);
  pularLws(r);
  let c = r.ler();
  if (c === -1 || c === D) return 1;
  if (c !== 0x71 /* q */) { pularAte(r, c, D); return 0; }
  pularLws(r);
  c = r.ler();
  if (c !== 0x3d /* = */) { pularAte(r, c, D); return 0; }
  pularLws(r);
  c = r.ler();
  let valor = '';
  let casas = -1;
  if (c === 0x30 || c === 0x31) {
    valor += String.fromCharCode(c);
    c = r.ler();
    while (true) {
      if (casas === -1 && c === 0x2e) { valor += '.'; casas = 0; }
      else if (casas > -1 && c >= 0x30 && c <= 0x39) { if (casas < 3) { valor += String.fromCharCode(c); casas++; } }
      else break;
      c = r.ler();
    }
  } else {
    pularAte(r, c, D);
    return 0;
  }
  if (c === 0x09 || c === 0x20) { pularLws(r); c = r.ler(); }
  if (c !== D && c !== -1) { pularAte(r, c, D); return 0; }
  const q = Number(valor);
  return q > 1 ? 0 : q;
}

// ─── AcceptLanguage2.toLegacyLocale ───────────────────────────────────────────

const alfa = (s) => /^[A-Za-z]+$/.test(s);
const alnum = (s) => /^[A-Za-z0-9]+$/.test(s);
const digitos = (s) => /^[0-9]+$/.test(s);
const minusculas = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const maiusculas = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** Tomcat's legacy tag → Locale(language, country, variant). */
export function localeLegado(tag) {
  const n = tag.length;
  if (n === 0) return LOCALE_RAIZ;
  let fim = tag.indexOf('-');
  if (fim < 0) fim = n;
  if (fim < 2 || fim > 8 || !alfa(tag.slice(0, fim))) return LOCALE_RAIZ;
  const idioma = minusculas(tag.slice(0, fim));
  let pais = '';
  let variante = '';
  let temScript = false;
  let temPais = false;
  const anexarVariante = (v) => { if (variante.length + v.length + 1 <= 64) variante += (variante.length > 0 ? '_' : '') + v; };
  let i = fim;
  while (i < n) {
    i++;
    fim = tag.indexOf('-', i);
    if (fim < 0) fim = n;
    const seg = tag.slice(i, fim);
    const len = seg.length;
    if (len === 0) break;
    if (len === 2 && !temPais && alfa(seg)) { pais = maiusculas(seg); temPais = true; }
    else if (len === 3 && !temPais && digitos(seg)) { pais = seg; temPais = true; }
    else if (len === 4 && !temScript && !temPais && alfa(seg)) { anexarVariante(maiusculas(seg)); temScript = true; }
    else if ((len >= 5 && len <= 8 && alnum(seg)) || (len === 4 && /[0-9]/.test(seg[0]) && alnum(seg.slice(1)))) anexarVariante(seg);
    else break;
    i = fim;
  }
  return javaLocale(idioma, pais, variante);
}

/** new Locale(language, country, variant): the JDK replaces the old ISO 639 codes. */
function javaLocale(idioma, pais, variante) {
  const antigos = { iw: 'he', ji: 'yi', in: 'id' };
  return { idioma: antigos[idioma] ?? idioma, pais, variante };
}

/** AcceptLanguage2.parse of one header value: [{ locale, qualidade }]. */
export function lerAcceptLanguage(valor) {
  const r = new Leitor(String(valor));
  const lista = [];
  while (true) {
    const tag = lerToken(r);
    if (tag === null) { pularAte(r, 0, 0x2c); continue; }
    if (tag === '') break;
    let q = 1;
    if (pularConstante(r, ';') === 'FOUND') q = lerPeso(r, ',');
    if (q > 0) lista.push({ locale: localeLegado(tag), qualidade: q });
  }
  return lista;
}

/** Request.getLocale(): highest quality first (stable), else the JVM default. `cabecalho` = string or string[]. */
export function localeDaRequisicao(cabecalho) {
  if (cabecalho == null) return LOCALE_PADRAO;
  const valores = Array.isArray(cabecalho) ? cabecalho : [cabecalho];
  const porQualidade = new Map();
  for (const v of valores) {
    for (const { locale, qualidade } of lerAcceptLanguage(v)) {
      if (!porQualidade.has(qualidade)) porQualidade.set(qualidade, []);
      porQualidade.get(qualidade).push(locale);
    }
  }
  if (!porQualidade.size) return LOCALE_PADRAO;
  const melhor = Math.max(...porQualidade.keys());
  return porQualidade.get(melhor)[0];
}

/** Locale of an incoming request (node:http joins repeated Accept-Language headers with ', '). */
export function localeDe(req) {
  const h = req?.headers?.['accept-language'];
  return localeDaRequisicao(h === undefined ? null : h);
}

// ─── ResourceBundle lookup ────────────────────────────────────────────────────

/** ResourceBundle.Control.getCandidateLocales (default control) as bundle suffixes; '' = root. */
export function candidatos(l) {
  const { idioma, pais, variante } = l;
  let script = '';
  if (idioma === 'zh' && pais) {
    if (['TW', 'HK', 'MO'].includes(pais)) script = 'Hant';
    else if (['CN', 'SG'].includes(pais)) script = 'Hans';
  }
  const variantes = [];
  if (variante) {
    let idx = variante.length;
    while (idx !== -1) { variantes.push(variante.slice(0, idx)); idx = variante.lastIndexOf('_', idx - 1); }
  }
  const nome = (i, s, p, v) => {
    let r = i;
    if (s || p || v) r += `_${s ? `${s}_` : ''}${p}`;
    if (v) r += `_${v}`;
    return r.replace(/_+$/, '');
  };
  const lista = [];
  for (const v of variantes) lista.push(nome(idioma, script, pais, v));
  if (pais) lista.push(nome(idioma, script, pais, ''));
  if (script) {
    lista.push(`${idioma}_${script}`);
    for (const v of variantes) lista.push(nome(idioma, '', pais, v));
    if (pais) lista.push(nome(idioma, '', pais, ''));
  }
  if (idioma) lista.push(idioma);
  lista.push('');
  return lista;
}

/**
 * ResourceBundle.getBundle(base, locale) over a set of available bundle suffixes: returns the
 * parent chain (most specific first, root last) of the bundle Java would load. A lone root bundle
 * is only accepted for the root locale; otherwise the default locale is tried.
 */
export function cadeiaDePacotes(locale, disponiveis) {
  const tentar = (l) => {
    const cands = candidatos(l);
    const i = cands.findIndex((c) => disponiveis.has(c));
    if (i < 0) return null;
    const achado = cands[i];
    if (achado === '' && !ehRaiz(l) && cands.length > 1) return null;
    return cands.slice(i).filter((c) => disponiveis.has(c));
  };
  return tentar(locale) ?? (iguais(locale, LOCALE_PADRAO) ? null : tentar(LOCALE_PADRAO)) ?? (disponiveis.has('') ? [''] : []);
}
