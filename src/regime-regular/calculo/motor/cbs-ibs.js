// Port of domain/service/calculotributo/CalculoCbsIbsService (calc-core.md §6): CBS, IBS UF and
// IBS Municipal of one item from the TRATAMENTO_TRIBUTARIO formulas.
//
// ADR003: exact account, each published number rounded once and the published number enters the
// next step: the base (vBC) at 2 places before multiplying; the rate and the effective rate at 4
// places in percentage points (publicarAliquota); value = arred2(vBC x published rate / 100);
// with deferral vDif = arred2(vBC x rate / 100 x pDif / 100) and due = calculated - vDif.
import { Dec } from '../../../core/decimal.js';
import * as A from '../../comum/arredondamento.js';
import { javaIsBlank } from '../../comum/java.js';
import {
  CbsIbsOutput, DiferimentoDomain, GrupoDiferimentoMonofasiaOutput, GrupoEtapaMonofasiaOutput, GrupoMonofasiaOutput,
  ReducaoAliquotaDomain, TributacaoCompraGovernamentalDomain, TributacaoRegularOutput, TributoEnum,
} from './dominios.js';
import * as E from './excecoes.js';
import { avaliar, variaveis, VariavelExpressao as V } from './expressao.js';
import { valorImpostoSeletivoInformado } from './imposto-seletivo.js';

const ZERO = Dec.ZERO;
const CEM_POR_CENTO = Dec.parse('100');
const PBIO = Dec.parse('30');
const PDIF = Dec.parse('100');
const VARIACAO_EAC = Dec.parse('5');
const ALIQUOTA_EAC = Dec.parse('0.1922');
const ALIQUOTA_GASOLINA_TIPO_A = Dec.parse('0.7925');

/** StringUtils.isNotBlank / isNoneBlank (Character.isWhitespace). */
const isNotBlank = (s) => s != null && !javaIsBlank(s);
const isNoneBlank = (...ss) => ss.every(isNotBlank);

/** Unboxing of a java.lang.Boolean: null → NullPointerException. */
function desembrulharBoolean(v, descricao) {
  if (v == null) throw E.nullPointer(`Cannot invoke "java.lang.Boolean.booleanValue()" because the return value of "${descricao}" is null`);
  return v;
}
const DTO_CLASSIFICACAO = 'br.gov.serpro.rtc.domain.model.dto.ClassificacaoTributariaCalculoDTO';

/**
 * expressaoUsaAliquota(e) = isNotBlank(e) && e.matches(".*\\baliquota\\b.*"): String.matches spans
 * the whole string and '.' does not cross line terminators (\n \r U+0085 U+2028 U+2029).
 */
const expressaoUsaAliquota = (e) => isNotBlank(e) && !/[\n\r\x85\u{2028}\u{2029}]/u.test(e) && /\baliquota\b/.test(e);

/** Published rate: fraction → percentage points, rounded once to 4 places, back to a fraction. Null stays null. */
const publicarAliquota = (fracao) => A.percentualParaFracao(A.arredondarAliquotaPublicada(A.fracaoParaPercentual(fracao)));

/** obterFatorBioCombustivel(): 30 / (100 - 30) with MathContext(34). */
const obterFatorBioCombustivel = () => A.dividir(PBIO, CEM_POR_CENTO.subtract(PBIO));

/**
 * @param servicos { percentualReducaoService, aliquotaReferenciaService, aliquotaPadraoService,
 *   aliquotaAdValoremServicoService, tratamentoService, classificacaoTributariaService, situacaoTributariaService }
 */
export function criarCalculoCbsIbs(servicos) {
  const {
    percentualReducaoService, aliquotaReferenciaService, aliquotaPadraoService, aliquotaAdValoremServicoService,
    tratamentoService, classificacaoTributariaService, situacaoTributariaService,
  } = servicos;

  /**
   * calcularCbsIbs(tributo, codigoUf, codigoMunicipio, item, tratamentoClassificacao,
   *   impostoSeletivoCalculado, temTributacaoRegular, data, tpEnteGov, pRedutorCompraGov) → CbsIbsOutput | null
   */
  function calcularCbsIbs(tributo, codigoUf, codigoMunicipio, item, tratamentoClassificacao, impostoSeletivoCalculado,
    temTributacaoRegular, data, tpEnteGov, pRedutorCompraGov) {
    const idTributo = tributo.codigo;

    let cst = null;
    let cClassTrib = null;

    const tratamentoTributario = tratamentoService.buscar(tratamentoClassificacao.idTratamentoTributario);
    const classificacaoTributaria = classificacaoTributariaService.buscarClassificacaoTributariaCalculo(tratamentoClassificacao.idClassificacaoTributaria);
    const situacaoTributaria = situacaoTributariaService.consultarSituacaoTributariaPorCodigo(item.cst, idTributo, data);

    if (temTributacaoRegular) {
      cst = item.tributacaoRegular.cst;
      cClassTrib = item.tributacaoRegular.cClassTrib;
    }

    const expressaoAliquota = tratamentoTributario.expressaoAliquota;
    const expressaoBaseCalculo = tratamentoTributario.expressaoBaseCalculo;
    const expressaoAliquotaEfetiva = tratamentoTributario.expressaoAliquotaEfetiva;
    const expressaoTributoCalculado = tratamentoTributario.expressaoTributoCalculado;
    const expressaoTributoDevido = tratamentoTributario.expressaoTributoDevido;
    const expressaoPercentualDiferimento = tratamentoTributario.expressaoPercentualDiferimento;
    const expressaoValorDiferimento = tratamentoTributario.expressaoValorDiferimento;

    if (tratamentoTributario.inPossuiAjuste) throw E.erroFaltaImplementacao(classificacaoTributaria.codigo);

    const possuiPercentualReducao = Boolean(tratamentoTributario.inPossuiPercentualReducao);

    let valorPercentualReducao = null;
    const valorAjuste = null;
    const valorRedutor = null;

    // the informed base already arrives validated (or derived as BC IS + IS informado)
    const baseCalculoInformada = item.baseCalculo ?? null;
    const quantidade = item.quantidade ?? null;
    let impostoSeletivoInformado = null;
    if (item.impostoSeletivo != null) impostoSeletivoInformado = valorImpostoSeletivoInformado(item.impostoSeletivo);

    const valorAliquotaPadraoOuReferencia = null;
    const valorAliquotaReferencia = null;
    const valorAliquotaAdValorem = null;
    const valorAliquotaAdRem = null;
    let valorAliquota = null;
    // monophasic taxation
    let valorAliquotaAdRemPrincipal = null;
    let valorAliquotaAdRemSecundaria = null;
    let variacaoPontoPercentual = null;
    let pBio = null;
    let pDif = null;

    let resultadoAliquota = null;
    let resultadoAliquotaEfetiva = null;
    let resultadoBaseCalculo = null;
    let resultadoTributoCalculado = null;
    let resultadoTributoDevido = null;
    let resultadoPercentualDiferimento = null;
    let resultadoValorDiferimento = null;

    if (possuiPercentualReducao) {
      const percentualReducao = percentualReducaoService.buscar(classificacaoTributaria.id, idTributo, data);
      valorPercentualReducao = A.percentualParaFracao(percentualReducao);
    }

    // 510001 is computed as "Padrão"
    const tipoAliquota = classificacaoTributaria.codigo === '510001' ? 'Padrão' : classificacaoTributaria.tipoAliquota;

    const aliquotaInformada = obterAliquotaNominal(tributo, item);

    let aliquotaInformadaAplicada = false;
    let aliquotaDivididaPorCem = false;
    if (tipoAliquota == null) throw E.nullPointer('Cannot invoke "String.hashCode()" because "<local32>" is null');
    switch (tipoAliquota) {
      case 'Padrão':
        if (aliquotaInformada != null) {
          valorAliquota = A.percentualParaFracao(aliquotaInformada);
          aliquotaInformadaAplicada = true;
        } else {
          valorAliquota = buscarAliquotaPadrao(idTributo, codigoUf, codigoMunicipio, data);
        }
        aliquotaDivididaPorCem = true;
        break;
      case 'Uniforme nacional (referência)':
        if (aliquotaInformada != null) {
          valorAliquota = A.percentualParaFracao(aliquotaInformada);
          aliquotaInformadaAplicada = true;
        } else {
          valorAliquota = buscarAliquotaReferencia(idTributo, data);
        }
        aliquotaDivididaPorCem = true;
        break;
      case 'Uniforme setorial':
        if (tratamentoTributario.inPossuiMonofasia) {
          // fixed constants of the Java code (gasolina A / EAC); unreachable with the current database
          valorAliquotaAdRemPrincipal = ALIQUOTA_GASOLINA_TIPO_A;
          valorAliquotaAdRemSecundaria = ALIQUOTA_EAC;
          pBio = A.percentualParaFracao(PBIO);
          pDif = A.percentualParaFracao(PDIF);
          variacaoPontoPercentual = VARIACAO_EAC;
        } else {
          if (aliquotaInformada != null) {
            valorAliquota = A.percentualParaFracao(aliquotaInformada);
            aliquotaInformadaAplicada = true;
          } else {
            valorAliquota = buscarAliquotaUniformeSetorial(item.nbs ?? null, idTributo, classificacaoTributaria.id, data);
          }
          aliquotaDivididaPorCem = true;
        }
        break;
      case 'Fixa':
        if (aliquotaInformada != null) {
          valorAliquota = A.percentualParaFracao(aliquotaInformada);
          aliquotaInformadaAplicada = true;
        } else {
          valorAliquota = buscarAliquotaFixa(idTributo, classificacaoTributaria.id, data);
        }
        aliquotaDivididaPorCem = true;
        break;
      case 'Sem alíquota':
        if (aliquotaInformada != null) {
          valorAliquota = A.percentualParaFracao(aliquotaInformada);
          aliquotaInformadaAplicada = true;
          aliquotaDivididaPorCem = true;
        } else {
          valorAliquota = ZERO;
        }
        break;
      case 'Alíquotas Combinadas (Ad Valorem e Ad Rem)':
        break;
      default:
        throw E.tipoAliquotaDesconhecido(tipoAliquota, cClassTrib, cst);
    }

    if (aliquotaInformadaAplicada && !expressaoUsaAliquota(expressaoAliquota)) {
      // the informed nominal rate prevails over a fixed persisted expression such as "0"
      resultadoAliquota = valorAliquota;
    } else if (isNotBlank(expressaoAliquota)) {
      const variaveis0 = variaveis([
        [V.ALIQUOTA, valorAliquota],
        [V.QUANTIDADE, quantidade],
        [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
        [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
        [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
        [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
        [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
        [V.AJUSTE, valorAjuste],
        [V.REDUTOR, valorRedutor],
        [V.ALIQUOTA_AD_REM_PRINCIPAL, valorAliquotaAdRemPrincipal],
        [V.ALIQUOTA_AD_REM_SECUNDARIA, valorAliquotaAdRemSecundaria],
        [V.VARIACAO_PONTO_PERCENTUAL, variacaoPontoPercentual],
        [V.PERCENTUAL_BIOCOMBUSTIVEL, pBio],
        [V.PERCENTUAL_DIFERIMENTO, pDif],
      ]);
      resultadoAliquota = avaliar(expressaoAliquota, variaveis0);
    }

    if (aliquotaDivididaPorCem) {
      // the rate goes to the document with up to 4 places and that is the one that continues
      resultadoAliquota = publicarAliquota(resultadoAliquota);
    }

    if (isNotBlank(expressaoAliquotaEfetiva)) {
      const variaveis1 = variaveis([
        [V.QUANTIDADE, quantidade],
        [V.ALIQUOTA, resultadoAliquota],
        [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
        [V.PERCENTUAL_REDUCAO_COMPRA_GOV, pRedutorCompraGov],
        [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
        [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
        [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
        [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
        [V.AJUSTE, valorAjuste],
        [V.REDUTOR, valorRedutor],
        [V.ALIQUOTA_AD_REM_PRINCIPAL, valorAliquotaAdRemPrincipal],
        [V.ALIQUOTA_AD_REM_SECUNDARIA, valorAliquotaAdRemSecundaria],
        [V.VARIACAO_PONTO_PERCENTUAL, variacaoPontoPercentual],
        [V.PERCENTUAL_BIOCOMBUSTIVEL, pBio],
        [V.PERCENTUAL_DIFERIMENTO, pDif],
      ]);
      resultadoAliquotaEfetiva = avaliar(expressaoAliquotaEfetiva, variaveis1);
      // effective rate: rounded once to 4 places; it is the one that multiplies the base
      if (aliquotaDivididaPorCem) resultadoAliquotaEfetiva = publicarAliquota(resultadoAliquotaEfetiva);
    }

    const variaveis2 = variaveis([
      [V.QUANTIDADE, quantidade],
      [V.ALIQUOTA, resultadoAliquota],
      [V.ALIQUOTA_EFETIVA, resultadoAliquotaEfetiva],
      [V.IMPOSTO_SELETIVO_INFORMADO, impostoSeletivoInformado],
      [V.BASE_CALCULO_INFORMADA, baseCalculoInformada],
      [V.IMPOSTO_SELETIVO_CALCULADO, impostoSeletivoCalculado],
      [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
      [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
      [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
      [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
      [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
      [V.AJUSTE, valorAjuste],
      [V.REDUTOR, valorRedutor],
      [V.ALIQUOTA_AD_REM_PRINCIPAL, valorAliquotaAdRemPrincipal],
      [V.ALIQUOTA_AD_REM_SECUNDARIA, valorAliquotaAdRemSecundaria],
      [V.VARIACAO_PONTO_PERCENTUAL, variacaoPontoPercentual],
      [V.PERCENTUAL_BIOCOMBUSTIVEL, pBio],
      [V.PERCENTUAL_DIFERIMENTO, pDif],
    ]);
    resultadoBaseCalculo = avaliar(expressaoBaseCalculo, variaveis2);
    // the base is rounded to 2 places before multiplying (in the monophasic taxation it is a quantity)
    if (!tratamentoTributario.inPossuiMonofasia) resultadoBaseCalculo = A.arredondarValorFiscal(resultadoBaseCalculo);
    if (resultadoBaseCalculo.compareTo(ZERO) < 0) resultadoBaseCalculo = ZERO;

    const variaveis3 = variaveis([
      [V.QUANTIDADE, quantidade],
      [V.BASE_CALCULO, resultadoBaseCalculo],
      [V.ALIQUOTA, resultadoAliquota],
      [V.ALIQUOTA_EFETIVA, resultadoAliquotaEfetiva],
      [V.BASE_CALCULO_INFORMADA, baseCalculoInformada],
      [V.IMPOSTO_SELETIVO_INFORMADO, impostoSeletivoInformado],
      [V.IMPOSTO_SELETIVO_CALCULADO, impostoSeletivoCalculado],
      [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
      [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
      [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
      [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
      [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
      [V.AJUSTE, valorAjuste],
      [V.REDUTOR, valorRedutor],
      [V.ALIQUOTA_AD_REM_PRINCIPAL, valorAliquotaAdRemPrincipal],
      [V.ALIQUOTA_AD_REM_SECUNDARIA, valorAliquotaAdRemSecundaria],
      [V.VARIACAO_PONTO_PERCENTUAL, variacaoPontoPercentual],
      [V.PERCENTUAL_BIOCOMBUSTIVEL, pBio],
      [V.PERCENTUAL_DIFERIMENTO, pDif],
    ]);
    // exact account over the published numbers (base and effective rate), rounded once
    const tributoCalculadoExato = avaliar(expressaoTributoCalculado, variaveis3);
    resultadoTributoCalculado = A.arredondarValorFiscal(tributoCalculadoExato);

    if (isNotBlank(expressaoTributoDevido)) {
      const variaveis4 = variaveis([
        [V.TRIBUTO_CALCULADO, resultadoTributoCalculado],
        [V.QUANTIDADE, quantidade],
        [V.BASE_CALCULO, resultadoBaseCalculo],
        [V.ALIQUOTA, resultadoAliquota],
        [V.ALIQUOTA_EFETIVA, resultadoAliquotaEfetiva],
        [V.BASE_CALCULO_INFORMADA, baseCalculoInformada],
        [V.IMPOSTO_SELETIVO_INFORMADO, impostoSeletivoInformado],
        [V.IMPOSTO_SELETIVO_CALCULADO, impostoSeletivoCalculado],
        [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
        [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
        [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
        [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
        [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
        [V.AJUSTE, valorAjuste],
        [V.REDUTOR, valorRedutor],
        [V.ALIQUOTA_AD_REM_PRINCIPAL, valorAliquotaAdRemPrincipal],
        [V.ALIQUOTA_AD_REM_SECUNDARIA, valorAliquotaAdRemSecundaria],
        [V.VARIACAO_PONTO_PERCENTUAL, variacaoPontoPercentual],
        [V.PERCENTUAL_BIOCOMBUSTIVEL, pBio],
        [V.PERCENTUAL_DIFERIMENTO, pDif],
      ]);
      resultadoTributoDevido = A.arredondarValorFiscal(avaliar(expressaoTributoDevido, variaveis4));
    }

    if (isNoneBlank(expressaoPercentualDiferimento, expressaoValorDiferimento)) {
      // note: no pBio / percentualDiferimento / ad rem variables here (a formula using them would fail)
      const variaveis5 = variaveis([
        [V.TRIBUTO_CALCULADO, resultadoTributoCalculado],
        [V.QUANTIDADE, quantidade],
        [V.BASE_CALCULO, resultadoBaseCalculo],
        [V.ALIQUOTA, resultadoAliquota],
        [V.ALIQUOTA_EFETIVA, resultadoAliquotaEfetiva],
        [V.BASE_CALCULO_INFORMADA, baseCalculoInformada],
        [V.IMPOSTO_SELETIVO_INFORMADO, impostoSeletivoInformado],
        [V.IMPOSTO_SELETIVO_CALCULADO, impostoSeletivoCalculado],
        [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
        [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
        [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
        [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
        [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
        [V.AJUSTE, valorAjuste],
        [V.REDUTOR, valorRedutor],
      ]);
      // pDif published with up to 4 places (percentage points)
      resultadoPercentualDiferimento = publicarAliquota(avaliar(expressaoPercentualDiferimento, variaveis5));

      // vDif = arred2(vBC x published rate / 100 x pDif / 100): the formula gets the EXACT calculated tax
      const variaveis6 = variaveis([
        [V.PERCENTUAL_DIFERIMENTO, resultadoPercentualDiferimento],
        [V.TRIBUTO_CALCULADO, tributoCalculadoExato],
        [V.QUANTIDADE, quantidade],
        [V.BASE_CALCULO, resultadoBaseCalculo],
        [V.ALIQUOTA, resultadoAliquota],
        [V.ALIQUOTA_EFETIVA, resultadoAliquotaEfetiva],
        [V.BASE_CALCULO_INFORMADA, baseCalculoInformada],
        [V.IMPOSTO_SELETIVO_INFORMADO, impostoSeletivoInformado],
        [V.IMPOSTO_SELETIVO_CALCULADO, impostoSeletivoCalculado],
        [V.PERCENTUAL_REDUCAO, valorPercentualReducao],
        [V.ALIQUOTA_PADRAO_OU_REFERENCIA, valorAliquotaPadraoOuReferencia],
        [V.ALIQUOTA_REFERENCIA, valorAliquotaReferencia],
        [V.ALIQUOTA_AD_VALOREM, valorAliquotaAdValorem],
        [V.ALIQUOTA_AD_REM, valorAliquotaAdRem],
        [V.AJUSTE, valorAjuste],
        [V.REDUTOR, valorRedutor],
      ]);
      resultadoValorDiferimento = A.arredondarValorFiscal(avaliar(expressaoValorDiferimento, variaveis6));

      // due value: calculated minus the deferral, discounted once
      resultadoTributoDevido = resultadoTributoCalculado.subtract(resultadoValorDiferimento);
      if (resultadoTributoDevido.compareTo(ZERO) < 0) resultadoTributoDevido = ZERO;
    }

    if (situacaoTributaria == null) {
      throw E.nullPointer('Cannot invoke "br.gov.serpro.rtc.domain.model.entity.SituacaoTributaria.getInGrupoIbsCbs()" because "situacaoTributaria" is null');
    }
    // CST without the IBS/CBS group: everything was calculated and is discarded
    if (!desembrulharBoolean(situacaoTributaria.inGrupoIbsCbs, 'br.gov.serpro.rtc.domain.model.entity.SituacaoTributaria.getInGrupoIbsCbs()')) return null;

    // builder arguments are evaluated in this order (grupoReducao ... quantidade)
    const inGrupoReducao = desembrulharBoolean(classificacaoTributaria.inGrupoReducao, `${DTO_CLASSIFICACAO}.inGrupoReducao()`);
    const grupoReducao = !inGrupoReducao || (temTributacaoRegular && tpEnteGov == null)
      ? null
      : obterGrupoReducao(classificacaoTributaria, resultadoAliquotaEfetiva, valorPercentualReducao, aliquotaDivididaPorCem);
    const compraGovernamental = obterGrupoCompraGov(tpEnteGov, TributoEnum.get(idTributo), resultadoAliquotaEfetiva, resultadoTributoDevido);
    const tributacaoRegular = temTributacaoRegular
      ? obterGrupoDesoneracao(cst, cClassTrib, resultadoBaseCalculo, resultadoAliquota, valorPercentualReducao ?? ZERO,
        aliquotaDivididaPorCem, possuiPercentualReducao)
      : null;
    const grupoDiferimento = obterGrupoDiferimento(resultadoValorDiferimento, resultadoPercentualDiferimento);
    const grupoMonofasia = obterGrupoMonofasia(classificacaoTributaria, quantidade, resultadoAliquota, resultadoAliquotaEfetiva,
      resultadoTributoCalculado, resultadoTributoDevido, variacaoPontoPercentual);
    return CbsIbsOutput.builder({
      grupoReducao,
      compraGovernamental,
      tributacaoRegular,
      grupoDiferimento,
      grupoMonofasia,
      tributoCalculado: temTributacaoRegular ? ZERO : resultadoTributoCalculado,
      tributoDevido: temTributacaoRegular ? ZERO : resultadoTributoDevido,
      aliquota: temTributacaoRegular ? ZERO
        : (aliquotaDivididaPorCem && resultadoAliquota != null ? resultadoAliquota.movePointRight(2) : resultadoAliquota),
      baseCalculo: resultadoBaseCalculo,
      quantidade,
    });
  }

  function obterGrupoCompraGov(tpEnteGov, t, aliquota, valor) {
    if (tpEnteGov == null) return null;
    const exigir = (a) => {
      if (a == null) throw E.nullPointer('Cannot invoke "java.math.BigDecimal.movePointRight(int)" because "aliquota" is null');
      return a.movePointRight(2); // not divided by 100
    };
    switch (t.nome) {
      case 'CBS': return TributacaoCompraGovernamentalDomain.builder({ pAliqCBS: exigir(aliquota), vTribCBS: valor });
      case 'IBS_ESTADUAL': return TributacaoCompraGovernamentalDomain.builder({ pAliqIBSUF: exigir(aliquota), vTribIBSUF: valor });
      case 'IBS_MUNICIPAL': return TributacaoCompraGovernamentalDomain.builder({ pAliqIBSMun: exigir(aliquota), vTribIBSMun: valor });
      default: throw E.runtime(`Tributo ${t.nome} nao possui compra governamental`);
    }
  }

  const buscarAliquotaReferencia = (idTributo, data) => A.percentualParaFracao(aliquotaReferenciaService.buscar(idTributo, data));

  /** protected buscarAliquotaPadrao(idTributo, codigoUf, codigoMunicipio, data): fraction of the applicable rate. */
  function buscarAliquotaPadrao(idTributo, codigoUf, codigoMunicipio, data) {
    const aliquota = aliquotaPadraoService.buscarAliquota(idTributo, codigoUf, codigoMunicipio, data);
    return A.percentualParaFracao(aliquota.valorAplicavel());
  }

  function buscarAliquotaUniformeSetorial(nbs, idTributo, idClassificacaoTributaria, data) {
    let v = aliquotaAdValoremServicoService.buscarAliquotaAdValorem(nbs, idTributo, idClassificacaoTributaria, data);
    if (v == null) {
      v = aliquotaAdValoremServicoService.buscarAliquotaAdValoremPorClassificacaoTributaria(idTributo, idClassificacaoTributaria, data);
      if (v == null) throw E.erroGenericoValidacao(`Alíquota uniforme setorial não encontrada em ${data}`);
    }
    return A.percentualParaFracao(v);
  }

  function buscarAliquotaFixa(idTributo, idClassificacaoTributaria, data) {
    const v = aliquotaAdValoremServicoService.buscarAliquotaAdValoremPorClassificacaoTributaria(idTributo, idClassificacaoTributaria, data);
    if (v == null) throw E.erroGenericoValidacao(`Alíquota fixa não encontrada em ${data}`);
    return A.percentualParaFracao(v);
  }

  return { calcularCbsIbs, buscarAliquotaPadrao };
}

function obterAliquotaNominal(tributo, item) {
  const an = item.aliquotasNominais;
  if (an == null) return null;
  switch (tributo.nome) {
    case 'CBS': return an.cbs ?? null;
    case 'IBS_ESTADUAL': return an.ibsEstadual ?? null;
    case 'IBS_MUNICIPAL': return an.ibsMunicipal ?? null;
    default: return null;
  }
}

function obterGrupoReducao(classificacaoTributaria, aliquotaEfetiva, percentualReducao, aliquotaDivididaPorCem) {
  if (percentualReducao == null || aliquotaEfetiva == null || !classificacaoTributaria.inGrupoReducao) return null;
  return ReducaoAliquotaDomain.builder({
    pRedAliq: percentualReducao.movePointRight(2), // not sent divided by 100
    pAliqEfet: aliquotaDivididaPorCem ? aliquotaEfetiva.movePointRight(2) : aliquotaEfetiva,
  });
}

function obterGrupoDesoneracao(cst, cClassTrib, baseCalculo, aliquota, percentualReducao, aliquotaDivididaPorCem, possuiPercentualReducao) {
  let aliquotaEfetiva = aliquota;
  if (possuiPercentualReducao && percentualReducao != null) {
    const redutor = Dec.ONE.subtract(percentualReducao);
    aliquotaEfetiva = A.multiplicar(aliquota, redutor);
  }
  // effective rate of the regular taxation: 4 places, and it multiplies the base (no purchase reducer)
  if (aliquotaDivididaPorCem) aliquotaEfetiva = publicarAliquota(aliquotaEfetiva);
  const tributoDevido = A.arredondarValorFiscal(A.multiplicar(baseCalculo, aliquotaEfetiva));
  return TributacaoRegularOutput.builder({
    cst,
    cClassTrib,
    baseCalculo,
    aliquotaEfetiva: aliquotaDivididaPorCem ? aliquotaEfetiva.movePointRight(2) : aliquotaEfetiva,
    tributoDevido,
  });
}

function obterGrupoDiferimento(valorDiferimento, percentualDiferimento) {
  if (valorDiferimento == null || percentualDiferimento == null) return null;
  return DiferimentoDomain.builder({ vDif: valorDiferimento, pDif: percentualDiferimento.movePointRight(2) });
}

/** Always a non-null group; the inner groups only when the classification flags are true. */
function obterGrupoMonofasia(cls, quantidade, aliquotaAdRemPrincipal, aliquotaAdRemSecundaria, tributoCalculado, tributoDevido, variacaoPontoPercentual) {
  const flag = (nome) => desembrulharBoolean(cls[nome], `${DTO_CLASSIFICACAO}.${nome}()`);
  const npe = (v, nome) => { if (v == null) throw E.nullPointer(`Cannot invoke "java.math.BigDecimal.${nome}" because a value is null`); return v; };
  let grupoGMonoPadrao = null;
  let grupoGMonoReten = null;
  let grupoGMonoRet = null;
  let grupoGMonoDiferimento = null;
  if (flag('inGrupoMonofasiaPadrao')) {
    const ret = flag('inGrupoMonofasiaRet');
    grupoGMonoPadrao = GrupoEtapaMonofasiaOutput.builder({
      quantidade: !ret ? quantidade : A.percentualParaFracao(npe(quantidade, 'multiply(java.math.BigDecimal)').multiply(npe(variacaoPontoPercentual, 'multiply(java.math.BigDecimal)'))),
      aliquotaAdRem: A.arredondarAliquotaPublicada(!flag('inGrupoMonofasiaRet') ? aliquotaAdRemPrincipal : aliquotaAdRemSecundaria),
      valor: tributoCalculado,
    });
  }
  if (flag('inGrupoMonofasiaReten')) {
    grupoGMonoReten = GrupoEtapaMonofasiaOutput.builder({
      quantidade: A.multiplicar(quantidade, obterFatorBioCombustivel()),
      aliquotaAdRem: A.arredondarAliquotaPublicada(aliquotaAdRemSecundaria),
      valor: tributoDevido,
    });
  }
  if (flag('inGrupoMonofasiaRet')) {
    grupoGMonoRet = GrupoEtapaMonofasiaOutput.builder({
      quantidade,
      aliquotaAdRem: A.arredondarAliquotaPublicada(aliquotaAdRemPrincipal),
      valor: tributoDevido,
    });
  }
  if (flag('inGrupoMonofasiaDiferimento')) {
    const diferenca = npe(tributoCalculado, 'subtract(java.math.BigDecimal)').subtract(npe(tributoDevido, 'subtract(java.math.BigDecimal)'));
    grupoGMonoDiferimento = GrupoDiferimentoMonofasiaOutput.builder({
      // tributoCalculado = 0 → ArithmeticException (Division by zero / Division undefined)
      percentualDiferimento: A.arredondarAliquotaPublicada(A.fracaoParaPercentual(A.dividir(diferenca, tributoCalculado))),
      valorDiferimento: tributoCalculado.subtract(tributoDevido),
    });
  }
  return GrupoMonofasiaOutput.builder({
    tributoMonofasico: grupoGMonoPadrao,
    tributoSujeitoRetencao: grupoGMonoReten,
    tributoRetido: grupoGMonoRet,
    tributoDiferido: grupoGMonoDiferimento,
  });
}
