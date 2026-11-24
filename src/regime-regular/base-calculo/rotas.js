// Official routes of calculadora-rtc-regime-regular for this slice (base-calculo):
//   BaseCalculoController  E1 POST /calculadora/base-calculo/cbs-ibs-mercadorias
//                          E2 POST /calculadora/base-calculo/is-mercadorias
//                          E3 POST /calculadora/base-calculo/base-calculo-unificada
//                          E4 POST /calculadora/base-calculo/base-calculo-unificada-nfse
//   NfseController         E5 POST /calculadora/nfse/base-calculo
//                          E6 POST /calculadora/nfse/indicador-operacao/validate
//                          E7 GET  /calculadora/nfse/local-operacao
//                          E8 GET  /calculadora/nfse/indicador-operacao
//                          E9 GET  /calculadora/nfse/situacoes-classificacoes-tributarias
//                          E10 GET /calculadora/nfse/locais-fornecimento
//                          E11 GET /calculadora/nfse/locais-incidencia
//   PedagioController      E12 POST /calculadora/pedagio
// Pipeline of each handler = Spring MVC: argument resolution (body read by Jackson / request
// params converted), then @Valid / method validation, then the service; errors are thrown as the
// Java exceptions and answered by the foundation's exception handlers.
import { escreverJson, lerCorpoRequisicao } from '../comum/json.js';
import { erroValidacaoMetodo, ErroSerializacao, respostaFalhaEscrita } from '../comum/problema.js';
import { parametroTexto } from '../comum/spring.js';
import {
  TIPOS, CAMPOS_COMPONENTES, lerCibs, lerIS, lerUnificada, lerUnificadaNfse, lerNfseBaseCalculo, lerValidacaoIndicador, lerPedagio,
} from './entradas.js';
import { Validacao } from './validacao.js';
import { localeDe } from './idioma.js';
import { parametroData, parametroInteger } from './parametros.js';
import { calcularCibs, calcularISMercadorias, calcularUnificada, saidaUnificada } from './base-calculo.js';
import { calcularUnificadaNfse, saidaUnificadaNfse } from './base-calculo-nfse.js';
import { calcularBaseCalculoNfse, criarServicoNfse } from './nfse.js';
import { calcularPedagio, criarDependenciasPedagio, saidaPedagio, warningDadosSimulados } from './pedagio.js';

const OPCOES = { oficial: 'regime-regular', produz: ['application/json'] };
const JSON_TIPO = 'application/json';
const ok = (corpo, headers = {}) => ({ status: 200, tipo: JSON_TIPO, headers, body: escreverJson(corpo) });

// Method.toGenericString() of each @RequestBody handler ("Required request body is missing: …")
const RE = 'public org.springframework.http.ResponseEntity';
const CTRL = 'br.gov.serpro.rtc.api.controller';
const OUT = 'br.gov.serpro.rtc.api.model.output';
const ASSINATURAS = {
  cibs: `${RE}<${OUT}.basecalculo.BaseCalculoCibsModel> ${CTRL}.BaseCalculoController.calcularCibs(${TIPOS.CIBS})`,
  is: `${RE}<${OUT}.basecalculo.BaseCalculoISMercadoriasModel> ${CTRL}.BaseCalculoController.calcularISMercadorias(${TIPOS.IS})`,
  unificada: `${RE}<${OUT}.basecalculo.BaseCalculoUnificadaOutput> ${CTRL}.BaseCalculoController.calcularBaseUnificada(${TIPOS.UNIFICADA})`,
  unificadaNfse: `${RE}<${OUT}.basecalculo.BaseCalculoUnificadaNfseOutput> ${CTRL}.BaseCalculoController.calcularBaseUnificadaNfse(${TIPOS.UNIFICADA_NFSE})`,
  nfseBase: `${RE}<${OUT}.nfse.NfseBaseCalculoOutput> ${CTRL}.NfseController.calcularBaseCalculo(${TIPOS.NFSE_BASE})`,
  nfseValidacao: `${RE}<${OUT}.nfse.NfseValidacaoIndicadorOperacaoOutput> ${CTRL}.NfseController.validarIndicadorOperacao(${TIPOS.NFSE_VALIDACAO})`,
  pedagio: `${RE}<${OUT}.pedagio.PedagioOutput> ${CTRL}.PedagioController.calcularTributo(${TIPOS.PEDAGIO})`,
};

/** @RequestBody: raw bytes → Jackson binding (HttpMessageNotReadableException on failure). */
async function lerCorpo(ctx, assinatura, tipoJava, vincular) {
  const bytes = await ctx.corpo();
  return lerCorpoRequisicao(bytes, { charset: ctx.charset, assinatura, tipoJava, vincular });
}

// ─── @Valid rules (declaration order of the fields) ─────────────────────────────

const CIBS_DECIMAIS = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'frete', 'impostoSeletivo', 'outrosTributos', 'demaisImportancias',
  'icms', 'iss', 'pis', 'pisImportacao', 'cofins', 'cofinsImportacao', 'cosip', 'ipi', 'descontoIncondicional'];
const IS_DECIMAIS = ['valorBem', 'ajusteAcrescimos', 'juros', 'multas', 'encargos', 'freteCobrado', 'outrosTributos', 'demaisImportancias',
  'icms', 'iss', 'cosip', 'ipi', 'descontoIncondicional', 'bonificacao', 'devolucaoVendas'];

function validarMercadorias(v, e, decimais) {
  v.naoNulo('anoFatoGerador', e.anoFatoGerador);
  v.positivo('anoFatoGerador', e.anoFatoGerador);
  for (const c of decimais) v.positivoOuZero(c, e[c]);
}

function validarUnificada(v, e) {
  v.naoNulo('anoFatoGerador', e.anoFatoGerador);
  v.naoNulo('tipoDocumento', e.tipoDocumento);
  v.naoNulo('natureza', e.natureza);
  for (const c of CAMPOS_COMPONENTES) v.positivoOuZero(`componentes.${c}`, e.componentes[c]);
}

function validarUnificadaNfse(v, e) {
  v.naoNulo('anoFatoGerador', e.anoFatoGerador);
  v.naoNulo('opSimpNac', e.opSimpNac);
  v.naoNulo('situacao', e.situacao);
  (e.documentos ?? []).forEach((d, i) => {
    if (d === null) return; // @Valid skips null elements
    v.naoEmBranco(`documentos[${i}].tpAjusteBC`, d.tpAjusteBC);
    v.naoNulo(`documentos[${i}].vAjusteAplic`, d.vAjusteAplic);
    v.positivoOuZero(`documentos[${i}].vAjusteAplic`, d.vAjusteAplic);
  });
  if (e.locacao !== null) {
    for (const c of ['pCopropriedade', 'vTotOper', 'vDescIncondTot', 'somaAjustesLocImoveis']) {
      v.naoNulo(`locacao.${c}`, e.locacao[c]);
      v.positivoOuZero(`locacao.${c}`, e.locacao[c]);
    }
  }
}

function validarNfseBase(v, e) {
  v.naoNulo('anoFatoGerador', e.anoFatoGerador);
  v.positivo('anoFatoGerador', e.anoFatoGerador);
  v.naoNulo('valorServico', e.valorServico);
  v.positivo('valorServico', e.valorServico);
  for (const c of ['descontoIncondicional', 'vCalcReeRepRes', 'vCalcDedRedIBSCBS', 'iss', 'pis', 'cofins']) v.positivoOuZero(c, e[c]);
}

const SEIS_DIGITOS = /^\d{6}$/;
function validarIndicador(v, e) {
  v.padrao('cTribNac', e.cTribNac, /^\d{4}$|^\d{6}$/, 'O campo cTribNac deve conter exatamente 4 ou 6 dígitos numéricos');
  for (const [campo, regex, texto] of [['cIndOp', SEIS_DIGITOS, '6'], ['cClassTrib', SEIS_DIGITOS, '6'], ['nbs', /^\d{9}$/, '9']]) {
    v.naoEmBranco(campo, e[campo], `O campo ${campo} é obrigatório`);
    v.naoNulo(campo, e[campo], `O campo ${campo} não pode ser nulo`);
    v.padrao(campo, e[campo], regex, `O campo ${campo} deve conter exatamente ${texto} dígitos numéricos`);
  }
  v.naoNulo('dataOcorrenciaFatoGerador', e.dataOcorrenciaFatoGerador, 'O campo dataOcorrenciaFatoGerador é obrigatório');
}

function validarPedagio(v, e) {
  v.naoNulo('dataHoraEmissao', e.dataHoraEmissao);
  v.naoNulo('codigoMunicipioOrigem', e.codigoMunicipioOrigem);
  v.minimo('codigoMunicipioOrigem', e.codigoMunicipioOrigem, 0);
  v.maximo('codigoMunicipioOrigem', e.codigoMunicipioOrigem, 9999999);
  v.naoNulo('ufMunicipioOrigem', e.ufMunicipioOrigem);
  v.tamanho('ufMunicipioOrigem', e.ufMunicipioOrigem, 2, 2);
  v.naoNulo('cst', e.cst);
  v.tamanho('cst', e.cst, 3, 3);
  v.naoNulo('cClassTrib', e.cClassTrib);
  v.tamanho('cClassTrib', e.cClassTrib, 6, 6);
  v.naoNulo('baseCalculo', e.baseCalculo);
  v.positivoOuZero('baseCalculo', e.baseCalculo);
  v.digitos('baseCalculo', e.baseCalculo, 13, 2);
  v.naoVazio('trechos', e.trechos);
  (e.trechos ?? []).forEach((t, i) => {
    if (t === null) return;
    v.naoNulo(`trechos[${i}].numero`, t.numero);
    v.minimo(`trechos[${i}].numero`, t.numero, 1);
    v.naoNulo(`trechos[${i}].municipio`, t.municipio);
    v.minimo(`trechos[${i}].municipio`, t.municipio, 0);
    v.maximo(`trechos[${i}].municipio`, t.municipio, 9999999);
    v.naoNulo(`trechos[${i}].uf`, t.uf);
    v.tamanho(`trechos[${i}].uf`, t.uf, 2, 2);
    v.naoNulo(`trechos[${i}].extensao`, t.extensao);
  });
}

/** Reads, binds and validates a @RequestBody @Valid argument. */
async function corpoValido(ctx, assinatura, tipoJava, vincular, regras) {
  const entrada = await lerCorpo(ctx, assinatura, tipoJava, vincular);
  const v = new Validacao(localeDe(ctx.req));
  regras(v, entrada);
  v.lancar();
  return entrada;
}

export function registrar(r, deps) {
  const nfse = criarServicoNfse(deps.base);
  const pedagio = criarDependenciasPedagio(deps.base);

  // ── BaseCalculoController ────────────────────────────────────────────────
  r.post('/api/calculadora/base-calculo/cbs-ibs-mercadorias', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.cibs, TIPOS.CIBS, lerCibs, (v, x) => validarMercadorias(v, x, CIBS_DECIMAIS));
    return ok({ baseCalculo: calcularCibs(e).baseCalculo });
  }, OPCOES);

  r.post('/api/calculadora/base-calculo/is-mercadorias', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.is, TIPOS.IS, lerIS, (v, x) => validarMercadorias(v, x, IS_DECIMAIS));
    return ok({ baseCalculo: calcularISMercadorias(e).baseCalculo });
  }, OPCOES);

  r.post('/api/calculadora/base-calculo/base-calculo-unificada', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.unificada, TIPOS.UNIFICADA, lerUnificada, validarUnificada);
    return ok(saidaUnificada(calcularUnificada(e)));
  }, OPCOES);

  r.post('/api/calculadora/base-calculo/base-calculo-unificada-nfse', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.unificadaNfse, TIPOS.UNIFICADA_NFSE, lerUnificadaNfse, validarUnificadaNfse);
    return ok(saidaUnificadaNfse(calcularUnificadaNfse(e)));
  }, OPCOES);

  // ── NfseController ───────────────────────────────────────────────────────
  r.post('/api/calculadora/nfse/base-calculo', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.nfseBase, TIPOS.NFSE_BASE, lerNfseBaseCalculo, validarNfseBase);
    return ok({ baseCalculo: calcularBaseCalculoNfse(e).baseCalculo });
  }, OPCOES);

  r.post('/api/calculadora/nfse/indicador-operacao/validate', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.nfseValidacao, TIPOS.NFSE_VALIDACAO, lerValidacaoIndicador, validarIndicador);
    return ok(nfse.validarIndicadorOperacao(e));
  }, OPCOES);

  r.get('/api/calculadora/nfse/local-operacao', (ctx) => {
    const locale = localeDe(ctx.req);
    const cIndOp = parametroTexto(ctx.parametros, 'cIndOp');
    const data = parametroData(ctx.parametros, 'dataOcorrenciaFatoGerador', locale);
    // method validation (@NotBlank @NotNull @Pattern("^\\d{6}$") cIndOp): a blank value never matches the pattern
    if (!SEIS_DIGITOS.test(cIndOp)) throw erroValidacaoMetodo();
    return ok(nfse.consultarLocalOperacao(cIndOp, data));
  }, OPCOES);

  r.get('/api/calculadora/nfse/indicador-operacao', (ctx) => {
    const locale = localeDe(ctx.req);
    const data = parametroData(ctx.parametros, 'dataOcorrenciaFatoGerador', locale);
    const nbs = parametroTexto(ctx.parametros, 'nbs', { obrigatorio: false });
    if (nbs !== null && !/^\d{9}$/.test(nbs)) throw erroValidacaoMetodo();
    return ok(nfse.consultarIndicadorOperacao(data, nbs));
  }, OPCOES);

  r.get('/api/calculadora/nfse/situacoes-classificacoes-tributarias', (ctx) => {
    const locale = localeDe(ctx.req);
    const nbs = parametroTexto(ctx.parametros, 'nbs');
    const data = parametroData(ctx.parametros, 'data', locale);
    if (!/^\d{9}$/.test(nbs)) throw erroValidacaoMetodo();
    return ok(nfse.consultarSituacoesClassificacoesPorNbs(nbs, data));
  }, OPCOES);

  r.get('/api/calculadora/nfse/locais-fornecimento', (ctx) => {
    const codigo = parametroInteger(ctx.parametros, 'codigo');
    return ok(nfse.consultarLocaisFornecimento(codigo).map((x) => ({ codigo: x.codigo, descricao: x.descricao })));
  }, OPCOES);

  r.get('/api/calculadora/nfse/locais-incidencia', (ctx) => {
    const codigo = parametroInteger(ctx.parametros, 'codigo');
    return ok(nfse.consultarLocaisIncidencia(codigo).map((x) => ({ codigo: x.codigo, descricao: x.descricao })));
  }, OPCOES);

  // ── PedagioController ────────────────────────────────────────────────────
  r.post('/api/calculadora/pedagio', async (ctx) => {
    const e = await corpoValido(ctx, ASSINATURAS.pedagio, TIPOS.PEDAGIO, lerPedagio, validarPedagio);
    const resultado = calcularPedagio(pedagio, e);
    const headers = {};
    const warning = warningDadosSimulados(e);
    if (warning !== null) headers['x-warning-dados-simulados'] = String(warning);
    try {
      return ok(saidaPedagio(resultado), headers);
    } catch (erro) {
      if (erro instanceof ErroSerializacao) return respostaFalhaEscrita(ctx.instance, headers);
      throw erro;
    }
  }, OPCOES);
}
