// Request pipeline of the calculation endpoints:
//  - ProcessamentoItemService.processarItem (P1..P11, obterTratamentoClassificacao T1..T13);
//  - CalculadoraService.calcularTributos (POST /calculadora/regime-geral: fail-fast);
//  - ObservabilidadeService.processarOperacao (POST /calculadora/observabilidade/regime-geral:
//    global 422 ErrosCalculo, per-item Bean Validation and ItemCollector, totals of calculated items);
//  - ItemCollector, GlobalCollector, AvisoDadosSimuladosService.
// Items run sequentially in index order: Java runs them on a parallel stream / virtual threads, which
// only changes WHICH error wins on the main endpoint when 2+ items fail (processing.md §14.15); the
// port reports the lowest index with its original message.
// P1..P10 build the engine input (montarOperacaoModel → OperacaoModel, CONTRATO-PORTE.md "Interface
// motor ↔ orquestração"); P11 hands it to the calculation engine (calculo/motor).
import { Dec } from '../../core/decimal.js';
import { registrarErro } from '../../http/seguranca.js';
import {
  ErroJava, ErrosCalculo, problemTypePorClasse, codigoValidacaoDaAnotacao, codigoValidacaoPorCodigo, erroDetalhe,
} from '../comum/problema.js';
import { javaTrim } from '../comum/java.js';
import {
  fatoGeradorAplicavel, anoDe, tpEnteGovDe, possuiComponentes, ajustarNcm, valorImpostoSeletivoInformado,
} from './entrada.js';
import { validar, interpolar, textoValorInvalido, LOCALE_PADRAO } from './validacao.js';
import {
  criarServicos, calcularBaseUnificada, TRIBUTO, isBlank, isNotBlank, comprimento, siglaPorNormalizada, impostoSeletivoAplicavelSigla,
} from './servicos.js';
import { valoresTotais } from './roc.js';
import * as E from './excecoes.js';
import { criarMotor } from './motor/index.js';

const ANO_LIMITE_SUPERIOR_ALIQUOTAS_NOMINAIS = 2027;
/** Largest |scale| the port accepts in unbounded BigDecimal inputs (see verificarEscala). */
export const ESCALA_MAXIMA = 100000;

/** EstadoItemEnum. */
export const ESTADO = Object.freeze({
  CALCULADO: 'CALCULADO', NAO_IMPLEMENTADO: 'NAO_IMPLEMENTADO', INCONSISTENCIA_ENTRADA: 'INCONSISTENCIA_ENTRADA',
  FALHA_TECNICA: 'FALHA_TECNICA', CALCULO_SIMULADO: 'CALCULO_SIMULADO',
});

/** TipoWarningDadosSimulados (header x-warning-dados-simulados = valor). */
export const AVISO = Object.freeze({
  CASO_GERAL: { nome: 'CASO_GERAL', valor: 1 },
  CASO_COMPRAS_GOVERNAMENTAIS: { nome: 'CASO_COMPRAS_GOVERNAMENTAIS', valor: 2 },
  CASO_IMPOSTO_SELETIVO: { nome: 'CASO_IMPOSTO_SELETIVO', valor: 3 },
  CASO_COMPRAS_GOVERNAMENTAIS_IS: { nome: 'CASO_COMPRAS_GOVERNAMENTAIS_IS', valor: 4 },
  CASO_ALIQUOTAS_FICTICIAS: { nome: 'CASO_ALIQUOTAS_FICTICIAS', valor: 5 },
  CASO_CALCULOS_SIMULADOS: { nome: 'CASO_CALCULOS_SIMULADOS', valor: 6 },
});

/** AvisoDadosSimuladosService.getWarningDadosSimulados(operacao): AVISO.* or null. */
export function avisoDadosSimulados(operacao) {
  const data = fatoGeradorAplicavel(operacao);
  if (data > '2026-12-31') return AVISO.CASO_CALCULOS_SIMULADOS;
  const temComprasGovernamentais = false; // TODO in the Java source
  let temImpostoSeletivo = false;
  let temAliquotasFicticias = false;
  for (const item of operacao.itens) {
    if (item == null) throw new ErroJava('NullPointerException', 'Cannot invoke "br.gov.serpro.rtc.api.model.input.ItemOperacaoInput.getCst()" because "item" is null');
    const cst = item.cst;
    if (cst === '010' || cst === '220' || cst === '221') temAliquotasFicticias = true;
    if (item.impostoSeletivo != null) temImpostoSeletivo = true;
  }
  if (temAliquotasFicticias && data > '2025-12-31') return AVISO.CASO_ALIQUOTAS_FICTICIAS;
  if (data < '2027-01-01') return null;
  // unreachable today (data >= 2027 already returned CASO_CALCULOS_SIMULADOS)
  if (temComprasGovernamentais && temImpostoSeletivo) return AVISO.CASO_COMPRAS_GOVERNAMENTAIS_IS;
  if (temImpostoSeletivo) return AVISO.CASO_IMPOSTO_SELETIVO;
  if (temComprasGovernamentais) return AVISO.CASO_COMPRAS_GOVERNAMENTAIS;
  return AVISO.CASO_GERAL;
}

// ─── Collectors ────────────────────────────────────────────────────────────────

/** Java exception view of anything thrown by the port (a JS bug becomes a RuntimeException). */
export function comoExcecaoJava(e) {
  if (e instanceof ErroJava) return e;
  if (e?.classeJava) return new ErroJava(e.classeJava, e.mensagemJava !== undefined ? e.mensagemJava : (e.message ?? null));
  registrarErro(e);
  return new ErroJava('RuntimeException', e?.message ?? String(e));
}

/** ItemCollector(index, baseURL). */
export class ItemCollector {
  constructor(index, baseURL) {
    this.index = index;
    this.baseURL = baseURL;
    this.erros = [];
    this.estado = ESTADO.CALCULADO;
  }

  addErroValidacao(code, campo, detail) {
    if (this.estado === ESTADO.CALCULADO) this.estado = ESTADO.INCONSISTENCIA_ENTRADA;
    const title = codigoValidacaoPorCodigo(code)?.title ?? 'Erro de validação';
    this.erros.push(erroDetalhe({ type: this.tipoURI(code), title, code, pointer: this.ponteiro(campo), detail }));
  }

  addErro(ex) {
    const e = comoExcecaoJava(ex);
    const pt = problemTypePorClasse(e.classeJava);
    if (pt.code != null) {
      this.estado = pt.estado;
      this.erros.push(erroDetalhe({ type: this.tipoURI(pt.code), title: pt.title, code: pt.code, pointer: this.ponteiro(pt.campoDefault), detail: e.mensagem }));
    } else {
      this.estado = ESTADO.FALHA_TECNICA;
      this.erros.push(erroDetalhe({ type: this.tipoURI('CAL-999'), title: pt.title, code: 'CAL-999', pointer: `#/itens/${this.index}`, detail: e.mensagem }));
    }
  }

  tipoURI(codigo) { return `${this.baseURL}/api/calculadora/observabilidade/erros?codigo=${codigo}`; }
  ponteiro(campo) { return campo == null ? `#/itens/${this.index}` : `#/itens/${this.index}/${campo}`; }
  getEstado() { return this.estado; }
  getErros() { return Object.freeze([...this.erros]); }
  hasErros() { return this.erros.length > 0; }
}

/** GlobalCollector (unused by the Java services; kept for parity with its unit tests). */
export class GlobalCollector {
  constructor() { this.errosGlobais = []; this.itemCollectors = []; }
  addErroGlobal(type, title, code, pointer, detail) { this.errosGlobais.push(erroDetalhe({ type, title, code, pointer, detail })); }
  addItemCollector(collector) { this.itemCollectors.push(collector); }
  getErrosGlobais() { return Object.freeze([...this.errosGlobais]); }
  getItemCollectors() { return Object.freeze([...this.itemCollectors]); }
  hasErrosGlobais() { return this.errosGlobais.length > 0; }
}

/** ObservabilidadeService.buildValidationDetail. */
export function detalheValidacao(campo, mensagem, valorInvalido) {
  return valorInvalido != null ? `Campo '${campo}' ${mensagem}, recebido: '${textoValorInvalido(valorInvalido)}'` : `Campo '${campo}' ${mensagem}`;
}

/**
 * Guard against BigDecimal inputs whose scale makes exact arithmetic explode (e.g. vProd 1E+999999999:
 * Java would try to materialize 10^999999999 and stall/OOM). Only fields without @Digits reach the
 * arithmetic unbounded: the 15 gComponentesBC values and aliquotasNominais.impostoSeletivo.adRem.
 */
function verificarEscala(v) {
  if (v != null && Math.abs(v.scale()) > ESCALA_MAXIMA) {
    throw new ErroJava('ArithmeticException', `Escala do valor ${v.toJavaString()} fora do limite suportado (${ESCALA_MAXIMA})`);
  }
}

// ─── Services ──────────────────────────────────────────────────────────────────

/**
 * Builds the calculation services over the shared database. `motor` (optional, tests) = { calcular,
 * serializarTributos }; by default the engine of calculo/motor over the same database.
 */
export function criarProcessamento(base, { motor = criarMotor(base) } = {}) {
  const S = criarServicos(base);
  const obterMotor = () => motor;

  // ProcessamentoItemService ------------------------------------------------------------

  function validarBaseCalculoComComponentes(operacao, item, componentes) {
    const tpDoc = operacao.tpDoc;
    const natureza = inferirNatureza(item);
    const ano = anoDe(fatoGeradorAplicavel(operacao));
    const resultado = calcularBaseUnificada(componentes, ano, natureza, tpDoc, verificarEscala);
    const impostoSeletivo = item.impostoSeletivo;
    if (impostoSeletivo != null) {
      const bc = resultado.baseIS;
      if (bc.signum() < 0) throw E.erroGenericoValidacao('A base de cálculo do Imposto Seletivo calculada a partir dos componentes é negativa');
      const declarada = impostoSeletivo.baseCalculo;
      if (declarada != null && declarada.compareTo(bc) !== 0) throw E.baseCalculoComponentesInconsistente(declarada, bc);
      if (declarada == null) impostoSeletivo.baseCalculo = bc;
      return;
    }
    const bc = resultado.baseRG;
    if (bc.signum() < 0) throw E.erroGenericoValidacao('A base de cálculo calculada a partir dos componentes é negativa');
    const declarada = item.baseCalculo;
    if (declarada != null && declarada.compareTo(bc) !== 0) throw E.baseCalculoComponentesInconsistente(declarada, bc);
    if (declarada == null) item.baseCalculo = bc;
  }

  function inferirNatureza(item) {
    const possuiNcm = isNotBlank(item.ncm);
    const possuiNbs = isNotBlank(item.nbs);
    if (possuiNcm && possuiNbs) return null;
    if (possuiNcm) return 'BEM';
    if (possuiNbs) return 'SERVICO';
    return null;
  }

  function validarBaseCalculoLegado(item) {
    const impostoSeletivo = item.impostoSeletivo;
    const baseCalculo = item.baseCalculo;
    if (impostoSeletivo == null) {
      if (baseCalculo == null) throw E.baseCalculoNaoInformada();
      return;
    }
    const baseCalculoIS = impostoSeletivo.baseCalculo;
    if (baseCalculoIS == null) throw E.erroGenericoValidacao('A base de cálculo do Imposto Seletivo deve ser informada quando o grupo de Imposto Seletivo é informado');
    const impostoInformado = impostoSeletivo.impostoInformado;
    if (baseCalculo == null) {
      item.baseCalculo = baseCalculoIS.add(valorImpostoSeletivoInformado(impostoSeletivo));
      return;
    }
    if (impostoInformado != null) {
      if (baseCalculo.compareTo(baseCalculoIS.add(impostoInformado)) !== 0) {
        throw E.baseCalculoInconsistente(baseCalculo, baseCalculoIS, impostoInformado);
      }
    } else if (baseCalculo.compareTo(baseCalculoIS) < 0) {
      throw E.baseCalculoMenorBaseIS(baseCalculo, baseCalculoIS);
    }
  }

  function validarQuantidadeEUnidade(item, aliquotaIS) {
    const is = item.impostoSeletivo;
    if (aliquotaIS.aliquotaAdRem != null && is != null) {
      if (is.quantidade == null) throw E.erroGenericoValidacao('A quantidade do Imposto Seletivo deve ser informada para alíquota ad rem');
      if (is.quantidade.signum() <= 0) throw E.erroGenericoValidacao('A quantidade do Imposto Seletivo deve ser maior do que zero para alíquota ad rem');
      if (is.unidade == null) throw E.erroGenericoValidacao('A unidade de medida do Imposto Seletivo deve ser informada para alíquota ad rem');
    }
    if (item.quantidade != null && item.quantidade.signum() <= 0) throw E.erroGenericoValidacao('A quantidade do item deve ser maior do que zero');
  }

  function validarAliquotasNominais(item, data) {
    const an = item.aliquotasNominais;
    if (anoDe(data) < ANO_LIMITE_SUPERIOR_ALIQUOTAS_NOMINAIS) {
      const informou = an != null && (an.cbs != null || an.ibsEstadual != null || an.ibsMunicipal != null
        || (an.impostoSeletivo != null && (an.impostoSeletivo.adValorem != null || an.impostoSeletivo.adRem != null)));
      if (informou) throw E.aliquotasNominaisInformadasIndevidamente();
      return;
    }
    const st = S.situacaoTributariaService.consultarSituacaoTributariaPorCodigo(item.cst, TRIBUTO.CBS, data);
    if (!(st != null && st.inGrupoIbsCbs === true)) return;
    if (an == null || an.cbs == null || an.ibsEstadual == null || an.ibsMunicipal == null) {
      throw E.aliquotasNominaisNaoInformadas();
    }
  }

  function validarNcmNbs(ncm, nbs, data) {
    const temNcm = !isNullOrEmpty(ncm), temNbs = !isNullOrEmpty(nbs);
    if (temNcm && temNbs) throw E.ncmNbsSimultaneas();
    if (temNcm && !S.ncmService.existeNcm(ncm, data)) throw E.ncmNaoEncontrada(ncm, data);
    if (temNbs && !S.nbsService.existeNbs(nbs, data)) throw E.nbsNaoEncontrada(nbs, data);
  }

  function validarClassificacaoTributariaCbsIbs(ct, cst, ncm, nbs) {
    if (isNullOrEmpty(ncm) && isNullOrEmpty(nbs)) return; // without NCM and NBS the CST × cClassTrib link is not checked
    if (ct.cst !== cst) throw E.classificacaoNaoVinculadaSituacao(ct.codigo, cst, 'CBS e IBS');
  }

  function validarVinculoTipoDfe(tipoDfe, ct, data) {
    if (tipoDfe == null) return;
    S.tipoDfeClassificacaoService.validarVinculo(tipoDfe, ct.id, ct.codigo, data, 'CBS e IBS');
  }

  function existeIncidenciaImpostoSeletivo(ncm, nbs, data) {
    if (isNotBlank(ncm) && comprimento(ncm) === 8) {
      return S.aliquotaAdValoremProdutoService.existeNcmAdValorem(ncm, TRIBUTO.IS, data)
        || S.aliquotaAdRemProdutoService.buscarAliquotaAdRem(ncm, TRIBUTO.IS, data) != null;
    }
    if (isNotBlank(nbs) && comprimento(nbs) === 9) return S.aliquotaAdValoremServicoService.existeNbsAdValorem(nbs, TRIBUTO.IS, data);
    return false;
  }

  function analisarAliquotaImpostoSeletivo(item, data) {
    const { ncm, nbs } = item;
    let informadas = null;
    if (item.impostoSeletivo != null) informadas = item.aliquotasNominais != null ? item.aliquotasNominais.impostoSeletivo : null;
    // (impostoSeletivo null + aliquotasNominais.impostoSeletivo informed: ignored, only a debug log in Java)
    const adRemInformada = informadas != null && informadas.adRem != null;
    if (adRemInformada && isBlank(item.impostoSeletivo.unidade)) {
      throw E.erroGenericoValidacao('A unidade de medida do Imposto Seletivo deve ser informada quando a alíquota ad rem é informada pelo usuário');
    }
    let aliquotaAdValorem = informadas != null ? informadas.adValorem : null;
    let aliquotaAdRem = informadas != null ? informadas.adRem : null;
    let unidadeMedida = aliquotaAdRem != null ? item.impostoSeletivo.unidade : null;
    if (isNotBlank(ncm) && comprimento(ncm) === 8) {
      if (aliquotaAdValorem == null) {
        const dto = S.aliquotaAdValoremProdutoService.buscarAliquotaAdValorem(ncm, TRIBUTO.IS, data);
        if (dto != null) aliquotaAdValorem = dto.valor;
      }
      if (aliquotaAdRem == null) {
        const dto = S.aliquotaAdRemProdutoService.buscarAliquotaAdRem(ncm, TRIBUTO.IS, data);
        if (dto != null) { aliquotaAdRem = dto.valor; unidadeMedida = dto.unidadeMedida; }
      }
    } else if (isNotBlank(nbs) && comprimento(nbs) === 9) {
      if (aliquotaAdValorem == null) aliquotaAdValorem = S.aliquotaAdValoremServicoService.buscarAliquotaAdValorem(nbs, TRIBUTO.IS, null, data);
    }
    if (aliquotaAdValorem != null || aliquotaAdRem != null) return { aliquotaAdValorem, aliquotaAdRem, unidadeMedida };
    return null;
  }

  /** ProcessamentoItemService.obterTratamentoClassificacao (T1..T13) → TratamentoClassificacaoModel. */
  function obterTratamentoClassificacao(item, data, tipoDfe) {
    const C = S.classificacaoTributariaService;
    const T = S.tratamentoClassificacaoService;
    let ctIS = null;
    let tcIS = null;
    let tcDeson = null;
    let temDesoneracao = false;
    const { ncm, nbs } = item;

    // T1..T4
    let ct = C.buscarClassificacaoTributariaCbsIbs(item.cClassTrib, data);
    validarClassificacaoTributariaCbsIbs(ct, item.cst, ncm, nbs);
    validarVinculoTipoDfe(tipoDfe, ct, data);
    let tc = T.buscarTratamentoClassificacao(ct.id, data);
    // T5/T6
    let cst = item.cst;
    let cClassTrib = item.cClassTrib;
    if (tc.inExigeGrupoDesoneracao) {
      if (item.tributacaoRegular == null) {
        throw E.tributacaoRegularNaoInformada(cClassTrib, cst);
      }
      cst = item.tributacaoRegular.cst;
      cClassTrib = item.tributacaoRegular.cClassTrib;
      tcDeson = tc;
      ct = C.buscarClassificacaoTributariaCbsIbs(cClassTrib, data);
      validarClassificacaoTributariaCbsIbs(ct, cst, ncm, nbs);
      validarVinculoTipoDfe(tipoDfe, ct, data);
      tc = T.buscarTratamentoClassificacao(ct.id, data);
      if (tc.inIncompativelComSuspensao) {
        throw E.incompatibilidadeSuspensao(cClassTrib, cst);
      }
      temDesoneracao = true;
    } else if (item.tributacaoRegular != null && tipoDfe != null) {
      // the regular-taxation group does not take part in the calculation, but its link with tpDoc is checked
      validarVinculoTipoDfe(tipoDfe, C.buscarClassificacaoTributariaCbsIbs(item.tributacaoRegular.cClassTrib, data), data);
    }

    // T7 nomenclature (effective classification)
    if (tipoDfe != null) {
      S.validacaoNomenclaturaService.validar(siglaPorNormalizada(tipoDfe.sigla), ct.id, ct.codigo, ncm, nbs, data, 'CBS e IBS', 'PERMISSIVO');
    } else {
      if (isNullOrEmpty(ncm) && isNullOrEmpty(nbs)) {
        S.ncmAplicavelService.validar(ncm, ct.id, ct.codigo, data, 'CBS e IBS');
        S.nbsAplicavelService.validar(nbs, ct.id, ct.codigo, data, 'CBS e IBS');
      }
      if (!isNullOrEmpty(ncm) && isNullOrEmpty(nbs)) S.ncmAplicavelService.validar(ncm, ct.id, ct.codigo, data, 'CBS e IBS');
      if (!isNullOrEmpty(nbs) && isNullOrEmpty(ncm)) S.nbsAplicavelService.validar(nbs, ct.id, ct.codigo, data, 'CBS e IBS');
    }

    // T8 Imposto Seletivo group
    if (item.impostoSeletivo != null) {
      S.situacaoTributariaService.validarCst(item.impostoSeletivo.cst, TRIBUTO.IS, data);
      ctIS = C.buscarClassificacaoTributariaImpostoSeletivo(item.impostoSeletivo.cClassTrib, data);
      if (ctIS.cst !== item.impostoSeletivo.cst) throw E.classificacaoNaoVinculadaSituacao(ctIS.codigo, item.impostoSeletivo.cst, 'Imposto Seletivo');
    }

    // T9
    const aliquotaIS = analisarAliquotaImpostoSeletivo(item, data);
    const tipoNomenclatura = () => (isNotBlank(ncm) ? 'NCM' : 'NBS');
    const codigoNomenclatura = () => (isNotBlank(ncm) ? ncm : nbs);
    // T10
    if (tipoDfe != null && !impostoSeletivoAplicavelSigla(tipoDfe.sigla) && aliquotaIS != null) {
      throw E.impostoSeletivoNaoAdmitidoTipoDfe(tipoDfe.tipo, tipoNomenclatura(), codigoNomenclatura());
    }
    // T11
    if (aliquotaIS == null && anoDe(data) >= ANO_LIMITE_SUPERIOR_ALIQUOTAS_NOMINAIS && existeIncidenciaImpostoSeletivo(ncm, nbs, data)) {
      if (item.impostoSeletivo == null) throw E.impostoSeletivoNaoInformado(tipoNomenclatura(), codigoNomenclatura(), data);
      throw E.aliquotaImpostoSeletivoNaoInformada(tipoNomenclatura(), codigoNomenclatura(), data);
    }
    // T12 (T13 is a no-op: its body is commented out in Java)
    if (aliquotaIS != null) {
      if (item.impostoSeletivo == null) throw E.impostoSeletivoNaoInformado(tipoNomenclatura(), codigoNomenclatura(), data);
      validarQuantidadeEUnidade(item, aliquotaIS);
      tcIS = T.buscarTratamentoClassificacao(ctIS.id, data);
    }
    return {
      tratamentoClassificacaoCbsIbs: tc,
      tratamentoClassificacaoImpostoSeletivo: tcIS,
      tratamentoClassificacaoCbsIbsDesoneracao: tcDeson,
      aliquotaImpostoSeletivo: aliquotaIS,
      temDesoneracao,
    };
  }

  /**
   * ProcessamentoItemService.processarItem up to the engine call (P1..P10): validates and normalizes
   * the item (mutating it like the Java does) and returns the OperacaoModel given to the engine.
   */
  function montarOperacaoModel(operacao, item, data, tipoDfe = null) {
    // P1 (mutates the input)
    if (item.quantidade == null) item.quantidade = Dec.ONE;
    if (item.unidade == null) item.unidade = 'UN';
    // P2
    ajustarNcm(item, tipoDfe);
    // P3 / P4
    const componentes = item.gComponentesBC;
    if (componentes != null && possuiComponentes(componentes)) validarBaseCalculoComComponentes(operacao, item, componentes);
    if (componentes == null || !possuiComponentes(componentes)) validarBaseCalculoLegado(item);
    // P5..P8
    validarNcmNbs(item.ncm, item.nbs, data);
    S.situacaoTributariaService.validarCst(item.cst, TRIBUTO.CBS, data);
    validarAliquotasNominais(item, data);
    const tratamentoClassificacao = obterTratamentoClassificacao(item, data, tipoDfe);
    // P9, P10 (OperacaoModel builder arguments)
    const codigoUf = S.ufService.buscar(operacao.uf);
    const tpEnteGov = tpEnteGovDe(operacao);
    const operacaoModel = {
      data, codigoMunicipio: operacao.municipio, codigoUf, ncm: item.ncm, nbs: item.nbs, tpEnteGov,
      pRedutor: S.redutorCompraGovernamentalService.buscarValorRedutor(tpEnteGov, data),
      item, tratamentoClassificacao,
    };
    verificarEscala(item.aliquotasNominais?.impostoSeletivo?.adRem);
    return operacaoModel;
  }

  /** ProcessamentoItemService.processarItem(operacao, item, data, tipoDfe) → TributosDomain (P11 = CalculoTributoService.calcular). */
  function processarItem(operacao, item, data, tipoDfe = null) {
    return motor.calcular(montarOperacaoModel(operacao, item, data, tipoDfe));
  }

  /** getOperacaoOutput: OperacaoConsumoDomain { gCompraGov: CompraGovernamentalDomain } or null. */
  function operacaoOutput(operacao) {
    const g = operacao.gCompraGov;
    if (g == null) return null;
    const saida = { tpEnteGov: g.tpEnteGov, pRedutor: Dec.ZERO, tpOperGov: g.tpOperGov };
    saida.pRedutor = S.redutorCompraGovernamentalService.buscarValorRedutor(tpEnteGovDe(operacao), fatoGeradorAplicavel(operacao));
    return { gCompraGov: saida };
  }

  // CalculadoraService ------------------------------------------------------------------

  /** CalculadoraService.calcularTributos(operacao) → ROCDomain { oper, objetos, total }. */
  async function calcularTributos(operacao) {
    if (operacao.uf == null) operacao.uf = S.municipioService.buscarUfPorMunicipio(operacao.municipio);
    S.ufService.validarUf(operacao.uf);
    S.municipioService.validarMunicipio(operacao.municipio, operacao.uf);
    const tpDoc = operacao.tpDoc;
    const tipoDfe = S.tipoDfeService.buscarPorTipo(tpDoc, fatoGeradorAplicavel(operacao));
    const data = fatoGeradorAplicavel(operacao);
    const detalhes = [];
    for (const item of operacao.itens) {
      if (item == null) throw new ErroJava('NullPointerException', 'Cannot invoke "br.gov.serpro.rtc.api.model.input.ItemOperacaoInput.getNumero()" because "item" is null');
      const nObj = item.numero;
      const tribCalc = processarItem(operacao, item, data, tipoDfe);
      detalhes.push({ nObj, tribCalc, calculoSimulado: item.aliquotasNominais != null });
    }
    detalhes.sort(compararObjetos); // ObjetoDomain.compareTo (stable)
    const oper = operacaoOutput(operacao);
    return { oper, objetos: detalhes, total: valoresTotais(detalhes) };
  }

  // ObservabilidadeService --------------------------------------------------------------

  /** Phase 1: Bean Validation of the operation (item paths skipped), messages in the request locale. */
  function validarCamposGlobais(operacao, baseURL, locale) {
    const erros = [];
    for (const v of validar(operacao, 'OperacaoInput')) {
      const field = v.caminho;
      if (field.startsWith('itens[') || field.startsWith('itens.')) continue;
      const code = codigoValidacaoDaAnotacao(v.anotacao);
      const pointer = `#/${field.replace(/\[(\d+)]/g, '/$1').replaceAll('.', '/')}`;
      const detail = detalheValidacao(field, interpolar(v.restricao, locale), v.valorInvalido);
      const type = `${baseURL}/calculadora/observabilidade/erros?codigo=${code}`;
      const title = codigoValidacaoPorCodigo(code)?.title ?? 'Erro de validação';
      erros.push(erroDetalhe({ type, title, code, pointer, detail }));
    }
    return erros;
  }

  function processarItemComValidacao(operacao, item, index, data, tipoDfe, baseURL) {
    const collector = new ItemCollector(index, baseURL);
    // item validation runs on a virtual thread: no LocaleContext → JVM default locale
    for (const v of validar(item, 'ItemOperacaoInput')) {
      collector.addErroValidacao(codigoValidacaoDaAnotacao(v.anotacao), v.caminho, detalheValidacao(v.caminho, interpolar(v.restricao, LOCALE_PADRAO), v.valorInvalido));
    }
    const nObj = () => (item.numero != null ? item.numero : index + 1);
    if (collector.hasErros()) return { nObj: nObj(), estadoItem: collector.getEstado(), erros: collector.getErros() };
    try {
      const tributos = processarItem(operacao, item, data, tipoDfe);
      return { nObj: nObj(), estadoItem: item.aliquotasNominais == null ? ESTADO.CALCULADO : ESTADO.CALCULO_SIMULADO, tribCalc: tributos };
    } catch (ex) {
      collector.addErro(ex);
      return { nObj: nObj(), estadoItem: collector.getEstado(), erros: collector.getErros() };
    }
  }

  /** ObservabilidadeService.processarOperacao(operacao, baseURL) → ObservabilidadeROCDomain. `locale` = request locale. */
  async function processarOperacao(operacao, baseURL, locale = LOCALE_PADRAO) {
    const errosGlobais = validarCamposGlobais(operacao, baseURL, locale);
    if (errosGlobais.length) throw new ErrosCalculo(errosGlobais);
    let data;
    let tipoDfe;
    try {
      if (operacao.uf == null) operacao.uf = S.municipioService.buscarUfPorMunicipio(operacao.municipio);
      S.ufService.validarUf(operacao.uf);
      S.municipioService.validarMunicipio(operacao.municipio, operacao.uf);
      data = fatoGeradorAplicavel(operacao);
      tipoDfe = S.tipoDfeService.buscarPorTipo(operacao.tpDoc, data);
    } catch (ex) {
      const collector = new ItemCollector(-1, baseURL);
      collector.addErro(ex);
      throw new ErrosCalculo(collector.getErros());
    }
    const itens = operacao.itens;
    // validator.validate(null) throws outside the per-item try → CompletionException at join() → 500
    if (itens.some((x) => x == null)) {
      throw new ErroJava('CompletionException', 'java.lang.IllegalArgumentException: HV000116: The object to be validated must not be null.');
    }
    const resultados = [];
    for (let i = 0; i < itens.length; i++) resultados.push(processarItemComValidacao(operacao, itens[i], i, data, tipoDfe, baseURL));
    resultados.sort((a, b) => a.nObj - b.nObj); // Comparator.comparing(getNObj), stable
    const calculados = resultados
      .filter((r) => r.estadoItem === ESTADO.CALCULADO || r.estadoItem === ESTADO.CALCULO_SIMULADO)
      .map((r) => ({ nObj: r.nObj, tribCalc: r.tribCalc, calculoSimulado: false }));
    const total = calculados.length === 0 ? null : valoresTotais(calculados);
    return { oper: operacaoOutput(operacao), objetos: resultados, total };
  }

  return {
    servicos: S,
    obterMotor,
    montarOperacaoModel,
    processarItem,
    calcularTributos,
    processarOperacao,
    validarCamposGlobais,
    validarBaseCalculoComComponentes,
    validarBaseCalculoLegado,
    validarQuantidadeEUnidade,
    operacaoOutput,
  };
}

/** ObjetoDomain.compareTo: Comparator.nullsFirst(Integer::compareTo) on nObj. */
export function compararObjetos(a, b) {
  if (a.nObj == null) return b.nObj == null ? 0 : -1;
  if (b.nObj == null) return 1;
  return a.nObj < b.nObj ? -1 : a.nObj > b.nObj ? 1 : 0;
}

/** ObjetoDomain.equals/hashCode (@EqualsAndHashCode(of = "nObj")): only nObj counts (nothing in the API relies on it). */
export const objetosIguais = (a, b) => (a.nObj ?? null) === (b.nObj ?? null);

/** ProcessamentoItemService.isNullOrEmpty: null or String.trim() (chars <= U+0020) empty. */
function isNullOrEmpty(s) {
  return s == null || javaTrim(s).length === 0;
}
