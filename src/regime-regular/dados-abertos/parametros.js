// Spring MVC argument resolution for the DadosAbertosController handlers (Spring Framework 7.0,
// WebConversionService of Spring Boot 4.1), checked against the oracle:
// - @RequestParam String: absent → 400 "Required parameter" (or null when optional); repeated values are
//   joined with ','; no trim, "" stays "".
// - Long / LocalDate / enum: a repeated parameter converts its FIRST value (ArrayToObjectConverter); a blank
//   value (only Character.isWhitespace chars) converts to null → 400 "Required parameter" when required.
//   Long: StringUtils.trimAllWhitespace, "-"?"0x"/"0X"/"#" → Long.decode (hex), else Long.valueOf.
//   LocalDate: ofLocalizedDate(SHORT) in the request locale, then LocalDate.parse (ISO); with
//   @DateTimeFormat(iso = DATE): ISO_DATE. Enum: String.trim() empty → null, else Enum.valueOf(trimmed),
//   case-sensitive.
//   A failed conversion → MethodArgumentTypeMismatchException 400 "Parâmetro inválido [nome: valor] ", where
//   valor is the raw text, or the String[] identity when the parameter was repeated.
// - @PathVariable Long: same conversion; blank → 400 "Required path variable 'x' is not present.".
// - @Pattern (Bean Validation inherited from the OpenAPI interface) → 400 "Validation failure", after
//   every argument has been resolved.
import { erroParametroAusente, erroValidacaoMetodo, ErroSpring, ErroTipoArgumento } from '../comum/problema.js';
import { javaIsBlank, javaIsWhitespace, javaTrim } from '../comum/java.js';
import { lerDataLocalizada, lerIsoDate, lerIsoLocalDate } from './datas.js';
import { localeDaRequisicao, padraoDataCurta } from './locale.js';

const LONG_MIN = -9223372036854775808n;
const LONG_MAX = 9223372036854775807n;

/** Object.toString() of the String[] Spring prints when a repeated parameter fails to convert. */
const identidadeArray = () => `[Ljava.lang.String;@${(Math.floor(Math.random() * 0x7fffffff) + 1).toString(16)}`;

/** Character.digit(ch, radix) for one UTF-16 unit: Unicode decimal digits, Latin and fullwidth Latin letters. */
export function digitoJava(ch, radix) {
  const c = ch.charCodeAt(0);
  let v = -1;
  if (c >= 0x30 && c <= 0x39) v = c - 0x30;
  else if (c >= 0x61 && c <= 0x7a) v = c - 0x61 + 10;
  else if (c >= 0x41 && c <= 0x5a) v = c - 0x41 + 10;
  else if (c >= 0xff41 && c <= 0xff5a) v = c - 0xff41 + 10;
  else if (c >= 0xff21 && c <= 0xff3a) v = c - 0xff21 + 10;
  else if (/^\p{Nd}$/u.test(ch)) {
    let inicio = c;
    while (inicio > 0 && /^\p{Nd}$/u.test(String.fromCharCode(inicio - 1))) inicio--;
    v = (c - inicio) % 10;
  }
  return v < radix ? v : -1;
}

/** Long.parseLong(s, radix) → BigInt, or null (NumberFormatException). */
function parseLongJava(s, radix) {
  if (s.length === 0) return null;
  let i = 0;
  let negativo = false;
  if (s[0] === '-' || s[0] === '+') {
    negativo = s[0] === '-';
    i = 1;
    if (s.length === 1) return null;
  }
  let v = 0n;
  const r = BigInt(radix);
  for (; i < s.length; i++) {
    const d = digitoJava(s[i], radix);
    if (d < 0) return null;
    v = v * r + BigInt(d);
    if (v > (negativo ? -LONG_MIN : LONG_MAX)) return null;
  }
  return negativo ? -v : v;
}

/** NumberUtils.parseNumber(text, Long.class) after the blank check. BigInt or null when it fails. */
export function converterLong(texto) {
  const t = [...texto].filter((c) => !javaIsWhitespace(c)).join('');
  const hex = /^(-?)(0x|0X|#)/.exec(t);
  if (!hex) return parseLongJava(t, 10);
  // Long.decode
  const resto = t.slice(hex[0].length);
  if (resto.startsWith('-') || resto.startsWith('+')) return null;
  const v = parseLongJava((hex[1] ? '-' : '') + resto, 16);
  return v === null || (resto.length === 0) ? null : v;
}

/** The request parameter values (Tomcat parsing) or null when absent. */
const valores = (ctx, nome) => ctx.parametros.valores(nome);

/** @RequestParam String. */
export function texto(ctx, nome, { obrigatorio = true } = {}) {
  const v = ctx.parametros.texto(nome);
  if (v === null && obrigatorio) throw erroParametroAusente(nome);
  return v;
}

/**
 * Shared flow of the single-value converters: first value, "empty" → null, failure → type mismatch.
 * Number and date converters treat Character.isWhitespace-only text as empty; the enum converter String.trim().
 */
function converter(ctx, nome, obrigatorio, conversor, vazio = javaIsBlank) {
  const vs = valores(ctx, nome);
  if (vs === null) {
    if (obrigatorio) throw erroParametroAusente(nome);
    return null;
  }
  const v0 = vs[0];
  if (vazio(v0)) {
    if (obrigatorio) throw erroParametroAusente(nome);
    return null;
  }
  const r = conversor(v0);
  if (r === null) throw new ErroTipoArgumento(nome, vs.length > 1 ? identidadeArray() : v0);
  return r;
}

/** @RequestParam Long → BigInt (null when optional and absent/blank). */
export function longo(ctx, nome, { obrigatorio = true } = {}) {
  return converter(ctx, nome, obrigatorio, converterLong);
}

/** @PathVariable Long → BigInt. */
export function longoCaminho(valor, nome) {
  if (javaIsBlank(valor)) throw new ErroSpring(400, `Required path variable '${nome}' is not present.`, {}, 'MissingPathVariableException');
  const r = converterLong(valor);
  if (r === null) throw new ErroTipoArgumento(nome, valor);
  return r;
}

/** @RequestParam LocalDate (iso: @DateTimeFormat(iso = ISO.DATE)) → DataLocal. */
export function data(ctx, nome, { obrigatorio = true, iso = false } = {}) {
  return converter(ctx, nome, obrigatorio, (t) => {
    if (iso) return lerIsoDate(t) ?? lerIsoLocalDate(t);
    return lerDataLocalizada(t, padraoDataCurta(localeDaRequisicao(ctx.req.headers))) ?? lerIsoLocalDate(t);
  });
}

/**
 * @RequestParam(required = false) enum (StringToEnumConverterFactory: source.trim() empty → null, else
 * Enum.valueOf(trimmed), case-sensitive) → the constant name or null.
 */
export function enumeracao(ctx, nome, constantes) {
  return converter(ctx, nome, false, (t) => {
    const c = javaTrim(t);
    return constantes.includes(c) ? c : null;
  }, (t) => javaTrim(t) === '');
}

/** @Pattern(regexp) on a String argument (Matcher.matches, ASCII \d): HandlerMethodValidationException. */
export function validarPadrao(valor, regex) {
  if (valor !== null && !regex.test(valor)) throw erroValidacaoMetodo();
}
