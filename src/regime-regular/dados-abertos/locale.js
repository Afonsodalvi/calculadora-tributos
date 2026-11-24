// Request locale and its SHORT date pattern, as the official API resolves them for a LocalDate
// @RequestParam without @DateTimeFormat (Spring's TemporalAccessorParser uses
// DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(LocaleContextHolder.getLocale())):
//   1. Tomcat 11.0.27 Request.getLocale(): Accept-Language parsed by
//      org.apache.tomcat.util.http.parser.AcceptLanguage2 (the default; HttpParser token and q-weight rules,
//      highest quality first, stable within a quality) whose toLegacyLocale builds
//      new Locale(language, country, variant) — a script subtag becomes an UPPER CASE variant ("am-Latn" →
//      am__LATN), grandfathered/private-use tags are not interpreted ("i-default" → ROOT); no usable entry →
//      the JVM default locale (pt_BR in the official package). More than 10 entries make Tomcat throw for the
//      whole request (an HTTP-layer 500, outside this area);
//   2. Spring's AcceptHeaderLocaleResolver (no default/supported locales) returns that locale as is;
//   3. the JDK CLDR provider looks the pattern up along CLDRLocaleProviderAdapter.getCandidateLocales
//      (ResourceBundle.Control default list + Chinese script inference + irregular parents + a script that
//      is not the language's likely script falling back to root). Data in locale-jdk.json (from the JDK 25).
import DADOS from './locale-jdk.json' with { type: 'json' };

/** java.util.Locale fields that matter here (language lower case, script title case, country upper case). */
export const LOCALE_PADRAO = Object.freeze({ L: 'pt', S: '', C: 'BR', V: '' });
const RAIZ = Object.freeze({ L: '', S: '', C: '', V: '' });

const chave = (l) => `${l.L}_${l.S}_${l.C}_${l.V}`;
const igual = (a, b) => a != null && b != null && chave(a) === chave(b);

// ─── Locale.forLanguageTag (sun.util.locale.LanguageTag.parse + InternalLocaleBuilder) ─────────

const LEGADO = {
  'art-lojban': 'jbo', 'cel-gaulish': 'xtg-x-cel-gaulish', 'en-gb-oed': 'en-GB-x-oed', 'i-ami': 'ami', 'i-bnn': 'bnn',
  'i-default': 'en-x-i-default', 'i-enochian': 'und-x-i-enochian', 'i-hak': 'hak', 'i-klingon': 'tlh', 'i-lux': 'lb',
  'i-mingo': 'see-x-i-mingo', 'i-navajo': 'nv', 'i-pwn': 'pwn', 'i-tao': 'tao', 'i-tay': 'tay', 'i-tsu': 'tsu',
  'no-bok': 'nb', 'no-nyn': 'nn', 'sgn-be-fr': 'sfb', 'sgn-be-nl': 'vgt', 'sgn-ch-de': 'sgg', 'zh-guoyu': 'cmn',
  'zh-hakka': 'hak', 'zh-min': 'nan-x-zh-min', 'zh-min-nan': 'nan', 'zh-xiang': 'hsn',
};
const ANTIGOS = { iw: 'he', in: 'id', ji: 'yi' };
const alfa = (s) => /^[A-Za-z]+$/.test(s);
const alnum = (s) => /^[A-Za-z0-9]+$/.test(s);

/**
 * Locale.forLanguageTag: the well-formed prefix of the tag (parsing stops at the first ill-formed subtag).
 * Used for the BCP 47 tags of the JDK tables (aliases, irregular parents), not for request headers.
 */
export function forLanguageTag(tag) {
  const legado = LEGADO[tag.toLowerCase()];
  const t = (legado ?? tag).split('-');
  let i = 0;
  let L = '', S = '', C = '';
  const V = [];
  const atual = () => t[i];
  if (i < t.length && atual().length >= 2 && atual().length <= 8 && alfa(atual())) {
    L = atual().toLowerCase();
    i++;
    const extlangs = [];
    while (i < t.length && extlangs.length < 3 && atual().length === 3 && alfa(atual())) { extlangs.push(atual().toLowerCase()); i++; }
    if (extlangs.length) L = extlangs[0];
    if (i < t.length && atual().length === 4 && alfa(atual())) { S = atual()[0].toUpperCase() + atual().slice(1).toLowerCase(); i++; }
    if (i < t.length && ((atual().length === 2 && alfa(atual())) || (atual().length === 3 && /^[0-9]{3}$/.test(atual())))) { C = atual().toUpperCase(); i++; }
    while (i < t.length && alnum(atual()) && ((atual().length >= 5 && atual().length <= 8) || (atual().length === 4 && /^[0-9]/.test(atual())))) { V.push(atual()); i++; }
  }
  if (L === 'und') L = '';
  return { L: ANTIGOS[L] ?? L, S, C, V: V.join('_') };
}

/** Locale.toLanguageTag (enough for the alias / parent tables). */
function paraTag(l) {
  if (!l.L && !l.S && !l.C && !l.V) return 'und';
  const variantes = l.V ? l.V.split('_') : [];
  const bcp47 = variantes.every((v) => /^[A-Za-z0-9]{5,8}$/.test(v) || /^[0-9][A-Za-z0-9]{3}$/.test(v));
  const v = bcp47 ? variantes : ['x', 'lvariant', ...variantes];
  return [l.L || 'und', l.S, l.C, ...v].filter(Boolean).join('-');
}

// ─── Tomcat AcceptLanguage / HttpParser ─────────────────────────────────────────

const SEPARADORES = new Set('()<>@,;:\\"/[]?={} \t');
const ehToken = (c) => c > 0x20 && c < 0x7f && !SEPARADORES.has(String.fromCharCode(c));
const ehLws = (c) => c === 32 || c === 9 || c === 10 || c === 13;

/** org.apache.tomcat.util.http.parser.AcceptLanguage.parse → [{ tag, q }] (entries with q > 0). */
export function lerAcceptLanguage(valor) {
  const s = String(valor);
  let pos = 0;
  const ler = () => (pos < s.length ? s.charCodeAt(pos++) : -1);
  const espiar = () => (pos < s.length ? s.charCodeAt(pos) : -1);
  const pularLws = () => { while (ehLws(espiar())) pos++; return espiar(); };
  const pularAte = (c, alvo) => { while (c !== -1 && c !== alvo) c = ler(); return c; };
  const lerToken = () => {
    pularLws();
    let r = '';
    while (espiar() !== -1 && ehToken(espiar())) r += s[pos++];
    return espiar() !== -1 && r === '' ? null : r;
  };
  const lerPeso = () => {
    pularLws();
    let c = ler();
    if (c === -1 || c === 0x2c) return 1;
    if (c !== 0x71) { pularAte(c, 0x2c); return 0; }
    pularLws();
    c = ler();
    if (c !== 0x3d) { pularAte(c, 0x2c); return 0; }
    pularLws();
    c = ler();
    let texto = '';
    let casas = -1;
    if (c === 0x30 || c === 0x31) {
      texto += String.fromCharCode(c);
      c = ler();
      for (;;) {
        if (casas === -1 && c === 0x2e) { texto += '.'; casas = 0; }
        else if (casas > -1 && c >= 0x30 && c <= 0x39) { if (casas < 3) { texto += String.fromCharCode(c); casas++; } }
        else break;
        c = ler();
      }
    } else { pularAte(c, 0x2c); return 0; }
    if (c === 9 || c === 32) { pularLws(); c = ler(); }
    if (c !== 0x2c && c !== -1) { pularAte(c, 0x2c); return 0; }
    const q = Number(texto);
    return q > 1 ? 0 : q;
  };
  const r = [];
  for (;;) {
    const tag = lerToken();
    if (tag === null) { pularAte(0, 0x2c); continue; }
    if (tag === '') break;
    let q = 1;
    pularLws();
    if (espiar() === 0x3b) { pos++; q = lerPeso(); }
    if (q > 0) r.push({ tag, q });
  }
  return r;
}

const alfaAscii = (s) => /^[A-Za-z]+$/.test(s);
const ehVariante = (s) => /^[A-Za-z0-9]{5,8}$/.test(s) || /^[0-9][A-Za-z0-9]{3}$/.test(s);

/** AcceptLanguage2.toLegacyLocale(tag): new Locale(language, country, variant) from the tag's subtags. */
export function localeLegado(tag) {
  const partes = tag.split('-');
  const idioma = partes[0];
  if (idioma.length < 2 || idioma.length > 8 || !alfaAscii(idioma)) return RAIZ;
  let C = '';
  const variantes = [];
  let comprimento = 0;
  const variante = (v) => { if (comprimento + v.length + 1 <= 64) { comprimento += (comprimento ? 1 : 0) + v.length; variantes.push(v); } };
  let script = false, regiao = false;
  for (let i = 1; i < partes.length; i++) {
    const p = partes[i];
    if (p.length === 0) break;
    if (p.length === 2 && !regiao && alfaAscii(p)) { C = p.toUpperCase(); regiao = true; }
    else if (p.length === 3 && !regiao && /^[0-9]{3}$/.test(p)) { C = p; regiao = true; }
    else if (p.length === 4 && !script && !regiao && alfaAscii(p)) { variante(p.toUpperCase()); script = true; }
    else if (ehVariante(p)) variante(p);
    else break;
  }
  const L = idioma.toLowerCase();
  return { L: ANTIGOS[L] ?? L, S: '', C, V: variantes.join('_') };
}

/** Request.getLocale(): first locale of the highest quality, else the JVM default. */
export function localeDaRequisicao(cabecalhos) {
  const valor = cabecalhos?.['accept-language'];
  if (valor == null) return LOCALE_PADRAO;
  const itens = lerAcceptLanguage(Array.isArray(valor) ? valor.join(',') : valor);
  if (!itens.length) return LOCALE_PADRAO;
  let melhor = itens[0];
  for (const x of itens) if (x.q > melhor.q) melhor = x;
  return localeLegado(melhor.tag);
}

// ─── CLDR candidate locales ─────────────────────────────────────────────────────

/** ResourceBundle.Control default candidate list (with the Chinese script/region special cases). */
function listaPadrao({ L, S, C, V }) {
  if (L === 'zh' && !S && C) S = { TW: 'Hant', HK: 'Hant', MO: 'Hant', CN: 'Hans', SG: 'Hans' }[C] ?? '';
  const variantes = [];
  if (V) {
    let v = V;
    for (;;) { variantes.push(v); const i = v.lastIndexOf('_'); if (i < 0) break; v = v.slice(0, i); }
  }
  const lista = [];
  for (const v of variantes) lista.push({ L, S, C, V: v });
  if (C) lista.push({ L, S, C, V: '' });
  if (S) {
    lista.push({ L, S, C: '', V: '' });
    if (L === 'zh' && !C) C = { Hans: 'CN', Hant: 'TW' }[S] ?? '';
    for (const v of variantes) lista.push({ L, S: '', C, V: v });
    if (C) lista.push({ L, S: '', C, V: '' });
  }
  if (L) lista.push({ L, S: '', C: '', V: '' });
  lista.push(RAIZ);
  return lista;
}

/** CLDRLocaleProviderAdapter.getParentLocale: irregular parent, or root for a non-likely script. */
function pai(l) {
  const tag = paraTag(l);
  if (Object.hasOwn(DADOS.pais, tag)) return DADOS.pais[tag] ? forLanguageTag(DADOS.pais[tag]) : RAIZ;
  if (l.S && !l.C && !l.V && DADOS.scriptProvavel[l.L] !== l.S) return RAIZ;
  return null;
}

function aplicarPais(lista) {
  for (let i = 0; i < lista.length; i++) {
    const l = lista[i];
    if (igual(l, RAIZ)) continue;
    const p = pai(l);
    if (p && !igual(lista[i + 1], p)) {
      const aplicado = lista.slice(0, i + 1);
      if (aplicado.some((x) => igual(x, p))) continue;
      return aplicado.concat(aplicarPais(listaPadrao(p)));
    }
  }
  return lista;
}

/** CLDRLocaleProviderAdapter.getCandidateLocales (applyAliases + default list + parents). */
export function candidatos(locale) {
  const tag = paraTag(locale);
  const l = Object.hasOwn(DADOS.alias, tag) ? forLanguageTag(DADOS.alias[tag]) : locale;
  return aplicarPais(listaPadrao(l));
}

/** DateTimeFormatterBuilder.getLocalizedDateTimePattern(SHORT, null, IsoChronology, locale). */
export function padraoDataCurta(locale) {
  for (const c of candidatos(locale)) {
    const i = DADOS.locales[chave(c)];
    if (i !== undefined) return DADOS.padroes[i];
  }
  return DADOS.padroes[DADOS.locales[chave(RAIZ)]] ?? 'y-MM-dd';
}
