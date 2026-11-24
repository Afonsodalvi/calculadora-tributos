// Repository queries used by the dados-abertos area, as specified in .work/spec/regreg/dados-abertos.md:
// native queries verbatim, JPQL translated 1:1 to the real table/column names. Where the Java query has no
// ORDER BY, the "effective order" the official API gets from the SQLite plan is made explicit (spec §1.9).
// Dates are bound as the text sqlite-jdbc gives a java.sql.Date (datas.js dataSql); Long ids as BigInt.
// REAL columns that Java reads with getBigDecimal come as CAST(x AS TEXT) (the driver builds the BigDecimal
// from SQLite's text); REAL columns of native queries (Float in Java) come as numbers.
import { dataSql } from './datas.js';

// ─── UF / município / situação tributária ─────────────────────────────────────

/** UfRepository.findAll (rowid order = UF_CD). */
export const consultarUfs = (base) => base.all('SELECT u.UF_CD, u.UF_NOME, u.UF_SIGLA FROM UF u ORDER BY u.UF_CD');

/** MunicipioRepository.consultarTodosPorSiglaUf (no vigência filter). */
export const consultarMunicipiosPorSiglaUf = (base, uf) => base.all(`
SELECT m.MUNI_CD, m.MUNI_NOME, m.MUNI_UF_CD
FROM MUNICIPIO m JOIN UF u ON u.UF_CD = m.MUNI_UF_CD
WHERE lower(u.UF_SIGLA) = lower(:uf)
ORDER BY m.MUNI_CD`, { uf });

/** SituacaoTributariaRepository.consultarPorIdTributo (only the link's vigência). */
export const consultarSituacoesPorIdTributo = (base, idTributo, data) => base.all(`
SELECT st.SITR_ID, st.SITR_CD, st.SITR_DESCRICAO
FROM TRIBUTO_SITUACAO_TRIBUTARIA tst JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = tst.TRST_SITR_ID
WHERE tst.TRST_TBTO_ID = :idTributo
  AND tst.TRST_INICIO_VIGENCIA <= :data AND (tst.TRST_FIM_VIGENCIA IS NULL OR tst.TRST_FIM_VIGENCIA >= :data)
ORDER BY tst.TRST_ID`, { idTributo: BigInt(idTributo), data: dataSql(data) });

// ─── TratamentoClassificacaoRepository (native) ────────────────────────────────

/** consultarTratamentoClassificacaoPorIdSituacaoTributaria → rows indexed as the Java Object[] (MAP_A). */
export const consultarTratamentoPorIdSituacao = (base, idSituacaoTributaria, data) => base.all(`
SELECT
    ct.CLTR_CD,
    ct.CLTR_DESCRICAO,
    ct.CLTR_TIPO_ALIQUOTA,
    ct.CLTR_NOMENCLATURA,
    tt.TRTR_DESCRICAO,
    tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO,
    tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO,
    st.SITR_IND_GRED,
    ct.CLTR_ID,
    ct.CLTR_DATA_ATUALIZACAO
FROM TRATAMENTO_CLASSIFICACAO tc
JOIN CLASSIFICACAO_TRIBUTARIA ct ON tc.TRCL_CLTR_ID = ct.CLTR_ID
JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
WHERE ct.CLTR_SITR_ID = :idSituacaoTributaria
    AND :data BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :data)
    AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
    AND :data BETWEEN tt.TRTR_INICIO_VIGENCIA AND COALESCE(tt.TRTR_FIM_VIGENCIA, :data)
    AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
ORDER BY ct.CLTR_CD`, { idSituacaoTributaria, data: dataSql(data) }).map(Object.values);

/** consultarTratamentoClassificacaoCbsIbs(codigo | null) → Object[] rows (MAP_B). */
export const consultarTratamentoCbsIbs = (base, codigo, data) => base.all(`
SELECT
    ct.CLTR_ID,
    ct.CLTR_CD,
    ct.CLTR_DESCRICAO,
    ct.CLTR_TIPO_ALIQUOTA,
    ct.CLTR_NOMENCLATURA,
    tt.TRTR_DESCRICAO,
    tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO,
    tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO,
    st.SITR_IND_GRED,
    ct.CLTR_IN_APROPRIACAO_CREDITOS_ADQUIRENTES_CBS,
    ct.CLTR_IN_APROPRIACAO_CREDITOS_ADQUIRENTES_IBS,
    ct.CLTR_IN_CREDITO_PRESUMIDO_FORNECEDOR,
    ct.CLTR_IN_CREDITO_PRESUMIDO_ADQUIRENTE,
    ct.CLTR_CREDITO_OPERACAO_ANTECEDENTE,
    -- Percentual de redução por tributo
    pr_cbs.PERE_VALOR AS PERCENTUAL_REDUCAO_CBS,
    pr_ibsuf.PERE_VALOR AS PERCENTUAL_REDUCAO_IBSUF,
    pr_ibsmun.PERE_VALOR AS PERCENTUAL_REDUCAO_IBSMUN,
    -- Dados novos da situação tributária
    st.SITR_IND_GDIF,
    ct.CLTR_DATA_ATUALIZACAO,
    ct.CLTR_TPRBSN
FROM TRATAMENTO_CLASSIFICACAO tc
JOIN CLASSIFICACAO_TRIBUTARIA ct ON tc.TRCL_CLTR_ID = ct.CLTR_ID
JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = ct.CLTR_SITR_ID
-- LEFT JOINs para percentuais de redução por tributo
LEFT JOIN PERCENTUAL_REDUCAO pr_cbs ON pr_cbs.PERE_CLTR_ID = ct.CLTR_ID
    AND pr_cbs.PERE_TBTO_ID = 2 -- CBS
    AND :data BETWEEN pr_cbs.PERE_INICIO_VIGENCIA AND COALESCE(pr_cbs.PERE_FIM_VIGENCIA, :data)
LEFT JOIN PERCENTUAL_REDUCAO pr_ibsuf ON pr_ibsuf.PERE_CLTR_ID = ct.CLTR_ID
    AND pr_ibsuf.PERE_TBTO_ID = 3 -- IBSUF
    AND :data BETWEEN pr_ibsuf.PERE_INICIO_VIGENCIA AND COALESCE(pr_ibsuf.PERE_FIM_VIGENCIA, :data)
LEFT JOIN PERCENTUAL_REDUCAO pr_ibsmun ON pr_ibsmun.PERE_CLTR_ID = ct.CLTR_ID
    AND pr_ibsmun.PERE_TBTO_ID = 4 -- IBSMun
    AND :data BETWEEN pr_ibsmun.PERE_INICIO_VIGENCIA AND COALESCE(pr_ibsmun.PERE_FIM_VIGENCIA, :data)
WHERE :data BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :data)
  AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
  AND :data BETWEEN tt.TRTR_INICIO_VIGENCIA AND COALESCE(tt.TRTR_FIM_VIGENCIA, :data)
  AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
  AND tst.TRST_TBTO_ID == 2
  AND (:codigo IS NULL OR ct.CLTR_CD = :codigo)
ORDER BY ct.CLTR_CD`, { codigo, data: dataSql(data) }).map(Object.values);

/** consultarTratamentoClassificacaoImpostoSeletivo(codigo | null) → Object[] rows (MAP_C). */
export const consultarTratamentoImpostoSeletivo = (base, codigo, data) => base.all(`
SELECT
    ct.CLTR_ID,
    ct.CLTR_CD,
    ct.CLTR_DESCRICAO,
    ct.CLTR_TIPO_ALIQUOTA,
    ct.CLTR_NOMENCLATURA,
    tt.TRTR_DESCRICAO,
    tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO,
    tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO,
    st.SITR_IND_GRED,
    tt.TRTR_IN_POSSUI_PERCENTUAL_REDUCAO,
    st.SITR_IND_GDIF,
    ct.CLTR_DATA_ATUALIZACAO
FROM TRATAMENTO_CLASSIFICACAO tc
JOIN CLASSIFICACAO_TRIBUTARIA ct ON tc.TRCL_CLTR_ID = ct.CLTR_ID
JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = ct.CLTR_SITR_ID
WHERE :data BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :data)
  AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
  AND :data BETWEEN tt.TRTR_INICIO_VIGENCIA AND COALESCE(tt.TRTR_FIM_VIGENCIA, :data)
  AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
  AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
  AND tst.TRST_TBTO_ID == 1
  AND (:codigo IS NULL OR ct.CLTR_CD = :codigo)
ORDER BY ct.CLTR_CD`, { codigo, data: dataSql(data) }).map(Object.values);

/** consultarTratamentoClassificacaoPorCstETributoTipo: IN (:tbtoSiglas) expanded to one marker per element. */
export function consultarTratamentoPorCstETributoTipo(base, cst, siglas, data) {
  const marcadores = siglas.map((_, i) => `:tbtoSigla${i}`).join(', ');
  const params = { cst, data: dataSql(data) };
  siglas.forEach((s, i) => { params[`tbtoSigla${i}`] = s; });
  return base.all(`
SELECT
    ct.CLTR_CD,
    ct.CLTR_DESCRICAO,
    ct.CLTR_TIPO_ALIQUOTA,
    ct.CLTR_NOMENCLATURA,
    tt.TRTR_DESCRICAO,
    tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO,
    tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO,
    st.SITR_IND_GRED,
    ct.CLTR_ID,
    ct.CLTR_DATA_ATUALIZACAO
FROM TRATAMENTO_CLASSIFICACAO tc
JOIN CLASSIFICACAO_TRIBUTARIA ct ON tc.TRCL_CLTR_ID = ct.CLTR_ID
JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
WHERE st.SITR_CD = :cst
  AND EXISTS (
      SELECT 1 FROM TRIBUTO_SITUACAO_TRIBUTARIA tst2
      JOIN TRIBUTO tb2 ON tst2.TRST_TBTO_ID = tb2.TBTO_ID
      WHERE tst2.TRST_SITR_ID = st.SITR_ID
      AND tb2.TBTO_SIGLA IN (${marcadores})
      AND :data BETWEEN tst2.TRST_INICIO_VIGENCIA AND COALESCE(tst2.TRST_FIM_VIGENCIA, :data)
      AND :data BETWEEN tb2.TBTO_INICIO_VIGENCIA AND COALESCE(tb2.TBTO_FIM_VIGENCIA, :data)
  )
  AND :data BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :data)
  AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
  AND :data BETWEEN tt.TRTR_INICIO_VIGENCIA AND COALESCE(tt.TRTR_FIM_VIGENCIA, :data)
  AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
ORDER BY ct.CLTR_CD`, params).map(Object.values);
}

/** consultarValidadeDfeClassificacaoTributaria (LIMIT 1; the "--" column comments of the Java SQL dropped). */
export const consultarValidadeDfe = (base, codigoClassificacaoTributaria, data) => base.all(`
SELECT
    ct.CLTR_ID,
    ct.CLTR_NOMENCLATURA,
    tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO,
    st.SITR_IND_GDIF,
    ct.CLTR_IND_GCREDPRESOPER,
    st.SITR_IND_GIBSCBS
FROM TRATAMENTO_CLASSIFICACAO tc
INNER JOIN CLASSIFICACAO_TRIBUTARIA ct ON tc.TRCL_CLTR_ID = ct.CLTR_ID
    AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
INNER JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
    AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
INNER JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
    AND :data BETWEEN tt.TRTR_INICIO_VIGENCIA AND COALESCE(tt.TRTR_FIM_VIGENCIA, :data)
INNER JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
    AND tst.TRST_TBTO_ID = 2
    AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
WHERE ct.CLTR_CD = :codigoClassificacaoTributaria
  AND :data BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :data)
LIMIT 1`, { codigoClassificacaoTributaria, data: dataSql(data) }).map(Object.values);

// ─── TipoDfeClassificacaoRepository ──────────────────────────────────────────

/**
 * TipoDfeClassificacaoRepository.buscar (JPQL) with its EAGER TipoDfe (no TIPO_DFE vigência filter).
 * Effective order: index idx_tipo_dfe_classificacao_vigencia (INICIO, FIM with NULL first, rowid).
 */
export const buscarTiposDfeClassificacao = (base, idClassificacaoTributaria, data) => base.all(`
SELECT td.TPDF_TIPO, td.TPDF_SIGLA, td.TPDF_DESCRICAO
FROM TIPO_DFE_CLASSIFICACAO tdcl
JOIN TIPO_DFE td ON td.TPDF_ID = tdcl.TDCL_TPDF_ID
WHERE tdcl.TDCL_CLTR_ID = :id
  AND (tdcl.TDCL_INICIO_VIGENCIA <= :data AND (tdcl.TDCL_FIM_VIGENCIA IS NULL OR tdcl.TDCL_FIM_VIGENCIA >= :data))
ORDER BY tdcl.TDCL_INICIO_VIGENCIA, tdcl.TDCL_FIM_VIGENCIA, tdcl.TDCL_ID`, { id: BigInt(idClassificacaoTributaria), data: dataSql(data) });

/** buscarCstsComClassificacoesCbsIbs(siglaDfe normalized, data). */
export const buscarCstsComClassificacoesCbsIbs = (base, siglaDfe, data) => base.all(`
SELECT DISTINCT
    st.SITR_ID as id_cst,
    st.SITR_CD as codigo_cst,
    st.SITR_DESCRICAO as descricao_cst,
    ct.CLTR_CD as codigo_classificacao,
    ct.CLTR_DESCRICAO as descricao_classificacao
FROM TIPO_DFE_CLASSIFICACAO tdcl
JOIN TIPO_DFE td ON tdcl.TDCL_TPDF_ID = td.TPDF_ID
JOIN CLASSIFICACAO_TRIBUTARIA ct ON tdcl.TDCL_CLTR_ID = ct.CLTR_ID
JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
    AND tst.TRST_TBTO_ID != 1
    AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
WHERE UPPER(REPLACE(REPLACE(REPLACE(td.TPDF_SIGLA, ' ', ''), '-', ''), '_', '')) = :siglaDfe
AND :data BETWEEN tdcl.TDCL_INICIO_VIGENCIA AND COALESCE(tdcl.TDCL_FIM_VIGENCIA, :data)
ORDER BY st.SITR_CD ASC, ct.CLTR_CD ASC`, { siglaDfe, data: dataSql(data) }).map(Object.values);

/** buscarCstsComClassificacoesCbsIbsTodosDfes(data). */
export const buscarCstsComClassificacoesCbsIbsTodosDfes = (base, data) => base.all(`
SELECT DISTINCT
    st.SITR_ID as id_cst,
    st.SITR_CD as codigo_cst,
    st.SITR_DESCRICAO as descricao_cst,
    ct.CLTR_CD as codigo_classificacao,
    ct.CLTR_DESCRICAO as descricao_classificacao
FROM CLASSIFICACAO_TRIBUTARIA ct
JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
    AND tst.TRST_TBTO_ID != 1
    AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
ORDER BY st.SITR_CD ASC, ct.CLTR_CD ASC`, { data: dataSql(data) }).map(Object.values);

/** buscarCstsComClassificacoesIs(data). */
export const buscarCstsComClassificacoesIs = (base, data) => base.all(`
SELECT DISTINCT
    st.SITR_ID as id_cst,
    st.SITR_CD as codigo_cst,
    st.SITR_DESCRICAO as descricao_cst,
    ct.CLTR_CD as codigo_classificacao,
    ct.CLTR_DESCRICAO as descricao_classificacao
FROM CLASSIFICACAO_TRIBUTARIA ct
JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
    AND tst.TRST_TBTO_ID = 1
    AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
ORDER BY st.SITR_CD ASC, ct.CLTR_CD ASC`, { data: dataSql(data) }).map(Object.values);

// ─── ClassificacaoTributariaRepository ─────────────────────────────────────────

/** buscarClassificacaoTributaria(codigo, idTributo, data) → [{ id, codigo, nomenclatura, cst }] (unique result expected). */
export const buscarClassificacaoTributaria = (base, codigo, idTributo, data) => base.all(`
SELECT ct.CLTR_ID as id, ct.CLTR_CD as codigo, ct.CLTR_NOMENCLATURA as nomenclatura, st.SITR_CD as cst
FROM CLASSIFICACAO_TRIBUTARIA ct
JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
JOIN TRIBUTO tb ON tst.TRST_TBTO_ID = tb.TBTO_ID
WHERE ct.CLTR_CD = :codigo
AND tb.TBTO_ID = :idTributo
AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
AND :data BETWEEN tb.TBTO_INICIO_VIGENCIA AND COALESCE(tb.TBTO_FIM_VIGENCIA, :data)`, { codigo, idTributo: BigInt(idTributo), data: dataSql(data) });

/** listarCodigosClassificacoesPorAtores(data, fornecedor, adquirente, siglaDfe). */
export const listarCodigosClassificacoesPorAtores = (base, data, fornecedor, adquirente, siglaDfe) => base.all(`
SELECT ct.CLTR_CD
FROM CLASSIFICACAO_TRIBUTARIA ct
WHERE :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
AND ( :fornecedor IS NULL
      OR NOT EXISTS (SELECT 1 FROM ATOR_CLASSIFICACAO ac
                      WHERE ac.ATCL_CLTR_ID = ct.CLTR_ID
                        AND ac.ATCL_IN_PAPEL = 'Fornecedor'
                        AND :data BETWEEN ac.ATCL_INICIO_VIGENCIA
                                      AND COALESCE(ac.ATCL_FIM_VIGENCIA, :data))
      OR EXISTS (SELECT 1 FROM ATOR_CLASSIFICACAO ac
                  WHERE ac.ATCL_CLTR_ID = ct.CLTR_ID
                    AND ac.ATCL_IN_PAPEL = 'Fornecedor'
                    AND ac.ATCL_ATOR_ID = :fornecedor
                    AND :data BETWEEN ac.ATCL_INICIO_VIGENCIA
                                  AND COALESCE(ac.ATCL_FIM_VIGENCIA, :data)) )
AND ( :adquirente IS NULL
      OR NOT EXISTS (SELECT 1 FROM ATOR_CLASSIFICACAO ac
                      WHERE ac.ATCL_CLTR_ID = ct.CLTR_ID
                        AND ac.ATCL_IN_PAPEL = 'Adquirente'
                        AND :data BETWEEN ac.ATCL_INICIO_VIGENCIA
                                      AND COALESCE(ac.ATCL_FIM_VIGENCIA, :data))
      OR EXISTS (SELECT 1 FROM ATOR_CLASSIFICACAO ac
                  WHERE ac.ATCL_CLTR_ID = ct.CLTR_ID
                    AND ac.ATCL_IN_PAPEL = 'Adquirente'
                    AND ac.ATCL_ATOR_ID = :adquirente
                    AND :data BETWEEN ac.ATCL_INICIO_VIGENCIA
                                  AND COALESCE(ac.ATCL_FIM_VIGENCIA, :data)) )
AND ( :siglaDfe IS NULL
      OR EXISTS (SELECT 1 FROM TIPO_DFE_CLASSIFICACAO tdcl
                  JOIN TIPO_DFE td ON tdcl.TDCL_TPDF_ID = td.TPDF_ID
                  WHERE tdcl.TDCL_CLTR_ID = ct.CLTR_ID
                    AND UPPER(REPLACE(REPLACE(REPLACE(td.TPDF_SIGLA, ' ', ''), '-', ''), '_', '')) = :siglaDfe
                    AND :data BETWEEN tdcl.TDCL_INICIO_VIGENCIA
                                  AND COALESCE(tdcl.TDCL_FIM_VIGENCIA, :data)) )`,
{ data: dataSql(data), fornecedor, adquirente, siglaDfe }).map((r) => r.CLTR_CD);

/**
 * listarCodigosClassificacoesServicoSemVinculoNbs(data). Effective order: index
 * idx_classificacao_tributaria_inicio_vigencia (CLTR_INICIO_VIGENCIA, rowid).
 */
export const listarCodigosClassificacoesServicoSemVinculoNbs = (base, data) => base.all(`
SELECT ct.CLTR_CD
FROM CLASSIFICACAO_TRIBUTARIA ct
WHERE (ct.CLTR_NOMENCLATURA LIKE '%NBS%')
AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
AND ct.CLTR_ID NOT IN (
    SELECT n.NBSA_CLTR_ID
    FROM NBS_APLICAVEL n
    WHERE :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)
)
ORDER BY ct.CLTR_INICIO_VIGENCIA, ct.CLTR_ID`, { data: dataSql(data) }).map((r) => r.CLTR_CD);

// ─── NBS / NCM ──────────────────────────────────────────────────────────────

/** NcmRepository.existeNcm (JPQL). */
export const existeNcm = (base, codigo, data) => base.count(
  'SELECT EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :codigo AND :data BETWEEN n.NCM_INICIO_VIGENCIA AND COALESCE(n.NCM_FIM_VIGENCIA, :data)) AS e',
  { codigo, data: dataSql(data) },
) === 1;

/** NbsRepository.existeNbs (JPQL). */
export const existeNbs = (base, codigo, data) => base.count(
  'SELECT EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :codigo AND :data BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :data)) AS e',
  { codigo, data: dataSql(data) },
) === 1;

/** NcmRepository.buscarDescricaoNcm(codigo, limite, data) → Optional<String> (null when empty). */
export const buscarDescricaoNcm = (base, codigo, limite, data) => base.get(`
SELECT ltrim(rtrim(n.NCM_DESCRICAO, ' '), ' -') AS descricao FROM NCM n
WHERE n.NCM_CD = substr(:codigo, 1, :limite)
  AND :data BETWEEN n.NCM_INICIO_VIGENCIA AND COALESCE(n.NCM_FIM_VIGENCIA, :data)`, { codigo, limite, data: dataSql(data) })?.descricao ?? null;

/** NbsRepository.buscarDescricaoNbs(codigo, limite, data) → Optional<String>. */
export const buscarDescricaoNbs = (base, codigo, limite, data) => base.get(`
SELECT ltrim(rtrim(n.NBS_DESCRICAO, ' '), ' -') AS descricao FROM NBS n
WHERE n.NBS_CD = substr(:codigo, 1, :limite)
  AND :data BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :data)`, { codigo, limite, data: dataSql(data) })?.descricao ?? null;

/** NcmRepository.buscarTodosNcmsVigentes (JPQL, raw description). */
export const buscarTodosNcmsVigentes = (base, data) => base.all(`
SELECT DISTINCT n.NCM_CD, n.NCM_DESCRICAO FROM NCM n
WHERE :data BETWEEN n.NCM_INICIO_VIGENCIA AND COALESCE(n.NCM_FIM_VIGENCIA, :data)
  AND length(n.NCM_CD) = 8
ORDER BY n.NCM_CD`, { data: dataSql(data) });

/** NbsRepository.listarNbs (JPQL). */
export const listarNbs = (base, data) => base.all(
  'SELECT n.NBS_CD, n.NBS_DESCRICAO FROM NBS n WHERE :data BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :data) AND length(n.NBS_CD) = 9 ORDER BY n.NBS_CD',
  { data: dataSql(data) },
);

/** AliquotaAdValoremProdutoRepository.buscarAliquotaAdValorem → { valor } | null (row existence matters). */
export const buscarAliquotaAdValoremProduto = (base, ncm, idTributo, data) => base.get(`
SELECT CAST(av.AADV_VALOR AS TEXT) AS valor
FROM ALIQUOTA_AD_VALOREM_PRODUTO a
JOIN ALIQUOTA_AD_VALOREM av ON av.AADV_ID = a.AAVP_AADV_ID
WHERE EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :ncm)
  AND a.AAVP_NCM_CD = substr(:ncm, 1, length(a.AAVP_NCM_CD))
  AND av.AADV_TBTO_ID = :idTributo
  AND :data BETWEEN a.AAVP_INICIO_VIGENCIA AND COALESCE(a.AAVP_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_PRODUTO e
                  WHERE e.EAVP_NCM_CD = substr(:ncm, 1, length(e.EAVP_NCM_CD))
                    AND e.EAVP_AAVP_ID = a.AAVP_ID
                    AND :data BETWEEN e.EAVP_INICIO_VIGENCIA AND COALESCE(e.EAVP_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_PRODUTO e
                  WHERE e.EAVP_NCM_CD = substr(a.AAVP_NCM_CD, 1, length(e.EAVP_NCM_CD))
                    AND e.EAVP_AAVP_ID = a.AAVP_ID
                    AND :data BETWEEN e.EAVP_INICIO_VIGENCIA AND COALESCE(e.EAVP_FIM_VIGENCIA, :data))
ORDER BY length(a.AAVP_NCM_CD) DESC
LIMIT 1`, { ncm, idTributo: BigInt(idTributo), data: dataSql(data) });

/** AliquotaAdRemProdutoRepository.buscarAliquotaAdRem → { valor, unidadeMedida } | null. */
export const buscarAliquotaAdRemProduto = (base, ncm, idTributo, data) => base.get(`
SELECT CAST(ar.AARE_VALOR AS TEXT) AS valor, um.UNMD_SIGLA AS unidadeMedida
FROM ALIQUOTA_AD_REM_PRODUTO a
JOIN ALIQUOTA_AD_REM ar ON ar.AARE_ID = a.AARP_AARE_ID
JOIN UNIDADE_MEDIDA um ON um.UNMD_ID = ar.AARE_UNMD_ID
WHERE EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :ncm)
  AND ar.AARE_TBTO_ID = :idTributo
  AND a.AARP_NCM_CD = substr(:ncm, 1, length(a.AARP_NCM_CD))
  AND :data BETWEEN a.AARP_INICIO_VIGENCIA AND COALESCE(a.AARP_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_REM_PRODUTO e
                  WHERE e.EARP_NCM_CD = substr(:ncm, 1, length(e.EARP_NCM_CD))
                    AND e.EARP_AARP_ID = a.AARP_ID
                    AND :data BETWEEN e.EARP_INICIO_VIGENCIA AND COALESCE(e.EARP_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_REM_PRODUTO e
                  WHERE e.EARP_NCM_CD = substr(a.AARP_NCM_CD, 1, length(e.EARP_NCM_CD))
                    AND e.EARP_AARP_ID = a.AARP_ID
                    AND :data BETWEEN e.EARP_INICIO_VIGENCIA AND COALESCE(e.EARP_FIM_VIGENCIA, :data))
ORDER BY length(a.AARP_NCM_CD) DESC
LIMIT 1`, { ncm, idTributo: BigInt(idTributo), data: dataSql(data) });

/** AliquotaAdValoremServicoRepository.buscarAliquotaAdValoremDto (no LIMIT: >1 row is an error for the caller). */
export const buscarAliquotaAdValoremServico = (base, nbs, idTributo, idClassificacaoTributaria, data) => base.all(`
SELECT CAST(av.AADV_VALOR AS TEXT) AS valor
FROM ALIQUOTA_AD_VALOREM_SERVICO a
JOIN ALIQUOTA_AD_VALOREM av ON av.AADV_ID = a.AAVS_AADV_ID
WHERE EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :nbs)
  AND a.AAVS_NBS_CD = substr(:nbs, 1, length(a.AAVS_NBS_CD))
  AND av.AADV_TBTO_ID = :idTributo
  AND (:idClassificacaoTributaria IS NULL OR av.AADV_CLTR_ID = :idClassificacaoTributaria)
  AND :data BETWEEN a.AAVS_INICIO_VIGENCIA AND COALESCE(a.AAVS_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_SERVICO e
                  WHERE e.EAVS_NBS_CD = substr(:nbs, 1, length(e.EAVS_NBS_CD))
                    AND e.EAVS_AAVS_ID = a.AAVS_ID
                    AND :data BETWEEN e.EAVS_INICIO_VIGENCIA AND COALESCE(e.EAVS_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_SERVICO e
                  WHERE e.EAVS_NBS_CD = substr(a.AAVS_NBS_CD, 1, length(e.EAVS_NBS_CD))
                    AND e.EAVS_AAVS_ID = a.AAVS_ID
                    AND :data BETWEEN e.EAVS_INICIO_VIGENCIA AND COALESCE(e.EAVS_FIM_VIGENCIA, :data))
ORDER BY length(a.AAVS_NBS_CD) DESC`, {
  nbs, idTributo: BigInt(idTributo), idClassificacaoTributaria: idClassificacaoTributaria == null ? null : BigInt(idClassificacaoTributaria), data: dataSql(data),
});

// ─── NcmAplicavelRepository / NbsAplicavelRepository ───────────────────────────

const existe = (base, sql, params) => base.count(sql, params) === 1;

/** tem(id, data): the classification has a vigente annex. */
export const ncmAplicavelTem = (base, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n WHERE n.NCMA_CLTR_ID = :id
  AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)) AS e`, { id: BigInt(id), data: dataSql(data) });
export const nbsAplicavelTem = (base, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n WHERE n.NBSA_CLTR_ID = :id
  AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)) AS e`, { id: BigInt(id), data: dataSql(data) });

export const temNcmAplicavel = (base, ncm, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
  WHERE n.NCMA_NCM_CD = substr(:ncm, 1, length(n.NCMA_NCM_CD)) AND n.NCMA_CLTR_ID = :id
    AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)) AS e`, { ncm, id: BigInt(id), data: dataSql(data) });
export const temExcecaoNcmAplicavel = (base, ncm, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM EXCECAO_NCM_APLICAVEL e JOIN NCM_APLICAVEL n ON n.NCMA_ID = e.ENCM_NCMA_ID
  WHERE n.NCMA_NCM_CD = substr(:ncm, 1, length(n.NCMA_NCM_CD)) AND e.ENCM_NCM_CD = substr(:ncm, 1, length(e.ENCM_NCM_CD))
    AND n.NCMA_CLTR_ID = :id AND :data BETWEEN e.ENCM_INICIO_VIGENCIA AND COALESCE(e.ENCM_FIM_VIGENCIA, :data)) AS e`, { ncm, id: BigInt(id), data: dataSql(data) });
export const temNcmAplicavelSemExcecao = (base, ncm, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n LEFT JOIN EXCECAO_NCM_APLICAVEL e ON e.ENCM_NCMA_ID = n.NCMA_ID
  WHERE n.NCMA_NCM_CD = substr(:ncm, 1, length(n.NCMA_NCM_CD)) AND n.NCMA_CLTR_ID = :id
    AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)
    AND (e.ENCM_ID IS NULL OR :data NOT BETWEEN e.ENCM_INICIO_VIGENCIA AND COALESCE(e.ENCM_FIM_VIGENCIA, :data))) AS e`, { ncm, id: BigInt(id), data: dataSql(data) });

export const temNbsAplicavel = (base, nbs, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
  WHERE n.NBSA_NBS_CD = substr(:nbs, 1, length(n.NBSA_NBS_CD)) AND n.NBSA_CLTR_ID = :id
    AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)) AS e`, { nbs, id: BigInt(id), data: dataSql(data) });
export const temExcecaoNbsAplicavel = (base, nbs, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM EXCECAO_NBS_APLICAVEL e JOIN NBS_APLICAVEL n ON n.NBSA_ID = e.ENBS_NBSA_ID
  WHERE n.NBSA_NBS_CD = substr(:nbs, 1, length(n.NBSA_NBS_CD)) AND e.ENBS_NBS_CD = substr(:nbs, 1, length(e.ENBS_NBS_CD))
    AND n.NBSA_CLTR_ID = :id AND :data BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data)) AS e`, { nbs, id: BigInt(id), data: dataSql(data) });
export const temNbsAplicavelSemExcecao = (base, nbs, id, data) => existe(base, `SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n LEFT JOIN EXCECAO_NBS_APLICAVEL e ON e.ENBS_NBSA_ID = n.NBSA_ID
  WHERE n.NBSA_NBS_CD = substr(:nbs, 1, length(n.NBSA_NBS_CD)) AND n.NBSA_CLTR_ID = :id
    AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)
    AND (e.ENBS_ID IS NULL OR :data NOT BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data))) AS e`, { nbs, id: BigInt(id), data: dataSql(data) });

/** NbsAplicavelRepository.listarCodigosClassificacoesVinculadasPorNbs (effective order: NBSA_ID). */
export const listarCodigosClassificacoesVinculadasPorNbs = (base, nbs, data) => base.all(`
SELECT ct.CLTR_CD
  FROM NBS_APLICAVEL n
  JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = n.NBSA_CLTR_ID
  LEFT JOIN EXCECAO_NBS_APLICAVEL e ON e.ENBS_NBSA_ID = n.NBSA_ID
    AND :data BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data)
 WHERE n.NBSA_NBS_CD = :nbs
   AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)
   AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
   AND e.ENBS_ID IS NULL
 ORDER BY n.NBSA_ID`, { nbs, data: dataSql(data) }).map((r) => r.CLTR_CD);

/** NbsAplicavelRepository.existeVinculoParaClassificacao (no date filter) → 0/1. */
export const existeVinculoParaClassificacao = (base, classificacaoId) => base.count(`
SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END
FROM NBS_APLICAVEL n
JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = n.NBSA_CLTR_ID
WHERE ct.CLTR_ID = :classificacaoId`, { classificacaoId: BigInt(classificacaoId) });

/** NbsAplicavelRepository.listarNbsAplicaveisPorClassificacao (native). */
export const listarNbsAplicaveisPorClassificacao = (base, classificacaoId, data) => base.all(`
SELECT DISTINCT nbs.NBS_CD, nbs.NBS_DESCRICAO
FROM NBS_APLICAVEL n
JOIN NBS nbs ON nbs.NBS_CD = n.NBSA_NBS_CD
LEFT JOIN EXCECAO_NBS_APLICAVEL e ON e.ENBS_NBSA_ID = n.NBSA_ID
    AND :data BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data)
JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = n.NBSA_CLTR_ID
WHERE ct.CLTR_ID = :classificacaoId
AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)
AND :data BETWEEN nbs.NBS_INICIO_VIGENCIA AND COALESCE(nbs.NBS_FIM_VIGENCIA, :data)
AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
AND e.ENBS_ID IS NULL
AND LENGTH(nbs.NBS_CD) = 9
ORDER BY nbs.NBS_CD`, { classificacaoId: BigInt(classificacaoId), data: dataSql(data) }).map(Object.values);

// ─── fundamentação legal ─────────────────────────────────────────────────────

/**
 * FundamentacaoClassificacaoRepository.buscarTodas (JPQL, ORDER BY CLTR_CD; FDCL_ID breaks the IS/CBS ties)
 * with the EAGER ClassificacaoTributaria → SituacaoTributaria and FundamentacaoLegal (no vigência filter).
 */
export const buscarFundamentacoes = (base, data) => base.all(`
SELECT ct.CLTR_CD, ct.CLTR_DESCRICAO, st.SITR_ID, st.SITR_CD, st.SITR_DESCRICAO,
       fl.FDLG_TEXTO, fl.FDLG_TEXTO_CURTO, fl.FDLG_REFERENCIA_NORMATIVA
FROM FUNDAMENTACAO_CLASSIFICACAO fc
JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = fc.FDCL_CLTR_ID
JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
JOIN FUNDAMENTACAO_LEGAL fl ON fl.FDLG_ID = fc.FDCL_FDLG_ID
WHERE :data BETWEEN fc.FDCL_INICIO_VIGENCIA AND COALESCE(fc.FDCL_FIM_VIGENCIA, :data)
ORDER BY ct.CLTR_CD, fc.FDCL_ID`, { data: dataSql(data) });

/** TributoSituacaoTributariaRepository.consultarPorIdSituacaoTributaria (native, LIMIT 1) → id or null. */
export const consultarTributoPorIdSituacao = (base, idSituacaoTributaria, data) => base.get(`
SELECT t.TRST_TBTO_ID
FROM TRIBUTO_SITUACAO_TRIBUTARIA t
JOIN SITUACAO_TRIBUTARIA s ON t.TRST_SITR_ID = s.SITR_ID
WHERE t.TRST_SITR_ID = :idSituacaoTributaria
  AND :data BETWEEN t.TRST_INICIO_VIGENCIA AND COALESCE(t.TRST_FIM_VIGENCIA, :data)
LIMIT 1`, { idSituacaoTributaria: BigInt(idSituacaoTributaria), data: dataSql(data) })?.TRST_TBTO_ID ?? null;

// ─── alíquotas / tabelas auxiliares ─────────────────────────────────────────────

/** AliquotaPadraoRepository.buscarAliquota (JPQL with the AliquotaResultadoDTO constructor expression). */
export const buscarAliquotaPadrao = (base, idTributo, codigoUf, municipio, data) => base.all(`
SELECT CAST(r.ALRE_VALOR AS TEXT) AS valorReferencia, CAST(p.ALPA_VALOR AS TEXT) AS valorPadrao, p.ALPA_FORMA_APLICACAO AS formaAplicacao
FROM ALIQUOTA_REFERENCIA r
LEFT JOIN ALIQUOTA_PADRAO p
    ON p.ALPA_ALRE_ID = r.ALRE_ID
    AND ((:municipio IS NULL AND p.ALPA_MUNI_CD IS NULL) OR (:municipio IS NOT NULL AND p.ALPA_MUNI_CD = :municipio))
    AND ((:codigoUf IS NULL AND p.ALPA_UF_CD IS NULL) OR (:codigoUf IS NOT NULL AND p.ALPA_UF_CD = :codigoUf))
    AND p.ALPA_INICIO_VIGENCIA <= :data
    AND (p.ALPA_FIM_VIGENCIA IS NULL OR p.ALPA_FIM_VIGENCIA >= :data)
WHERE r.ALRE_TBTO_ID = :idTributo
    AND r.ALRE_INICIO_VIGENCIA <= :data
    AND (r.ALRE_FIM_VIGENCIA IS NULL OR r.ALRE_FIM_VIGENCIA >= :data)`, {
  idTributo: BigInt(idTributo), codigoUf: codigoUf == null ? null : BigInt(codigoUf), municipio: municipio == null ? null : BigInt(municipio), data: dataSql(data),
});

/** GrupoDfeRepository.buscarTiposDfeAgrupados (native). */
export const buscarTiposDfeAgrupados = (base, data) => base.all(`
SELECT
    g.GRDF_ID        AS grupo_id,
    g.GRDF_DESCRICAO AS grupo_titulo,
    t.TPDF_SIGLA     AS tipo_sigla,
    t.TPDF_DESCRICAO AS tipo_titulo,
    t.TPDF_TIPO      AS tipo_modelo,
    t.TPDF_B_POSSUI_TRATAMENTO_CALCULADORA AS tipo_suportado,
    t.TPDF_B_PERMITE_NCM_ZERO              AS tipo_permite_ncm_zero
FROM TIPO_DFE t
JOIN GRUPO_DFE g ON t.TPDF_GRDF_ID = g.GRDF_ID
WHERE :data BETWEEN t.TPDF_INICIO_VIGENCIA AND COALESCE(t.TPDF_FIM_VIGENCIA, :data)
  AND :data BETWEEN g.GRDF_INICIO_VIGENCIA AND COALESCE(g.GRDF_FIM_VIGENCIA, :data)
ORDER BY g.GRDF_ID ASC, t.TPDF_ID ASC`, { data: dataSql(data) }).map(Object.values);

/** GrupoAtorRepository.buscarAtoresAgrupados (native). */
export const buscarAtoresAgrupados = (base, data, papel) => base.all(`
SELECT
    g.GRAT_ID        AS grupo_id,
    g.GRAT_DESCRICAO AS grupo_descricao,
    g.GRAT_ORDEM     AS grupo_ordem,
    a.ATOR_ID        AS ator_id,
    a.ATOR_DESCRICAO AS ator_descricao,
    a.ATOR_ORDEM     AS ator_ordem
FROM ATOR a
JOIN GRUPO_ATOR g ON a.ATOR_GRAT_ID = g.GRAT_ID
WHERE a.ATOR_INICIO_VIGENCIA <= :data
  AND (a.ATOR_FIM_VIGENCIA IS NULL OR a.ATOR_FIM_VIGENCIA >= :data)
  AND g.GRAT_INICIO_VIGENCIA <= :data
  AND (g.GRAT_FIM_VIGENCIA IS NULL OR g.GRAT_FIM_VIGENCIA >= :data)
  AND (
      :papel IS NULL
      OR EXISTS (
          SELECT 1 FROM ATOR_CLASSIFICACAO ac
          WHERE ac.ATCL_ATOR_ID = a.ATOR_ID
            AND ac.ATCL_IN_PAPEL = :papel
            AND ac.ATCL_INICIO_VIGENCIA <= :data
            AND (ac.ATCL_FIM_VIGENCIA IS NULL OR ac.ATCL_FIM_VIGENCIA >= :data)
      )
  )
ORDER BY g.GRAT_ORDEM ASC, a.ATOR_ORDEM ASC`, { data: dataSql(data), papel }).map(Object.values);

/** RedutorCompraGovernamentalRepository.buscarTodos (JPQL; valor via getBigDecimal). */
export const buscarRedutoresCompraGovernamental = (base) => base.all(
  'SELECT r.RCGO_ID, r.RCGO_FIM_VIGENCIA AS fim, r.RCGO_INICIO_VIGENCIA AS inicio, CAST(r.RCGO_VALOR AS TEXT) AS valor FROM REDUTOR_COMPRA_GOVERNAMENTAL r ORDER BY r.RCGO_INICIO_VIGENCIA ASC',
);

/** TransferenciaCBSRepository.buscarTodos (JPQL). */
export const buscarTransferenciasCbs = (base) => base.all(
  'SELECT t.TCEG_ID, t.TCEG_FIM_VIGENCIA AS fim, t.TCEG_INICIO_VIGENCIA AS inicio, CAST(t.TCEG_VALOR AS TEXT) AS valor FROM TRANSFERENCIA_CBS_ENTE_GOV t ORDER BY t.TCEG_INICIO_VIGENCIA ASC',
);
