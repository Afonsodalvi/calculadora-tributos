// Official routes of the calculation slice (calculadora-rtc-regime-regular 1.7.2):
//   POST /api/calculadora/regime-geral                     — CalculadoraTributoController.calcularTributos
//   POST /api/calculadora/observabilidade/regime-geral     — ObservabilidadeController.calcularTributosObservabilidade
//   GET  /api/calculadora/observabilidade/erros?codigo=X   — ObservabilidadeController.buscarErro
// Both POST mappings: consumes = produces = application/json. Body read with the Jackson-compatible
// reader (comum/json.js); errors answered like ApiExceptionHandler / ObservabilidadeExceptionHandler.
// 200 responses carry X-CALC-APP-VERSION, X-CALC-DB-VERSION and, when applicable,
// x-warning-dados-simulados (computed after the calculation, from the possibly mutated input).
import { escreverJson } from '../comum/json.js';
import {
  ErroJava, ErroSpring, ErroSerializacao, ErroValidacaoCorpo, cabecalhosVersao, erroDescricao, erroParametroAusente, respostaFalhaEscrita,
} from '../comum/problema.js';
import { caminhoCru, respostaDeErro } from '../comum/spring.js';
import { lerOperacao, ASSINATURA_REGIME_GERAL, ASSINATURA_OBSERVABILIDADE } from './entrada.js';
import { validar, interpolar, localeDaRequisicao } from './validacao.js';
import { criarProcessamento, avisoDadosSimulados } from './processamento.js';
import { rocJson, observabilidadeJson } from './roc.js';
import { ErroHttp } from '../../http/roteador.js';
import { registrarErro } from '../../http/seguranca.js';

/** Largest request body accepted (the Java API has no limit; the app needs one). */
const LIMITE_CORPO = 16 * 1024 * 1024;

/**
 * Port limit (documented divergence, like LIMITE_ESCALA): items per operation, ~10x the NF-e
 * maximum of 990. Java answers any count, but each item costs ~0.5 KB of output built in memory,
 * so a few MB of `{}` items would block the event loop for seconds. Checked after binding (bodies
 * Jackson rejects keep the Java answer) and before validation/calculation: 413 {"erro": "..."}.
 */
export const LIMITE_ITENS_OPERACAO = 10000;

function verificarItens(operacao) {
  const n = operacao?.itens?.length ?? 0;
  if (n > LIMITE_ITENS_OPERACAO) {
    throw new ErroHttp(413, `Operação com ${n} itens: esta implementação aceita até ${LIMITE_ITENS_OPERACAO} itens por operação (a NF-e admite 990).`);
  }
}

const JSON_ = ['application/json'];
const OPCOES_POST = { oficial: 'regime-regular', consome: JSON_, produz: JSON_ };

export function registrar(r, deps) {
  const proc = criarProcessamento(deps.base);
  /** Serializer of the item tribCalc (the engine's TributosDomain → Jackson tree). */
  const motor = proc.obterMotor();
  const serializarTributos = (t) => motor.serializarTributos(t);

  /** Success response: headers of VersaoAplicacaoService + warning; a serializer failure keeps them (500). */
  function respostaRoc(ctx, operacao, montarJson) {
    const headers = cabecalhosVersao(deps.base);
    const aviso = avisoDadosSimulados(operacao);
    if (aviso != null) headers['x-warning-dados-simulados'] = String(aviso.valor);
    let body;
    try {
      body = escreverJson(montarJson(serializarTributos));
    } catch (e) {
      if (e instanceof ErroSerializacao) return respostaFalhaEscrita(instancia(ctx), headers);
      throw e;
    }
    return { status: 200, tipo: 'application/json', headers, body };
  }

  r.post('/api/calculadora/regime-geral', comErros(async (ctx) => {
    const operacao = lerOperacao(await ctx.corpo(LIMITE_CORPO), { charset: ctx.charset, assinatura: ASSINATURA_REGIME_GERAL });
    verificarItens(operacao);
    // @Valid @RequestBody → MethodArgumentNotValidException (messages in the request locale)
    const violacoes = validar(operacao, 'OperacaoInput');
    if (violacoes.length) {
      const locale = localeDaRequisicao(ctx.req.headers['accept-language']);
      throw new ErroValidacaoCorpo(violacoes.map((v) => [v.caminho, interpolar(v.restricao, locale)]));
    }
    const roc = await proc.calcularTributos(operacao);
    return respostaRoc(ctx, operacao, (ser) => rocJson(roc, ser));
  }), OPCOES_POST);

  r.post('/api/calculadora/observabilidade/regime-geral', comErros(async (ctx) => {
    const operacao = lerOperacao(await ctx.corpo(LIMITE_CORPO), { charset: ctx.charset, assinatura: ASSINATURA_OBSERVABILIDADE });
    verificarItens(operacao);
    const locale = localeDaRequisicao(ctx.req.headers['accept-language']);
    const roc = await proc.processarOperacao(operacao, ctx.baseURL, locale);
    return respostaRoc(ctx, operacao, (ser) => observabilidadeJson(roc, ser));
  }), OPCOES_POST);

  // ErroService.buscarPorCodigo: 200 ErroDescricao, or 404 without body
  r.get('/api/calculadora/observabilidade/erros', comErros((ctx) => {
    const codigo = ctx.parametros.texto('codigo');
    if (codigo === null) throw erroParametroAusente('codigo');
    const descricao = erroDescricao(codigo);
    if (descricao == null) return { status: 404, body: null };
    return { status: 200, tipo: 'application/json', body: escreverJson(descricao) };
  }), { oficial: 'regime-regular', produz: JSON_ });
}

const instancia = (ctx) => ctx.instance ?? caminhoCru(ctx.req?.url ?? ctx.url?.pathname);

/**
 * Answers the official error bodies inside the handler too, so in-process callers
 * (regime-regular/aplicacao.js) get the same response as an HTTP client. Body-size errors (413)
 * are left to the router.
 */
function comErros(handler) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (e) {
      if (e?.status === 413 && !(e instanceof ErroJava)) throw e;
      if (!(e instanceof ErroJava) && !(e instanceof ErroSpring)) registrarErro(e);
      return respostaDeErro(e, { estilo: ctx.estilo ?? 'regime-regular', instance: instancia(ctx), baseURL: ctx.baseURL });
    }
  };
}
