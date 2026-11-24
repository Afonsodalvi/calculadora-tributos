// DadosAbertosController of calculadora-rtc-regime-regular 1.7.2: the 33 GET routes under
// /api/calculadora/dados-abertos (produces application/json). Arguments are resolved in the order of each
// Java handler signature (the first failing one answers), then the @Pattern validation, then the service.
// Routes are registered literal-first: the official router tries them in order, which reproduces Spring's
// PathPattern precedence (literal segment beats a variable; fewer variables win).
import { escreverJson } from '../comum/json.js';
import { VERSAO_APLICACAO, ultimaVersaoBase } from '../comum/problema.js';
import { criarServicoDadosAbertos } from './servico.js';
import * as P from './parametros.js';

const RAIZ = '/api/calculadora/dados-abertos';
const OPCOES = { oficial: 'regime-regular', produz: ['application/json'] };
/** CacheControl.maxAge(Duration.ofHours(1)).cachePublic() */
const CACHE = Object.freeze({ 'Cache-Control': 'max-age=3600, public' });
/** literal .header("Cache-Control", "public, max-age=3600") of nbs-aplicavel / ncm-aplicavel */
const CACHE_LITERAL = Object.freeze({ 'Cache-Control': 'public, max-age=3600' });
const PAPEIS = ['FORNECEDOR', 'ADQUIRENTE'];

const ok = (body, headers = {}) => ({ status: 200, tipo: 'application/json', headers: { ...headers }, body: escreverJson(body) });

/** getVersaoAplicacaoDadosAbertos(): the part after "-SNAPSHOT-" when there is one. */
export function versaoAplicacaoDadosAbertos(versao) {
  if (versao == null) return null;
  const i = versao.indexOf('-SNAPSHOT-');
  return i >= 0 && i + '-SNAPSHOT-'.length < versao.length ? versao.slice(i + 1) : versao;
}

export function registrar(r, deps) {
  const servico = criarServicoDadosAbertos(deps.base);
  const ambiente = deps.ambiente ?? 'offline'; // active Spring profile of the official package
  // ${info.app.version} (Spring relaxed binding: INFO_APP_VERSION overrides it, as the Java tests do)
  const versaoAplicacao = deps.versaoAplicacao ?? process.env.INFO_APP_VERSION ?? VERSAO_APLICACAO;

  /** okComWarningDadosSimulados: x-warning-dados-simulados from 2027-01-01 (only on the 200). */
  const comWarning = (body, data) => {
    const w = servico.getWarningDadosSimuladosPorData(data);
    return ok(body, w != null ? { 'x-warning-dados-simulados': String(w) } : {});
  };
  const get = (caminho, handler) => r.get(RAIZ + caminho, handler, OPCOES);
  /** Path with {variables}: each one matches a whole (decoded) segment. */
  const getVariavel = (caminho, handler) => {
    const fonte = (RAIZ + caminho).split(/\{[A-Za-z]+\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('([^/]+)');
    r.get(new RegExp(`^${fonte}$`), handler, OPCOES);
  };
  const data = (ctx, opcoes) => P.data(ctx, 'data', opcoes);

  // ─── literal paths ─────────────────────────────────────────────────────────
  get('/ufs', () => ok(servico.consultarUfs(), CACHE));

  get('/ufs/municipios', (ctx) => {
    const siglaUf = P.texto(ctx, 'siglaUf');
    return ok(servico.consultarMunicipiosPorSiglaUf(siglaUf), CACHE);
  });

  get('/situacoes-tributarias/cbs-ibs', (ctx) => {
    const siglaDfe = P.texto(ctx, 'siglaDfe', { obrigatorio: false });
    const d = data(ctx);
    return ok(servico.consultarCstsComClassificacoesCbsIbs(siglaDfe, d), CACHE);
  });

  get('/situacoes-tributarias/is', (ctx) => {
    const siglaDfe = P.texto(ctx, 'siglaDfe', { obrigatorio: false });
    const d = data(ctx);
    return ok(servico.consultarCstsComClassificacoesIs(siglaDfe, d), CACHE);
  });

  get('/situacoes-tributarias/imposto-seletivo', (ctx) => ok(servico.consultarSituacoesTributarias(1, data(ctx))));

  get('/classificacoes-tributarias/cbs-ibs', (ctx) => ok(servico.consultarClassificacoesTributariasCbsIbs(data(ctx))));

  get('/classificacoes-tributarias/cbs-ibs/por-atores', (ctx) => {
    const d = data(ctx);
    const fornecedor = P.longo(ctx, 'fornecedor', { obrigatorio: false });
    const adquirente = P.longo(ctx, 'adquirente', { obrigatorio: false });
    const siglaDfe = P.texto(ctx, 'siglaDfe', { obrigatorio: false });
    return ok(servico.consultarClassificacoesTributariasCbsIbsPorAtores(d, fornecedor, adquirente, siglaDfe), CACHE);
  });

  get('/classificacoes-tributarias/imposto-seletivo', (ctx) => {
    const d = data(ctx);
    return comWarning(servico.consultarClassificacoesTributariasImpostoSeletivo(d), d);
  });

  get('/classificacoes-tributarias/nbs', (ctx) => {
    const nbs = P.texto(ctx, 'nbs');
    const d = data(ctx);
    P.validarPadrao(nbs, /^[0-9]{9}$/);
    return ok(servico.listarClassificacaoAplicavelPorNbs(nbs, d));
  });

  get('/classificacoes-tributarias/nbs-aplicavel', (ctx) => {
    const cClassTrib = P.texto(ctx, 'cClassTrib');
    const nbs = P.texto(ctx, 'nbs');
    const d = P.data(ctx, 'dataOcorrenciaFatoGerador');
    return ok(servico.validarNbsAplicavel(cClassTrib, nbs, d), CACHE_LITERAL);
  });

  get('/classificacoes-tributarias/ncm-aplicavel', (ctx) => {
    const cClassTrib = P.texto(ctx, 'cClassTrib');
    const ncm = P.texto(ctx, 'ncm');
    const d = P.data(ctx, 'dataOcorrenciaFatoGerador');
    return ok(servico.validarNcmAplicavel(cClassTrib, ncm, d), CACHE_LITERAL);
  });

  get('/ncm', (ctx) => {
    const ncm = P.texto(ctx, 'ncm');
    const d = data(ctx);
    const resultado = servico.consultarNcm(ncm, d);
    return resultado.tributadoPeloImpostoSeletivo ? comWarning(resultado, d) : ok(resultado);
  });

  // @DateTimeFormat(iso = ISO.DATE) inherited from DadosAbertosControllerOpenApi
  get('/ncm/vigentes', (ctx) => ok(servico.consultarNcmsVigentes(data(ctx, { iso: true })), CACHE));

  get('/nbs', (ctx) => {
    const nbs = P.texto(ctx, 'nbs');
    const d = data(ctx);
    const resultado = servico.consultarNbs(nbs, d);
    return resultado.tributadoPeloImpostoSeletivo ? comWarning(resultado, d) : ok(resultado);
  });

  get('/nbs/lista', (ctx) => ok(servico.listarNbs(data(ctx))));

  get('/nbs-aplicaveis', (ctx) => {
    const cClassTrib = P.texto(ctx, 'cClassTrib');
    const d = data(ctx);
    P.validarPadrao(cClassTrib, /^[0-9]{6}$/);
    return ok(servico.listarNbsAplicaveisPorClassificacao(cClassTrib, d));
  });

  get('/fundamentacoes-legais', (ctx) => ok(servico.consultarFundamentacoesLegais(data(ctx))));

  get('/aliquota-uniao', (ctx) => {
    const d = data(ctx);
    return comWarning(servico.consultarAliquota(2, null, null, d), d);
  });

  get('/aliquota-uf', (ctx) => {
    const codigoUf = P.longo(ctx, 'codigoUf');
    const d = data(ctx);
    return comWarning(servico.consultarAliquota(3, codigoUf, null, d), d);
  });

  get('/aliquota-municipio', (ctx) => {
    const codigoMunicipio = P.longo(ctx, 'codigoMunicipio');
    const d = data(ctx);
    return comWarning(servico.consultarAliquota(4, null, codigoMunicipio, d), d);
  });

  get('/dfe/grupos', (ctx) => ok(servico.consultarTiposDfeAgrupados(data(ctx, { obrigatorio: false })), CACHE));

  get('/versao', () => {
    const versaoApp = versaoAplicacaoDadosAbertos(versaoAplicacao);
    const v = ultimaVersaoBase(deps.base);
    return ok({
      ambiente: ambiente === 'local' ? 'online' : ambiente,
      dataVersaoDb: v.data,
      descricaoVersaoApp: versaoAplicacao,
      descricaoVersaoDb: v.descricao,
      versaoApp,
      versaoDb: v.numeroVersao,
    });
  });

  get('/redutores-compra-governamental', () => ok(servico.consultarRedutoresCompraGovernamental(), CACHE));
  get('/transferencias-cbs', () => ok(servico.consultarTransferenciasCBS(), CACHE));
  get('/transferencias-ibs', () => ok(servico.consultarTransferenciasIBS(), CACHE));

  get('/ator/grupos', (ctx) => {
    const d = data(ctx);
    const papel = P.enumeracao(ctx, 'papel', PAPEIS);
    return ok(servico.consultarAtoresAgrupados(d, papel), CACHE);
  });

  // ─── one path variable ─────────────────────────────────────────────────────
  getVariavel('/classificacoes-tributarias/cbs-ibs/class-trib/{cClassTrib}', (ctx) => {
    const [cClassTrib] = ctx.params;
    return ok(servico.consultarClassificacaoTributariaCbsIbsPorCodigo(cClassTrib, data(ctx)));
  });

  getVariavel('/classificacoes-tributarias/is/class-trib/{cClassTrib}', (ctx) => {
    const [cClassTrib] = ctx.params;
    return ok(servico.consultarClassificacaoTributariaIsPorCodigo(cClassTrib, data(ctx)));
  });

  getVariavel('/classificacoes-tributarias/imposto-seletivo/{cst}', (ctx) => {
    const [cst] = ctx.params;
    return ok(servico.consultarClassificacoesTributariasPorCstETributoTipo(cst, ['IS'], data(ctx)));
  });

  getVariavel('/classificacoes-tributarias/cbs-ibs/{cst}', (ctx) => {
    const [cst] = ctx.params;
    return ok(servico.consultarClassificacoesTributariasPorCstETributoTipo(cst, ['CBS', 'IBSUF', 'IBSMun'], data(ctx)));
  });

  // deprecated (since 2026-01-13, forRemoval)
  getVariavel('/classificacoes-tributarias/{idSituacaoTributaria}', (ctx) => {
    const id = P.longoCaminho(ctx.params[0], 'idSituacaoTributaria');
    return ok(servico.consultarClassificacoesTributariasPorIdSituacaoTributaria(id, data(ctx)));
  });

  // ─── two path variables ────────────────────────────────────────────────────
  getVariavel('/classificacoes-tributarias/cbs-ibs/{siglaDfe}/{cClassTrib}', (ctx) => {
    const [siglaDfe, cClassTrib] = ctx.params;
    return ok(servico.consultarValidadeDfeClassificacaoTributaria(siglaDfe, cClassTrib, data(ctx)));
  });

  getVariavel('/nomenclatura/{siglaDfe}/{cClassTrib}', (ctx) => {
    const [siglaDfe, cClassTrib] = ctx.params;
    return ok(servico.consultarNomenclatura(siglaDfe, cClassTrib, data(ctx)), CACHE);
  });
}
