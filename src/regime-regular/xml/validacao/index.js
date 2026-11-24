// XmlService.validarXml(xml, tipo, subtipo): schema = XmlUtil.getSchema(tipo, subtipo) (the
// official XSD under src/regime-regular/xml/xsd/<mnemonico>/<grupo|nota>.xsd), then
// schema.newValidator().validate(StreamSource(StringReader(xml))) with the DraconianErrorHandler:
// the first error becomes ErroXmlException → 422 "Erro na validação do XML: Erro na linha L,
// coluna C: <mensagem>". No network, no external DTD/entity, no xsi:schemaLocation lookup.
import { ErroJava } from '../../comum/problema.js';
import { LeitorXml } from './leitor-xml.js';
import { Validador } from './validador.js';
import { obterEsquema } from './esquema.js';
import { ErroXml } from './mensagens.js';

/**
 * Validates `texto` against the schema of `tipo` (TipoDocumento) / `subtipo` (TipoXml).
 * Returns null when valid, else { linha, coluna, mensagem, semLocal, io }.
 */
export function validarDocumento(texto, tipo, subtipo) {
  const esquema = obterEsquema(tipo.mnemonico, subtipo.mnemonico);
  const validador = new Validador(esquema);
  const leitor = new LeitorXml(texto, validador);
  validador.leitor = leitor;
  try {
    leitor.analisar();
    return null;
  } catch (e) {
    if (e instanceof ErroXml) return { linha: e.linha, coluna: e.coluna, mensagem: e.message, semLocal: e.semLocal, io: e.io };
    throw e;
  }
}

/** ErroXmlException("Erro na validação do XML: %s") → 422 via ApiExceptionHandler (ValidacaoException). */
export function validarXml(texto, tipo, subtipo) {
  const r = validarDocumento(texto, tipo, subtipo);
  if (!r) return true;
  let detalhe = `Erro na linha ${r.linha}, coluna ${r.coluna}: ${r.mensagem}`;
  if (r.io) detalhe = `Erro de IO na validação de XML: ${r.mensagem}`;
  else if (r.semLocal) detalhe = r.mensagem;
  throw new ErroJava('ErroXmlException', `Erro na validação do XML: ${detalhe}`);
}
