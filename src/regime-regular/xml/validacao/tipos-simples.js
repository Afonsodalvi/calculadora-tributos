// XML Schema simple types as the JDK Xerces validates them (impl.dv.xs.XSSimpleTypeDecl and the
// datatype validators): whitespace normalization, patterns (base type's first: they are appended
// after the type's own and checked from the last to the first), special NCName/Name/NMTOKEN
// checks, the primitive lexical space (cvc-datatype-valid.1.2.1 with the DV's name), facets in the
// order maxLength, minLength, length, enumeration, maxInclusive, maxExclusive, minInclusive,
// minExclusive, and the ID extra rule (cvc-id.2).
import { regexXsd } from './regex.js';
import { ehNCName } from './leitor-xml.js';

export const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

/** Error of a datatype check: Xerces InvalidDatatypeValueException(key, args). */
export class ErroTipo extends Error {
  constructor(chave, args) { super(chave); this.chave = chave; this.args = args; }
}

const ehDigito = (c) => c >= '0' && c <= '9';

// ─── Whitespace ────────────────────────────────────────────────────────────────────────────────
/** XMLChar.trim: leading and trailing XML whitespace. */
const aparar = (s) => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');

/** XSSimpleTypeDecl.normalize(String, short ws). */
export function normalizarEspacos(texto, espacos) {
  if (espacos === 'preserve' || texto == null) return texto;
  if (espacos === 'replace') return texto.replace(/[\t\n\r]/g, ' ');
  return texto.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '');
}

// ─── Datatype validators (primitive lexical spaces) ──────────────────────────────────────────────
/** Length of the DVs whose actual value is the normalized text itself (string, anyURI, ID). */
const tamanhoTexto = (v) => v.length;
const DV_STRING = { nome: 'string', normalizacao: 'completa', valor: (s) => s, tamanho: tamanhoTexto };

const DV_DECIMAL = {
  normalizacao: 'aparar',
  nome: 'decimal',
  valor(s) {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'decimal']);
    return { tipo: 'decimal', sinal: m[1] === '-' ? -1 : 1, inteiro: m[2].replace(/^0+/, ''), fracao: (m[3] ?? '').replace(/0+$/, '') };
  },
};

const DV_INTEGER = {
  normalizacao: 'aparar',
  nome: 'integer',
  valor(s) {
    const m = /^([+-]?)(\d+)$/.exec(s);
    if (!m) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'integer']);
    return { tipo: 'decimal', sinal: m[1] === '-' ? -1 : 1, inteiro: m[2].replace(/^0+/, ''), fracao: '' };
  },
};

/** Base64.removeWhiteSpace + decode: null when invalid. */
function decodificarBase64(s) {
  const dados = s.replace(/[ \r\n\t]/g, '');
  if (dados.length % 4 !== 0) return null;
  if (dados.length === 0) return 0;
  const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const valor = (c) => ALFA.indexOf(c);
  const quads = dados.length / 4;
  for (let i = 0; i < (quads - 1) * 4; i++) if (valor(dados[i]) < 0) return null;
  const [d1, d2, d3, d4] = dados.slice(-4);
  if (valor(d1) < 0 || valor(d2) < 0) return null;
  if (valor(d3) >= 0 && valor(d4) >= 0) return quads * 3;
  if (d3 === '=' && d4 === '=') return (valor(d2) & 0xf) === 0 ? (quads - 1) * 3 + 1 : null;
  if (valor(d3) >= 0 && d4 === '=') return (valor(d3) & 0x3) === 0 ? (quads - 1) * 3 + 2 : null;
  return null;
}

const DV_BASE64 = {
  normalizacao: 'nenhuma', // Base64 knows how to deal with spaces
  nome: 'base64Binary',
  valor(s) {
    const n = decodificarBase64(s);
    if (n == null) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'base64Binary']);
    return { tipo: 'base64', texto: s.replace(/[ \r\n\t]/g, ''), bytes: n };
  },
  tamanho: (v) => v.bytes,
};

const DV_HEX = {
  normalizacao: 'aparar',
  nome: 'hexBinary',
  valor(s) {
    if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'hexBinary']);
    return { tipo: 'hex', texto: s.toUpperCase(), bytes: s.length / 2 };
  },
  tamanho: (v) => v.bytes,
};

const DV_BOOLEAN = {
  normalizacao: 'aparar',
  nome: 'boolean',
  valor(s) {
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'boolean']);
  },
};

// AnyURIDV: XLink escaping, then org.apache.xerces.util.URI(BASE_URI, encoded).
const PRECISA_ESCAPE = new Set([...Array(0x20).keys(), 0x7f, ...' <>"{}|\\^~`'.split('').map((c) => c.charCodeAt(0))]);
function codificarUri(s) {
  let r = '';
  for (const b of Buffer.from(s, 'utf8')) {
    if (b >= 0x80 || PRECISA_ESCAPE.has(b)) r += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    else r += String.fromCharCode(b);
  }
  return r;
}
const NAO_RESERVADO = /[A-Za-z0-9\-_.!~*'()]/;
const ehEscapeValido = (s, i) => /^%[0-9A-Fa-f]{2}/.test(s.slice(i, i + 3));
/** Characters allowed in a path / query / fragment after the URI class rules (escapes checked). */
function verificarParte(s, permitidos) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%') { if (!ehEscapeValido(s, i)) return false; i += 2; continue; }
    if (!NAO_RESERVADO.test(c) && !permitidos.includes(c)) return false;
  }
  return true;
}
function hostValido(h) {
  if (h === '') return true;
  if (h.startsWith('[')) return /^\[[0-9A-Fa-f:.]+\]$/.test(h);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h.split('.').every((x) => Number(x) <= 255);
  return /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.?$/.test(h) && !/^\d/.test(h.split('.').filter(Boolean).pop() ?? '');
}
/** URI(base, spec) of org.apache.xerces.internal.util.URI: true when it parses. */
function uriValida(u) {
  const dp = u.indexOf(':');
  let resto = u;
  if (dp !== -1) {
    const antes = u.slice(0, dp);
    if (dp === 0) return false;
    if (!/[/?#]/.test(antes)) {
      if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(antes)) return false;
      if (dp === u.length - 1 || u[dp + 1] === '#') return false;
      resto = u.slice(dp + 1);
    }
  }
  let fragmento = null;
  const iFrag = resto.indexOf('#');
  if (iFrag >= 0) { fragmento = resto.slice(iFrag + 1); resto = resto.slice(0, iFrag); }
  let consulta = null;
  const iCons = resto.indexOf('?');
  if (iCons >= 0) { consulta = resto.slice(iCons + 1); resto = resto.slice(0, iCons); }
  if (resto.startsWith('//')) {
    const fimAut = resto.indexOf('/', 2);
    const autoridade = fimAut < 0 ? resto.slice(2) : resto.slice(2, fimAut);
    resto = fimAut < 0 ? '' : resto.slice(fimAut);
    if (autoridade !== '') {
      const arroba = autoridade.lastIndexOf('@');
      const hostPorta = arroba >= 0 ? autoridade.slice(arroba + 1) : autoridade;
      const info = arroba >= 0 ? autoridade.slice(0, arroba) : '';
      const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hostPorta);
      const servidor = m && hostValido(m[1]) && verificarParte(info, ';:&=+$,');
      if (!servidor && !verificarParte(autoridade, '$,;:@&=+')) return false;
    }
  }
  if (!verificarParte(resto, ';/:@&=+$,')) return false;
  if (consulta != null && !verificarParte(consulta, ';/?:@&=+$,[]')) return false;
  if (fragmento != null && !verificarParte(fragmento, ';/?:@&=+$,[]')) return false;
  return true;
}
const DV_ANYURI = {
  normalizacao: 'aparar',
  nome: 'anyURI',
  valor(s) {
    if (s.length !== 0 && !uriValida(codificarUri(s))) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'anyURI']);
    return s;
  },
  tamanho: tamanhoTexto,
};

const DV_ID = {
  normalizacao: 'aparar',
  nome: 'ID',
  valor(s) {
    if (!ehNCName(s)) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'NCName']);
    return s;
  },
  tamanho: tamanhoTexto,
  ehId: true,
};

const DV_QNAME = {
  normalizacao: 'aparar',
  nome: 'QName',
  valor(s) {
    const partes = s.split(':');
    if (partes.length > 2 || !partes.every(ehNCName)) throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, 'QName']);
    return s;
  },
};

// Dates (AbstractDateTimeDV): parsing with the same failures as Xerces; compareDates for facets.
function lerInteiro(s, i, f) {
  if (f > s.length || i >= f) throw new Error('fora');
  let v = 0;
  for (let k = i; k < f; k++) { if (!ehDigito(s[k])) throw new Error('digito'); v = v * 10 + (s.charCodeAt(k) - 48); }
  return v;
}
const bissexto = (a) => (a % 4 === 0 && (a % 100 !== 0 || a % 400 === 0));
function maxDia(a, m) {
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  if (m === 2) return bissexto(a < 0 ? -a - 1 : a) ? 29 : 28;
  return 31;
}
function lerAnoMes(s, d) {
  let inicio = 0;
  if (s[0] === '-') inicio = 1;
  const i = s.indexOf('-', inicio);
  if (i === -1) throw new Error('ano');
  const len = i - inicio;
  if (len < 4) throw new Error('ano');
  if (len > 4 && s[inicio] === '0') throw new Error('ano');
  const ano = lerInteiro(s, inicio, i);
  d.ano = s[0] === '-' ? -ano : ano;
  d.mes = lerInteiro(s, i + 1, i + 3);
  return i + 3;
}
function lerFuso(s, inicio, d) {
  if (inicio >= s.length) return;
  const c = s[inicio];
  if (c !== 'Z' && c !== '+' && c !== '-') throw new Error('fuso');
  d.utc = c;
  if (c === 'Z') { if (s.length > inicio + 1) throw new Error('fuso'); return; }
  if (inicio > s.length - 6) throw new Error('fuso');
  const sinal = c === '-' ? -1 : 1;
  d.fusoH = sinal * lerInteiro(s, inicio + 1, inicio + 3);
  if (s[inicio + 3] !== ':') throw new Error('fuso');
  d.fusoM = sinal * lerInteiro(s, inicio + 4, inicio + 6);
  if (inicio + 6 !== s.length) throw new Error('fuso');
}
function validarDataHora(d) {
  if (d.ano === 0) throw new Error('ano 0000');
  if (d.mes < 1 || d.mes > 12) throw new Error('mes');
  if (d.dia > maxDia(d.ano, d.mes) || d.dia < 1) throw new Error('dia');
  if (d.fusoH > 14 || d.fusoH < -14) throw new Error('fuso');
  if ((d.fusoH === 14 || d.fusoH === -14) && d.fusoM !== 0) throw new Error('fuso');
  if (d.fusoM > 59 || d.fusoM < -59) throw new Error('fuso');
}
/** normalize(): to UTC (minutes then hours, with month/year carries). */
function normalizar(d) {
  const r = { ...d };
  let minuto = r.minuto - r.fusoM;
  let hora = r.hora - r.fusoH;
  hora += Math.floor(minuto / 60); minuto = ((minuto % 60) + 60) % 60;
  let carryDia = Math.floor(hora / 24); hora = ((hora % 24) + 24) % 24;
  let dia = r.dia + carryDia;
  let mes = r.mes, ano = r.ano;
  for (;;) {
    if (dia < 1) { mes--; if (mes < 1) { mes = 12; ano--; if (ano === 0) ano = -1; } dia += maxDia(ano, mes); } else {
      const max = maxDia(ano, mes);
      if (dia > max) { dia -= max; mes++; if (mes > 12) { mes = 1; ano++; if (ano === 0) ano = 1; } } else break;
    }
  }
  return { ...r, ano, mes, dia, hora, minuto, utc: 'Z', fusoH: 0, fusoM: 0 };
}
function compararOrdem(a, b) {
  for (const k of ['ano', 'mes', 'dia', 'hora', 'minuto', 'segundo']) {
    if (a[k] < b[k]) return -1;
    if (a[k] > b[k]) return 1;
  }
  return 0;
}
/** AbstractDateTimeDV.compareDates(strict): -1, 0, 1 or 2 (INDETERMINATE). */
export function compararDatas(a, b) {
  if (a.utc === b.utc) return compararOrdem(a, b);
  const comFuso = (d, h) => normalizar({ ...d, fusoH: h, fusoM: 0, utc: h > 0 ? '+' : '-' });
  if (a.utc === 'Z') {
    if (compararOrdem(a, comFuso(b, 14)) === -1) return -1;
    if (compararOrdem(a, comFuso(b, -14)) === 1) return 1;
    return 2;
  }
  if (b.utc === 'Z') {
    if (compararOrdem(comFuso(a, -14), b) === -1) return -1;
    if (compararOrdem(comFuso(a, 14), b) === 1) return 1;
    return 2;
  }
  return 2;
}
const pad = (n, k) => (n < 0 ? '-' + String(-n).padStart(k, '0') : String(n).padStart(k, '0'));
function dvData(nome, ler, texto) {
  return {
    nome,
    normalizacao: 'aparar',
    valor(s) {
      const d = { ano: 0, mes: 1, dia: 1, hora: 0, minuto: 0, segundo: 0, utc: null, fusoH: 0, fusoM: 0 };
      try {
        ler(s, d);
        validarDataHora(d);
      } catch {
        throw new ErroTipo('cvc-datatype-valid.1.2.1', [s, nome]);
      }
      const v = d.utc && d.utc !== 'Z' ? normalizar(d) : d;
      return { tipo: 'data', ...v, texto: texto(d) };
    },
    comparar: compararDatas,
  };
}
const DV_DATE = dvData('date', (s, d) => {
  const f = lerAnoMes(s, d);
  if (s[f] !== '-') throw new Error('-');
  d.dia = lerInteiro(s, f + 1, f + 3);
  lerFuso(s, f + 3, d);
}, (d) => `${pad(d.ano, 4)}-${pad(d.mes, 2)}-${pad(d.dia, 2)}${d.utc ?? ''}`);
const DV_GYEARMONTH = dvData('gYearMonth', (s, d) => {
  const f = lerAnoMes(s, d);
  lerFuso(s, f, d);
}, (d) => `${pad(d.ano, 4)}-${pad(d.mes, 2)}${d.utc ?? ''}`);
const DV_DATETIME = dvData('dateTime', (s, d) => {
  const f = lerAnoMes(s, d);
  if (s[f] !== '-') throw new Error('-');
  d.dia = lerInteiro(s, f + 1, f + 3);
  if (s[f + 3] !== 'T') throw new Error('T');
  const t = f + 4;
  d.hora = lerInteiro(s, t, t + 2);
  if (s[t + 2] !== ':') throw new Error(':');
  d.minuto = lerInteiro(s, t + 3, t + 5);
  if (s[t + 5] !== ':') throw new Error(':');
  d.segundo = lerInteiro(s, t + 6, t + 8);
  let k = t + 8;
  if (s[k] === '.') { k++; const ini = k; while (ehDigito(s[k] ?? '')) k++; if (k === ini) throw new Error('fração'); }
  lerFuso(s, k, d);
  if (d.hora > 23 || d.minuto > 59 || d.segundo > 59) throw new Error('hora');
}, (d) => `${pad(d.ano, 4)}-${pad(d.mes, 2)}-${pad(d.dia, 2)}T${pad(d.hora, 2)}:${pad(d.minuto, 2)}:${pad(d.segundo, 2)}${d.utc ?? ''}`);

// ─── Built-in types ────────────────────────────────────────────────────────────────────────────
const NOMES_ESPECIAIS = { NMTOKEN: 'NMTOKEN', Name: 'Name', NCName: 'NCName' };

/**
 * Texts longer than max(this, 64 × maxLength) skip the patterns (TipoSimples.validar). 64 KB keeps
 * the worst official pattern (a 1000-char qrCode URL) in tens of ms and is far above every maxLength
 * of the DF-e schemas (≤ 8000), so realistic oversize values keep Xerces' exact message.
 */
export const LIMITE_TEXTO_PADROES = 65536;

/** Simple type definition. */
export class TipoSimples {
  constructor({ nome, ns = XSD_NS, base = null, dv, espacos = 'preserve', anonimo = false, especial = null }) {
    this.categoria = 'simples';
    this.nome = nome;
    this.ns = ns;
    this.base = base;
    this.dv = dv;
    this.espacos = espacos;
    this.anonimo = anonimo;
    this.especial = especial;
    this.padroes = []; // { regex, texto }
    this.enumeracao = null; // [{ valor, texto }]
    this.facetas = {};
  }

  get ehId() { return Boolean(this.dv.ehId); }

  /**
   * XSSimpleTypeDecl.validate(content) with normalization required (the JAXP Validator does not
   * normalize data itself): without a pattern facet the DV decides (fDVNormalizeType: none for
   * base64Binary/anySimpleType, a plain trim for the non-string primitives); with a pattern the
   * whiteSpace facet applies. Returns { normalizado, valor } or throws ErroTipo.
   */
  validar(conteudo, contexto) {
    const modo = this.padroes.length ? 'completa' : this.dv.normalizacao ?? 'completa';
    const normalizado = modo === 'nenhuma' ? conteudo : modo === 'aparar' ? aparar(conteudo) : normalizarEspacos(conteudo, this.espacos);
    // Port limit (documented divergence): a text far longer than its maxLength/length facet skips
    // the patterns, whose backtracking can be quadratic (the official qrCode patterns
    // `(HTTPS?|https?)://.*\?chCTe=…&sign=[!-ÿ][ -ÿ]{0,}[!-ÿ]` took 22 s on 1.5 MB). The length
    // facet below rejects it anyway; Xerces would report cvc-pattern-valid first if a pattern failed.
    const pularPadroes = this.padroes.length > 0 && this.textoAbsurdo(normalizado);
    for (let i = pularPadroes ? -1 : this.padroes.length - 1; i >= 0; i--) {
      if (!this.padroes[i].regex.test(normalizado)) throw new ErroTipo('cvc-pattern-valid', [conteudo, this.padroes[i].texto, this.nome]);
    }
    if (this.especial) {
      const ok = this.especial === 'NCName' ? ehNCName(normalizado) : this.especial === 'Name' ? /^[\p{L}_:][\p{L}\p{N}\p{M}._:\-·]*$/u.test(normalizado) : /^[\p{L}\p{N}\p{M}._:\-·]+$/u.test(normalizado);
      if (!ok) throw new ErroTipo('cvc-datatype-valid.1.2.1', [normalizado, NOMES_ESPECIAIS[this.especial]]);
    }
    const valor = this.dv.valor(normalizado);
    this.verificarFacetas(normalizado, valor);
    if (this.ehId && contexto) {
      if (contexto.ids.has(valor)) throw new ErroTipo('cvc-id.2', [normalizado]);
      contexto.ids.add(valor);
    }
    return { normalizado, valor };
  }

  /** The text alone already breaks the maxLength (or length) facet by far: see LIMITE_TEXTO_PADROES. */
  textoAbsurdo(texto) {
    const limite = this.facetas.maxLength ?? this.facetas.length;
    return limite !== undefined && this.dv.tamanho === tamanhoTexto && texto.length > Math.max(LIMITE_TEXTO_PADROES, 64 * limite);
  }

  verificarFacetas(conteudo, valor) {
    const f = this.facetas;
    const tamanho = () => (this.dv.tamanho ? this.dv.tamanho(valor) : String(valor).length);
    if (f.maxLength !== undefined && tamanho() > f.maxLength) throw new ErroTipo('cvc-maxLength-valid', [conteudo, String(tamanho()), String(f.maxLength), this.nome]);
    if (f.minLength !== undefined && tamanho() < f.minLength) throw new ErroTipo('cvc-minLength-valid', [conteudo, String(tamanho()), String(f.minLength), this.nome]);
    if (f.length !== undefined && tamanho() !== f.length) throw new ErroTipo('cvc-length-valid', [conteudo, String(tamanho()), String(f.length), this.nome]);
    if (this.enumeracao) {
      if (!this.enumeracao.some((e) => valoresIguais(e.valor, valor))) {
        throw new ErroTipo('cvc-enumeration-valid', [conteudo, `[${this.enumeracao.map((e) => textoValor(e.valor)).join(', ')}]`]);
      }
    }
    const cmp = (a, b) => (this.dv.comparar ? this.dv.comparar(a, b) : compararDecimais(a, b));
    if (f.maxInclusive && ![-1, 0].includes(cmp(valor, f.maxInclusive.valor))) throw new ErroTipo('cvc-maxInclusive-valid', [conteudo, textoValor(f.maxInclusive.valor), this.nome]);
    if (f.maxExclusive && cmp(valor, f.maxExclusive.valor) !== -1) throw new ErroTipo('cvc-maxExclusive-valid', [conteudo, textoValor(f.maxExclusive.valor), this.nome]);
    if (f.minInclusive && ![1, 0].includes(cmp(valor, f.minInclusive.valor))) throw new ErroTipo('cvc-minInclusive-valid', [conteudo, textoValor(f.minInclusive.valor), this.nome]);
    if (f.minExclusive && cmp(valor, f.minExclusive.valor) !== 1) throw new ErroTipo('cvc-minExclusive-valid', [conteudo, textoValor(f.minExclusive.valor), this.nome]);
  }

  /** toString of XSSimpleTypeDecl is its name. */
  toString() { return this.nome; }
}

function compararDecimais(a, b) {
  const s = (x) => (x.inteiro === '' && x.fracao === '' ? 0 : x.sinal);
  if (s(a) !== s(b)) return s(a) < s(b) ? -1 : 1;
  const sinal = s(a);
  if (sinal === 0) return 0;
  let c = a.inteiro.length - b.inteiro.length;
  if (c === 0) c = a.inteiro < b.inteiro ? -1 : a.inteiro > b.inteiro ? 1 : 0;
  if (c === 0) { const n = Math.max(a.fracao.length, b.fracao.length); const fa = a.fracao.padEnd(n, '0'), fb = b.fracao.padEnd(n, '0'); c = fa < fb ? -1 : fa > fb ? 1 : 0; }
  return Math.sign(c) * sinal;
}

function valoresIguais(a, b) {
  if (typeof a !== 'object' || a === null) return a === b;
  if (a.tipo === 'decimal') return compararDecimais(a, b) === 0;
  if (a.tipo === 'data') return compararDatas(a, b) === 0;
  return a.texto === b.texto;
}

/** Text of an actual value as Xerces prints it (toString of the actual value object). */
function textoValor(v) {
  if (typeof v !== 'object' || v === null) return String(v);
  if (v.tipo === 'decimal') {
    const int = v.inteiro || '0';
    return `${v.sinal < 0 && (v.inteiro || v.fracao) ? '-' : ''}${int}${v.fracao ? `.${v.fracao}` : ''}`;
  }
  return v.texto;
}

const T = (nome, dv, espacos, base, extra = {}) => new TipoSimples({ nome, dv, espacos, base, ...extra });
const anySimpleType = T('anySimpleType', { ...DV_STRING, normalizacao: 'nenhuma' }, 'preserve', null);
const string = T('string', DV_STRING, 'preserve', anySimpleType);
const normalizedString = T('normalizedString', DV_STRING, 'replace', string);
const token = T('token', DV_STRING, 'collapse', normalizedString);
const Name = T('Name', DV_STRING, 'collapse', token, { especial: 'Name' });
const NCName = T('NCName', DV_STRING, 'collapse', Name, { especial: 'NCName' });
const decimal = T('decimal', DV_DECIMAL, 'collapse', anySimpleType);
const integer = T('integer', DV_INTEGER, 'collapse', decimal);

/** Built-in simple types by local name (namespace XSD). */
export const TIPOS_EMBUTIDOS = new Map([
  ['anySimpleType', anySimpleType],
  ['string', string],
  ['normalizedString', normalizedString],
  ['token', token],
  ['language', T('language', DV_STRING, 'collapse', token)],
  ['Name', Name],
  ['NCName', NCName],
  ['NMTOKEN', T('NMTOKEN', DV_STRING, 'collapse', token, { especial: 'NMTOKEN' })],
  ['ID', T('ID', DV_ID, 'collapse', NCName, { especial: 'NCName' })],
  ['IDREF', T('IDREF', DV_STRING, 'collapse', NCName, { especial: 'NCName' })],
  ['decimal', decimal],
  ['integer', integer],
  ['nonNegativeInteger', T('nonNegativeInteger', DV_INTEGER, 'collapse', integer)],
  ['positiveInteger', T('positiveInteger', DV_INTEGER, 'collapse', integer)],
  ['int', T('int', DV_INTEGER, 'collapse', integer)],
  ['long', T('long', DV_INTEGER, 'collapse', integer)],
  ['boolean', T('boolean', DV_BOOLEAN, 'collapse', anySimpleType)],
  ['base64Binary', T('base64Binary', DV_BASE64, 'collapse', anySimpleType)],
  ['hexBinary', T('hexBinary', DV_HEX, 'collapse', anySimpleType)],
  ['anyURI', T('anyURI', DV_ANYURI, 'collapse', anySimpleType)],
  ['QName', T('QName', DV_QNAME, 'collapse', anySimpleType)],
  ['date', T('date', DV_DATE, 'collapse', anySimpleType)],
  ['gYearMonth', T('gYearMonth', DV_GYEARMONTH, 'collapse', anySimpleType)],
  ['dateTime', T('dateTime', DV_DATETIME, 'collapse', anySimpleType)],
]);
{
  const f = (n, k, v) => { TIPOS_EMBUTIDOS.get(n).facetas[k] = { valor: DV_INTEGER.valor(v) }; };
  f('nonNegativeInteger', 'minInclusive', '0');
  f('positiveInteger', 'minInclusive', '1');
  f('int', 'minInclusive', '-2147483648'); f('int', 'maxInclusive', '2147483647');
  f('long', 'minInclusive', '-9223372036854775808'); f('long', 'maxInclusive', '9223372036854775807');
}

/**
 * Restriction of `base` (XSDSimpleTypeTraverser + XSSimpleTypeDecl.applyFacets): facets of the
 * restriction step; patterns of one step are joined with '|'; inherited patterns are appended.
 */
export function restringir(base, { nome, ns, anonimo, facetas }) {
  const t = new TipoSimples({ nome, ns, base, dv: base.dv, espacos: base.espacos, anonimo, especial: base.especial });
  t.facetas = { ...base.facetas };
  t.enumeracao = base.enumeracao;
  const padroesProprios = facetas.filter((f) => f.tipo === 'pattern').map((f) => f.valor);
  if (padroesProprios.length) {
    const texto = padroesProprios.join('|');
    t.padroes = [{ regex: regexXsd(texto), texto }, ...base.padroes];
  } else {
    t.padroes = base.padroes;
  }
  const ws = facetas.find((f) => f.tipo === 'whiteSpace');
  if (ws) t.espacos = ws.valor;
  const enums = facetas.filter((f) => f.tipo === 'enumeration');
  if (enums.length) t.enumeracao = enums.map((e) => ({ valor: base.dv.valor(normalizarEspacos(e.valor, t.espacos)), texto: e.valor }));
  for (const f of facetas) {
    if (f.tipo === 'length' || f.tipo === 'minLength' || f.tipo === 'maxLength') t.facetas[f.tipo] = Number(f.valor);
    if (['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'].includes(f.tipo)) t.facetas[f.tipo] = { valor: base.dv.valor(normalizarEspacos(f.valor, 'collapse')) };
  }
  return t;
}
