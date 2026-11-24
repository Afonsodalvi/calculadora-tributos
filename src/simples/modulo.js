// Simples Nacional module.
//  - App routes (/api/simples/*): DAS by LC 123 + CBS/IBS simulation from the invoices.
//  - Official contract (/api/calculadora/... and /api/versao): same requests/responses as the
//    Receita Federal API calculadora-rtc-simples-nacional 1.0.2 (context path /api), including
//    the Spring/Tomcat behaviour (headers, ProblemDetail errors, parameter binding) — rtc/spring.js.
//  - GET /api/versao/status of the Simples API is NOT registered: the regime-regular API serves the
//    same path with another body (VersaoOfflineDomain 1.7.2), so that path belongs to that module.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './rtc/db.js';
import { createEngine } from './rtc/engine.js';
import { criarAtividadeSimplesService, converterAnexos, serializarAtividade } from './rtc/atividades.js';
import { criarVersaoService, VERSAO_APLICACAO } from './rtc/versao.js';
import { lerCorpoJson, TIPOS, ASSINATURAS } from './rtc/jackson.js';
import {
  respostaJson, respostaProblema, respostaVazia, respostaDeExcecao, escreverJson, requestUri, parametros,
  paramString, paramLista, paramStringObrigatorio, paramDataObrigatoria, dataSql, verificarConsumes, verificarProduces,
} from './rtc/spring.js';
import { criarDas } from './das.js';
import { calcular, verificarLimites } from './calculo.js';
import { ErroHttp } from '../http/roteador.js';
import { ATIVIDADES } from './atividades.js';
import { marcarEmitentesDiferentes, marcarSubstituidas } from '../notas/notas.js';
import CODIGOS from './rtc/codigos.json' with { type: 'json' };

const OFICIAL = '/api/calculadora/observabilidade/simples-nacional';
const ATIVIDADES_OFICIAL = '/api/calculadora/simples-nacional/atividades';
/** Version of the official API this module reproduces (headers X-CALC-APP-VERSION). */
export const VERSAO_OFICIAL_SIMPLES = VERSAO_APLICACAO;
const PORCODIGO = new Map(Object.values(CODIGOS).map((c) => [c.code, c]));

/**
 * Port limit (documented divergence, like LIMITE_ESCALA of the regime-regular port): items per
 * operation, ~10x the NF-e maximum of 990. Java answers any count, but each item costs ~1.1 KB of
 * output built in memory (650k `{}` items = 9 s of blocked event loop, then a 500). Checked after
 * binding (bodies Jackson rejects keep the Java answer) and before the calculation: 413 {"erro"}.
 */
export const LIMITE_ITENS_OPERACAO = 10000;

/** Runs an official handler; any exception becomes the response ApiExceptionHandler would write. */
async function executar(ctx, fn) {
  try {
    return await fn();
  } catch (ex) {
    if (ex instanceof ErroHttp) throw ex; // app limits (413 body too large) stay app answers
    return respostaDeExcecao(ex, ctx);
  }
}

export function moduloSimples({ base, raiz }) {
  const db = openDb(base);
  const engine = createEngine(db);
  const tabelas = JSON.parse(readFileSync(join(raiz, 'data', 'anexos.json'), 'utf8'));
  const das = criarDas(tabelas);
  const versao = criarVersaoService(base);

  // AtividadeSimplesService with its repositories (dates bound as the SQLite driver binds a LocalDate)
  const atividades = criarAtividadeSimplesService({
    atividadeRepository: {
      buscarVigentes: (data) => db.buscarAtividadesVigentes(dataSql(data)),
      buscarVinculosTpDocVigentes: (data) => db.buscarVinculosTpDocVigentes(dataSql(data)),
      contarTiposDfePorTipo: (tpDoc) => db.contarTiposDfePorTipo(tpDoc),
    },
    classificacaoTributariaRepository: { buscarVigentes: (codigo, data) => db.buscarClassificacoesVigentes(codigo, dataSql(data)) },
    parametroService: {
      buscarTipoReceitaBruta: (tpRBSN, data) => {
        const r = db.buscarTipoReceitaBruta(tpRBSN, null, dataSql(data));
        return r && { codigo: Number(r.codigo), descricao: r.descricao, vedadoNaoTributavel: Number(r.vedadoNaoTributavel) === 1 };
      },
    },
  });

  /** SimplesNacionalController POST handlers: consumes/produces, @RequestBody (Jackson), service. */
  const calculoOficial = (tipo, assinatura, calcular) => (ctx) => executar(ctx, async () => {
    verificarConsumes(ctx.req);
    verificarProduces(ctx.req);
    const operacao = lerCorpoJson(await ctx.corpo(), tipo, assinatura);
    const itens = operacao.itens?.length ?? 0;
    if (itens > LIMITE_ITENS_OPERACAO) {
      throw new ErroHttp(413, `Operação com ${itens} itens: esta implementação aceita até ${LIMITE_ITENS_OPERACAO} itens por operação (a NF-e admite 990).`);
    }
    const res = calcular(operacao, { baseURL: ctx.baseURL, instance: requestUri(ctx) });
    if (res.status === 200) return respostaJson(200, escreverJson(res.body), versao.headers());
    return respostaProblema(res.status, escreverJson(res.body));
  });

  /** AtividadeSimplesController.buscarAtividade (GET atividades/{codigo}). */
  const buscarAtividade = (ctx) => executar(ctx, () => {
    verificarProduces(ctx.req);
    const codigo = ctx.params[0];
    const params = parametros(ctx);
    const data = paramDataObrigatoria(params, 'data');
    const tpDoc = paramString(params, 'tpDoc');
    const cClassTrib = paramString(params, 'cClassTrib');
    const atividade = atividades.buscarPorCodigo(codigo, data, tpDoc, cClassTrib);
    return atividade ? respostaJson(200, escreverJson(serializarAtividade(atividade)), versao.headers()) : respostaVazia(404);
  });

  return {
    id: 'simples',
    nome: 'Simples Nacional',
    engine,
    das,
    registrar(r) {
      r.get('/api/simples/info', () => ({
        status: 200,
        body: { atividades: ATIVIDADES, periodos: tabelas.periodos.map((p) => ({ id: p.id, inicio: p.inicio, fim: p.fim })) },
      }));
      r.post('/api/simples/calcular', async (ctx) => {
        const input = await ctx.json();
        const erro = verificarLimites(input?.notas);
        if (erro) return { status: 400, body: { erro } };
        marcarEmitentesDiferentes(input.notas ?? []);
        marcarSubstituidas(input.notas ?? []);
        return { status: 200, body: calcular(input, { das, engine }) };
      });

      // ── SimplesNacionalController ──
      // consome: false → the app-level Spring mapping leaves `consumes` to these handlers (verificarConsumes),
      // which also reproduce the body-less 415 Spring writes when the Accept header is unparsable.
      r.post(OFICIAL, calculoOficial(TIPOS.OperacaoSimplesInput, ASSINATURAS.classico, engine.classico), { oficial: 'simples', consome: false });
      r.post(`${OFICIAL}/nao-assistido`, calculoOficial(TIPOS.OperacaoSimplesNaoAssistidaInput, ASSINATURAS.naoAssistido, engine.naoAssistido), { oficial: 'simples', consome: false });
      // buscarErro: SimplesNacionalErroService.buscarPorCodigo (exact code; 404 without body otherwise)
      r.get(`${OFICIAL}/erros`, (ctx) => executar(ctx, () => {
        verificarProduces(ctx.req);
        const codigo = paramStringObrigatorio(parametros(ctx), 'codigo');
        const c = PORCODIGO.get(codigo);
        return c ? respostaJson(200, escreverJson({ codigo, titulo: c.title, descricao: c.detail })) : respostaVazia(404);
      }), { oficial: 'simples' });

      // ── AtividadeSimplesController ──
      r.get(ATIVIDADES_OFICIAL, (ctx) => executar(ctx, () => {
        verificarProduces(ctx.req);
        const params = parametros(ctx);
        const data = paramDataObrigatoria(params, 'data');
        const anexos = paramLista(params, 'anexos');
        const tpDoc = paramString(params, 'tpDoc');
        const cClassTrib = paramString(params, 'cClassTrib');
        const lista = atividades.listar(data, converterAnexos(anexos), tpDoc, cClassTrib);
        return respostaJson(200, escreverJson(lista.map(serializarAtividade)), versao.headers());
      }), { oficial: 'simples' });
      r.get(/^\/api\/calculadora\/simples-nacional\/atividades\/([^/]+)$/, buscarAtividade, { oficial: 'simples' });

      // ── VersaoController (GET /versao; /versao/status is the regime-regular one) ──
      r.get('/api/versao', (ctx) => executar(ctx, () => {
        verificarProduces(ctx.req);
        return respostaJson(200, escreverJson(versao.getVersao()), versao.headers());
      }), { oficial: 'simples' });
    },
  };
}
