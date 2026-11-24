// Calculation engine of calculadora-rtc-regime-regular 1.7.2: CalculoTributoService.calcular(OperacaoModel)
// → TributosDomain, plus the Jackson serialization of the result (CONTRATO-PORTE.md, "Interface
// motor ↔ orquestração").
//
//   const motor = criarMotor(base);
//   const tributos = motor.calcular(operacaoModel);     // { IS, IBSCBS } with Dec values (Java field names)
//   const tribCalc = motor.serializarTributos(tributos); // ordered object, numbers as strings, nulls omitted
//
// operacaoModel = { data: 'AAAA-MM-DD', codigoMunicipio, codigoUf, ncm, nbs, tpEnteGov (1..6 | null),
//   pRedutor: Dec, item: ItemOperacaoInput (Java field names, BigDecimal → Dec, quantidade/unidade/
//   baseCalculo already filled), tratamentoClassificacao: { tratamentoClassificacaoCbsIbs,
//   tratamentoClassificacaoCbsIbsDesoneracao, temDesoneracao, tratamentoClassificacaoImpostoSeletivo,
//   aliquotaImpostoSeletivo: { aliquotaAdValorem, aliquotaAdRem, unidadeMedida } } } where each
//   tratamentoClassificacao* = { idTratamentoTributario, idClassificacaoTributaria,
//   inIncompativelComSuspensao, inExigeGrupoDesoneracao }.
// Engine exceptions are ErroJava (comum/problema.js) named after the Java class; serialization
// failures are ErroSerializacao.
import { criarCalculoCbsIbs } from './cbs-ibs.js';
import { criarCalculoImpostoSeletivo } from './imposto-seletivo.js';
import { criarCalculoTributo } from './calculo-tributo.js';
import { criarMemoriaCalculo } from './memoria-calculo.js';
import { criarServicos } from './consultas.js';
import { serializarTributos } from './serializacao.js';
import { ErroJava } from '../../comum/problema.js';

/**
 * @param base read-only connection (src/core/db.js)
 * @param opcoes { servicos: overrides of the repository services (tests), calculoIbsHabilitado,
 *   memoriaCalculoHabilitada } — both flags are true in the official offline profile.
 */
export function criarMotor(base, { servicos: substitutos = {}, calculoIbsHabilitado = true, memoriaCalculoHabilitada = true } = {}) {
  const servicos = { ...(base ? criarServicos(base) : {}), ...substitutos };
  const calculoCbsIbs = criarCalculoCbsIbs(servicos);
  const calculoImpostoSeletivo = criarCalculoImpostoSeletivo(servicos);
  const memoriaCalculo = criarMemoriaCalculo(servicos, { habilitada: memoriaCalculoHabilitada });
  const calculoTributo = criarCalculoTributo(
    { calculoCbsIbs, calculoImpostoSeletivo, memoriaCalculo, transferenciaService: servicos.transferenciaService },
    { calculoIbsHabilitado },
  );
  return {
    /** CalculoTributoService.calcular. JDK exceptions raised by Dec (ArithmeticException, NumberFormatException) come out as ErroJava too. */
    calcular(operacao) {
      try {
        return calculoTributo.calcular(operacao);
      } catch (e) {
        if (!(e instanceof ErroJava) && e?.classeJava) throw new ErroJava(e.classeJava, e.mensagemJava !== undefined ? e.mensagemJava : e.message);
        throw e;
      }
    },
    serializarTributos,
    // internals exposed for the unit vectors and the orchestration's own lookups
    servicos,
    calculoCbsIbs,
    calculoImpostoSeletivo,
    memoriaCalculo,
  };
}

export { serializarTributos } from './serializacao.js';
export * as dominios from './dominios.js';
export { avaliar, variaveis, VariavelExpressao } from './expressao.js';
