// Official routes of calculadora-rtc-regime-regular for this slice (xml) — XMLController:
//   GET  /api/calculadora/xml/generate               — TipoDocumento.getDocumentosGeracao()
//   GET  /api/calculadora/xml/validate               — TipoDocumento.getDocumentosValidacao()
//   POST /api/calculadora/xml/generate?tipo=         — ROC JSON → XML of the DFe group (JAXB output)
//   POST /api/calculadora/xml/validate?tipo=&subtipo= — XML text validated against the official XSD
// Argument resolution order of Spring: the @RequestBody first, then the @RequestParam's in order.
import { cabecalhosVersao, ErroJava } from '../comum/problema.js';
import { escreverJson, lerCorpoRequisicao } from '../comum/json.js';
import { decodificarCharsetJava } from './charset-java.js';
import { DOCUMENTOS_GERACAO, DOCUMENTOS_VALIDACAO, parametroTipoDocumento, parametroTipoXml } from './tipos.js';
import { vincularRoc, ASSINATURA_GENERATE, TIPO_JAVA_ROC } from './roc.js';
import { gerarXml, utf8Java } from './geracao.js';
import { validarXml } from './validacao/index.js';

const OFICIAL = { oficial: 'regime-regular' };
const JSON_TIPO = 'application/json';
/** Neither Tomcat nor Spring limit these bodies; the app keeps a generous cap (413 above it). */
const LIMITE_CORPO = 16 * 1024 * 1024;

const ASSINATURA_VALIDATE = 'public org.springframework.http.ResponseEntity<java.lang.Boolean> br.gov.serpro.rtc.api.controller.XMLController.validate(java.lang.String,br.gov.serpro.rtc.api.model.xml.enumeration.TipoDocumento,br.gov.serpro.rtc.api.model.xml.enumeration.TipoXml)';

/**
 * @RequestBody String (StringHttpMessageConverter): charset of the Content-Type, else UTF-8;
 * malformed input becomes U+FFFD (the JDK decoder in REPLACE mode). 0 bytes → "Required request body is missing".
 */
export function lerCorpoTexto(bytes, charset) {
  if (!bytes || bytes.length === 0) throw new ErroJava('HttpMessageNotReadableException', `Required request body is missing: ${ASSINATURA_VALIDATE}`);
  return decodificarCharsetJava(bytes, charset);
}

export function registrar(r, deps) {
  r.get('/api/calculadora/xml/generate', async () => ({ status: 200, tipo: JSON_TIPO, body: escreverJson(DOCUMENTOS_GERACAO) }), { ...OFICIAL, produz: [JSON_TIPO] });

  r.get('/api/calculadora/xml/validate', async () => ({ status: 200, tipo: JSON_TIPO, body: escreverJson(DOCUMENTOS_VALIDACAO) }), { ...OFICIAL, produz: [JSON_TIPO] });

  r.post('/api/calculadora/xml/generate', async (ctx) => {
    const bytes = await ctx.corpo(LIMITE_CORPO);
    const roc = lerCorpoRequisicao(bytes, { charset: ctx.charset, assinatura: ASSINATURA_GENERATE, tipoJava: TIPO_JAVA_ROC, vincular: vincularRoc });
    const tipo = parametroTipoDocumento(ctx.parametros);
    const xml = gerarXml(roc, tipo);
    // headers are built after the XML (an empty VERSAO_BASE_DADO fails only here)
    const headers = cabecalhosVersao(deps.base);
    return { status: 200, tipo: 'application/xml;charset=UTF-8', headers, body: utf8Java(xml) };
  }, { ...OFICIAL, consome: [JSON_TIPO], produz: ['application/xml'] });

  r.post('/api/calculadora/xml/validate', async (ctx) => {
    const texto = lerCorpoTexto(await ctx.corpo(LIMITE_CORPO), ctx.charset);
    const tipo = parametroTipoDocumento(ctx.parametros);
    const subtipo = parametroTipoXml(ctx.parametros);
    validarXml(texto, tipo, subtipo);
    return { status: 200, tipo: JSON_TIPO, body: 'true' };
  }, { ...OFICIAL, consome: ['application/xml'], produz: [JSON_TIPO] });
}
