// java.time.LocalDate as the dados-abertos area needs it:
// - DataLocal: proleptic ISO date (year -999 999 999 … 999 999 999), toString() = LocalDate.toString();
// - the text sqlite-jdbc binds for it (Hibernate setDate(java.sql.Date) → FastDateFormat "yyyy-MM-dd",
//   year of ERA; a 5+ digit year makes the driver throw ArrayIndexOutOfBoundsException, as the oracle shows);
// - the parsers Spring uses for request parameters: DateTimeFormatter.ofLocalizedDate(SHORT) (pattern of the
//   request locale, ResolverStyle.SMART, strict parsing), ISO_LOCAL_DATE and ISO_DATE (ResolverStyle.STRICT).
import { ErroJava } from '../comum/problema.js';

const ANO_MIN = -999_999_999;
const ANO_MAX = 999_999_999;
const bissexto = (a) => (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
const diasNoMes = (a, m) => [31, bissexto(a) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

export class DataLocal {
  constructor(ano, mes, dia) { this.ano = ano; this.mes = mes; this.dia = dia; }

  /** LocalDate.of(y, m, d) validation (STRICT): null when the date does not exist. */
  static de(ano, mes, dia) {
    if (!(ano >= ANO_MIN && ano <= ANO_MAX) || !(mes >= 1 && mes <= 12) || !(dia >= 1 && dia <= diasNoMes(ano, mes))) return null;
    return new DataLocal(ano, mes, dia);
  }

  /**
   * LocalDate.now() in the JVM default zone: the official package runs with -Duser.timezone=America/Sao_Paulo
   * (TZ, when set, takes its place here).
   */
  static hoje(agora = new Date(), fuso = process.env.TZ || 'America/Sao_Paulo') {
    let partes;
    try {
      partes = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora);
    } catch {
      return new DataLocal(agora.getFullYear(), agora.getMonth() + 1, agora.getDate()); // unknown zone: process zone
    }
    const campo = (t) => Number(partes.find((p) => p.type === t).value);
    return new DataLocal(campo('year'), campo('month'), campo('day'));
  }

  /** LocalDate.toString(): 4+ digit year, '+' above 9999, sign below 0. */
  toString() {
    const a = Math.abs(this.ano);
    let ano;
    if (a < 1000) ano = (this.ano < 0 ? '-' : '') + String(a).padStart(4, '0');
    else ano = (this.ano > 9999 ? '+' : '') + String(this.ano);
    return `${ano}-${String(this.mes).padStart(2, '0')}-${String(this.dia).padStart(2, '0')}`;
  }

  compareTo(o) {
    return this.ano - o.ano || this.mes - o.mes || this.dia - o.dia;
  }

  /** LocalDate.isBefore. */
  antesDe(o) { return this.compareTo(o) < 0; }
}

/**
 * Text the SQLite driver binds for a LocalDate parameter (java.sql.Date formatted "yyyy-MM-dd", year of era:
 * year 0 → "0001", -2026 → "2027"). A year of era with 5+ digits fails inside the driver.
 */
export function dataSql(d) {
  const anoEra = d.ano > 0 ? d.ano : 1 - d.ano;
  if (anoEra >= 10000) throw new ErroJava('ArrayIndexOutOfBoundsException', 'Index -1 out of bounds for length 4');
  return `${String(anoEra).padStart(4, '0')}-${String(d.mes).padStart(2, '0')}-${String(d.dia).padStart(2, '0')}`;
}

// ─── parsing helpers (DateTimeFormatterBuilder printer-parsers, strict mode, DecimalStyle.STANDARD) ─────

const ehDigito = (c) => c >= 0x30 && c <= 0x39;

/**
 * NumberPrinterParser.parse in strict mode. sinal: 'NORMAL' ('-' accepted, '+' rejected), 'NOT_NEGATIVE'
 * (no sign), 'EXCEEDS_PAD' ('+' required above minLargura digits). Returns { pos, valor (BigInt) } or null.
 */
function lerNumero(texto, pos, minLargura, maxLargura, sinal) {
  if (pos >= texto.length) return null;
  const c0 = texto.charCodeAt(pos);
  let negativo = false, positivo = false;
  if (c0 === 0x2b) {
    if (sinal !== 'EXCEEDS_PAD') return null;
    positivo = true;
    pos++;
  } else if (c0 === 0x2d) {
    if (sinal === 'NOT_NEGATIVE') return null;
    negativo = true;
    pos++;
  }
  const inicio = pos;
  let fim = pos;
  while (fim < texto.length && fim - inicio < maxLargura && ehDigito(texto.charCodeAt(fim))) fim++;
  if (fim - inicio < minLargura) return null;
  let valor = fim > inicio ? BigInt(texto.slice(inicio, fim)) : 0n;
  if (valor > 0x7fffffffffffffffn) { valor /= 10n; fim--; }
  if (negativo) {
    if (valor === 0n) return null; // minus zero not allowed in strict mode
    valor = -valor;
  } else if (sinal === 'EXCEEDS_PAD') {
    const lidos = fim - inicio;
    if (positivo ? lidos <= minLargura : lidos > minLargura) return null;
  }
  return { pos: fim, valor };
}

// ─── ISO_LOCAL_DATE / ISO_DATE ─────────────────────────────────────────────────

/** ISO_LOCAL_DATE prefix: { pos, data } (STRICT resolution) or null. */
function lerIsoPrefixo(texto) {
  const ano = lerNumero(texto, 0, 4, 10, 'EXCEEDS_PAD');
  if (!ano || texto[ano.pos] !== '-') return null;
  const mes = lerNumero(texto, ano.pos + 1, 2, 2, 'NOT_NEGATIVE');
  if (!mes || texto[mes.pos] !== '-') return null;
  const dia = lerNumero(texto, mes.pos + 1, 2, 2, 'NOT_NEGATIVE');
  if (!dia) return null;
  if (ano.valor < BigInt(ANO_MIN) || ano.valor > BigInt(ANO_MAX)) return null;
  const data = DataLocal.de(Number(ano.valor), Number(mes.valor), Number(dia.valor));
  return data ? { pos: dia.pos, data } : null;
}

/** LocalDate.parse(texto) (DateTimeFormatter.ISO_LOCAL_DATE). null when it fails. */
export function lerIsoLocalDate(texto) {
  const r = lerIsoPrefixo(texto);
  return r && r.pos === texto.length ? r.data : null;
}

/**
 * OffsetIdPrinterParser("+HH:MM:ss", "Z") in strict mode, case-insensitive 'Z': end position or -1. The
 * offset value is not range-checked for a LocalDate query (the oracle accepts "+23:59").
 */
function lerOffset(texto, pos) {
  if (pos >= texto.length) return -1;
  if (texto[pos] === 'Z' || texto[pos] === 'z') return pos + 1;
  const sinal = texto[pos];
  if (sinal !== '+' && sinal !== '-') return -1;
  const doisDigitos = (p, max) => {
    if (p + 2 > texto.length) return false;
    const a = texto.charCodeAt(p), b = texto.charCodeAt(p + 1);
    if (!ehDigito(a) || !ehDigito(b)) return false;
    return (a - 48) * 10 + (b - 48) <= max;
  };
  let p = pos + 1;
  if (!doisDigitos(p, 59)) return -1;
  const hora = Number(texto.slice(p, p + 2));
  p += 2;
  if (texto[p] !== ':' || !doisDigitos(p + 1, 59)) return -1;
  p += 3;
  if (texto[p] === ':' && doisDigitos(p + 1, 59)) p += 3;
  // "Value out of range: Hour[0-23]..." is a DateTimeException → the parse fails as well
  if (hora > 23) return -1;
  return p;
}

/** DateTimeFormatter.ISO_DATE (ISO_LOCAL_DATE + optional offset id). null when it fails. */
export function lerIsoDate(texto) {
  const r = lerIsoPrefixo(texto);
  if (!r) return null;
  if (r.pos === texto.length) return r.data;
  const fim = lerOffset(texto, r.pos);
  return fim === texto.length ? r.data : null;
}

// ─── localized SHORT pattern (CLDR patterns use only d, dd, M, MM, y, yy and literals) ───────────

const cachePadroes = new Map();

/** DateTimeFormatterBuilder.appendPattern for the letters CLDR SHORT date patterns use. */
function compilarPadrao(padrao) {
  if (cachePadroes.has(padrao)) return cachePadroes.get(padrao);
  const itens = [];
  for (let i = 0; i < padrao.length;) {
    const c = padrao[i];
    if (c === "'") {
      let j = i + 1;
      let lit = '';
      while (j < padrao.length) {
        if (padrao[j] === "'") {
          if (padrao[j + 1] === "'") { lit += "'"; j += 2; continue; }
          break;
        }
        lit += padrao[j++];
      }
      itens.push({ literal: lit === '' ? "'" : lit });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let n = 1;
      while (padrao[i + n] === c) n++;
      if (c === 'd' || c === 'M') itens.push(n === 1 ? { campo: c, min: 1, max: 19, sinal: 'NORMAL' } : { campo: c, min: 2, max: 2, sinal: 'NOT_NEGATIVE' });
      else if (c === 'y') itens.push(n === 2 ? { campo: 'y', reduzido: true, min: 2, max: 2, sinal: 'NOT_NEGATIVE' } : { campo: 'y', min: n, max: 19, sinal: n < 4 ? 'NORMAL' : 'EXCEEDS_PAD' });
      else throw new Error(`letra de padrão não suportada: ${c}`);
      i += n;
      continue;
    }
    itens.push({ literal: c });
    i++;
  }
  cachePadroes.set(padrao, itens);
  return itens;
}

/**
 * LocalDate.parse(texto, ofLocalizedDate(SHORT).withLocale(locale)) for the locale's pattern: strict
 * parsing, ResolverStyle.SMART (year of era 1…999 999 999 with the era invented as CE, day clamped to the
 * month length for 30-day months and February, 2-digit years 2000…2099). null when it fails.
 */
export function lerDataLocalizada(texto, padrao) {
  let pos = 0;
  const v = {};
  for (const it of compilarPadrao(padrao)) {
    if (it.literal !== undefined) {
      if (!texto.startsWith(it.literal, pos)) return null;
      pos += it.literal.length;
      continue;
    }
    const n = lerNumero(texto, pos, it.min, it.max, it.sinal);
    if (!n) return null;
    let valor = n.valor;
    if (it.reduzido && n.pos - pos === it.min && valor >= 0n) {
      valor += 2000n;
      if (valor < 2000n) valor += 100n;
    }
    v[it.campo] = valor;
    pos = n.pos;
  }
  if (pos !== texto.length) return null;
  // resolveYearOfEra (SMART): YEAR_OF_ERA in 1..Year.MAX_VALUE+1, then YEAR = year of era
  if (v.y < 1n || v.y > BigInt(ANO_MAX) + 1n) return null;
  const ano = v.y;
  // resolveYMD (SMART): YEAR, MONTH_OF_YEAR, DAY_OF_MONTH range checks, then "previous valid" day
  if (ano > BigInt(ANO_MAX) || v.M < 1n || v.M > 12n || v.d < 1n || v.d > 31n) return null;
  const a = Number(ano), m = Number(v.M);
  let d = Number(v.d);
  if (m === 4 || m === 6 || m === 9 || m === 11) d = Math.min(d, 30);
  else if (m === 2) d = Math.min(d, diasNoMes(a, 2));
  return DataLocal.de(a, m, d);
}
