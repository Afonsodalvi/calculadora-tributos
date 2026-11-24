// Bean Validation (Hibernate Validator 9.1.5) of OperacaoInput / ItemOperacaoInput as the
// calculation endpoints use it:
//  - the constraints of api/model/input/* (declaration order; @Valid cascades);
//  - the interpolated messages of org/hibernate/validator/ValidationMessages*.properties
//    (mensagens-validacao.json, extracted from the HV 9.1.5 jar), with the ResourceBundle lookup of
//    the JDK (candidate locales, parent chain, fallback to the JVM default locale);
//  - the request locale as Spring MVC gets it: AcceptHeaderLocaleResolver → Tomcat 11
//    Request.getLocale(), whose Accept-Language parser is AcceptLanguage2 (legacy Locale building).
// The JVM default locale of the official package run is pt_BR (JAVA_LOCALE overrides it, e.g. "en").
// Java keeps the violations in a HashSet (identity hash), so their order is random there; here the
// order is fixed: fields in declaration order, constraints in declaration order, cascades in place.
import { Dec } from '../../core/decimal.js';
import { javaValueOf } from '../comum/java.js';
import MENSAGENS from './mensagens-validacao.json' with { type: 'json' };
import { CAMPOS_COMPONENTES } from './entrada.js';

// ─── Constraints ─────────────────────────────────────────────────────────────

const CEM = Dec.of('100.00');
const DIGITOS = /^[0-9]+$/; // java.util.regex "\d+" (ASCII) with matches()

const naoNulo = () => ({ anotacao: 'NotNull', valido: (v) => v != null });
const naoVazio = () => ({ anotacao: 'NotEmpty', valido: (v) => v != null && v.length > 0 });
const tamanho = (min, max) => ({ anotacao: 'Size', atributos: { min, max }, valido: (v) => v == null || (v.length >= min && v.length <= max) });
const somenteDigitos = () => ({ anotacao: 'Pattern', mensagem: 'Informar somente dígitos', valido: (v) => v == null || DIGITOS.test(v) });
const minimo = (n) => ({ anotacao: 'Min', atributos: { value: n }, valido: (v) => v == null || BigInt(v) >= BigInt(n) });
const maximo = (n) => ({ anotacao: 'Max', atributos: { value: n }, valido: (v) => v == null || BigInt(v) <= BigInt(n) });
const positivoOuZero = () => ({ anotacao: 'PositiveOrZero', valido: (v) => v == null || v.signum() >= 0 });
/** @Digits on BigDecimal: precision/scale of the value as received (no stripTrailingZeros). */
const digitos = (integer, fraction) => ({
  anotacao: 'Digits', atributos: { integer, fraction },
  valido: (v) => v == null || (v.precision() - v.scale() <= integer && Math.max(v.scale(), 0) <= fraction),
});
const decimalMaximo = (valor) => ({ anotacao: 'DecimalMax', atributos: { value: valor, inclusive: true }, valido: (v) => v == null || v.compareTo(Dec.of(valor)) <= 0 });
const decimalMinimo = (valor) => ({ anotacao: 'DecimalMin', atributos: { value: valor, inclusive: true }, valido: (v) => v == null || v.compareTo(Dec.of(valor)) >= 0 });

const CST = [naoNulo(), somenteDigitos(), tamanho(3, 3)];
const CCLASSTRIB = [naoNulo(), somenteDigitos(), tamanho(6, 6)];
const ALIQUOTA_NOMINAL = [positivoOuZero(), digitos(3, 4), decimalMaximo('100.00')];

/** Each class: [field, constraints, cascaded class (for @Valid) or null]. */
const CLASSES = {
  OperacaoInput: [
    ['id', [naoNulo()]],
    ['versao', [naoNulo()]],
    ['municipio', [naoNulo(), minimo(0), maximo(9999999)]],
    ['uf', [tamanho(2, 2)]],
    ['tpDoc', [minimo(1), maximo(999)]],
    ['gCompraGov', [], 'CompraGovernamentalInput'],
    ['itens', [naoVazio()], 'ItemOperacaoInput[]'],
  ],
  CompraGovernamentalInput: [
    ['tpEnteGov', [naoNulo()]],
  ],
  ItemOperacaoInput: [
    ['numero', [naoNulo(), minimo(1), maximo(9999999)]],
    ['cst', CST],
    ['cClassTrib', CCLASSTRIB],
    ['baseCalculo', [positivoOuZero(), digitos(13, 2)]],
    ['quantidade', [digitos(11, 4)]],
    ['impostoSeletivo', [], 'ImpostoSeletivoInput'],
    ['tributacaoRegular', [], 'TributacaoRegularInput'],
    ['gComponentesBC', [], 'ComponentesBaseCalculoInput'],
    ['aliquotasNominais', [], 'AliquotasNominaisInput'],
  ],
  ImpostoSeletivoInput: [
    ['cst', CST],
    ['cClassTrib', CCLASSTRIB],
    ['baseCalculo', [naoNulo(), positivoOuZero(), digitos(13, 2)]],
    ['quantidade', [positivoOuZero(), digitos(11, 4)]],
    ['impostoInformado', [positivoOuZero(), digitos(13, 2)]],
  ],
  TributacaoRegularInput: [
    ['cst', CST],
    ['cClassTrib', CCLASSTRIB],
  ],
  ComponentesBaseCalculoInput: CAMPOS_COMPONENTES.map((c) => [c, [positivoOuZero()]]),
  AliquotasNominaisInput: [
    ['cbs', ALIQUOTA_NOMINAL],
    ['ibsEstadual', ALIQUOTA_NOMINAL],
    ['ibsMunicipal', ALIQUOTA_NOMINAL],
    ['impostoSeletivo', [], 'AliquotasNominaisImpostoSeletivo'],
  ],
  AliquotasNominaisImpostoSeletivo: [
    ['adValorem', [positivoOuZero(), digitos(3, 4), decimalMaximo('100.00')]],
    ['adRem', [decimalMinimo('0.00')]],
  ],
};

/**
 * Validator.validate(bean) for the classes above. Returns the violations
 * [{ caminho (PropertyPath.toString()), anotacao (simple name), restricao, valorInvalido }].
 * Cascaded lists skip null elements (as HV does); a null cascaded bean is not validated.
 */
export function validar(bean, classe = 'OperacaoInput', prefixo = '') {
  const violacoes = [];
  const visitar = (obj, nomeClasse, pre) => {
    for (const [campo, restricoes, cascata] of CLASSES[nomeClasse]) {
      const v = obj[campo];
      const caminho = `${pre}${campo}`;
      for (const r of restricoes) if (!r.valido(v)) violacoes.push({ caminho, anotacao: r.anotacao, restricao: r, valorInvalido: v ?? null });
      if (!cascata || v == null) continue;
      if (cascata.endsWith('[]')) {
        const elemento = cascata.slice(0, -2);
        v.forEach((x, i) => { if (x != null) visitar(x, elemento, `${caminho}[${i}].`); });
      } else visitar(v, cascata, `${caminho}.`);
    }
  };
  visitar(bean, classe, prefixo);
  return violacoes;
}

/** String.valueOf(invalidValue) as the services print it ("recebido: '%s'"). */
export const textoValorInvalido = (v) => (Array.isArray(v) ? `[${v.map(javaValueOf).join(', ')}]` : javaValueOf(v));

// ─── Locale (Tomcat AcceptLanguage2 + JDK ResourceBundle) ──────────────────────

/** Legacy java.util.Locale: language (lower), country (upper), variant ('_'-joined). */
const ROOT = Object.freeze({ language: '', country: '', variant: '' });

function localePadrao() {
  const t = String(process.env.JAVA_LOCALE ?? 'pt_BR').replace('-', '_');
  const [language = '', country = '', ...resto] = t.split('_');
  return { language: language.toLowerCase(), country: country.toUpperCase(), variant: resto.join('_') };
}
/** Locale.getDefault() of the reference JVM (-Duser.language=pt -Duser.country=BR). */
export const LOCALE_PADRAO = localePadrao();

const asciiAlpha = (s) => /^[A-Za-z]*$/.test(s);
const asciiDigits = (s) => /^[0-9]*$/.test(s);
const asciiAlnum = (s) => /^[A-Za-z0-9]*$/.test(s);
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upperAscii = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** AcceptLanguage2.toLegacyLocale(tag): language-region-variants only (no script, no extensions, no grandfathered map). */
export function localeLegado(tag) {
  const n = tag.length;
  if (n === 0) return ROOT;
  let fim = tag.indexOf('-');
  if (fim < 0) fim = n;
  if (fim < 2 || fim > 8 || !asciiAlpha(tag.slice(0, fim))) return ROOT;
  const language = lowerAscii(tag.slice(0, fim));
  let country = '';
  let variante = '';
  let temScript = false, temPais = false;
  const anexar = (v) => { if (variante.length + v.length + 1 <= 64) variante += (variante.length > 0 ? '_' : '') + v; };
  for (let ini = fim; ini < n;) {
    ini++;
    fim = tag.indexOf('-', ini);
    if (fim < 0) fim = n;
    const sub = tag.slice(ini, fim);
    const len = sub.length;
    if (len === 0) break;
    if (len === 2 && !temPais && asciiAlpha(sub)) { country = upperAscii(sub); temPais = true; }
    else if (len === 3 && !temPais && asciiDigits(sub)) { country = sub; temPais = true; }
    else if (len === 4 && !temScript && !temPais && asciiAlpha(sub)) { anexar(upperAscii(sub)); temScript = true; }
    else if ((len >= 5 && len <= 8 && asciiAlnum(sub)) || (len === 4 && sub[0] >= '0' && sub[0] <= '9' && asciiAlnum(sub.slice(1)))) anexar(sub);
    else break; // singleton or anything else ends the scan
    ini = fim;
  }
  return { language, country, variant: variante };
}

// Tomcat HttpParser over a string reader (latin-1 chars of the header).
const SEPARADORES = new Set('()<>@,;:\\"/[]?={} \t');
const ehToken = (c) => c > 32 && c < 127 && !SEPARADORES.has(String.fromCharCode(c));

class LeitorTexto {
  constructor(s) { this.s = s; this.p = 0; this.marca = 0; }
  ler() { return this.p < this.s.length ? this.s.charCodeAt(this.p++) : -1; }
  marcar() { this.marca = this.p; }
  voltar() { this.p = this.marca; }
}
function pularEspacos(r) {
  r.marcar();
  let c = r.ler();
  while (c === 32 || c === 9) { r.marcar(); c = r.ler(); }
  r.voltar();
  return c;
}
function lerToken(r) {
  let out = '';
  pularEspacos(r);
  r.marcar();
  let c = r.ler();
  while (c !== -1 && ehToken(c)) { out += String.fromCharCode(c); r.marcar(); c = r.ler(); }
  r.voltar();
  return c !== -1 && out.length === 0 ? null : out;
}
function pularAte(r, c, alvo) {
  while (c !== -1 && c !== alvo) c = r.ler();
  return c === -1 ? 'EOF' : 'FOUND';
}
function pularConstante(r, constante) {
  pularEspacos(r);
  r.marcar();
  let c = r.ler();
  for (let i = 0; i < constante.length; i++) {
    if (i === 0 && c === -1) return 'EOF';
    if (c !== constante.charCodeAt(i)) { r.voltar(); return 'NOT_FOUND'; }
    if (i !== constante.length - 1) c = r.ler();
  }
  return 'FOUND';
}
/** HttpParser.readWeight(input, ','). */
function lerPeso(r, delim) {
  pularEspacos(r);
  let c = r.ler();
  if (c === -1 || c === delim) return 1;
  if (c !== 0x71) { pularAte(r, c, delim); return 0; }
  pularEspacos(r);
  c = r.ler();
  if (c !== 0x3d) { pularAte(r, c, delim); return 0; }
  pularEspacos(r);
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
  } else { pularAte(r, c, delim); return 0; }
  if (c === 9 || c === 32) { pularEspacos(r); c = r.ler(); }
  if (c !== delim && c !== -1) { pularAte(r, c, delim); return 0; }
  const q = Number(valor);
  return q > 1 ? 0 : q;
}

/** AcceptLanguage2.parse: [{ locale, qualidade }] (entries with quality 0 dropped). */
export function lerAcceptLanguage(valor) {
  const r = new LeitorTexto(valor);
  const res = [];
  while (true) {
    const tag = lerToken(r);
    if (tag === null) { pularAte(r, 0, 0x2c); continue; }
    if (tag === '') break;
    let q = 1;
    if (pularConstante(r, ';') === 'FOUND') q = lerPeso(r, 0x2c);
    if (q > 0) res.push({ locale: localeLegado(tag), qualidade: q });
  }
  return res;
}

/**
 * Locale of the request thread: Request.getLocale() (highest quality first, header order within the
 * same quality) or the JVM default when Accept-Language is absent / yields nothing.
 */
export function localeDaRequisicao(acceptLanguage) {
  if (acceptLanguage == null) return LOCALE_PADRAO;
  const valores = Array.isArray(acceptLanguage) ? acceptLanguage : [acceptLanguage];
  const porQualidade = new Map();
  for (const v of valores) {
    for (const { locale, qualidade } of lerAcceptLanguage(String(v))) {
      if (!porQualidade.has(qualidade)) porQualidade.set(qualidade, []);
      porQualidade.get(qualidade).push(locale);
    }
  }
  if (!porQualidade.size) return LOCALE_PADRAO;
  const melhor = Math.max(...porQualidade.keys());
  return porQualidade.get(melhor)[0];
}

const DISPONIVEIS = new Set(Object.keys(MENSAGENS));
/** ResourceBundle.Control.toBundleName suffix ('' = base bundle). */
function nomeDoPacote({ language, country, variant }, script = '') {
  if (!language && !country && !variant) return '';
  if (script) {
    if (variant) return `${language}_${script}_${country}_${variant}`;
    if (country) return `${language}_${script}_${country}`;
    return `${language}_${script}`;
  }
  if (variant) return `${language}_${country}_${variant}`;
  if (country) return `${language}_${country}`;
  return language;
}

/** ResourceBundle.Control.getCandidateLocales (legacy locales: no script except the Chinese one). */
function candidatos(l) {
  const { language, country } = l;
  let script = '';
  if (language === 'zh' && country) {
    if (['TW', 'HK', 'MO'].includes(country)) script = 'Hant';
    else if (['CN', 'SG'].includes(country)) script = 'Hans';
  }
  const variantes = [];
  if (l.variant) {
    let idx = l.variant.length;
    while (idx !== -1) { variantes.push(l.variant.slice(0, idx)); idx = l.variant.lastIndexOf('_', idx - 1); }
  }
  const lista = [];
  const add = (lang, scr, reg, v) => lista.push(nomeDoPacote({ language: lang, country: reg, variant: v }, scr));
  for (const v of variantes) add(language, script, country, v);
  if (country) add(language, script, country, '');
  if (script) {
    add(language, script, '', '');
    for (const v of variantes) add(language, '', country, v);
    if (country) add(language, '', country, '');
  }
  if (language) add(language, '', '', '');
  lista.push('');
  return lista;
}

const mesmoLocale = (a, b) => a.language === b.language && a.country === b.country && a.variant === b.variant;

/** ResourceBundle.getBundle("org.hibernate.validator.ValidationMessages", locale): the parent chain of bundle names. */
export function cadeiaDePacotes(locale) {
  let base = null;
  for (let alvo = locale; alvo != null; alvo = mesmoLocale(alvo, LOCALE_PADRAO) ? null : LOCALE_PADRAO) {
    const cands = candidatos(alvo);
    const i = cands.findIndex((c) => DISPONIVEIS.has(c));
    const cadeia = cands.slice(i).filter((c) => DISPONIVEIS.has(c));
    const ehBase = cadeia[0] === '';
    if (!ehBase || mesmoLocale(locale, ROOT) || cands.length === 1) return cadeia;
    base ??= cadeia;
  }
  return base ?? [''];
}

// ─── Message interpolation ───────────────────────────────────────────────────

/** The az bundle's EL suffix rule for Min/Max (`${value != 0 && ... ? 'dən' : 'dan'}`), verbatim condition. */
function condicaoAz(value) {
  const v = BigInt(value);
  const m100 = v % 100n, m10 = v % 10n;
  return v !== 0n && v % 1000000n !== 0n && v % 1000000000n !== 0n
    && (m100 === 0n || m100 === 20n || m100 === 50n || m100 === 70n || m100 === 80n
      || [1n, 2n, 3n, 4n, 5n, 7n, 8n].includes(m10));
}

/**
 * ResourceBundleMessageInterpolator: bundle message of the annotation (or the custom `message`),
 * then {attribute} parameters, then the EL expressions used by the bundles.
 */
export function interpolar(restricao, locale) {
  let t = restricao.mensagem;
  if (t === undefined) {
    for (const p of cadeiaDePacotes(locale)) {
      const m = MENSAGENS[p]?.[restricao.anotacao];
      if (m !== undefined) { t = m; break; }
    }
  }
  const atr = restricao.atributos ?? {};
  // EL: ${inclusive == true ? 'a' : 'b'} and the az ordinal suffix rule
  t = t.replace(/\$\{inclusive == true \? '([^']*)' : '([^']*)'\}/g, (_, sim, nao) => (atr.inclusive === true ? sim : nao));
  t = t.replace(/\$\{value != 0 &&[^}]*\? '([^']*)' : '([^']*)'\}/g, (_, sim, nao) => (condicaoAz(atr.value) ? sim : nao));
  return t.replace(/\{(min|max|value|integer|fraction)\}/g, (x, nome) => (nome in atr ? String(atr[nome]) : x));
}
