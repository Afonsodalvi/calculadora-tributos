// Repositories and services read by the calculation engine (data-access.md §5, calc-core.md §4),
// with the SQL of the spec (native queries verbatim; JPQL translated as Hibernate generates it).
//
// Binding (data-access.md §1.3): dates as 'AAAA-MM-DD' text, Long/Integer parameters as BigInt
// (INTEGER, like setLong), null as NULL. Reading: REAL columns of JPQL/entity paths through
// CAST(... AS TEXT) + new BigDecimal(text); the native query that returns a bare REAL
// (buscarAliquotaAdValoremPorClassificacaoTributaria) goes through java.lang.Float like Hibernate.
// Single-result methods throw IncorrectResultSizeDataAccessException when 2+ rows come back.
//
// Every @Cacheable of the Java is transparent over the read-only database; the hot lookups are
// memoized per connection anyway (exceptions are not cached, like Spring).
import { Dec } from '../../../core/decimal.js';
import { javaFloatToString } from '../../comum/java.js';
import { criarAliquotaResultadoDTO } from './dominios.js';
import * as E from './excecoes.js';

export const SQL = Object.freeze({
  // TratamentoTributarioRepository.findById (entity)
  tratamentoTributario: `
SELECT * FROM TRATAMENTO_TRIBUTARIO tt WHERE tt.TRTR_ID = :id`,
  // ClassificacaoTributariaRepository.buscarClassificacaoTributariaCalculo (JPQL DTO)
  classificacaoTributariaCalculo: `
SELECT ct.CLTR_ID AS id, ct.CLTR_CD AS codigo, ct.CLTR_TIPO_ALIQUOTA AS tipoAliquota,
       ct.CLTR_IND_GMONOPADRAO AS inGrupoMonofasiaPadrao, ct.CLTR_IND_GMONORETEN AS inGrupoMonofasiaReten,
       ct.CLTR_IND_GMONORET AS inGrupoMonofasiaRet, ct.CLTR_IND_GMONODIF AS inGrupoMonofasiaDiferimento,
       st.SITR_IND_GRED AS inGrupoReducao
FROM CLASSIFICACAO_TRIBUTARIA ct
JOIN SITUACAO_TRIBUTARIA st ON st.SITR_ID = ct.CLTR_SITR_ID
WHERE ct.CLTR_ID = :id`,
  // SituacaoTributariaRepository.consultarSituacaoTributariaPorCodigo (native, verbatim)
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
  // PercentualReducaoRepository.buscar (JPQL scalar BigDecimal)
  percentualReducao: `
SELECT CAST(p.PERE_VALOR AS TEXT) AS valor
FROM PERCENTUAL_REDUCAO p
WHERE p.PERE_CLTR_ID = :idClassificacaoTributaria
  AND p.PERE_TBTO_ID = :idTributo
  AND (p.PERE_INICIO_VIGENCIA <= :data AND (p.PERE_FIM_VIGENCIA IS NULL OR p.PERE_FIM_VIGENCIA >= :data))`,
  // AliquotaPadraoRepository.buscarAliquota (JPQL constructor expression AliquotaResultadoDTO)
  aliquotaPadrao: `
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
  AND (r.ALRE_FIM_VIGENCIA IS NULL OR r.ALRE_FIM_VIGENCIA >= :data)`,
  // AliquotaReferenciaRepository.buscar (JPQL scalar BigDecimal)
  aliquotaReferencia: `
SELECT CAST(ar.ALRE_VALOR AS TEXT) AS valor
FROM ALIQUOTA_REFERENCIA ar
WHERE ar.ALRE_TBTO_ID = :idTributo
  AND :data BETWEEN ar.ALRE_INICIO_VIGENCIA AND COALESCE(ar.ALRE_FIM_VIGENCIA, :data)`,
  // AliquotaAdValoremServicoRepository.buscarAliquotaAdValoremDto (JPQL DTO; no LIMIT)
  aliquotaAdValoremServico: `
SELECT CAST(av.AADV_VALOR AS TEXT) AS valor
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
  // AliquotaAdValoremServicoRepository.buscarAliquotaAdValoremPorClassificacaoTributaria (native, verbatim)
  aliquotaAdValoremPorClassificacao: `
            SELECT aadv.AADV_VALOR
            FROM ALIQUOTA_AD_VALOREM aadv
            WHERE aadv.AADV_TBTO_ID = :idTributo
            AND aadv.AADV_CLTR_ID = :idClassificacaoTributaria
            AND :data BETWEEN aadv.AADV_INICIO_VIGENCIA AND COALESCE(aadv.AADV_FIM_VIGENCIA, :data)`,
  // TransferenciaCBSRepository.getPercentualTransferencia (JPQL Optional<BigDecimal>)
  percentualTransferencia: `
SELECT CAST(t.TCEG_VALOR AS TEXT) AS valor
FROM TRANSFERENCIA_CBS_ENTE_GOV t
WHERE t.TCEG_INICIO_VIGENCIA <= :data AND (t.TCEG_FIM_VIGENCIA IS NULL OR t.TCEG_FIM_VIGENCIA >= :data)`,
  // FundamentacaoClassificacaoRepository.buscar (JPQL DTO)
  fundamentacaoClassificacao: `
SELECT fl.FDLG_TEXTO_CURTO AS textoCurto, ct.CLTR_MEMORIA_CALCULO AS memoriaCalculo
FROM FUNDAMENTACAO_CLASSIFICACAO fc
JOIN FUNDAMENTACAO_LEGAL fl ON fl.FDLG_ID = fc.FDCL_FDLG_ID
JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = fc.FDCL_CLTR_ID
WHERE fc.FDCL_CLTR_ID = :idClassificacaoTributaria
  AND :data BETWEEN fc.FDCL_INICIO_VIGENCIA AND COALESCE(fc.FDCL_FIM_VIGENCIA, :data)`,
});

/** Long/Integer parameter → INTEGER binding (null stays NULL). */
const longo = (v) => (v == null ? null : BigInt(v));
/** BigDecimal read through the JPQL path: new BigDecimal(sqlite3_column_text). */
const decimalTexto = (t) => (t == null ? null : Dec.parse(String(t)));
/** Boolean entity/DTO attribute from INTEGER: getInt != 0; NULL → null. */
const booleano = (v) => (v == null ? null : Number(v) !== 0);

/**
 * getSingleResult + uniqueElement (data-access.md §3): 0 rows → null; 2+ rows → error, except a
 * scalar column that is NULL in every row (same reference) → null.
 */
function unico(linhas, coluna) {
  if (linhas.length === 0) return null;
  if (linhas.length > 1 && !(coluna && linhas.every((l) => l[coluna] == null))) throw E.resultadoNaoUnico(linhas.length);
  return coluna ? linhas[0][coluna] : linhas[0];
}

/**
 * Memoizes f by its arguments (Spring @Cacheable with allowNullValues; exceptions are not cached).
 * Bounded like the Caffeine caches (maximumSize): the oldest entry is dropped when full.
 */
function memo(f, maximo = 10_000) {
  const cache = new Map();
  return (...args) => {
    const k = JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
    if (cache.has(k)) return cache.get(k);
    const r = f(...args);
    if (cache.size >= maximo) cache.delete(cache.keys().next().value);
    cache.set(k, r);
    return r;
  };
}

/**
 * Services of the engine over the read-only connection `base` (src/core/db.js). Method names and
 * contracts are the Java ones; ids are numbers, dates 'AAAA-MM-DD'.
 */
export function criarServicos(base) {
  const tratamentoService = {
    /** TratamentoTributarioService.buscar(id) (@Cacheable): entity or TratamentoTributarioNaoEncontradoException. */
    buscar: memo((id) => {
      const r = unico(base.all(SQL.tratamentoTributario, { id: longo(id) }));
      if (!r) throw E.tratamentoTributarioNaoEncontrado(id);
      return Object.freeze({
        id: Number(r.TRTR_ID),
        descricao: r.TRTR_DESCRICAO,
        expressaoAliquota: r.TRTR_EXPRESSAO_ALIQUOTA,
        expressaoAliquotaEfetiva: r.TRTR_EXPRESSAO_ALIQUOTA_EFETIVA,
        expressaoBaseCalculo: r.TRTR_EXPRESSAO_BASE_CALCULO,
        expressaoTributoCalculado: r.TRTR_EXPRESSAO_TRIBUTO_CALCULADO,
        expressaoTributoDevido: r.TRTR_EXPRESSAO_TRIBUTO_DEVIDO,
        expressaoPercentualDiferimento: r.TRTR_EXPRESSAO_PERCENTUAL_DIFERIMENTO,
        expressaoValorDiferimento: r.TRTR_EXPRESSAO_VALOR_DIFERIMENTO,
        // primitive boolean attributes (NOT NULL columns)
        inIncompativelComSuspensao: Number(r.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO) !== 0,
        inExigeGrupoDesoneracao: Number(r.TRTR_IN_EXIGE_GRUPO_DESONERACAO) !== 0,
        inPossuiPercentualReducao: Number(r.TRTR_IN_POSSUI_PERCENTUAL_REDUCAO) !== 0,
        inPossuiAjuste: Number(r.TRTR_IN_POSSUI_AJUSTE) !== 0,
        inPossuiRedutor: Number(r.TRTR_IN_POSSUI_REDUTOR) !== 0,
        inPossuiMonofasia: Number(r.TRTR_IN_POSSUI_MONOFASIA) !== 0,
      });
    }),
  };

  const classificacaoTributariaService = {
    /** ClassificacaoTributariaService.buscarClassificacaoTributariaCalculo(id): DTO or ClassificacaoTributariaNaoEncontradaException. */
    buscarClassificacaoTributariaCalculo: memo((id) => {
      const r = unico(base.all(SQL.classificacaoTributariaCalculo, { id: longo(id) }));
      if (!r) throw E.classificacaoTributariaNaoEncontradaPorId(id);
      return Object.freeze({
        id: Number(r.id), codigo: r.codigo, tipoAliquota: r.tipoAliquota,
        inGrupoMonofasiaPadrao: booleano(r.inGrupoMonofasiaPadrao), inGrupoMonofasiaReten: booleano(r.inGrupoMonofasiaReten),
        inGrupoMonofasiaRet: booleano(r.inGrupoMonofasiaRet), inGrupoMonofasiaDiferimento: booleano(r.inGrupoMonofasiaDiferimento),
        inGrupoReducao: booleano(r.inGrupoReducao),
      });
    }),
  };

  const situacaoTributariaService = {
    /** SituacaoTributariaService.consultarSituacaoTributariaPorCodigo(cst, idTributo, data): entity or null (LIMIT 1). */
    consultarSituacaoTributariaPorCodigo: memo((cst, idTributo, data) => {
      const r = base.get(SQL.situacaoTributariaPorCodigo, { cst: cst ?? null, idTributo: longo(idTributo), data });
      if (!r) return null;
      return Object.freeze({ id: Number(r.SITR_ID), codigo: r.SITR_CD, inGrupoIbsCbs: booleano(r.SITR_IND_GIBSCBS), inGrupoReducao: booleano(r.SITR_IND_GRED) });
    }),
  };

  const percentualReducaoService = {
    /** PercentualReducaoService.buscar(idClassificacao, idTributo, data): p.p. or PercentualReducaoNaoEncontradoException. */
    buscar: memo((idClassificacaoTributaria, idTributo, data) => {
      const v = decimalTexto(unico(base.all(SQL.percentualReducao, { idClassificacaoTributaria: longo(idClassificacaoTributaria), idTributo: longo(idTributo), data }), 'valor'));
      if (v == null) throw E.percentualReducaoNaoEncontrado(idClassificacaoTributaria, data);
      return v;
    }),
  };

  const aliquotaPadraoService = {
    /** AliquotaPadraoService.buscarAliquota(idTributo, codigoUf, municipio, data): AliquotaResultadoDTO or AliquotaNaoEncontradaException. */
    buscarAliquota: memo((idTributo, codigoUf, municipio, data) => {
      const linhas = base.all(SQL.aliquotaPadrao, { idTributo: longo(idTributo), codigoUf: longo(codigoUf), municipio: longo(municipio), data });
      // Hibernate instantiates the DTO for every row (the compact constructor validates), then uniqueElement
      const dtos = linhas.map((l) => criarAliquotaResultadoDTO(decimalTexto(l.valorReferencia), decimalTexto(l.valorPadrao), l.formaAplicacao ?? null));
      if (dtos.length > 1) throw E.resultadoNaoUnico(dtos.length);
      if (dtos.length === 0) throw E.aliquotaNaoEncontrada(idTributo, codigoUf, municipio, data);
      return dtos[0];
    }),
  };

  const aliquotaReferenciaService = {
    /** AliquotaReferenciaService.buscar(idTributo, data): p.p. or AliquotaReferenciaNaoEncontradaException. */
    buscar: memo((idTributo, data) => {
      const v = decimalTexto(unico(base.all(SQL.aliquotaReferencia, { idTributo: longo(idTributo), data }), 'valor'));
      if (v == null) throw E.aliquotaReferenciaNaoEncontrada(idTributo, data);
      return v;
    }),
  };

  const aliquotaAdValoremServicoService = {
    /** buscarAliquotaAdValorem(nbs, idTributo, idClassificacao, data) = buscarAliquotaAdValoremDto(...)?.valor(). */
    buscarAliquotaAdValorem(nbs, idTributo, idClassificacaoTributaria, data) {
      const dto = aliquotaAdValoremServicoService.buscarAliquotaAdValoremDto(nbs, idTributo, idClassificacaoTributaria, data);
      return dto != null ? dto.valor : null;
    },
    /** AliquotaAdValoremDTO(valor) or null; 2+ rows → ErroGenericoValidacaoException (caught IncorrectResultSize). */
    buscarAliquotaAdValoremDto(nbs, idTributo, idClassificacaoTributaria, data) {
      const linhas = base.all(SQL.aliquotaAdValoremServico, { nbs: nbs ?? null, idTributo: longo(idTributo), idClassificacaoTributaria: longo(idClassificacaoTributaria), data });
      if (linhas.length > 1) throw E.erroGenericoValidacao('Consulta retornou múltiplos valores quando apenas um era esperado.');
      return linhas.length === 0 ? null : Object.freeze({ valor: decimalTexto(linhas[0].valor) });
    },
    /** Native scalar REAL → java.lang.Float → new BigDecimal(Float.toString(f)); NULL → null. */
    buscarAliquotaAdValoremPorClassificacaoTributaria(idTributo, idClassificacaoTributaria, data) {
      const linhas = base.all(SQL.aliquotaAdValoremPorClassificacao, { idTributo: longo(idTributo), idClassificacaoTributaria: longo(idClassificacaoTributaria), data });
      if (linhas.length > 1 && !linhas.every((l) => l.AADV_VALOR == null)) {
        throw E.erroGenericoValidacao('Consulta retornou múltiplos valores quando apenas um era esperado.');
      }
      const x = linhas.length === 0 ? null : linhas[0].AADV_VALOR;
      return x == null ? null : Dec.parse(javaFloatToString(Number(x)));
    },
  };

  const transferenciaService = {
    /** TransferenciaCBSService.getPercentualTransferencia(data): p.p. or RuntimeException. */
    getPercentualTransferencia: memo((data) => {
      const v = decimalTexto(unico(base.all(SQL.percentualTransferencia, { data }), 'valor'));
      if (v == null) throw E.runtime('Percentual de transferência de CBS para ente federativo não encontrada.');
      return v;
    }),
  };

  const fundamentacaoClassificacaoService = {
    /** FundamentacaoClassificacaoService.buscar(idClassificacao, data): {textoCurto, memoriaCalculo} or FundamentacaoClassificacaoNaoEncontradaException. */
    buscar: memo((idClassificacaoTributaria, data) => {
      const r = unico(base.all(SQL.fundamentacaoClassificacao, { idClassificacaoTributaria: longo(idClassificacaoTributaria), data }));
      if (!r) throw E.fundamentacaoNaoEncontrada(idClassificacaoTributaria, data);
      return Object.freeze({ textoCurto: r.textoCurto, memoriaCalculo: r.memoriaCalculo });
    }),
  };

  return {
    tratamentoService, classificacaoTributariaService, situacaoTributariaService, percentualReducaoService,
    aliquotaPadraoService, aliquotaReferenciaService, aliquotaAdValoremServicoService, transferenciaService,
    fundamentacaoClassificacaoService,
  };
}
