// Port of domain/service/calculotributo/AvaliadorExpressaoAritmetica (ADR001) and VariavelExpressao.
//
// The Java class evaluates the TRATAMENTO_TRIBUTARIO formulas with Apache Commons JEXL 3.5 and a
// custom BigDecimalArithmetic. This port is a SAFE whitelist evaluator (never eval/new Function):
// it accepts only the arithmetic subset of JEXL that the formulas use
//   expr   := term (('+' | '-') term)*          left associative
//   term   := unary (('*' | '/') unary)*        left associative
//   unary  := ('-' | '+') unary | factor        JEXL negate / positivize
//   factor := NUMBER | IDENT | '(' expr ')'
// and reproduces JEXL's observable semantics (checked against the official class running on the
// JDK): integer literals are exact (octal when they start with 0, hexadecimal with 0x), real
// literals are Double values converted by new BigDecimal(Double.toString(d)), + - * are exact,
// / is ArredondamentoUtils.dividir (MathContext 34, HALF_EVEN) and a zero divisor is a
// JexlException "/ error", an unknown variable is a JexlException$Variable (strict engine), and the
// error messages carry the same "@line:column" position. Anything else JEXL would accept (method
// calls, strings, comparisons, %, ternaries...) is refused as a parsing error: fail closed.
import { Dec } from '../../../core/decimal.js';
import { dividir } from '../../comum/arredondamento.js';
import { ErroJava } from '../../comum/problema.js';
import { javaDoubleToString, javaTrim } from '../../comum/java.js';

/** VariavelExpressao: enum constant → name used in the formulas. */
export const VariavelExpressao = Object.freeze({
  BASE_CALCULO: 'baseCalculo',
  IMPOSTO_SELETIVO_CALCULADO: 'impostoSeletivoCalculado',
  BASE_CALCULO_INFORMADA: 'baseCalculoInformada',
  IMPOSTO_SELETIVO_INFORMADO: 'impostoSeletivoInformado',
  ALIQUOTA_EFETIVA: 'aliquotaEfetiva',
  REDUTOR: 'redutor',
  AJUSTE: 'ajuste',
  ALIQUOTA_AD_REM: 'aliquotaAdRem',
  ALIQUOTA_AD_VALOREM: 'aliquotaAdValorem',
  ALIQUOTA_REFERENCIA: 'aliquotaReferencia',
  ALIQUOTA_PADRAO_OU_REFERENCIA: 'aliquotaPadraoOuReferencia',
  PERCENTUAL_REDUCAO: 'percentualReducao',
  PERCENTUAL_REDUCAO_COMPRA_GOV: 'pRedutorCompraGov',
  ALIQUOTA: 'aliquota',
  QUANTIDADE: 'quantidade',
  TRIBUTO_CALCULADO: 'tributoCalculado',
  PERCENTUAL_DIFERIMENTO: 'percentualDiferimento',
  ALIQUOTA_AD_REM_PRINCIPAL: 'aliquotaAdRemPrincipal',
  ALIQUOTA_AD_REM_SECUNDARIA: 'aliquotaAdRemSecundaria',
  VARIACAO_PONTO_PERCENTUAL: 'variacaoPontoPercentual',
  PERCENTUAL_BIOCOMBUSTIVEL: 'pBio',
});

/**
 * Map.ofEntries(entry(VARIAVEL, valor), ...) of the calculation services: every null value becomes
 * BigDecimal.ZERO (requireNonNullElse). `pares` = [[VariavelExpressao.X, valor], ...].
 */
export function variaveis(pares) {
  const m = new Map();
  for (const [nome, valor] of pares) {
    // Map.ofEntries rejects duplicate keys (IllegalArgumentException); never happens in the services
    if (m.has(nome)) throw new ErroJava('IllegalArgumentException', `duplicate key: ${nome}`);
    m.set(nome, valor ?? Dec.ZERO);
  }
  return m;
}

/** Location prefix JEXL puts in its exception messages (the caller of createExpression, line 111). */
const ORIGEM = 'br.gov.serpro.rtc.domain.service.calculotributo.AvaliadorExpressaoAritmetica.evaluate:111';

/** JEXL keywords: an identifier with one of these names is a parsing error. */
const RESERVADAS = new Set([
  'or', 'and', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'div', 'mod', 'not', 'null', 'true', 'false', 'NaN',
  'function', 'new', 'size', 'empty', 'if', 'else', 'for', 'while', 'do', 'var', 'let', 'const',
  'return', 'break', 'continue', 'import', 'pragma', 'switch', 'case', 'default', 'try', 'catch',
  'finally', 'throw', 'instanceof',
]);

const erroParsing = (tok) => new ErroJava('JexlException$Parsing', `${ORIGEM}@${tok.linha}:${tok.coluna} parsing error in '${tok.texto}'`);

/** Engine.trimSource: strips Character.isSpaceChar (Zs/Zl/Zp) at both ends. */
const trimSource = (s) => s.replace(/^[\p{Zs}\p{Zl}\p{Zp}]+|[\p{Zs}\p{Zl}\p{Zp}]+$/gu, '');

/** Tokens: { tipo: 'num'|'id'|'op'|'fim', texto, valor?, linha, coluna } (columns count UTF-16 units, tab = 1). */
function tokenizar(fonte) {
  const tokens = [];
  let i = 0;
  let linha = 1;
  let coluna = 1;
  const avancar = (n) => {
    for (let k = 0; k < n; k++) {
      if (fonte[i] === '\n') { linha++; coluna = 1; } else coluna++;
      i++;
    }
  };
  while (i < fonte.length) {
    const c = fonte[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { avancar(1); continue; }
    const inicio = { linha, coluna };
    const resto = fonte.slice(i);
    let m;
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(resto))) {
      tokens.push({ tipo: 'num', texto: m[0], valor: new Dec(BigInt(m[0]), 0), ...inicio });
    } else if ((m = /^(?:\d+\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)/.exec(resto))) {
      // real literal: Double.parseDouble, then new BigDecimal(Double.toString(d)) where it is used
      const d = Number(m[0]);
      tokens.push({ tipo: 'num', texto: m[0], valor: null, duplo: d, ...inicio });
    } else if ((m = /^0[0-7]*/.exec(resto))) {
      const valor = m[0].length > 1 ? BigInt('0o' + m[0].slice(1)) : 0n;
      tokens.push({ tipo: 'num', texto: m[0], valor: new Dec(valor, 0), ...inicio });
    } else if ((m = /^[1-9]\d*/.exec(resto))) {
      tokens.push({ tipo: 'num', texto: m[0], valor: new Dec(BigInt(m[0]), 0), ...inicio });
    } else if ((m = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(resto))) {
      tokens.push({ tipo: 'id', texto: m[0], ...inicio });
    } else if ((m = /^(?:--|\+\+)/.exec(resto))) {
      tokens.push({ tipo: 'op', texto: m[0], ...inicio }); // JEXL decrement/increment: refused by the parser
    } else if ('+-*/()'.includes(c)) {
      tokens.push({ tipo: 'op', texto: c, ...inicio });
      m = [c];
    } else {
      // any other character (strings, ., %, comparisons, ...) is outside the whitelist
      const cp = String.fromCodePoint(resto.codePointAt(0));
      throw erroParsing({ texto: cp, ...inicio });
    }
    avancar(m[0].length);
  }
  return tokens;
}

/**
 * Recursive-descent parser. AST nodes: { tipo: 'num', valor } | { tipo: 'var', nome, tok } |
 * { tipo: 'neg'|'pos', filho } | { tipo: '+'|'-'|'*'|'/', esq, dir, tokDir }.
 */
function analisar(tokens) {
  let p = 0;
  const atual = () => tokens[p];
  // unexpected end: JavaCC reports the last token read
  const erroAqui = () => erroParsing(atual() ?? tokens[tokens.length - 1]);

  function expr() {
    let no = termo();
    while (atual()?.tipo === 'op' && (atual().texto === '+' || atual().texto === '-')) {
      const op = tokens[p++].texto;
      const tokDir = atual();
      no = { tipo: op, esq: no, dir: termo(), tokDir };
    }
    return no;
  }
  function termo() {
    let no = unario();
    while (atual()?.tipo === 'op' && (atual().texto === '*' || atual().texto === '/')) {
      const op = tokens[p++].texto;
      const tokDir = atual();
      no = { tipo: op, esq: no, dir: unario(), tokDir };
    }
    return no;
  }
  function unario() {
    const t = atual();
    if (t?.tipo === 'op' && (t.texto === '-' || t.texto === '+')) {
      p++;
      return { tipo: t.texto === '-' ? 'neg' : 'pos', filho: unario() };
    }
    return fator();
  }
  function fator() {
    const t = atual();
    if (!t) throw erroAqui();
    if (t.tipo === 'num') { p++; return t.valor ? { tipo: 'num', valor: t.valor } : { tipo: 'num', duplo: t.duplo }; }
    if (t.tipo === 'id') {
      if (RESERVADAS.has(t.texto)) throw erroParsing(t);
      p++;
      return { tipo: 'var', nome: t.texto, tok: t };
    }
    if (t.tipo === 'op' && t.texto === '(') {
      p++;
      const no = expr();
      if (atual()?.texto !== ')') throw erroAqui();
      p++;
      return no;
    }
    throw erroParsing(t);
  }

  const raiz = expr();
  if (p < tokens.length) throw erroParsing(atual());
  return raiz;
}

/** BigDecimalArithmetic.toBigDecimal: a real literal (Double) becomes new BigDecimal(Double.toString(d)). */
function paraBigDecimal(v) {
  if (v instanceof Dec) return v;
  return Dec.parse(javaDoubleToString(v)); // Infinity → NumberFormatException, as new BigDecimal("Infinity")
}

function avaliarNo(no, vars) {
  switch (no.tipo) {
    case 'num': return no.valor ?? no.duplo;
    case 'var': {
      if (!vars.has(no.nome)) {
        throw new ErroJava('JexlException$Variable', `${ORIGEM}@${no.tok.linha}:${no.tok.coluna} variable '${no.nome}' is undefined`);
      }
      return vars.get(no.nome);
    }
    // JexlArithmetic.negate / positivize (not overridden): sign change of the same number
    case 'neg': { const v = avaliarNo(no.filho, vars); return v instanceof Dec ? v.negate() : -v; }
    case 'pos': return avaliarNo(no.filho, vars);
    default: {
      const esq = paraBigDecimal(avaliarNo(no.esq, vars));
      const dir = paraBigDecimal(avaliarNo(no.dir, vars));
      if (no.tipo === '+') return esq.add(dir);
      if (no.tipo === '-') return esq.subtract(dir);
      if (no.tipo === '*') return esq.multiply(dir);
      // divide: zero divisor → ArithmeticException, rethrown by the strict interpreter as "/ error"
      if (dir.compareTo(Dec.ZERO) === 0) {
        throw new ErroJava('JexlException', `${ORIGEM}@${no.tokDir.linha}:${no.tokDir.coluna} JEXL error : / error`);
      }
      return dividir(esq, dir);
    }
  }
}

/** Parse cache (JexlBuilder.cache(512)): no semantic effect, only avoids re-parsing the same formula. */
const cacheAst = new Map();

/**
 * AvaliadorExpressaoAritmetica.evaluate(String expression, Map<String, BigDecimal> variables).
 * `variaveis` = Map nome → Dec (use variaveis()). Returns a Dec (not rounded: callers round).
 */
export function avaliar(expressao, vars) {
  if (expressao == null) {
    throw new ErroJava('NullPointerException', 'Cannot invoke "String.trim()" because "expression" is null');
  }
  const exprTrim = javaTrim(expressao);
  // Case 1: the expression is just a variable name → the very same bound value
  if (vars.has(exprTrim)) {
    const valor = vars.get(exprTrim);
    if (valor != null) return valor;
    throw new ErroJava('RuntimeException', `Valor não mapeado corretamente: ${exprTrim}`);
  }
  let ast = cacheAst.get(expressao);
  if (ast === undefined) {
    const tokens = tokenizar(trimSource(expressao));
    ast = tokens.length === 0 ? null : analisar(tokens);
    if (expressao.length <= 1024) { // cacheThreshold(1024)
      if (cacheAst.size >= 512) cacheAst.delete(cacheAst.keys().next().value);
      cacheAst.set(expressao, ast);
    }
  }
  // an empty script evaluates to null → "Erro ao avaliar expressão: null"
  if (ast === null) throw new ErroJava('NumberFormatException', 'Erro ao avaliar expressão: null');
  // NumberUtils.convertNumberToTargetClass(n, BigDecimal.class): BigDecimal as is, else new BigDecimal(n.toString())
  return paraBigDecimal(avaliarNo(ast, vars));
}
