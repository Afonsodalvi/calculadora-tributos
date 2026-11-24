// Exceptions raised by the request pipeline of the calculation endpoints (domain/service/exception/*),
// with the String.format messages of the Java constructors. Templates come from the catalogue extracted
// from the source (comum/codigos-regreg.json, "excecoes"), so the text has a single origin; the
// argument order follows each constructor (several format the date before the tributo).
// The engine's own exceptions live in motor/excecoes.js.
import CATALOGO from '../comum/codigos-regreg.json' with { type: 'json' };
import { ErroJava } from '../comum/problema.js';
import { javaFormat } from '../comum/java.js';
import { formatarMoeda, ESCALA_VALOR_FISCAL } from '../comum/arredondamento.js';

const modelo = (classe, nome = 'MESSAGE') => CATALOGO.excecoes[classe].constantes[nome];
/** super(String.format(MESSAGE, args…)). */
const formatada = (classe, ...args) => new ErroJava(classe, javaFormat(modelo(classe), ...args));
/** super(MESSAGE). */
const fixa = (classe) => new ErroJava(classe, modelo(classe));

// operation level
export const ufNaoEncontrada = (siglaUf) => formatada('UfNaoEncontradaException', siglaUf);
export const municipioNaoEncontrado = (id) => formatada('MunicipioNaoEncontradoException', id);
export const municipioNaoPertencente = (idMunicipio, siglaUf) => formatada('MunicipioNaoPertencenteException', idMunicipio, siglaUf);
export const tipoDfeNaoEncontrado = (tpDoc, data) => formatada('TipoDfeNaoEncontradoException', tpDoc, data);
/** TipoDfeNaoTratadoException(TipoDfe tipo): format(MESSAGE, tipo.getTipo(), tipo.getSigla()). */
export const tipoDfeNaoTratado = (tipoDfe) => formatada('TipoDfeNaoTratadoException', tipoDfe.tipo, tipoDfe.sigla);
/** DataFatoGeradorNaoInformadaException(): literal message (no constant in the class). */
export const dataFatoGeradorNaoInformada = () => new ErroJava('DataFatoGeradorNaoInformadaException', 'A data do fato gerador não foi informada.');
export const siglaDfeNaoEncontrada = (sigla) => formatada('SiglaDFeNaoEncontradaException', sigla);

// classification, situation, treatment
/** SituacaoTributariaNaoEncontradaException(codigo, tributo, data): format(MESSAGE, codigo, data, tributo). */
export const situacaoTributariaNaoEncontrada = (codigo, tributo, data) => formatada('SituacaoTributariaNaoEncontradaException', codigo, data, tributo);
/** ClassificacaoTributariaNaoEncontradaException(codigo, tributo, data): format(MESSAGE1, codigo, data, tributo). */
export const classificacaoTributariaNaoEncontrada = (codigo, tributo, data) => new ErroJava('ClassificacaoTributariaNaoEncontradaException',
  javaFormat(modelo('ClassificacaoTributariaNaoEncontradaException', 'MESSAGE1'), codigo, data, tributo));
export const tratamentoClassificacaoNaoEncontrado = (id, data) => formatada('TratamentoClassificacaoNaoEncontradoException', id, data);
export const classificacaoNaoVinculadaSituacao = (cClassTrib, cst, tributo) => formatada('ClassificacaoTributariaNaoVinculadaSituacaoTributariaException', cClassTrib, cst, tributo);
export const classificacaoNaoVinculadaTipoDfe = (cClassTrib, tpDoc, tributos) => formatada('ClassificacaoTributariaNaoVinculadaTipoDfeException', cClassTrib, tpDoc, tributos);
export const tributacaoRegularNaoInformada = (cClassTrib, cst) => formatada('TributacaoRegularNaoInformadaException', cClassTrib, cst);
/** Declared in the project; not raised by the current pipeline. */
export const tributacaoRegularInformadaIndevidamente = (cClassTrib, cst) => formatada('TributacaoRegularInformadaIndevidamenteException', cClassTrib, cst);
export const incompatibilidadeSuspensao = (cClassTrib, cst) => formatada('IncompatibilidadeSuspensaoException', cClassTrib, cst);

// nomenclature (NCM / NBS)
export const ncmNaoEncontrada = (ncm, data) => formatada('NcmNaoEncontradaException', ncm, data);
export const nbsNaoEncontrada = (nbs, data) => formatada('NbsNaoEncontradaException', nbs, data);
export const ncmNbsSimultaneas = () => fixa('NcmNbsSimultaneasException');
export const ncmNaoVinculada = (ncm, cClassTrib, tributo) => formatada('NcmNaoVinculadaException', ncm, cClassTrib, tributo);
export const nbsNaoVinculada = (nbs, cClassTrib, tributo) => formatada('NbsNaoVinculadaException', nbs, cClassTrib, tributo);
export const ncmCompletoNaoInformado = () => fixa('NcmCompletoNaoInformadoException');
export const nbsCompletoNaoInformado = () => fixa('NbsCompletoNaoInformadoException');
export const nomenclaturaIncompativelTipoDfe = (nomenclatura, cClassTrib, siglaDfe) => formatada('NomenclaturaIncompativelTipoDfeException', nomenclatura, cClassTrib, siglaDfe);
export const nomenclaturaNaoPermitidaTipoDfe = (cClassTrib, siglaDfe) => formatada('NomenclaturaNaoPermitidaTipoDfeException', cClassTrib, siglaDfe);
export const nomenclaturaObrigatoriaNaoInformada = (cClassTrib, siglaDfe) => formatada('NomenclaturaObrigatoriaNaoInformadaException', cClassTrib, siglaDfe);
/** NomenclaturaException(mensagem): super(String.format(mensagem)) — a format string without arguments. Not raised today. */
export const nomenclatura = (mensagem) => new ErroJava('NomenclaturaException', javaFormat(mensagem));

// Imposto Seletivo and nominal rates
export const impostoSeletivoNaoInformado = (tipoNomenclatura, codigoNomenclatura, data) => formatada('ImpostoSeletivoNaoInformadoException', tipoNomenclatura, codigoNomenclatura, data);
/** Declared in the project; not raised by the current pipeline. */
export const impostoSeletivoInformadoIndevidamente = (ncm, data) => formatada('ImpostoSeletivoInformadoIndevidamenteException', ncm, data);
export const impostoSeletivoNaoAdmitidoTipoDfe = (tpDoc, nomenclatura, codigo) => formatada('ImpostoSeletivoNaoAdmitidoTipoDfeException', tpDoc, nomenclatura, codigo);
export const aliquotaImpostoSeletivoNaoInformada = (tipoNomenclatura, codigoNomenclatura, data) => formatada('AliquotaImpostoSeletivoNaoInformadaException', tipoNomenclatura, codigoNomenclatura, data);
/** AliquotaAdRemNaoEncontradaException(ncm, idTributo, data): format(MESSAGE, ncm, data, idTributo). Not raised today. */
export const aliquotaAdRemNaoEncontrada = (ncm, idTributo, data) => formatada('AliquotaAdRemNaoEncontradaException', ncm, data, idTributo);
export const aliquotasNominaisNaoInformadas = () => fixa('AliquotasNominaisNaoInformadasException');
export const aliquotasNominaisInformadasIndevidamente = () => fixa('AliquotasNominaisInformadasIndevidamenteException');

// calculation base
export const baseCalculoNaoInformada = () => fixa('BaseCalculoNaoInformadaException');
export const baseCalculoInconsistente = (baseCalculo, baseIS, impostoInformado) => formatada('BaseCalculoInconsistenteException', baseCalculo, baseIS, impostoInformado);
export const baseCalculoMenorBaseIS = (baseCalculo, baseIS) => formatada('BaseCalculoMenorBaseCalculoImpostoSeletivoException', baseCalculo, baseIS);
/**
 * BaseCalculoComponentesInconsistenteException(declarada, calculada): each value with 2 decimals when it
 * fits in 2 (formatarMoeda), otherwise with all its decimals (toPlainString).
 */
export function baseCalculoComponentesInconsistente(declarada, calculada) {
  const texto = (v) => (v.stripTrailingZeros().scale() <= ESCALA_VALOR_FISCAL ? formatarMoeda(v) : v.toPlainString());
  return formatada('BaseCalculoComponentesInconsistenteException', texto(declarada), texto(calculada));
}

// generic
export const erroGenericoValidacao = (mensagem) => new ErroJava('ErroGenericoValidacaoException', mensagem);
export const campoInvalido = (mensagem) => new ErroJava('CampoInvalidoException', mensagem);
export const erroInternoSistema = (mensagem) => new ErroJava('ErroInternoSistemaException', mensagem);
