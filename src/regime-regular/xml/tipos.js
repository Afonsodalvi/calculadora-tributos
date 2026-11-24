// Enums of the XML area (api/model/xml/enumeration) and the Spring conversion of the query
// parameters `tipo` / `subtipo` (TipoDocumentoConverter, TipoXmlConverter + TypeConverterDelegate).
import { javaEqualsIgnoreCase, javaTrim } from '../comum/java.js';
import { erroParametroAusente, ErroTipoArgumento } from '../comum/problema.js';

/**
 * TipoDocumento in declaration order: constante (enum name), mnemonico (@JsonValue), nome,
 * versaoNotaTecnica, geracao, validacao.
 */
export const TIPOS_DOCUMENTO = Object.freeze([
  { constante: 'NFE', mnemonico: 'nfe', nome: 'NFe', versaoNotaTecnica: 'v1.36', geracao: true, validacao: true },
  { constante: 'NFCE', mnemonico: 'nfce', nome: 'NFCe', versaoNotaTecnica: 'v1.36', geracao: true, validacao: true },
  { constante: 'NFSE', mnemonico: 'nfse', nome: 'NFSe', versaoNotaTecnica: 'v1.01.03 - NT004', geracao: false, validacao: true },
  { constante: 'CTE', mnemonico: 'cte', nome: 'CTe', versaoNotaTecnica: 'v1.14a', geracao: true, validacao: true },
  { constante: 'CTE_SIMPLIFICADO', mnemonico: 'cte-simplificado', nome: 'CTe Simplificado', versaoNotaTecnica: 'v1.14a', geracao: true, validacao: true },
  { constante: 'BPE', mnemonico: 'bpe', nome: 'BPe', versaoNotaTecnica: 'v1.14a', geracao: true, validacao: true },
  { constante: 'BPE_TM', mnemonico: 'bpe-tm', nome: 'BPeTM', versaoNotaTecnica: 'v1.14a', geracao: true, validacao: true },
  { constante: 'NF3E', mnemonico: 'nf3e', nome: 'NF3E', versaoNotaTecnica: 'v1.14a', geracao: true, validacao: true },
].map(Object.freeze));

/** TipoXml: the "mnemonico" is the XSD file name of the entry point. */
export const TIPOS_XML = Object.freeze([
  Object.freeze({ constante: 'GRUPO', mnemonico: 'grupo.xsd' }),
  Object.freeze({ constante: 'NOTA', mnemonico: 'nota.xsd' }),
]);

/** TipoDocumento.getDocumentosGeracao()/getDocumentosValidacao(): TipoDocumentoDTO(nome, mnemonico, versaoNotaTecnica). */
const dto = (t) => ({ nome: t.nome, mnemonico: t.mnemonico, versaoNotaTecnica: t.versaoNotaTecnica });
export const DOCUMENTOS_GERACAO = Object.freeze(TIPOS_DOCUMENTO.filter((t) => t.geracao).map(dto));
export const DOCUMENTOS_VALIDACAO = Object.freeze(TIPOS_DOCUMENTO.filter((t) => t.validacao).map(dto));

/** IllegalArgumentException thrown by a converter (its message never reaches the client). */
class ErroConversor extends Error {}

/** TipoDocumento.fromMnemonico (TipoDocumentoConverter). */
export function tipoDocumentoDoMnemonico(fonte) {
  if (fonte == null || javaTrim(fonte) === '') throw new ErroConversor('Mnemonico não pode ser nulo ou vazio');
  const t = TIPOS_DOCUMENTO.find((x) => javaEqualsIgnoreCase(x.mnemonico, fonte));
  if (!t) throw new ErroConversor(`Tipo de documento inválido: ${fonte}`);
  return t;
}

/** TipoXmlConverter: EnumUtils.getEnumIgnoreCase(TipoXml.class, source) (by constant NAME). */
export function tipoXmlDoTexto(fonte) {
  const t = fonte == null ? null : TIPOS_XML.find((x) => javaEqualsIgnoreCase(x.constante, fonte));
  if (!t) throw new ErroConversor(`TipoXml inválido: ${fonte}`);
  return t;
}

/**
 * @RequestParam <Enum> resolution as Spring does it (AbstractNamedValueMethodArgumentResolver +
 * TypeConverterDelegate): absent → 400 "Required parameter"; one value → the @Component converter,
 * and when it fails the default fallback of TypeConverterDelegate: trimmed "" → null ("Required
 * parameter" after conversion), trimmed text equal to a constant NAME (Class.getField) → that
 * constant; otherwise 400 MethodArgumentTypeMismatchException with the raw value. Two or more
 * values: ArrayToObjectConverter converts the first one; on failure the String[] has no fallback
 * and the detail prints its identity "[Ljava.lang.String;@hash" (not deterministic in Java).
 */
export function resolverParametroEnum(parametros, nome, conversor, constantes) {
  const valores = parametros.valores(nome);
  if (valores == null) throw erroParametroAusente(nome);
  try {
    return conversor(valores[0]);
  } catch (e) {
    if (!(e instanceof ErroConversor)) throw e;
  }
  if (valores.length > 1) throw new ErroTipoArgumento(nome, `[Ljava.lang.String;@${Math.floor(Math.random() * 0x7fffffff).toString(16)}`);
  const aparado = javaTrim(valores[0]);
  if (aparado === '') throw erroParametroAusente(nome);
  const porNome = constantes.find((c) => c.constante === aparado);
  if (porNome) return porNome;
  throw new ErroTipoArgumento(nome, valores[0]);
}

export const parametroTipoDocumento = (parametros) => resolverParametroEnum(parametros, 'tipo', tipoDocumentoDoMnemonico, TIPOS_DOCUMENTO);
export const parametroTipoXml = (parametros) => resolverParametroEnum(parametros, 'subtipo', tipoXmlDoTexto, TIPOS_XML);
