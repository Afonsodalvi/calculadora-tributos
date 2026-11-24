// Exceptions thrown by the calculation engine (domain/service/exception/*), with the exact
// String.format messages of the Java constructors. Templates come from the catalogue extracted
// from the source (comum/codigos-regreg.json, "excecoes"), so the text has a single origin.
import CATALOGO from '../../comum/codigos-regreg.json' with { type: 'json' };
import { ErroJava } from '../../comum/problema.js';
import { javaFormat } from '../../comum/java.js';

const constante = (classe, nome) => CATALOGO.excecoes[classe].constantes[nome];
const erro = (classe, nome, ...args) => new ErroJava(classe, javaFormat(constante(classe, nome), ...args));

export const tratamentoTributarioNaoEncontrado = (id) => erro('TratamentoTributarioNaoEncontradoException', 'MESSAGE', id);
export const classificacaoTributariaNaoEncontradaPorId = (id) => erro('ClassificacaoTributariaNaoEncontradaException', 'MESSAGE2', id);
/** ClassificacaoTributariaNaoEncontradaException(codigo, tributo, data): note the argument order of the format (codigo, data, tributo). */
export const classificacaoTributariaNaoEncontrada = (codigo, tributo, data) => erro('ClassificacaoTributariaNaoEncontradaException', 'MESSAGE1', codigo, data, tributo);
export const erroFaltaImplementacao = (codigo) => erro('ErroFaltaImplementacaoException', 'MESSAGE', codigo);
export const percentualReducaoNaoEncontrado = (idClassificacao, data) => erro('PercentualReducaoNaoEncontradoException', 'MESSAGE', idClassificacao, data);
export const aliquotaNaoEncontrada = (idTributo, codigoUf, municipio, data) => erro('AliquotaNaoEncontradaException', 'MESSAGE', idTributo, codigoUf, municipio, data);
export const aliquotaReferenciaNaoEncontrada = (idTributo, data) => (idTributo === undefined
  ? erro('AliquotaReferenciaNaoEncontradaException', 'DEFAULT_MESSAGE')
  : erro('AliquotaReferenciaNaoEncontradaException', 'MESSAGE', idTributo, data));
export const aliquotaPadraoNaoEncontrada = () => erro('AliquotaPadraoNaoEncontradaException', 'DEFAULT_MESSAGE');
/** AliquotaNegativaException(tipo): "referencia" | "padrao" | "aplicavel" | other → default message. */
export function aliquotaNegativa(tipo) {
  const nome = { referencia: 'MESSAGE_REFERENCIA', padrao: 'MESSAGE_PADRAO', aplicavel: 'MESSAGE_APLICAVEL' }[tipo] ?? 'DEFAULT_MESSAGE';
  return erro('AliquotaNegativaException', nome);
}
export const formaAplicacaoNaoDefinida = () => erro('FormaAplicacaoNaoDefinidaException', 'MESSAGE');
export const formaAplicacaoNaoTratada = () => erro('FormaAplicacaoNaoTratadaException', 'MESSAGE');
export const erroGenericoValidacao = (mensagem) => new ErroJava('ErroGenericoValidacaoException', mensagem);
export const tipoAliquotaDesconhecido = (tipo, cClassTrib, cst) => erro('TipoAliquotaDesconhecidoException', 'MESSAGE', tipo, cClassTrib, cst);
export const fundamentacaoNaoEncontrada = (idClassificacao, data) => erro('FundamentacaoClassificacaoNaoEncontradaException', 'MESSAGE', idClassificacao, data);
/** ErroAvaliadorExpressaoAritmeticaException: declared in the project, never thrown by the engine. */
export const erroAvaliadorExpressao = (detalhe) => erro('ErroAvaliadorExpressaoAritmeticaException', 'MESSAGE', detalhe);
/** java.lang.RuntimeException(message). */
export const runtime = (mensagem) => new ErroJava('RuntimeException', mensagem);
/** Objects.requireNonNull(x, message) / unboxing of a null Boolean. */
export const nullPointer = (mensagem = null) => new ErroJava('NullPointerException', mensagem);

/**
 * IncorrectResultSizeDataAccessException (Spring) of a single-result repository method that found
 * more than one row (Hibernate NonUniqueResultException message).
 */
export const resultadoNaoUnico = (n) => new ErroJava('IncorrectResultSizeDataAccessException', `Query did not return a unique result: ${n} results were returned`);
