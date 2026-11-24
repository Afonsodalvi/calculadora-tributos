// @RequestParam conversions of the NFS-e GET endpoints, as Spring MVC 7 + Spring Boot 4 do them:
// - LocalDate without @DateTimeFormat: TemporalAccessorParser with
//   DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT) (ResolverStyle.SMART, ISO chronology) in
//   the request locale, and when that fails the ISO fallback LocalDate.parse(text) (STRICT);
// - Integer: StringToNumberConverterFactory (blank → null) + NumberUtils.parseNumber
//   (trimAllWhitespace, Integer.decode for "0x"/"0X"/"#" with an optional '-', else Integer.valueOf).
// Failures are MethodArgumentTypeMismatchException (400 "Parâmetro inválido [nome: valor] "); with
// 2+ values Spring converts the first one and reports the String[] itself.
// The SHORT patterns (padroes-data-curta.json) are DateTimeFormatterBuilder
// .getLocalizedDateTimePattern(SHORT, null, IsoChronology.INSTANCE, locale) of every available
// locale of the JDK 25 that runs the official package (CLDR data).
import PADROES from './padroes-data-curta.json' with { type: 'json' };
import { javaIsBlank, javaIsWhitespace } from '../comum/java.js';
import { parseInteiroJava } from '../comum/json.js';
import { ErroTipoArgumento, erroParametroAusente } from '../comum/problema.js';

const ARRAY_JAVA = () => `[Ljava.lang.String;@${Math.floor(Math.random() * 0x7fffffff).toString(16)}`;

// ─── LocalDate ──────────────────────────────────────────────────────────────

/** SHORT date pattern of a locale (exact language_COUNTRY, then language, then root). */
export function padraoDataCurta(locale) {
  const { idioma, pais } = locale;
  if (idioma && pais && PADROES[`${idioma}_${pais}`] !== undefined) return PADROES[`${idioma}_${pais}`];
  if (idioma && PADROES[idioma] !== undefined) return PADROES[idioma];
  return PADROES[''];
}

/** DateTimeFormatterBuilder.appendPattern for the letters used by these patterns (d, M, y). */
function compilar(padrao) {
  const itens = [];
  for (let i = 0; i < padrao.length;) {
    const c = padrao[i];
    if (/[A-Za-z]/.test(c)) {
      let n = 1;
      while (padrao[i + n] === c) n++;
      itens.push({ letra: c, n });
      i += n;
    } else if (c === "'") {
      let j = i + 1;
      let texto = '';
      while (j < padrao.length) {
        if (padrao[j] === "'") { if (padrao[j + 1] === "'") { texto += "'"; j += 2; continue; } break; }
        texto += padrao[j++];
      }
      itens.push({ literal: texto.length ? texto : "'" });
      i = j + 1;
    } else {
      itens.push({ literal: c });
      i++;
    }
  }
  return itens;
}

/** NumberPrinterParser.parse in strict mode. Returns { valor: BigInt, pos } or null. */
function lerNumero(texto, pos, min, max, sinal) {
  let positivo = false;
  let negativo = false;
  const c = texto[pos];
  if (c === undefined) return null;
  if (c === '+') {
    if (!(sinal === 'EXCEEDS_PAD')) return null;
    positivo = true;
    pos++;
  } else if (c === '-') {
    if (!(sinal === 'NORMAL' || sinal === 'EXCEEDS_PAD')) return null;
    negativo = true;
    pos++;
  }
  const inicio = pos;
  if (inicio + min > texto.length) return null;
  const limite = Math.min(inicio + max, texto.length);
  let digitos = '';
  while (pos < limite && texto.charCodeAt(pos) >= 0x30 && texto.charCodeAt(pos) <= 0x39) digitos += texto[pos++];
  if (pos < inicio + min) return null;
  let valor = BigInt(digitos || '0');
  if (negativo) {
    if (valor === 0n) return null;
    valor = -valor;
  } else if (sinal === 'EXCEEDS_PAD') {
    const len = pos - inicio;
    if (positivo ? len <= min : len > min) return null;
  }
  return { valor, pos };
}

const anoBissexto = (a) => (a % 4n === 0n && a % 100n !== 0n) || a % 400n === 0n;
const diasNoMes = (a, m) => [31, anoBissexto(a) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** Parses `texto` with a localized pattern and resolves it (ResolverStyle.SMART). Returns {ano, mes, dia} or null. */
function lerLocalizada(texto, padrao) {
  const campos = {};
  let pos = 0;
  for (const item of compilar(padrao)) {
    if (item.literal !== undefined) {
      if (texto.slice(pos, pos + item.literal.length) !== item.literal) return null;
      pos += item.literal.length;
      continue;
    }
    const { letra, n } = item;
    let r;
    if (letra === 'y' && n === 2) {
      r = lerNumero(texto, pos, 2, 2, 'NOT_NEGATIVE');
      if (r && r.valor >= 0n) r.valor = 2000n + r.valor; // ReducedPrinterParser, base date 2000-01-01
    } else if (letra === 'y') {
      r = lerNumero(texto, pos, n, 19, n < 4 ? 'NORMAL' : 'EXCEEDS_PAD');
    } else if (letra === 'd' || letra === 'M') {
      r = n === 1 ? lerNumero(texto, pos, 1, 19, 'NORMAL') : lerNumero(texto, pos, 2, 2, 'NOT_NEGATIVE');
    } else {
      return null;
    }
    if (!r) return null;
    const chave = letra === 'y' ? 'ano' : letra === 'M' ? 'mes' : 'dia';
    if (campos[chave] !== undefined && campos[chave] !== r.valor) return null;
    campos[chave] = r.valor;
    pos = r.pos;
  }
  if (pos !== texto.length) return null;
  const { ano, mes, dia } = campos;
  if (ano === undefined || mes === undefined || dia === undefined) return null;
  // YEAR_OF_ERA without ERA → YEAR (SMART), then IsoChronology.resolveYMD
  if (ano < 1n || ano > 999999999n) return null;
  if (mes < 1n || mes > 12n || dia < 1n || dia > 31n) return null;
  const m = Number(mes);
  let d = Number(dia);
  d = Math.min(d, diasNoMes(ano, m));
  return { ano, mes: m, dia: d };
}

/** LocalDate.parse(text) = ISO_LOCAL_DATE, ResolverStyle.STRICT. */
function lerIso(texto) {
  const a = lerNumero(texto, 0, 4, 10, 'EXCEEDS_PAD');
  if (!a || texto[a.pos] !== '-') return null;
  const m = lerNumero(texto, a.pos + 1, 2, 2, 'NOT_NEGATIVE');
  if (!m || texto[m.pos] !== '-') return null;
  const d = lerNumero(texto, m.pos + 1, 2, 2, 'NOT_NEGATIVE');
  if (!d || d.pos !== texto.length) return null;
  if (a.valor < -999999999n || a.valor > 999999999n) return null;
  if (m.valor < 1n || m.valor > 12n || d.valor < 1n || d.valor > 31n) return null;
  if (Number(d.valor) > diasNoMes(a.valor, Number(m.valor))) return null;
  return { ano: a.valor, mes: Number(m.valor), dia: Number(d.valor) };
}

/** LocalDate.toString(): yyyy-MM-dd, 4-digit padded year, '+' above 9999. */
export function textoData({ ano, mes, dia }) {
  const abs = ano < 0n ? -ano : ano;
  let a;
  if (abs < 1000n) a = (ano < 0n ? '-' : '') + String(abs).padStart(4, '0');
  else a = (ano > 9999n ? '+' : '') + String(ano);
  return `${a}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** TemporalAccessorParser.parse for LocalDate: localized SHORT first, ISO fallback. Text or null. */
export function converterData(texto, locale) {
  const r = lerLocalizada(texto, padraoDataCurta(locale)) ?? lerIso(texto);
  return r ? textoData(r) : null;
}

/** @RequestParam LocalDate (required by default). Returns 'yyyy-MM-dd' (LocalDate.toString) or null when optional and absent. */
export function parametroData(parametros, nome, locale, { obrigatorio = true } = {}) {
  const valores = parametros.valores(nome);
  const v0 = valores?.[0];
  if (v0 == null || javaIsBlank(v0)) {
    if (obrigatorio) throw erroParametroAusente(nome);
    return null;
  }
  const data = converterData(v0, locale);
  if (data === null) throw new ErroTipoArgumento(nome, valores.length > 1 ? ARRAY_JAVA() : v0);
  return data;
}

// ─── Integer ────────────────────────────────────────────────────────────────

const INT_MIN = -2147483648n;
const INT_MAX = 2147483647n;

/** Integer.decode for a string already known to start with [-]0x/0X/#. BigInt or null. */
function decodificarHex(t) {
  let i = 0;
  let neg = false;
  if (t[0] === '-') { neg = true; i = 1; } else if (t[0] === '+') i = 1;
  if (t.startsWith('0x', i) || t.startsWith('0X', i)) i += 2;
  else if (t.startsWith('#', i)) i += 1;
  const resto = t.slice(i);
  if (!resto || resto[0] === '-' || resto[0] === '+') return null;
  if (!/^[0-9a-fA-F]+$/.test(resto)) return null;
  const v = BigInt(`0x${resto}`) * (neg ? -1n : 1n);
  return v < INT_MIN || v > INT_MAX ? null : v;
}

/** @RequestParam(required = false) Integer: null when absent/blank. */
export function parametroInteger(parametros, nome) {
  const valores = parametros.valores(nome);
  const v0 = valores?.[0];
  if (v0 == null || javaIsBlank(v0)) return null;
  const t = [...v0].filter((c) => !javaIsWhitespace(c)).join('');
  const hex = t.startsWith('0x', t[0] === '-' ? 1 : 0) || t.startsWith('0X', t[0] === '-' ? 1 : 0) || t.startsWith('#', t[0] === '-' ? 1 : 0);
  const v = hex ? decodificarHex(t) : parseInteiroJava(t, INT_MIN, INT_MAX);
  if (v === null) throw new ErroTipoArgumento(nome, valores.length > 1 ? ARRAY_JAVA() : v0);
  return Number(v);
}
