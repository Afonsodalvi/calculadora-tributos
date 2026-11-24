// Queries of this slice, verbatim from the repositories (native SQL as written in Java; the JPQL
// of NbsRepository, MunicipioRepository, UfRepository and AliquotaPadraoRepository translated to
// SQLite with the real column names, see basecalc-nfse-pedagio.md §14). Dates are bound as
// 'yyyy-MM-dd' text (LocalDate.toString / sqlite-jdbc date_string_format); REAL columns are read
// as text (getBigDecimal of sqlite-jdbc).

// IndicadorOperacaoRepository.validarCombinacaoExiste → int
export const VALIDAR_COMBINACAO_EXISTE = `
        SELECT EXISTS (
            SELECT 1
            FROM CLASSIF_NBS_INDOP_LC c
            INNER JOIN CLASSIFICACAO_TRIBUTARIA ct ON c.CNIL_CLTR_ID = ct.CLTR_ID
            INNER JOIN INDICADOR_OPERACAO_IBS_CBS io ON c.CNIL_IOIC_ID = io.IOIC_ID
            WHERE c.CNIL_NBS_CD = :nbsCd
              AND ct.CLTR_CD = :cClassTrib
              AND io.IOIC_CD = :cIndOp
              AND (:cTribNac IS NULL OR c.CNIL_LSLC_CD = :cTribNac)
              AND c.CNIL_INICIO_VIGENCIA <= :dataOcorrenciaFatoGerador
              AND (c.CNIL_FIM_VIGENCIA IS NULL
                   OR c.CNIL_FIM_VIGENCIA >= :dataOcorrenciaFatoGerador)
        ) AS resultado`;

// IndicadorOperacaoRepository.buscarLocalOperacaoPorIndOp → rows [fornecimento, incidencia]
export const BUSCAR_LOCAL_OPERACAO_POR_IND_OP = `
        SELECT
            io.IOIC_CD_LOCAL_FORNECIMENTO_DFE,
            io.IOIC_CD_LOCAL_INCIDENCIA
        FROM INDICADOR_OPERACAO_IBS_CBS io
        WHERE io.IOIC_CD = :cIndOp
          AND :data BETWEEN io.IOIC_INICIO_VIGENCIA AND COALESCE(io.IOIC_FIM_VIGENCIA, :data)`;

// IndicadorOperacaoRepository.buscarIndicadorOperacaoPorData (the two NULL columns get aliases:
// node:sqlite returns rows keyed by column name)
export const BUSCAR_INDICADOR_OPERACAO_POR_DATA = `
        SELECT
            io.IOIC_CD,
            io.IOIC_TIPO_OPERACAO,
            io.IOIC_CD_LOCAL_FORNECIMENTO_DFE,
            io.IOIC_LOCAL_INCIDENCIA,
            io.IOIC_CD_LOCAL_INCIDENCIA,
            NULL AS CNIL_IN_PS_ONEROSA,
            NULL AS CNIL_IN_ADQ_EXTERIOR
        FROM
            INDICADOR_OPERACAO_IBS_CBS io
        WHERE
            io.IOIC_TIPO_OPERACAO IS NOT NULL
            AND :data BETWEEN io.IOIC_INICIO_VIGENCIA AND COALESCE(io.IOIC_FIM_VIGENCIA, :data)
        ORDER BY io.IOIC_CD`;

// IndicadorOperacaoRepository.buscarIndicadorOperacaoPorDataComNbs
export const BUSCAR_INDICADOR_OPERACAO_POR_DATA_COM_NBS = `
        SELECT DISTINCT
            io.IOIC_CD,
            io.IOIC_TIPO_OPERACAO,
            io.IOIC_CD_LOCAL_FORNECIMENTO_DFE,
            io.IOIC_LOCAL_INCIDENCIA,
            io.IOIC_CD_LOCAL_INCIDENCIA,
            c.CNIL_IN_PS_ONEROSA,
            c.CNIL_IN_ADQ_EXTERIOR
        FROM
            INDICADOR_OPERACAO_IBS_CBS io
            INNER JOIN CLASSIF_NBS_INDOP_LC c ON io.IOIC_ID = c.CNIL_IOIC_ID
        WHERE
            c.CNIL_NBS_CD = :nbs
            AND :data BETWEEN io.IOIC_INICIO_VIGENCIA AND COALESCE(io.IOIC_FIM_VIGENCIA, :data)
            AND :data BETWEEN c.CNIL_INICIO_VIGENCIA AND COALESCE(c.CNIL_FIM_VIGENCIA, :data)
            AND io.IOIC_TIPO_OPERACAO IS NOT NULL
        ORDER BY io.IOIC_CD`;

// IndicadorOperacaoRepository.buscarSituacoesClassificacoesPorNbsEData
export const BUSCAR_SITUACOES_CLASSIFICACOES_POR_NBS_E_DATA = `
        SELECT DISTINCT
            st.SITR_CD AS codigoSituacaoTributaria,
            st.SITR_DESCRICAO AS descricaoSituacaoTributaria,
            ct.CLTR_CD AS codigoClassificacaoTributaria,
            ct.CLTR_DESCRICAO AS descricaoClassificacaoTributaria
        FROM
            CLASSIF_NBS_INDOP_LC c
            INNER JOIN CLASSIFICACAO_TRIBUTARIA ct ON c.CNIL_CLTR_ID = ct.CLTR_ID
            INNER JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
        WHERE
            c.CNIL_NBS_CD = :nbs
            AND :data BETWEEN c.CNIL_INICIO_VIGENCIA AND COALESCE(c.CNIL_FIM_VIGENCIA, :data)
            AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
            AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
        ORDER BY ct.CLTR_CD, st.SITR_CD`;

// IndicadorOperacaoRepository.buscarSituacaoClassificacaoPorClassificacao (0 or 1 row)
export const BUSCAR_SITUACAO_CLASSIFICACAO_POR_CLASSIFICACAO = `
        SELECT
            st.SITR_CD AS codigoSituacaoTributaria,
            st.SITR_DESCRICAO AS descricaoSituacaoTributaria,
            ct.CLTR_CD AS codigoClassificacaoTributaria,
            ct.CLTR_DESCRICAO AS descricaoClassificacaoTributaria
        FROM CLASSIFICACAO_TRIBUTARIA ct
        INNER JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
        WHERE ct.CLTR_CD = :codigoClassificacaoTributaria
          AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
          AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
        LIMIT 1`;

// NbsRepository.existeNbs (JPQL)
export const EXISTE_NBS = `
SELECT EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :codigo
  AND :data BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :data)) AS r`;

// MunicipioRepository.validarMunicipio (JPQL, implicit join m.uf.sigla)
export const VALIDAR_MUNICIPIO = `
SELECT CASE
         WHEN COUNT(m.MUNI_CD) = 0 THEN 1
         WHEN COUNT(m.MUNI_CD) > 0 AND LOWER(u.UF_SIGLA) != LOWER(:siglaUf) THEN 2
         ELSE 0
       END AS resultado
FROM MUNICIPIO m
JOIN UF u ON u.UF_CD = m.MUNI_UF_CD
WHERE m.MUNI_CD = :codigoMunicipio`;

// UfRepository.consultarPorSigla → Long (0 rows → null)
export const CONSULTAR_UF_POR_SIGLA = `SELECT u.UF_CD FROM UF u WHERE u.UF_SIGLA = UPPER(:sigla)`;

// AliquotaPadraoRepository.buscarAliquota (JPQL; FK paths resolved without joins)
export const BUSCAR_ALIQUOTA = `
SELECT CAST(r.ALRE_VALOR AS TEXT) AS valorReferencia, CAST(p.ALPA_VALOR AS TEXT) AS valorPadrao,
       p.ALPA_FORMA_APLICACAO AS formaAplicacao
FROM ALIQUOTA_REFERENCIA r
LEFT JOIN ALIQUOTA_PADRAO p
  ON p.ALPA_ALRE_ID = r.ALRE_ID
 AND ((:municipio IS NULL AND p.ALPA_MUNI_CD IS NULL) OR (:municipio IS NOT NULL AND p.ALPA_MUNI_CD = :municipio))
 AND ((:codigoUf IS NULL AND p.ALPA_UF_CD IS NULL) OR (:codigoUf IS NOT NULL AND p.ALPA_UF_CD = :codigoUf))
 AND p.ALPA_INICIO_VIGENCIA <= :data
 AND (p.ALPA_FIM_VIGENCIA IS NULL OR p.ALPA_FIM_VIGENCIA >= :data)
WHERE r.ALRE_TBTO_ID = :idTributo
  AND r.ALRE_INICIO_VIGENCIA <= :data
  AND (r.ALRE_FIM_VIGENCIA IS NULL OR r.ALRE_FIM_VIGENCIA >= :data)`;
