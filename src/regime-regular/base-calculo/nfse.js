// Port of domain/service/nfse/NfseService (E5 base-calculo, E6 indicador-operacao/validate,
// E7 local-operacao, E8 indicador-operacao, E9 situacoes-classificacoes-tributarias,
// E10 locais-fornecimento, E11 locais-incidencia) with the LocalFornecimento/LocalIncidencia
// enums and the IndicadorOperacaoRepository / NbsRepository queries it uses.
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';
import { campoInvalido, mapaDe, somarCadeia, validaAnoInicioTributo, validaValoresForaLimiteVigenciaPermitido } from './base-calculo.js';
import * as SQL from './consultas.js';

const ANO_INICIO_CBS_IBS = 2026;
const ANO_EXTINCAO_PIS_COFINS = 2027;
const ANO_EXTINCAO_ISS = 2033;
const CCLASSTRIB_FALLBACK = '000001';
const MENSAGEM_ERRO_CBS_IBS = `O ano do fato gerador deve ser ${ANO_INICIO_CBS_IBS} ou superior`;
const CLASSE_NFSE = 'br.gov.serpro.rtc.api.model.input.nfse.NfseBaseCalculoInput';

// ─── Enums (código → descrição, declaration order) ─────────────────────────────

export const LOCAIS_FORNECIMENTO = Object.freeze([
  [1, 'Endereço diverso do fornecedor, adquirente ou destinatário'],
  [2, 'Local da prestação do serviço diverso do estabelecimento do fornecedor'],
  [3, 'Endereço do destinatário'],
  [4, 'Endereço fornecido para entrega do bem'],
  [5, 'Estabelecimento do fornecedor como local da prestação'],
  [6, 'Local do porto como local da prestação'],
  [7, 'Local da prestação correspondente à extensão da via explorada, proporcionalmente ao território dos entes tributantes'],
  [8, 'Local da retirada do bem'],
  [9, 'Local de início do transporte'],
  [10, 'Local do domicílio principal do destinatário residente ou domiciliado no País, caso o adquirente não seja residente ou domiciliado no País'],
  [11, 'Local do domicílio principal do adquirente residente ou domiciliado no País. Nas aquisições indicadas no art. 11, §4º, II, considera-se domicílio principal do adquirente o estabelecimento matriz'],
  [12, 'local do domicílio principal do destinatário residente ou domiciliado no País'],
  [13, 'Local do evento a que se refere o serviço'],
  [14, 'Localidade do imóvel'],
  [15, 'Estabelecimento do fornecedor como o local da entrega ou disponibilização do bem ao destinatário'],
  [16, 'Local da realização da operação e sua retirada'],
  [17, 'Endereço do destinatário fornecido para entrega ou disponibilização (assim considerado o destino final indicado pelo adquirente)'],
  [18, 'Local onde se encontra o bem móvel material'],
  [19, 'Local onde se encontra o bem móvel material (Local da retirada)'],
  [20, 'Local do domicílio principal do adquirente (estabelecimento matriz)'],
  [21, 'Domicílio principal do destinatário'],
  [22, 'Local de instalação do terminal'],
  [23, 'Local do domicílio principal do adquirente (assim considerada a matriz), nas aquisições realizadas de forma centralizada por contribuinte sujeito ao regime regular do IBS e da CBS que possui mais de um estabelecimento e que não estejam sujeitas a vedação à apropriação de créditos'],
  [24, 'Local da entrega ou disponibilização'],
  [25, 'Local do estabelecimento principal do adquirente (assim considerada a matriz), conforme §4º do art. 11'],
  [26, 'Local do estabelecimento do agente ou de seus representados que figurem na posição devedora da liquidação financeira apurada pela Câmara de Comercialização de Energia Elétrica'],
  [27, 'Local do estabelecimento principal do fornecedor'],
  [28, 'Local do estabelecimento principal do adquirente'],
  [29, 'Localidade do Imóvel (BICE)'],
].map(([codigo, descricao]) => Object.freeze({ codigo, descricao })));

export const LOCAIS_INCIDENCIA = Object.freeze([
  [1, 'Endereço do Destinatário'],
  [2, 'Endereço do Tomador/Adquirente'],
  [3, 'Estabelecimento do Prestador/Fornecedor'],
  [4, 'Local da Prestação'],
  [5, 'Local do Evento'],
  [6, 'Localidade do Imóvel'],
  [7, 'Localização do Trecho'],
].map(([codigo, descricao]) => Object.freeze({ codigo, descricao })));

/** fromCodigo(int): IllegalArgumentException("Código inválido: " + codigo). */
function fromCodigo(lista, codigo) {
  const v = lista.find((x) => x.codigo === codigo);
  if (!v) throw new ErroJava('IllegalArgumentException', `Código inválido: ${codigo}`);
  return v;
}
export const localFornecimento = (codigo) => fromCodigo(LOCAIS_FORNECIMENTO, codigo);
export const localIncidencia = (codigo) => fromCodigo(LOCAIS_INCIDENCIA, codigo);

/**
 * A LocalDate bound as a JDBC parameter (Hibernate → java.sql.Date.valueOf → sqlite-jdbc with
 * date_string_format=yyyy-MM-dd): the year is printed as the year-of-era of the hybrid
 * Julian/Gregorian calendar (ISO year -2026 → "2027"), the 1582 cutover gap is normalized forward,
 * and a year-of-era above 9999 makes sqlite-jdbc's FastDatePrinter fail ("Index -1 out of bounds
 * for length 4", 500). Only the queries whose Java parameter is a LocalDate use this text; the
 * others receive LocalDate.toString().
 */
export function dataJdbc(data) {
  const m = /^([+-]?)(\d+)-(\d{2})-(\d{2})$/.exec(data);
  const ano = BigInt(m[2]) * (m[1] === '-' ? -1n : 1n);
  const anoEra = ano > 0n ? ano : 1n - ano;
  if (anoEra > 9999n) throw new ErroJava('ArrayIndexOutOfBoundsException', 'Index -1 out of bounds for length 4');
  let dia = m[4];
  if (ano === 1582n && m[3] === '10' && dia >= '05' && dia <= '14') dia = String(Number(dia) + 10);
  return `${String(anoEra).padStart(4, '0')}-${m[3]}-${dia}`;
}

/** ((Number) value).intValue() of a column read by node:sqlite. */
const intValue = (v) => Number(BigInt.asIntN(32, BigInt(v)));

// ─── E5 ─────────────────────────────────────────────────────────────────────

/** NfseService.calcularBaseCalculo → { baseCalculo } (exact). */
export function calcularBaseCalculoNfse(e) {
  const ano = e.anoFatoGerador;
  validaAnoInicioTributo(ano, ANO_INICIO_CBS_IBS, MENSAGEM_ERRO_CBS_IBS);
  validaValoresForaLimiteVigenciaPermitido(mapaDe([['PIS', e.pis], ['COFINS', e.cofins]]), ano, ANO_EXTINCAO_PIS_COFINS);
  validaValoresForaLimiteVigenciaPermitido(mapaDe([['ISS', e.iss]]), ano, ANO_EXTINCAO_ISS);
  const integra = e.valorServico;
  const naoIntegra = somarCadeia(e, ['descontoIncondicional', 'vCalcReeRepRes', 'vCalcDedRedIBSCBS', 'pis', 'cofins', 'iss'], CLASSE_NFSE);
  const baseCalculo = integra.sub(naoIntegra);
  if (baseCalculo.compareTo(Dec.ZERO) < 0) {
    throw campoInvalido('Base de cálculo não pode ser negativa. Valores que não integram a base são maiores que o valor do serviço.');
  }
  return { baseCalculo };
}

// ─── E6..E11 ────────────────────────────────────────────────────────────────

/** formatarCTribNac: "0101" → "1.01", "170101" → "17.01.01"; null/"" → null. */
export function formatarCTribNac(c) {
  if (c == null || c === '') return null;
  const primeiro = String(Number.parseInt(c.slice(0, 2), 10));
  if (c.length === 4) return `${primeiro}.${c.slice(2, 4)}`;
  if (c.length === 6) return `${primeiro}.${c.slice(2, 4)}.${c.slice(4, 6)}`;
  return null;
}

export function criarServicoNfse(base) {
  // NbsRepository.existeNbs(String, LocalDate): the date goes through the JDBC LocalDate binding
  const existeNbs = (codigo, data) => base.count(SQL.EXISTE_NBS, { codigo, data: dataJdbc(data) }) !== 0;

  function mapToIndicadorOperacaoOutput(row) {
    const lf = row.IOIC_CD_LOCAL_FORNECIMENTO_DFE != null ? localFornecimento(intValue(row.IOIC_CD_LOCAL_FORNECIMENTO_DFE)) : null;
    const li = row.IOIC_CD_LOCAL_INCIDENCIA != null ? localIncidencia(intValue(row.IOIC_CD_LOCAL_INCIDENCIA)) : null;
    // JSON (field visibility, alphabetical, @JsonInclude NON_NULL)
    return {
      adquirenteExterior: row.CNIL_IN_ADQ_EXTERIOR != null ? intValue(row.CNIL_IN_ADQ_EXTERIOR) === 1 : null,
      cIndOp: row.IOIC_CD,
      codigoLocalFornecimento: lf?.codigo ?? null,
      codigoLocalIncidencia: li?.codigo ?? null,
      localFornecimento: lf?.descricao ?? null,
      localIncidencia: li?.descricao ?? null,
      prestacaoServicoOnerosa: row.CNIL_IN_PS_ONEROSA != null ? intValue(row.CNIL_IN_PS_ONEROSA) === 1 : null,
      tipoOperacao: row.IOIC_TIPO_OPERACAO,
    };
  }

  return {
    /** E6: { cClassTrib, cIndOp, cTribNac?, dataOcorrenciaFatoGerador, nbs, valido }. */
    validarIndicadorOperacao(e) {
      const resultado = base.count(SQL.VALIDAR_COMBINACAO_EXISTE, {
        nbsCd: e.nbs, cClassTrib: e.cClassTrib, cIndOp: e.cIndOp, cTribNac: formatarCTribNac(e.cTribNac), dataOcorrenciaFatoGerador: e.dataOcorrenciaFatoGerador,
      });
      return {
        cClassTrib: e.cClassTrib,
        cIndOp: e.cIndOp,
        cTribNac: e.cTribNac,
        dataOcorrenciaFatoGerador: e.dataOcorrenciaFatoGerador,
        nbs: e.nbs,
        valido: resultado === 1,
      };
    },

    /** E7: first row of the query; none → IndicadorOperacaoNaoEncontradoException (404). */
    consultarLocalOperacao(cIndOp, data) {
      const linhas = base.all(SQL.BUSCAR_LOCAL_OPERACAO_POR_IND_OP, { cIndOp, data });
      if (!linhas.length) throw new ErroJava('IndicadorOperacaoNaoEncontradoException', `Indicador de operação '${cIndOp}' não encontrado para a data ${data}`);
      const row = linhas[0];
      const lf = row.IOIC_CD_LOCAL_FORNECIMENTO_DFE != null ? localFornecimento(intValue(row.IOIC_CD_LOCAL_FORNECIMENTO_DFE)) : null;
      const li = row.IOIC_CD_LOCAL_INCIDENCIA != null ? localIncidencia(intValue(row.IOIC_CD_LOCAL_INCIDENCIA)) : null;
      return {
        cIndOp,
        codigoLocalFornecimento: lf?.codigo ?? null,
        codigoLocalIncidencia: li?.codigo ?? null,
        dataOcorrenciaFatoGerador: data,
        localFornecimento: lf?.descricao ?? null,
        localIncidencia: li?.descricao ?? null,
      };
    },

    /** E8: by date, optionally filtered by NBS (fallback to the date list when the NBS has no link). */
    consultarIndicadorOperacao(data, nbs) {
      let linhas;
      if (nbs != null && nbs !== '') {
        if (!existeNbs(nbs, data)) throw new ErroJava('NbsNaoEncontradaException', `NBS de código ${nbs} não encontrada para a data ${data}`);
        linhas = base.all(SQL.BUSCAR_INDICADOR_OPERACAO_POR_DATA_COM_NBS, { data: dataJdbc(data), nbs });
        if (!linhas.length) linhas = base.all(SQL.BUSCAR_INDICADOR_OPERACAO_POR_DATA, { data: dataJdbc(data) });
      } else {
        linhas = base.all(SQL.BUSCAR_INDICADOR_OPERACAO_POR_DATA, { data: dataJdbc(data) });
      }
      return linhas.map(mapToIndicadorOperacaoOutput);
    },

    /** E10: all values, or the one of `codigo` (unknown → CampoInvalidoException). */
    consultarLocaisFornecimento(codigo) {
      if (codigo != null) {
        try { return [localFornecimento(codigo)]; } catch (e) { throw campoInvalido(e.mensagem); }
      }
      return [...LOCAIS_FORNECIMENTO];
    },

    /** E11. */
    consultarLocaisIncidencia(codigo) {
      if (codigo != null) {
        try { return [localIncidencia(codigo)]; } catch (e) { throw campoInvalido(e.mensagem); }
      }
      return [...LOCAIS_INCIDENCIA];
    },

    /** E9: classifications linked to the NBS; none → the "000001" fallback (LIMIT 1). */
    consultarSituacoesClassificacoesPorNbs(nbs, data) {
      if (!existeNbs(nbs, data)) throw new ErroJava('NbsNaoEncontradaException', `NBS de código ${nbs} não encontrada para a data ${data}`);
      const lista = base.all(SQL.BUSCAR_SITUACOES_CLASSIFICACOES_POR_NBS_E_DATA, { nbs, data });
      const montar = (r) => ({
        // creator properties first, in constructor order (implicit @AllArgsConstructor creator)
        codigoSituacaoTributaria: r.codigoSituacaoTributaria,
        descricaoSituacaoTributaria: r.descricaoSituacaoTributaria,
        codigoClassificacaoTributaria: r.codigoClassificacaoTributaria,
        descricaoClassificacaoTributaria: r.descricaoClassificacaoTributaria,
      });
      if (!lista.length) {
        const fallback = base.get(SQL.BUSCAR_SITUACAO_CLASSIFICACAO_POR_CLASSIFICACAO, { codigoClassificacaoTributaria: CCLASSTRIB_FALLBACK, data });
        return fallback == null ? [] : [montar(fallback)];
      }
      return lista.map(montar);
    },
  };
}
