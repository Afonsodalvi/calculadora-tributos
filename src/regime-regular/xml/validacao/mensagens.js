// Messages of the JDK 25 internal Xerces (com.sun.org.apache.xerces.internal.impl.msg) in the
// locale of the official API (pt_BR, falling back to the base English bundle like
// ResourceBundle does): XMLMessages (well-formedness, XMLMessageFormatter) and
// XMLSchemaMessages (cvc-*, XSMessageFormatter). Extracted from lib/modules of the JDK
// (.work/spec/regreg/xml-tools/extract-xerces-messages.mjs).
import XML_MENSAGENS from './mensagens/XMLMessages.json' with { type: 'json' };
import ESQUEMA_MENSAGENS from './mensagens/XMLSchemaMessages.json' with { type: 'json' };

/** Number formatting of MessageFormat in pt_BR (grouping '.'), for the rare numeric argument. */
const formatarNumero = (n) => (typeof n === 'bigint' ? n : BigInt(Math.trunc(n))).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * java.text.MessageFormat.format(padrao, args) for the patterns of these bundles: quotes ('' is a
 * literal quote, '...' a quoted run) and simple {n} arguments (String as is, null → "null").
 */
export function formatarMensagem(padrao, args) {
  let saida = '';
  let i = 0;
  const n = padrao.length;
  while (i < n) {
    const c = padrao[i];
    if (c === "'") {
      if (padrao[i + 1] === "'") { saida += "'"; i += 2; continue; }
      const fim = padrao.indexOf("'", i + 1);
      if (fim < 0) { saida += padrao.slice(i + 1); break; }
      saida += padrao.slice(i + 1, fim);
      i = fim + 1;
      continue;
    }
    if (c === '{') {
      const fim = padrao.indexOf('}', i + 1);
      const indice = fim < 0 ? NaN : Number(padrao.slice(i + 1, fim).trim());
      if (!Number.isInteger(indice)) throw new Error(`padrão MessageFormat não suportado: ${padrao}`);
      const v = args[indice];
      if (indice >= args.length) saida += `{${indice}}`;
      else saida += v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'bigint' ? formatarNumero(v) : String(v);
      i = fim + 1;
      continue;
    }
    saida += c;
    i++;
  }
  return saida;
}

/** XMLMessageFormatter / XSMessageFormatter.formatMessage: MessageFormat only when there are arguments. */
function formatar(bundle, chave, args) {
  const padrao = bundle[chave];
  if (padrao === undefined) return formatar(bundle, 'BadMessageKey', null);
  if (args == null) return padrao;
  try {
    return formatarMensagem(padrao, args);
  } catch {
    return `${bundle.FormatFailed} ${padrao}`;
  }
}

/** Well-formedness message (domain http://www.w3.org/TR/1998/REC-xml-19980210). */
export const mensagemXml = (chave, args = null) => formatar(XML_MENSAGENS, chave, args);

/** Schema validation message (domain http://www.w3.org/TR/xml-schema-1). */
export const mensagemEsquema = (chave, args = null) => formatar(ESQUEMA_MENSAGENS, chave, args);

/**
 * SAXParseException raised through the DraconianErrorHandler: the first error stops the
 * validation. linha/coluna are the locator values (-1 when the entity is already closed).
 */
export class ErroXml extends Error {
  constructor(linha, coluna, mensagem, { semLocal = false, io = false } = {}) {
    super(mensagem);
    this.name = 'ErroXml';
    this.linha = linha;
    this.coluna = coluna;
    /** true for a plain SAXException/RuntimeException (no "Erro na linha" prefix). */
    this.semLocal = semLocal;
    /** true for an IOException (XmlService: "Erro de IO na validação de XML: " + message). */
    this.io = io;
  }
}
