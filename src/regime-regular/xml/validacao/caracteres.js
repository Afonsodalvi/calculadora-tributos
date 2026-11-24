// Character classes of the JDK Xerces scanners (XMLChar / XML11Char), shared by the document
// scanner (leitor-xml.js) and the internal-subset DTD scanner (dtd.js).

export const ehEspaco = (c) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d;
export const ehAlta = (c) => c >= 0xd800 && c <= 0xdbff;
export const ehBaixa = (c) => c >= 0xdc00 && c <= 0xdfff;
export const hex = (c) => c.toString(16);

/** XMLChar.isValid (1.0) for a UTF-16 unit (surrogates are handled in pairs by the callers). */
export function ehValido10(c) {
  return c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd);
}
/** XML11Char.isXML11Valid: 1.1 also accepts #x1-#x1F (only as references) — literal use is checked by ehLiteral11. */
export function ehValido11(c) {
  return (c >= 0x01 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd);
}
/** XML 1.1 characters that may appear literally (C0 controls other than tab/LF/CR and C1 controls must be escaped). */
export function ehLiteral11(c) {
  return c === 0x09 || c === 0x0a || c === 0x0d || c === 0x85 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd);
}

const RE_INICIO_NOME = /[\p{L}\p{Nl}_]/u;
const RE_NOME = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Lm}\p{Pc}··ːˑـๆໆ々〱-〵ゝゞー-ヾ._\-]/u;

/** Name start char (colon handled by the QName scanner). */
export function ehInicioNome(c, comDoisPontos = true) {
  if (c < 0) return false;
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f) return true;
  if (c === 0x3a) return comDoisPontos;
  if (c < 0xc0) return false;
  return RE_INICIO_NOME.test(String.fromCodePoint(c));
}

export function ehNome(c, comDoisPontos = true) {
  if (c < 0) return false;
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d || c === 0x2e) return true;
  if (c === 0x3a) return comDoisPontos;
  if (c === 0xb7) return true;
  if (c < 0xc0) return false;
  return RE_NOME.test(String.fromCodePoint(c));
}

/** XMLChar.isValidNCName. */
export function ehNCName(s) {
  if (!s) return false;
  const cps = [...s].map((x) => x.codePointAt(0));
  if (!ehInicioNome(cps[0], false)) return false;
  return cps.every((c) => ehNome(c, false));
}

/** XMLChar.isPubid: PubidChar of the public identifier literal. */
export function ehPubid(c) {
  return c === 0x20 || c === 0x0d || c === 0x0a || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)
    || "-'()+,./:=?;!*#@$_%".includes(String.fromCharCode(c));
}
