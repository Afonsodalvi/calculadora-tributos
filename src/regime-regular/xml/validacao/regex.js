// XML Schema regular expressions (Xerces impl.xpath.regex.RegularExpression in XML Schema mode)
// translated to JavaScript RegExp with the 'u' flag and implicit anchoring. Supported syntax (the
// one used by the official XSDs and the XSD 1.0 grammar): branches, groups, quantifiers ? * + {n}
// {n,} {n,m}, character classes with ranges, negation and subtraction ([a-z-[aeiou]]), the escapes
// \n \r \t \\ \| \. \- \^ \? \* \+ \{ \} \( \) \[ \], the multi-char escapes \s \S \d \D \w \W \i
// \I \c \C, '.', and \p{..}/\P{..} general categories and Is<Block> names.
const ESPACO = ' \\t\\n\\r';
const CLASSES = {
  s: `[${ESPACO}]`,
  S: `[^${ESPACO}]`,
  d: '\\p{Nd}',
  D: '\\P{Nd}',
  w: '[^\\p{P}\\p{Z}\\p{C}]',
  W: '[\\p{P}\\p{Z}\\p{C}]',
  i: '[\\p{L}_:]',
  I: '[^\\p{L}_:]',
  c: '[\\p{L}\\p{Nd}\\p{Mn}\\p{Mc}._:\\-·]',
  C: '[^\\p{L}\\p{Nd}\\p{Mn}\\p{Mc}._:\\-·]',
};
/** Inside a class: the members of each multi-char escape (complements as ranges). */
const MEMBROS = {
  s: ESPACO,
  S: '\\u{0}-\\u{8}\\u{b}\\u{c}\\u{e}-\\u{1f}\\u{21}-\\u{10ffff}',
  d: '\\p{Nd}',
  w: '\\p{L}\\p{M}\\p{N}\\p{S}',
  i: '\\p{L}_:',
  c: '\\p{L}\\p{Nd}\\p{Mn}\\p{Mc}._:\\-·',
};
const ESCAPES_SIMPLES = { n: 0x0a, r: 0x0d, t: 0x09 };
const METACARACTERES = new Set('\\|.-^?*+{}()[]'.split(''));

export class ErroRegex extends Error {}

const literal = (cp) => `\\u{${cp.toString(16)}}`;

/** Unicode property name of XSD (\p{Lu}, \p{IsBasicLatin}) in JS syntax. */
function propriedade(nome) {
  if (/^Is[A-Za-z0-9-]+$/.test(nome)) {
    const bloco = BLOCOS[nome.slice(2)];
    if (!bloco) throw new ErroRegex(`bloco desconhecido: ${nome}`);
    return { faixa: bloco };
  }
  if (!/^[A-Z][a-z]?$/.test(nome)) throw new ErroRegex(`categoria desconhecida: ${nome}`);
  return { categoria: nome };
}

/** Unicode blocks most likely to appear in XSD patterns (others are rejected). */
const BLOCOS = {
  BasicLatin: [0x0000, 0x007f],
  'Latin-1Supplement': [0x0080, 0x00ff],
  LatinExtended_A: [0x0100, 0x017f],
  'LatinExtended-A': [0x0100, 0x017f],
  'LatinExtended-B': [0x0180, 0x024f],
  IPAExtensions: [0x0250, 0x02af],
  GeneralPunctuation: [0x2000, 0x206f],
  CurrencySymbols: [0x20a0, 0x20cf],
};

/** Translates one XSD regex to the source of an anchored JS RegExp (flag 'u'). */
export function traduzirRegex(padrao) {
  const cps = [...padrao].map((c) => c.codePointAt(0));
  let i = 0;
  const fim = () => i >= cps.length;
  const ch = () => String.fromCodePoint(cps[i]);

  function escapeMulti(letra) {
    return CLASSES[letra];
  }

  function lerEscapeEmClasse() {
    // after '\'
    const c = ch();
    i++;
    if (c in ESCAPES_SIMPLES) return { cp: ESCAPES_SIMPLES[c] };
    if (METACARACTERES.has(c)) return { cp: c.codePointAt(0) };
    if (c === 'p' || c === 'P') {
      const p = lerPropriedade();
      return { classe: p, negada: c === 'P' };
    }
    if ('sSdDwWiIcC'.includes(c)) return { multi: c };
    throw new ErroRegex(`escape inválido \\${c}`);
  }

  function lerPropriedade() {
    if (ch() !== '{') throw new ErroRegex('esperado {');
    i++;
    let nome = '';
    while (!fim() && ch() !== '}') { nome += ch(); i++; }
    if (fim()) throw new ErroRegex('esperado }');
    i++;
    return propriedade(nome);
  }

  function propriedadeJs(p, negada) {
    if (p.categoria) return `\\${negada ? 'P' : 'p'}{${p.categoria}}`;
    const faixa = `${literal(p.faixa[0])}-${literal(p.faixa[1])}`;
    return negada ? `[^${faixa}]` : `[${faixa}]`;
  }

  /** Character class after '['; returns a JS fragment (a class or an alternation for subtraction). */
  function lerClasse() {
    let negada = false;
    if (ch() === '^') { negada = true; i++; }
    const partes = []; // JS class members
    const extras = []; // members that need an alternation (negated multi-escapes)
    let primeiro = true;
    let subtracao = null;
    while (!fim() && (ch() !== ']' || primeiro)) {
      primeiro = false;
      if (ch() === '-' && cps[i + 1] === 0x5b) { // subtraction
        i += 2;
        subtracao = lerClasse();
        if (ch() !== ']') throw new ErroRegex('subtração deve encerrar a classe');
        break;
      }
      let inicio;
      if (ch() === '\\') {
        i++;
        const e = lerEscapeEmClasse();
        if (e.multi) {
          if (MEMBROS[e.multi]) partes.push(MEMBROS[e.multi]);
          else extras.push(escapeMulti(e.multi));
          continue;
        }
        if (e.classe) {
          if (e.classe.categoria) partes.push(`\\${e.negada ? 'P' : 'p'}{${e.classe.categoria}}`);
          else if (!e.negada) partes.push(`${literal(e.classe.faixa[0])}-${literal(e.classe.faixa[1])}`);
          else extras.push(propriedadeJs(e.classe, true));
          continue;
        }
        inicio = e.cp;
      } else {
        if (ch() === '[') throw new ErroRegex('[ não escapado em classe');
        inicio = cps[i];
        i++;
      }
      if (ch() === '-' && cps[i + 1] !== 0x5d && cps[i + 1] !== 0x5b && !fim()) {
        i++;
        let fimFaixa;
        if (ch() === '\\') {
          i++;
          const e = lerEscapeEmClasse();
          if (e.cp === undefined) throw new ErroRegex('faixa inválida');
          fimFaixa = e.cp;
        } else { fimFaixa = cps[i]; i++; }
        if (fimFaixa < inicio) throw new ErroRegex('faixa invertida');
        partes.push(`${literal(inicio)}-${literal(fimFaixa)}`);
      } else {
        partes.push(literal(inicio));
      }
    }
    if (fim()) throw new ErroRegex('classe não terminada');
    i++; // ']'
    let base;
    const corpo = partes.join('');
    if (!negada) {
      const alternativas = [];
      if (corpo) alternativas.push(`[${corpo}]`);
      alternativas.push(...extras);
      base = alternativas.length === 1 ? alternativas[0] : `(?:${alternativas.join('|') || '[]'})`;
    } else {
      // [^ ...] : not any member
      const negativas = extras.map((x) => `(?!${x})`).join('');
      base = negativas ? `(?:${negativas}[^${corpo}])` : `[^${corpo}]`;
    }
    if (subtracao) base = `(?:(?!${subtracao})${base})`;
    return base;
  }

  function lerAtomo() {
    const c = ch();
    if (c === '(') {
      i++;
      const r = lerRamos();
      if (fim() || ch() !== ')') throw new ErroRegex('parêntese não fechado');
      i++;
      return `(?:${r})`;
    }
    if (c === '[') { i++; return lerClasse(); }
    if (c === '.') { i++; return '[^\\n\\r]'; }
    if (c === '\\') {
      i++;
      if (fim()) throw new ErroRegex('escape no fim');
      const e = ch();
      i++;
      if (e in ESCAPES_SIMPLES) return literal(ESCAPES_SIMPLES[e]);
      if (METACARACTERES.has(e)) return literal(e.codePointAt(0));
      if (e === 'p' || e === 'P') return propriedadeJs(lerPropriedade(), e === 'P');
      if (CLASSES[e]) return escapeMulti(e);
      throw new ErroRegex(`escape inválido \\${e}`);
    }
    if (c === ')' || c === '|') throw new ErroRegex('átomo vazio');
    if ('?*+{'.includes(c)) throw new ErroRegex('quantificador sem átomo');
    if (c === ']' || c === '}') { i++; return literal(c.codePointAt(0)); }
    i++;
    return literal(cps[i - 1]);
  }

  function lerQuantificador() {
    if (fim()) return '';
    const c = ch();
    if (c === '?' || c === '*' || c === '+') { i++; return c; }
    if (c === '{') {
      let j = i + 1;
      let s = '';
      while (j < cps.length && String.fromCodePoint(cps[j]) !== '}') { s += String.fromCodePoint(cps[j]); j++; }
      const m = /^(\d+)(,(\d*))?$/.exec(s);
      if (j >= cps.length || !m) throw new ErroRegex('quantificador inválido');
      if (m[3] !== undefined && m[3] !== '' && Number(m[3]) < Number(m[1])) throw new ErroRegex('quantificador invertido');
      i = j + 1;
      return `{${s}}`;
    }
    return '';
  }

  function lerRamo() {
    let r = '';
    while (!fim() && ch() !== '|' && ch() !== ')') {
      const a = lerAtomo();
      const q = lerQuantificador();
      r += q ? `(?:${a})${q}` : a;
    }
    return r;
  }

  function lerRamos() {
    const ramos = [lerRamo()];
    while (!fim() && ch() === '|') { i++; ramos.push(lerRamo()); }
    return ramos.join('|');
  }

  const corpo = lerRamos();
  if (!fim()) throw new ErroRegex('parêntese inesperado');
  return `^(?:${corpo})$`;
}

const cache = new Map();
/** RegExp for an XSD pattern (cached). */
export function regexXsd(padrao) {
  let r = cache.get(padrao);
  if (!r) {
    r = new RegExp(traduzirRegex(padrao), 'u');
    cache.set(padrao, r);
  }
  return r;
}
