// Port of domain/service/calculotributo/CalculoImpostoSeletivoService (calc-core.md §5).
// ADR003: the base (vBCIS) is rounded to 2 places and the rates (pIS, adRemIS) to 4 places before
// the account; vIS is the exact account over those published numbers, rounded once.
import { Dec } from '../../../core/decimal.js';
import * as A from '../../comum/arredondamento.js';
import { javaIsBlank } from '../../comum/java.js';
import { ImpostoSeletivoDomain } from './dominios.js';
import { nullPointer } from './excecoes.js';
import { avaliar, variaveis, VariavelExpressao as V } from './expressao.js';

const isNotBlank = (s) => s != null && !javaIsBlank(s);

/** ImpostoSeletivoInput.getValorImpostoSeletivoInformado(): impostoInformado or ZERO. */
export const valorImpostoSeletivoInformado = (is) => (is.impostoInformado != null ? is.impostoInformado : Dec.ZERO);

export function criarCalculoImpostoSeletivo({ tratamentoService }) {
  /**
   * calcularImpostoSeletivo(idTributo (1, unused), item, tratamentoClassificacao, aliquotaImpostoSeletivo, data)
   * → ImpostoSeletivoDomain (memoriaCalculo still null).
   */
  function calcularImpostoSeletivo(idTributo, item, tratamentoClassificacao, aliquotaImpostoSeletivo, data) {
    const tt = tratamentoService.buscar(tratamentoClassificacao.idTratamentoTributario);
    const expressaoBaseCalculo = tt.expressaoBaseCalculo;
    const expressaoTributoCalculado = tt.expressaoTributoCalculado;
    const expressaoTributoDevido = tt.expressaoTributoDevido;

    const valorPercentualReducao = null;
    const valorAjuste = null;
    const valorRedutor = null;

    const is = item.impostoSeletivo;
    const cst = is.cst;
    const cClassTrib = is.cClassTrib;
    const unidade = is.unidade;
    const memoriaCalculo = null;
    const baseCalculoInformada = is.baseCalculo;
    const quantidade = is.quantidade ?? null;
    const impostoSeletivoInformado = valorImpostoSeletivoInformado(is);
    const impostoSeletivoCalculado = Dec.ZERO;

    const valorAliquotaPadraoOuReferencia = null;
    const valorAliquotaReferencia = null;

    if (aliquotaImpostoSeletivo == null) {
      throw nullPointer('Cannot invoke "br.gov.serpro.rtc.domain.service.calculotributo.model.AliquotaImpostoSeletivoModel.getAliquotaAdValorem()" because "aliquotaImpostoSeletivo" is null');
    }
    // published rates (4 places) are the ones that enter the account
    let valorAliquotaAdValorem = A.arredondarAliquotaPublicada(aliquotaImpostoSeletivo.aliquotaAdValorem ?? null);
    if (valorAliquotaAdValorem != null) valorAliquotaAdValorem = A.percentualParaFracao(valorAliquotaAdValorem);
    const valorAliquotaAdRem = A.arredondarAliquotaPublicada(aliquotaImpostoSeletivo.aliquotaAdRem ?? null);

    // the rate and effective rate phases are commented out in the Java: both stay null
    const resultadoAliquota = null;
    const resultadoAliquotaEfetiva = null;

    const variaveis2 = variaveis([
      [V.QUANTIDADE, quantidade],
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
    // published base (2 places) enters the account
    const resultadoBaseCalculo = A.arredondarValorFiscal(avaliar(expressaoBaseCalculo, variaveis2));

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
    ]);
    // exact account over the published numbers, rounded once
    const resultadoTributoCalculado = A.arredondarValorFiscal(avaliar(expressaoTributoCalculado, variaveis3));

    let resultadoTributoDevido = null;
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
      ]);
      resultadoTributoDevido = A.arredondarValorFiscal(avaliar(expressaoTributoDevido, variaveis4));
    }

    return ImpostoSeletivoDomain.builder({
      CSTIS: cst,
      cClassTribIS: cClassTrib,
      qTrib: quantidade,
      uTrib: unidade ?? null,
      vIS: resultadoTributoDevido,
      pIS: A.fracaoParaPercentual(valorAliquotaAdValorem), // not divided by 100
      pISEspec: valorAliquotaAdRem, // deprecated, kept for old clients
      adRemIS: valorAliquotaAdRem,
      vBCIS: resultadoBaseCalculo,
      memoriaCalculo,
    });
  }

  return { calcularImpostoSeletivo };
}
