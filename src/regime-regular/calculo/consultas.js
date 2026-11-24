// Repository queries used by the calculation pipeline (CalculadoraService, ObservabilidadeService,
// ProcessamentoItemService and the small services they call). SQL copied from the verified port
// of the Spring Data repositories (.work/spec/regreg/data-access-queries.mjs; processing.md §7):
// JPQL translated with the real column names, native queries verbatim. Dates are bound as TEXT
// 'YYYY-MM-DD' (date_class=TEXT), so BETWEEN/<= are ISO text comparisons as in the Java datasource.
// REAL columns read through getBigDecimal are fetched with CAST(... AS TEXT) (= sqlite3_column_text).
// Booleans (INTEGER 0/1) become JS booleans; NULL stays null.
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';

const SQL = {
  // UfRepository.existeUf / consultarPorSigla (SQLite UPPER only folds ASCII, like the Java side)
  existeUf: 'SELECT EXISTS (SELECT 1 FROM UF u WHERE u.UF_SIGLA = UPPER(:sigla)) AS r',
  consultarUfPorSigla: 'SELECT u.UF_CD FROM UF u WHERE u.UF_SIGLA = UPPER(:sigla)',

  // MunicipioRepository.findById (Municipio + Uf, ManyToOne EAGER) / validarMunicipio
  municipioPorId: `SELECT m.MUNI_CD, m.MUNI_NOME, m.MUNI_UF_CD, u.UF_CD, u.UF_NOME, u.UF_SIGLA
FROM MUNICIPIO m
LEFT JOIN UF u ON u.UF_CD = m.MUNI_UF_CD
WHERE m.MUNI_CD = :codigo`,
  validarMunicipio: `SELECT CASE
         WHEN COUNT(m.MUNI_CD) = 0 THEN 1
         WHEN COUNT(m.MUNI_CD) > 0 AND LOWER(u.UF_SIGLA) != LOWER(:siglaUf) THEN 2
         ELSE 0
       END AS resultado
FROM MUNICIPIO m
JOIN UF u ON u.UF_CD = m.MUNI_UF_CD
WHERE m.MUNI_CD = :codigoMunicipio`,

  // TipoDfeRepository.buscarPorTipo (Optional single result)
  tipoDfePorTipo: `SELECT t.TPDF_ID, t.TPDF_DESCRICAO, t.TPDF_FIM_VIGENCIA, t.TPDF_INICIO_VIGENCIA, t.TPDF_B_PERMITE_NCM_ZERO,
       t.TPDF_B_POSSUI_TRATAMENTO_CALCULADORA, t.TPDF_SIGLA, t.TPDF_TIPO
FROM TIPO_DFE t
WHERE t.TPDF_TIPO = :tipo
  AND :data BETWEEN t.TPDF_INICIO_VIGENCIA AND COALESCE(t.TPDF_FIM_VIGENCIA, :data)`,

  // TipoDfeClassificacaoRepository.buscar (TipoDfe EAGER: only its id is used here)
  tipoDfeClassificacao: `SELECT t.TDCL_ID, t.TDCL_CLTR_ID, t.TDCL_FIM_VIGENCIA, t.TDCL_INICIO_VIGENCIA, t.TDCL_TPDF_ID,
       td.TPDF_SIGLA
FROM TIPO_DFE_CLASSIFICACAO t
JOIN TIPO_DFE td ON td.TPDF_ID = t.TDCL_TPDF_ID
WHERE t.TDCL_CLTR_ID = :idClassificacaoTributaria
  AND (t.TDCL_INICIO_VIGENCIA <= :data AND (t.TDCL_FIM_VIGENCIA IS NULL OR t.TDCL_FIM_VIGENCIA >= :data))`,

  // NcmRepository.existeNcm / NbsRepository.existeNbs
  existeNcm: `SELECT EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :codigo
  AND :data BETWEEN n.NCM_INICIO_VIGENCIA AND COALESCE(n.NCM_FIM_VIGENCIA, :data)) AS r`,
  existeNbs: `SELECT EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :codigo
  AND :data BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :data)) AS r`,

  // SituacaoTributariaRepository.existeCst (JPQL) / consultarSituacaoTributariaPorCodigo (native, verbatim)
  existeCst: `SELECT EXISTS (SELECT 1 FROM TRIBUTO_SITUACAO_TRIBUTARIA t
  JOIN SITUACAO_TRIBUTARIA s ON s.SITR_ID = t.TRST_SITR_ID
  WHERE t.TRST_TBTO_ID = :idTributo
    AND s.SITR_CD = :cst
    AND :data BETWEEN t.TRST_INICIO_VIGENCIA AND COALESCE(t.TRST_FIM_VIGENCIA, :data)
    AND :data BETWEEN s.SITR_INICIO_VIGENCIA AND COALESCE(s.SITR_FIM_VIGENCIA, :data)) AS r`,
  situacaoTributariaPorCodigo: `
			    SELECT s.*
			    FROM SITUACAO_TRIBUTARIA s
			    JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = s.SITR_ID
			    JOIN TRIBUTO t ON t.TBTO_ID = tst.TRST_TBTO_ID
			    WHERE COALESCE(s.SITR_CD, '') = COALESCE(:cst, '')
			      AND COALESCE(t.TBTO_ID, 0) = COALESCE(:idTributo, 0)
			      AND COALESCE(:data, '') BETWEEN COALESCE(tst.TRST_INICIO_VIGENCIA, '') AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
			      AND COALESCE(:data, '') BETWEEN COALESCE(s.SITR_INICIO_VIGENCIA, '') AND COALESCE(s.SITR_FIM_VIGENCIA, :data)
			      AND COALESCE(:data, '') BETWEEN COALESCE(t.TBTO_INICIO_VIGENCIA, '') AND COALESCE(t.TBTO_FIM_VIGENCIA, :data)
			    LIMIT 1`,

  // ClassificacaoTributariaRepository.buscarClassificacaoTributaria (native, verbatim)
  classificacaoTributaria: `
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
            AND :data BETWEEN tb.TBTO_INICIO_VIGENCIA AND COALESCE(tb.TBTO_FIM_VIGENCIA, :data)
            `,

  // TratamentoClassificacaoRepository.buscarTratamentoClassificacao (JPQL → TratamentoClassificacaoDTO)
  tratamentoClassificacao: `SELECT tc.TRCL_TRTR_ID AS idTratamentoTributario, tc.TRCL_CLTR_ID AS idClassificacaoTributaria,
       tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO AS inIncompativelComSuspensao,
       tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO AS inExigeGrupoDesoneracao
FROM TRATAMENTO_CLASSIFICACAO tc
JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
WHERE tc.TRCL_CLTR_ID = :idClassificacaoTributaria
  AND (tc.TRCL_INICIO_VIGENCIA <= :data AND (tc.TRCL_FIM_VIGENCIA IS NULL OR tc.TRCL_FIM_VIGENCIA >= :data))`,

  // NcmAplicavelRepository
  ncmTem: `SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
  WHERE n.NCMA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)) AS r`,
  temNcmAplicavel: `SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
  WHERE n.NCMA_NCM_CD = SUBSTR(:ncm, 1, LENGTH(n.NCMA_NCM_CD))
    AND n.NCMA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)) AS r`,
  temExcecaoNcmAplicavel: `SELECT EXISTS (SELECT 1 FROM EXCECAO_NCM_APLICAVEL e
  JOIN NCM_APLICAVEL n ON n.NCMA_ID = e.ENCM_NCMA_ID
  WHERE n.NCMA_NCM_CD = SUBSTR(:ncm, 1, LENGTH(n.NCMA_NCM_CD))
    AND e.ENCM_NCM_CD = SUBSTR(:ncm, 1, LENGTH(e.ENCM_NCM_CD))
    AND n.NCMA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN e.ENCM_INICIO_VIGENCIA AND COALESCE(e.ENCM_FIM_VIGENCIA, :data)) AS r`,
  temNcmAplicavelSemExcecao: `SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
  LEFT JOIN EXCECAO_NCM_APLICAVEL e ON e.ENCM_NCMA_ID = n.NCMA_ID
  WHERE n.NCMA_NCM_CD = SUBSTR(:ncm, 1, LENGTH(n.NCMA_NCM_CD))
    AND n.NCMA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)
    AND (e.ENCM_ID IS NULL OR :data NOT BETWEEN e.ENCM_INICIO_VIGENCIA AND COALESCE(e.ENCM_FIM_VIGENCIA, :data))) AS r`,

  // NbsAplicavelRepository
  nbsTem: `SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
  WHERE n.NBSA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)) AS r`,
  temNbsAplicavel: `SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
  WHERE n.NBSA_NBS_CD = SUBSTR(:nbs, 1, LENGTH(n.NBSA_NBS_CD))
    AND n.NBSA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)) AS r`,
  temExcecaoNbsAplicavel: `SELECT EXISTS (SELECT 1 FROM EXCECAO_NBS_APLICAVEL e
  JOIN NBS_APLICAVEL n ON n.NBSA_ID = e.ENBS_NBSA_ID
  WHERE n.NBSA_NBS_CD = SUBSTR(:nbs, 1, LENGTH(n.NBSA_NBS_CD))
    AND e.ENBS_NBS_CD = SUBSTR(:nbs, 1, LENGTH(e.ENBS_NBS_CD))
    AND n.NBSA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data)) AS r`,
  temNbsAplicavelSemExcecao: `SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
  LEFT JOIN EXCECAO_NBS_APLICAVEL e ON e.ENBS_NBSA_ID = n.NBSA_ID
  WHERE n.NBSA_NBS_CD = SUBSTR(:nbs, 1, LENGTH(n.NBSA_NBS_CD))
    AND n.NBSA_CLTR_ID = :idClassificacaoTributaria
    AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)
    AND (e.ENBS_ID IS NULL OR :data NOT BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data))) AS r`,

  // AliquotaAdValoremProdutoRepository
  aliquotaAdValoremProduto: `SELECT CAST(av.AADV_VALOR AS TEXT) AS valor
FROM ALIQUOTA_AD_VALOREM_PRODUTO a
JOIN ALIQUOTA_AD_VALOREM av ON av.AADV_ID = a.AAVP_AADV_ID
WHERE EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :ncm)
  AND a.AAVP_NCM_CD = SUBSTR(:ncm, 1, LENGTH(a.AAVP_NCM_CD))
  AND av.AADV_TBTO_ID = :idTributo
  AND :data BETWEEN a.AAVP_INICIO_VIGENCIA AND COALESCE(a.AAVP_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_PRODUTO e
                  WHERE e.EAVP_NCM_CD = SUBSTR(:ncm, 1, LENGTH(e.EAVP_NCM_CD))
                    AND e.EAVP_AAVP_ID = a.AAVP_ID
                    AND :data BETWEEN e.EAVP_INICIO_VIGENCIA AND COALESCE(e.EAVP_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_PRODUTO e
                  WHERE e.EAVP_NCM_CD = SUBSTR(a.AAVP_NCM_CD, 1, LENGTH(e.EAVP_NCM_CD))
                    AND e.EAVP_AAVP_ID = a.AAVP_ID
                    AND :data BETWEEN e.EAVP_INICIO_VIGENCIA AND COALESCE(e.EAVP_FIM_VIGENCIA, :data))
ORDER BY LENGTH(a.AAVP_NCM_CD) DESC
LIMIT 1`,
  existeNcmAdValorem: `SELECT COUNT(1) > 0 AS existe
FROM ALIQUOTA_AD_VALOREM_PRODUTO a
JOIN ALIQUOTA_AD_VALOREM av ON av.AADV_ID = a.AAVP_AADV_ID
WHERE EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :ncm)
  AND a.AAVP_NCM_CD = SUBSTR(:ncm, 1, LENGTH(a.AAVP_NCM_CD))
  AND av.AADV_TBTO_ID = :tributo
  AND :data BETWEEN a.AAVP_INICIO_VIGENCIA AND COALESCE(a.AAVP_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_PRODUTO e
                  WHERE e.EAVP_NCM_CD = SUBSTR(:ncm, 1, LENGTH(e.EAVP_NCM_CD))
                    AND e.EAVP_AAVP_ID = a.AAVP_ID
                    AND :data BETWEEN e.EAVP_INICIO_VIGENCIA AND COALESCE(e.EAVP_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_PRODUTO e
                  WHERE e.EAVP_NCM_CD = SUBSTR(a.AAVP_NCM_CD, 1, LENGTH(e.EAVP_NCM_CD))
                    AND e.EAVP_AAVP_ID = a.AAVP_ID
                    AND :data BETWEEN e.EAVP_INICIO_VIGENCIA AND COALESCE(e.EAVP_FIM_VIGENCIA, :data))`,

  // AliquotaAdRemProdutoRepository
  aliquotaAdRemProduto: `SELECT CAST(ar.AARE_VALOR AS TEXT) AS valor, um.UNMD_SIGLA AS unidadeMedida
FROM ALIQUOTA_AD_REM_PRODUTO a
JOIN ALIQUOTA_AD_REM ar ON ar.AARE_ID = a.AARP_AARE_ID
JOIN UNIDADE_MEDIDA um ON um.UNMD_ID = ar.AARE_UNMD_ID
WHERE EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :ncm)
  AND ar.AARE_TBTO_ID = :idTributo
  AND a.AARP_NCM_CD = SUBSTR(:ncm, 1, LENGTH(a.AARP_NCM_CD))
  AND :data BETWEEN a.AARP_INICIO_VIGENCIA AND COALESCE(a.AARP_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_REM_PRODUTO e
                  WHERE e.EARP_NCM_CD = SUBSTR(:ncm, 1, LENGTH(e.EARP_NCM_CD))
                    AND e.EARP_AARP_ID = a.AARP_ID
                    AND :data BETWEEN e.EARP_INICIO_VIGENCIA AND COALESCE(e.EARP_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_REM_PRODUTO e
                  WHERE e.EARP_NCM_CD = SUBSTR(a.AARP_NCM_CD, 1, LENGTH(e.EARP_NCM_CD))
                    AND e.EARP_AARP_ID = a.AARP_ID
                    AND :data BETWEEN e.EARP_INICIO_VIGENCIA AND COALESCE(e.EARP_FIM_VIGENCIA, :data))
ORDER BY LENGTH(a.AARP_NCM_CD) DESC
LIMIT 1`,

  // AliquotaAdValoremServicoRepository (no LIMIT: 2+ rows = IncorrectResultSizeDataAccessException)
  aliquotaAdValoremServico: `SELECT CAST(av.AADV_VALOR AS TEXT) AS valor
FROM ALIQUOTA_AD_VALOREM_SERVICO a
JOIN ALIQUOTA_AD_VALOREM av ON av.AADV_ID = a.AAVS_AADV_ID
WHERE EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :nbs)
  AND a.AAVS_NBS_CD = SUBSTR(:nbs, 1, LENGTH(a.AAVS_NBS_CD))
  AND av.AADV_TBTO_ID = :idTributo
  AND (:idClassificacaoTributaria IS NULL OR av.AADV_CLTR_ID = :idClassificacaoTributaria)
  AND :data BETWEEN a.AAVS_INICIO_VIGENCIA AND COALESCE(a.AAVS_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_SERVICO e
                  WHERE e.EAVS_NBS_CD = SUBSTR(:nbs, 1, LENGTH(e.EAVS_NBS_CD))
                    AND e.EAVS_AAVS_ID = a.AAVS_ID
                    AND :data BETWEEN e.EAVS_INICIO_VIGENCIA AND COALESCE(e.EAVS_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_SERVICO e
                  WHERE e.EAVS_NBS_CD = SUBSTR(a.AAVS_NBS_CD, 1, LENGTH(e.EAVS_NBS_CD))
                    AND e.EAVS_AAVS_ID = a.AAVS_ID
                    AND :data BETWEEN e.EAVS_INICIO_VIGENCIA AND COALESCE(e.EAVS_FIM_VIGENCIA, :data))
ORDER BY LENGTH(a.AAVS_NBS_CD) DESC`,
  existeNbsAdValorem: `SELECT COUNT(1) > 0 AS existe
FROM ALIQUOTA_AD_VALOREM_SERVICO a
JOIN ALIQUOTA_AD_VALOREM av ON av.AADV_ID = a.AAVS_AADV_ID
WHERE EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :nbs)
  AND a.AAVS_NBS_CD = SUBSTR(:nbs, 1, LENGTH(a.AAVS_NBS_CD))
  AND av.AADV_TBTO_ID = :tributo
  AND :data BETWEEN a.AAVS_INICIO_VIGENCIA AND COALESCE(a.AAVS_FIM_VIGENCIA, :data)
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_SERVICO e
                  WHERE e.EAVS_NBS_CD = SUBSTR(:nbs, 1, LENGTH(e.EAVS_NBS_CD))
                    AND e.EAVS_AAVS_ID = a.AAVS_ID
                    AND :data BETWEEN e.EAVS_INICIO_VIGENCIA AND COALESCE(e.EAVS_FIM_VIGENCIA, :data))
  AND NOT EXISTS (SELECT 1 FROM EXCECAO_AD_VALOREM_SERVICO e
                  WHERE e.EAVS_NBS_CD = SUBSTR(a.AAVS_NBS_CD, 1, LENGTH(e.EAVS_NBS_CD))
                    AND e.EAVS_AAVS_ID = a.AAVS_ID
                    AND :data BETWEEN e.EAVS_INICIO_VIGENCIA AND COALESCE(e.EAVS_FIM_VIGENCIA, :data))`,

  // RedutorCompraGovernamentalRepository.buscarValorRedutor (Optional single result)
  redutorCompraGovernamental: `SELECT CAST(r.RCGO_VALOR AS TEXT) AS valor
FROM REDUTOR_COMPRA_GOVERNAMENTAL r
WHERE r.RCGO_INICIO_VIGENCIA <= :data AND (r.RCGO_FIM_VIGENCIA IS NULL OR r.RCGO_FIM_VIGENCIA >= :data)`,
};

export { SQL };

/** Integer column read as Java Long/Integer (node:sqlite gives number, or BigInt when readBigInts is on). */
const inteiro = (v) => (v == null ? null : typeof v === 'bigint' ? Number(v) : v);
/** INTEGER 0/1 read as Java boolean/Boolean (NULL → null). */
const booleano = (v) => (v == null ? null : Number(v) !== 0);
/** REAL read through ResultSet.getBigDecimal (text of the SQLite value). */
const decimal = (v) => (v == null ? null : Dec.parse(String(v)));
/** Long parameter (Java binds it as INTEGER): JS number or BigInt. */
const longParam = (v) => (v == null ? null : typeof v === 'bigint' ? v : BigInt(v));

/**
 * Spring Data "single result": 0 rows → null; more than one → IncorrectResultSizeDataAccessException
 * (500 / CAL-999 with Spring's message).
 */
function unico(linhas) {
  if (linhas.length === 0) return null;
  if (linhas.length > 1) {
    throw new ErroJava('IncorrectResultSizeDataAccessException', `Query did not return a unique result: ${linhas.length} results were returned`);
  }
  return linhas[0];
}

/** Repository layer bound to the shared read-only connection (`deps.base`). */
export function criarConsultas(base) {
  const existe = (sql, params) => booleano(Object.values(base.get(sql, params))[0]);
  return {
    existeUf: (sigla) => existe(SQL.existeUf, { sigla }),
    consultarUfPorSigla: (sigla) => {
      const l = unico(base.all(SQL.consultarUfPorSigla, { sigla }));
      return l ? inteiro(l.UF_CD) : null;
    },
    /** Municipio (with its Uf) or null. */
    municipioPorId: (codigo) => {
      const l = base.get(SQL.municipioPorId, { codigo: longParam(codigo) });
      return l ? { codigo: inteiro(l.MUNI_CD), nome: l.MUNI_NOME, uf: l.UF_CD == null ? null : { codigo: inteiro(l.UF_CD), nome: l.UF_NOME, sigla: l.UF_SIGLA } } : null;
    },
    validarMunicipio: (codigoMunicipio, siglaUf) => inteiro(base.get(SQL.validarMunicipio, { codigoMunicipio: longParam(codigoMunicipio), siglaUf }).resultado),
    /** TipoDfe entity or null. */
    tipoDfePorTipo: (tipo, data) => {
      const l = unico(base.all(SQL.tipoDfePorTipo, { tipo, data }));
      return l ? {
        id: inteiro(l.TPDF_ID), tipo: inteiro(l.TPDF_TIPO), sigla: l.TPDF_SIGLA, descricao: l.TPDF_DESCRICAO,
        permiteNcmZero: booleano(l.TPDF_B_PERMITE_NCM_ZERO) === true, possuiTratamento: booleano(l.TPDF_B_POSSUI_TRATAMENTO_CALCULADORA) === true,
      } : null;
    },
    tipoDfeClassificacao: (idClassificacaoTributaria, data) => base.all(SQL.tipoDfeClassificacao, { idClassificacaoTributaria, data })
      .map((l) => ({ id: inteiro(l.TDCL_ID), tipoDfe: { id: inteiro(l.TDCL_TPDF_ID), sigla: l.TPDF_SIGLA } })),
    existeNcm: (codigo, data) => existe(SQL.existeNcm, { codigo, data }),
    existeNbs: (codigo, data) => existe(SQL.existeNbs, { codigo, data }),
    existeCst: (cst, idTributo, data) => existe(SQL.existeCst, { cst, idTributo, data }),
    /** SituacaoTributaria entity subset (inGrupoIbsCbs = SITR_IND_GIBSCBS) or null. */
    situacaoTributariaPorCodigo: (cst, idTributo, data) => {
      const l = base.get(SQL.situacaoTributariaPorCodigo, { cst, idTributo, data });
      return l ? { id: inteiro(l.SITR_ID), codigo: l.SITR_CD, inGrupoIbsCbs: booleano(l.SITR_IND_GIBSCBS) } : null;
    },
    /** ClassificacaoTributariaDTO(id, codigo, nomenclatura, cst) or null. */
    classificacaoTributaria: (codigo, idTributo, data) => {
      const l = unico(base.all(SQL.classificacaoTributaria, { codigo, idTributo, data }));
      return l ? { id: inteiro(l.id), codigo: l.codigo, nomenclatura: l.nomenclatura, cst: l.cst } : null;
    },
    /** TratamentoClassificacaoDTO or null. */
    tratamentoClassificacao: (idClassificacaoTributaria, data) => {
      const l = unico(base.all(SQL.tratamentoClassificacao, { idClassificacaoTributaria, data }));
      return l ? {
        idTratamentoTributario: inteiro(l.idTratamentoTributario), idClassificacaoTributaria: inteiro(l.idClassificacaoTributaria),
        inIncompativelComSuspensao: booleano(l.inIncompativelComSuspensao) === true, inExigeGrupoDesoneracao: booleano(l.inExigeGrupoDesoneracao) === true,
      } : null;
    },
    ncmTem: (idClassificacaoTributaria, data) => existe(SQL.ncmTem, { idClassificacaoTributaria, data }),
    temNcmAplicavel: (ncm, idClassificacaoTributaria, data) => existe(SQL.temNcmAplicavel, { ncm, idClassificacaoTributaria, data }),
    temExcecaoNcmAplicavel: (ncm, idClassificacaoTributaria, data) => existe(SQL.temExcecaoNcmAplicavel, { ncm, idClassificacaoTributaria, data }),
    temNcmAplicavelSemExcecao: (ncm, idClassificacaoTributaria, data) => existe(SQL.temNcmAplicavelSemExcecao, { ncm, idClassificacaoTributaria, data }),
    nbsTem: (idClassificacaoTributaria, data) => existe(SQL.nbsTem, { idClassificacaoTributaria, data }),
    temNbsAplicavel: (nbs, idClassificacaoTributaria, data) => existe(SQL.temNbsAplicavel, { nbs, idClassificacaoTributaria, data }),
    temExcecaoNbsAplicavel: (nbs, idClassificacaoTributaria, data) => existe(SQL.temExcecaoNbsAplicavel, { nbs, idClassificacaoTributaria, data }),
    temNbsAplicavelSemExcecao: (nbs, idClassificacaoTributaria, data) => existe(SQL.temNbsAplicavelSemExcecao, { nbs, idClassificacaoTributaria, data }),
    /** AliquotaAdValoremDTO(valor) or null (the row may carry a NULL value). */
    aliquotaAdValoremProduto: (ncm, idTributo, data) => {
      const l = base.get(SQL.aliquotaAdValoremProduto, { ncm, idTributo, data });
      return l ? { valor: decimal(l.valor) } : null;
    },
    existeNcmAdValorem: (ncm, tributo, data) => existe(SQL.existeNcmAdValorem, { ncm, tributo, data }),
    /** AliquotaAdRemDTO(valor, unidadeMedida) or null. */
    aliquotaAdRemProduto: (ncm, idTributo, data) => {
      const l = base.get(SQL.aliquotaAdRemProduto, { ncm, idTributo, data });
      return l ? { valor: decimal(l.valor), unidadeMedida: l.unidadeMedida } : null;
    },
    /** AliquotaAdValoremDTO or null; 2+ rows → IncorrectResultSizeDataAccessException. */
    aliquotaAdValoremServico: (nbs, idTributo, idClassificacaoTributaria, data) => {
      const l = unico(base.all(SQL.aliquotaAdValoremServico, { nbs, idTributo, idClassificacaoTributaria, data }));
      return l ? { valor: decimal(l.valor) } : null;
    },
    existeNbsAdValorem: (nbs, tributo, data) => existe(SQL.existeNbsAdValorem, { nbs, tributo, data }),
    /** Optional<BigDecimal> of the government purchase reducer. */
    redutorCompraGovernamental: (data) => {
      const l = unico(base.all(SQL.redutorCompraGovernamental, { data }));
      return l ? { valor: decimal(l.valor) } : null;
    },
  };
}
