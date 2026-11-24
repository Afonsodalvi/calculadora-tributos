// Read-only access to the OFFICIAL calculator database (calculadora-pro.db, built from the
// Receita Federal flyway migrations of calculadora-rtc-regime-regular). Every query below is
// the one the Java code runs (native SQL copied verbatim; JPQL translated 1:1), so vigência
// semantics (BETWEEN on 'YYYY-MM-DD' text, COALESCE of open ends, ORDER BY) are identical.
// REAL columns are read as TEXT, like sqlite-jdbc's getBigDecimal does, so 0.1 stays "0.1".
import { abrirBanco } from '../../core/db.js';

/** Simples Nacional queries over a shared base (core/db.js). Accepts a path for tests. */
export function openDb(base) {
  if (typeof base === 'string') base = abrirBanco(base);
  const { all, get, count, exists } = base;

  const CBS = `SELECT tst.TRST_SITR_ID FROM TRIBUTO_SITUACAO_TRIBUTARIA tst WHERE tst.TRST_TBTO_ID = 2`;

  return {
    close: base.close,
    versao: base.versao,

    // ── TipoDfeCalculoSimplesRepository ──────────────────────────────────────
    contarSemTratamentoCalculadoraVigentes: (tpDoc, data) => count(`
      SELECT COUNT(1) FROM TIPO_DFE td
      WHERE td.TPDF_TIPO = :tpDoc AND td.TPDF_B_POSSUI_TRATAMENTO_CALCULADORA = 0
        AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)`, { tpDoc, data }),
    /** contarVinculosVigentes (ParametroCalculoSimplesService.tpDocSuportado). */
    contarVinculosVigentesTipoDfeCalculo: (tpDoc, data) => count(`
      SELECT COUNT(1)
      FROM TIPO_DFE_CALCULO_SIMPLES_NACIONAL t
      JOIN TIPO_DFE td ON td.TPDF_ID = t.TDCS_TPDF_ID
      WHERE td.TPDF_TIPO = :tpDoc
      AND :data BETWEEN t.TDCS_INICIO_VIGENCIA AND COALESCE(t.TDCS_FIM_VIGENCIA, :data)
      AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)`, { tpDoc, data }),
    buscarTipoDfeCalculo: (tpDoc, data) => get(`
      SELECT t.TDCS_TPDF_ID tipoDfeId, t.TDCS_VOCABULARIO_REGIME vocabulario, t.TDCS_CASAS_ALIQUOTA_CALCULO casas,
             t.TDCS_MAXIMO_ITENS maximoItens, t.TDCS_IN_ADMITE_IS admiteIs
      FROM TIPO_DFE_CALCULO_SIMPLES_NACIONAL t JOIN TIPO_DFE td ON td.TPDF_ID = t.TDCS_TPDF_ID
      WHERE td.TPDF_TIPO = :tpDoc
        AND :data BETWEEN t.TDCS_INICIO_VIGENCIA AND COALESCE(t.TDCS_FIM_VIGENCIA, :data)
        AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)
      ORDER BY t.TDCS_INICIO_VIGENCIA DESC`, { tpDoc, data }),
    buscarSiglaVigentePorId: (id, data) => get(`
      SELECT td.TPDF_SIGLA s FROM TIPO_DFE td
      WHERE td.TPDF_ID = :id AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)`, { id, data })?.s ?? null,
    permiteNcmZeroVigentePorId: (id, data) => {
      const r = get(`SELECT td.TPDF_B_PERMITE_NCM_ZERO b FROM TIPO_DFE td
        WHERE td.TPDF_ID = :id AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)`, { id, data });
      return r ? Number(r.b) === 1 : false;
    },

    // ── EnquadramentoRegimeSimplesRepository (JPQL: null param matches only null column) ──
    buscarRegimeApuracao: (vocabulario, crt, tpRegimeIBSCBS, opSimpNac, regApIBSCBSSN, data) => get(`
      SELECT r.RASN_ID id, r.RASN_CD codigo, r.RASN_IN_CALCULA_TRIBUTOS calculaTributos, r.RASN_IN_GERA_IBS geraIbs,
             r.RASN_DESTINO_DEVIDO destinoDevido, r.RASN_DESTINO_PENDENTE_SUSPENSO destinoPendenteSuspenso
      FROM ENQUADRAMENTO_REGIME_SIMPLES_NACIONAL e JOIN REGIME_APURACAO_SIMPLES_NACIONAL r ON r.RASN_ID = e.ERSN_RASN_ID
      WHERE e.ERSN_VOCABULARIO_REGIME = :vocabulario
        AND ((:crt IS NULL AND e.ERSN_CRT IS NULL) OR e.ERSN_CRT = :crt)
        AND ((:tpRegimeIBSCBS IS NULL AND e.ERSN_TPREGIMEIBSCBS IS NULL) OR e.ERSN_TPREGIMEIBSCBS = :tpRegimeIBSCBS)
        AND ((:opSimpNac IS NULL AND e.ERSN_OPSIMPNAC IS NULL) OR e.ERSN_OPSIMPNAC = :opSimpNac)
        AND ((:regApIBSCBSSN IS NULL AND e.ERSN_REGAPIBSCBSSN IS NULL) OR e.ERSN_REGAPIBSCBSSN = :regApIBSCBSSN)
        AND :data BETWEEN e.ERSN_INICIO_VIGENCIA AND COALESCE(e.ERSN_FIM_VIGENCIA, :data)
        AND :data BETWEEN r.RASN_INICIO_VIGENCIA AND COALESCE(r.RASN_FIM_VIGENCIA, :data)
      ORDER BY e.ERSN_INICIO_VIGENCIA DESC, r.RASN_INICIO_VIGENCIA DESC`,
    { vocabulario, crt, tpRegimeIBSCBS, opSimpNac, regApIBSCBSSN, data }),

    // ── TransicaoAliquotaCompraGovSimplesRepository ──────────────────────────
    buscarFatorTransicaoCompraGov: (data) => get(`
      SELECT CAST(t.TACG_FATOR AS TEXT) fator FROM TRANSICAO_ALIQUOTA_COMPRA_GOV_SIMPLES_NACIONAL t
      WHERE :data BETWEEN t.TACG_INICIO_VIGENCIA AND COALESCE(t.TACG_FIM_VIGENCIA, :data)
      ORDER BY t.TACG_INICIO_VIGENCIA DESC`, { data })?.fator ?? null,

    // ── SituacaoIssParAliquotaSimplesRepository ──────────────────────────────
    buscarSituacoesIss: (data) => all(`
      SELECT s.SIPA_CAMPO campo, s.SIPA_VALOR valor, s.SIPA_REGRA regra, s.SIPA_TIPO_ALIQUOTA tipoAliquota, s.SIPA_ORDEM ordem
      FROM SITUACAO_ISS_PAR_ALIQUOTA_SIMPLES_NACIONAL s
      WHERE :data BETWEEN s.SIPA_INICIO_VIGENCIA AND COALESCE(s.SIPA_FIM_VIGENCIA, :data)
      ORDER BY s.SIPA_ORDEM ASC, s.SIPA_ID ASC`, { data }),

    // ── ClassificacaoTributariaSimplesRepository ─────────────────────────────
    contarTratamentosNaoImplementados: (codigo, data) => count(`
      SELECT COUNT(1) FROM TRATAMENTO_CLASSIFICACAO tc
      JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
      JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = tc.TRCL_CLTR_ID
      WHERE ct.CLTR_CD = :codigo AND tt.TRTR_IN_POSSUI_AJUSTE = 1
        AND ct.CLTR_SITR_ID IN (${CBS})
        AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
        AND :data BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :data)
        AND :data BETWEEN tt.TRTR_INICIO_VIGENCIA AND COALESCE(tt.TRTR_FIM_VIGENCIA, :data)`, { codigo, data }),
    buscarClassificacoesVigentes: (codigo, data) => all(`
      SELECT ct.CLTR_ID id, ct.CLTR_CD codigo, ct.CLTR_TPRBSN tpRBSN, ct.CLTR_DESCRICAO descricao
      FROM CLASSIFICACAO_TRIBUTARIA ct
      WHERE ct.CLTR_CD = :codigo
        AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
        AND ct.CLTR_SITR_ID IN (${CBS})
      ORDER BY ct.CLTR_INICIO_VIGENCIA DESC`, { codigo, data }),
    contarVinculosClassificacaoTpDoc: (codigo, tpDoc, data) => count(`
      SELECT COUNT(1) FROM TIPO_DFE_CLASSIFICACAO tdcl
      JOIN TIPO_DFE td ON td.TPDF_ID = tdcl.TDCL_TPDF_ID
      JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = tdcl.TDCL_CLTR_ID
      WHERE ct.CLTR_CD = :codigo AND td.TPDF_TIPO = :tpDoc
        AND ct.CLTR_SITR_ID IN (${CBS})
        AND :data BETWEEN tdcl.TDCL_INICIO_VIGENCIA AND COALESCE(tdcl.TDCL_FIM_VIGENCIA, :data)
        AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)`, { codigo, tpDoc, data }),

    // ── TipoReceitaBrutaSimplesRepository (vocabulary row first, then the default one) ──
    buscarTipoReceitaBruta: (codigo, vocabulario, data) => get(`
      SELECT t.TRBS_CD codigo, t.TRBS_DESCRICAO descricao, t.TRBS_IN_COMPOE_RECEITA compoeReceita,
             t.TRBS_IN_IS_COMPOE_RECEITA isCompoeReceita, CAST(t.TRBS_FATOR_RECEITA AS TEXT) fatorReceita,
             t.TRBS_IN_PENDENTE_SUSPENSO pendenteSuspenso, t.TRBS_IN_EXIGE_ALIQUOTA exigeAliquota,
             t.TRBS_IN_VEDADO_NAO_TRIBUTAVEL vedadoNaoTributavel, t.TRBS_VOCABULARIO_REGIME vocabularioRegime
      FROM TIPO_RECEITA_BRUTA_SIMPLES_NACIONAL t
      WHERE t.TRBS_CD = :codigo AND (t.TRBS_VOCABULARIO_REGIME = :vocabulario OR t.TRBS_VOCABULARIO_REGIME IS NULL)
        AND :data BETWEEN t.TRBS_INICIO_VIGENCIA AND COALESCE(t.TRBS_FIM_VIGENCIA, :data)
      ORDER BY CASE WHEN t.TRBS_VOCABULARIO_REGIME IS NULL THEN 1 ELSE 0 END, t.TRBS_INICIO_VIGENCIA DESC`,
    { codigo, vocabulario, data }),

    // ── AtividadeSimplesCalculoRepository ────────────────────────────────────
    buscarAtividadeVigente: (cAtivSN, data) => get(`
      SELECT a.ATSN_ID id, a.ATSN_CATIVSN cAtivSN, a.ATSN_DESCRICAO descricao,
             a.ATSN_ANEXO_SEM_FATOR_R anexoSemFatorR, a.ATSN_ANEXO_COM_FATOR_R anexoComFatorR,
             a.ATSN_IN_NAO_TRIBUTAVEL naoTributavel, a.ATSN_IN_ISS_NO_SIMPLES issNoSimples,
             a.ATSN_IN_ADMITE_BENEFICIO_MUNICIPAL admiteBeneficioMunicipal
      FROM ATIVIDADE_SIMPLES_NACIONAL a
      WHERE a.ATSN_CATIVSN = :cAtivSN
        AND :data BETWEEN a.ATSN_INICIO_VIGENCIA AND COALESCE(a.ATSN_FIM_VIGENCIA, :data)
      ORDER BY a.ATSN_INICIO_VIGENCIA DESC`, { cAtivSN, data }),
    contarVinculosAtividadeTpDoc: (atividadeId, tpDoc, data) => count(`
      SELECT COUNT(1) FROM TIPO_DFE_ATIVIDADE_SIMPLES_NACIONAL t
      JOIN TIPO_DFE td ON td.TPDF_ID = t.TDAS_TPDF_ID
      WHERE t.TDAS_ATSN_ID = :atividadeId AND td.TPDF_TIPO = :tpDoc
        AND :data BETWEEN t.TDAS_INICIO_VIGENCIA AND COALESCE(t.TDAS_FIM_VIGENCIA, :data)
        AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)`, { atividadeId, tpDoc, data }),
    // ── AtividadeSimplesRepository (package atividadesimples, endpoint /atividades) ──
    /** buscarVigentes (JPQL): the whole entity, ordered by ATSN_ORDEM. */
    buscarAtividadesVigentes: (data) => all(`
      SELECT a.ATSN_ID id, a.ATSN_ORDEM ordem, a.ATSN_DESCRICAO descricao, a.ATSN_ANEXO_SEM_FATOR_R anexoSemFatorR,
             a.ATSN_ANEXO_COM_FATOR_R anexoComFatorR, a.ATSN_ROTULO rotulo, a.ATSN_ROTULO_CURTO rotuloCurto,
             a.ATSN_INICIO_VIGENCIA inicioVigencia, a.ATSN_FIM_VIGENCIA fimVigencia, a.ATSN_CATIVSN cAtivSN,
             a.ATSN_IN_NAO_TRIBUTAVEL naoTributavel, a.ATSN_IN_ISS_NO_SIMPLES issNoSimples,
             a.ATSN_IN_ADMITE_BENEFICIO_MUNICIPAL admiteBeneficioMunicipal
      FROM ATIVIDADE_SIMPLES_NACIONAL a
      WHERE :data BETWEEN a.ATSN_INICIO_VIGENCIA AND COALESCE(a.ATSN_FIM_VIGENCIA, :data)
      ORDER BY a.ATSN_ORDEM ASC`, { data }).map((r) => ({
      ...r, id: Number(r.id), ordem: Number(r.ordem), naoTributavel: Number(r.naoTributavel) === 1,
      issNoSimples: Number(r.issNoSimples) === 1, admiteBeneficioMunicipal: Number(r.admiteBeneficioMunicipal) === 1,
    })),
    /** buscarVinculosTpDocVigentes (native, verbatim). */
    buscarVinculosTpDocVigentes: (data) => all(`
      SELECT t.TDAS_ATSN_ID AS atividadeId, td.TPDF_TIPO AS tpDoc
      FROM TIPO_DFE_ATIVIDADE_SIMPLES_NACIONAL t
      JOIN TIPO_DFE td ON td.TPDF_ID = t.TDAS_TPDF_ID
          AND :data BETWEEN td.TPDF_INICIO_VIGENCIA AND COALESCE(td.TPDF_FIM_VIGENCIA, :data)
      WHERE :data BETWEEN t.TDAS_INICIO_VIGENCIA AND COALESCE(t.TDAS_FIM_VIGENCIA, :data)`, { data })
      .map((r) => ({ atividadeId: Number(r.atividadeId), tpDoc: Number(r.tpDoc) })),
    /** contarTiposDfePorTipo (native, verbatim; no vigência). */
    contarTiposDfePorTipo: (tpDoc) => count(`
      SELECT COUNT(1)
      FROM TIPO_DFE td
      WHERE td.TPDF_TIPO = :tpDoc`, { tpDoc }),

    // ── TransicaoAliquotaCompraGovSimplesRepository.findAll (unit tests) ──
    listarTransicoesCompraGov: () => all(`
      SELECT t.TACG_ID id, CAST(t.TACG_FATOR AS TEXT) fator, t.TACG_INICIO_VIGENCIA inicioVigencia, t.TACG_FIM_VIGENCIA fimVigencia
      FROM TRANSICAO_ALIQUOTA_COMPRA_GOV_SIMPLES_NACIONAL t`),

    listarAtividades: (data) => all(`
      SELECT a.ATSN_CATIVSN cAtivSN, a.ATSN_DESCRICAO descricao, a.ATSN_ANEXO_SEM_FATOR_R anexoSemFatorR,
             a.ATSN_ANEXO_COM_FATOR_R anexoComFatorR, a.ATSN_ROTULO rotulo, a.ATSN_IN_ISS_NO_SIMPLES issNoSimples
      FROM ATIVIDADE_SIMPLES_NACIONAL a
      WHERE :data BETWEEN a.ATSN_INICIO_VIGENCIA AND COALESCE(a.ATSN_FIM_VIGENCIA, :data)
      ORDER BY a.ATSN_ORDEM`, { data }),

    // ── Nomenclature (NcmRepository/NbsRepository + *AplicavelRepository + NomenclaturaService) ──
    existeNcm: (codigo, data) => exists(`SELECT EXISTS (SELECT 1 FROM NCM n WHERE n.NCM_CD = :codigo
      AND :data BETWEEN n.NCM_INICIO_VIGENCIA AND COALESCE(n.NCM_FIM_VIGENCIA, :data))`, { codigo, data }),
    existeNbs: (codigo, data) => exists(`SELECT EXISTS (SELECT 1 FROM NBS n WHERE n.NBS_CD = :codigo
      AND :data BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :data))`, { codigo, data }),
    descricaoNbs: (codigo, data) => get(`SELECT NBS_DESCRICAO d FROM NBS WHERE NBS_CD = :codigo
      AND :data BETWEEN NBS_INICIO_VIGENCIA AND COALESCE(NBS_FIM_VIGENCIA, :data)`, { codigo, data })?.d ?? null,
    /** ClassificacaoTributariaService.buscarClassificacaoTributariaCbsIbs (singleResult semantics). */
    classificacaoCbsIbs: (codigo, data) => all(`
      SELECT ct.CLTR_ID id FROM CLASSIFICACAO_TRIBUTARIA ct
      JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID
      JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
      JOIN TRIBUTO tb ON tst.TRST_TBTO_ID = tb.TBTO_ID
      WHERE ct.CLTR_CD = :codigo AND tb.TBTO_ID = 2
        AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
        AND :data BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :data)
        AND :data BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :data)
        AND :data BETWEEN tb.TBTO_INICIO_VIGENCIA AND COALESCE(tb.TBTO_FIM_VIGENCIA, :data)`, { codigo, data }),
    /** TipoDfeClassificacaoRepository.buscar → siglas of the linked TIPO_DFE rows. */
    siglasTipoDfeDaClassificacao: (id, data) => all(`
      SELECT td.TPDF_SIGLA s FROM TIPO_DFE_CLASSIFICACAO tdcl JOIN TIPO_DFE td ON td.TPDF_ID = tdcl.TDCL_TPDF_ID
      WHERE tdcl.TDCL_CLTR_ID = :id
        AND (tdcl.TDCL_INICIO_VIGENCIA <= :data AND (tdcl.TDCL_FIM_VIGENCIA IS NULL OR tdcl.TDCL_FIM_VIGENCIA >= :data))`,
    { id, data }).map((r) => r.s),
    temNcmAplicavelClassificacao: (id, data) => exists(`SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
      WHERE n.NCMA_CLTR_ID = :id AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data))`, { id, data }),
    temNbsAplicavelClassificacao: (id, data) => exists(`SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
      WHERE n.NBSA_CLTR_ID = :id AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data))`, { id, data }),
    temNcmAplicavel: (ncm, id, data) => exists(`SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
      WHERE n.NCMA_NCM_CD = SUBSTR(:ncm, 1, LENGTH(n.NCMA_NCM_CD)) AND n.NCMA_CLTR_ID = :id
        AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data))`, { ncm, id, data }),
    temExcecaoNcmAplicavel: (ncm, id, data) => exists(`SELECT EXISTS (SELECT 1 FROM EXCECAO_NCM_APLICAVEL e
      JOIN NCM_APLICAVEL n ON n.NCMA_ID = e.ENCM_NCMA_ID
      WHERE n.NCMA_NCM_CD = SUBSTR(:ncm, 1, LENGTH(n.NCMA_NCM_CD)) AND e.ENCM_NCM_CD = SUBSTR(:ncm, 1, LENGTH(e.ENCM_NCM_CD))
        AND n.NCMA_CLTR_ID = :id AND :data BETWEEN e.ENCM_INICIO_VIGENCIA AND COALESCE(e.ENCM_FIM_VIGENCIA, :data))`, { ncm, id, data }),
    temNcmAplicavelSemExcecao: (ncm, id, data) => exists(`SELECT EXISTS (SELECT 1 FROM NCM_APLICAVEL n
      LEFT JOIN EXCECAO_NCM_APLICAVEL e ON e.ENCM_NCMA_ID = n.NCMA_ID
      WHERE n.NCMA_NCM_CD = SUBSTR(:ncm, 1, LENGTH(n.NCMA_NCM_CD)) AND n.NCMA_CLTR_ID = :id
        AND :data BETWEEN n.NCMA_INICIO_VIGENCIA AND COALESCE(n.NCMA_FIM_VIGENCIA, :data)
        AND (e.ENCM_ID IS NULL OR :data NOT BETWEEN e.ENCM_INICIO_VIGENCIA AND COALESCE(e.ENCM_FIM_VIGENCIA, :data)))`, { ncm, id, data }),
    temNbsAplicavel: (nbs, id, data) => exists(`SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
      WHERE n.NBSA_NBS_CD = SUBSTR(:nbs, 1, LENGTH(n.NBSA_NBS_CD)) AND n.NBSA_CLTR_ID = :id
        AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data))`, { nbs, id, data }),
    temExcecaoNbsAplicavel: (nbs, id, data) => exists(`SELECT EXISTS (SELECT 1 FROM EXCECAO_NBS_APLICAVEL e
      JOIN NBS_APLICAVEL n ON n.NBSA_ID = e.ENBS_NBSA_ID
      WHERE n.NBSA_NBS_CD = SUBSTR(:nbs, 1, LENGTH(n.NBSA_NBS_CD)) AND e.ENBS_NBS_CD = SUBSTR(:nbs, 1, LENGTH(e.ENBS_NBS_CD))
        AND n.NBSA_CLTR_ID = :id AND :data BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data))`, { nbs, id, data }),
    temNbsAplicavelSemExcecao: (nbs, id, data) => exists(`SELECT EXISTS (SELECT 1 FROM NBS_APLICAVEL n
      LEFT JOIN EXCECAO_NBS_APLICAVEL e ON e.ENBS_NBSA_ID = n.NBSA_ID
      WHERE n.NBSA_NBS_CD = SUBSTR(:nbs, 1, LENGTH(n.NBSA_NBS_CD)) AND n.NBSA_CLTR_ID = :id
        AND :data BETWEEN n.NBSA_INICIO_VIGENCIA AND COALESCE(n.NBSA_FIM_VIGENCIA, :data)
        AND (e.ENBS_ID IS NULL OR :data NOT BETWEEN e.ENBS_INICIO_VIGENCIA AND COALESCE(e.ENBS_FIM_VIGENCIA, :data)))`, { nbs, id, data }),
    /** cClassTrib options for a service code (used by the UI to suggest, never by the calc). */
    classificacoesDoDocumento: (tpDoc, data) => all(`
      SELECT DISTINCT ct.CLTR_CD codigo, ct.CLTR_DESCRICAO descricao, ct.CLTR_TPRBSN tpRBSN
      FROM TIPO_DFE_CLASSIFICACAO tdcl JOIN TIPO_DFE td ON td.TPDF_ID = tdcl.TDCL_TPDF_ID
      JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = tdcl.TDCL_CLTR_ID
      WHERE td.TPDF_TIPO = :tpDoc AND ct.CLTR_SITR_ID IN (${CBS})
        AND :data BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :data)
        AND :data BETWEEN tdcl.TDCL_INICIO_VIGENCIA AND COALESCE(tdcl.TDCL_FIM_VIGENCIA, :data)
      ORDER BY ct.CLTR_CD`, { tpDoc, data }),
  };
}
