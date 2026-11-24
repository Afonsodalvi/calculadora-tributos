// DadosAbertosService (domain/service/dadosabertos) and the services it calls, ported from
// calculadora-rtc-regime-regular 1.7.2: NomenclaturaService, NcmAplicavelService / NbsAplicavelService
// (validar*), NcmService, AliquotaPadraoService + the AliquotaResultadoDTO record, SiglasDFeEnum.
// Every output DTO is built as a plain object whose keys are already in Jackson 3 order (alphabetical,
// spec §1.5; the NcmVigenciaOutput record keeps its component order); null properties are dropped by the
// JSON writer (NON_NULL). BigDecimal → Dec (written with BigDecimal.toString()), LocalDate → 'yyyy-MM-dd'.
// Defects of the Java code are kept on purpose (see the comments marked "preserved").
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';
import { javaFloatToString, javaDoubleToString, javaIsBlank } from '../comum/java.js';
import { DataLocal, lerIsoLocalDate } from './datas.js';
import * as Q from './consultas.js';

// ─── SiglasDFeEnum ──────────────────────────────────────────────────────────

/** Constant name → sigla, in declaration order. */
export const SIGLAS_DFE = Object.freeze({
  NFEABI: 'NFe ABI', NFE: 'NFe', NFCE: 'NFCe', CTE: 'CTe', CTEOS: 'CTe OS', CTESIMPLIFICADO: 'CT-e Simplificado',
  BPE: 'BPe', BPETA: 'BPe TA', BPETM: 'BPe TM', NF3E: 'NF3e', NFSE: 'NFSe', NFSEVIA: 'NFSe Via', NFCOM: 'NFCom',
  DERE: 'DERE', DIR: 'DIR', DUIMP: 'Duimp', NFAG: 'NFAg', NFGAS: 'NFGas',
});
const NCM_APLICAVEL = new Set(['NFSE', 'NFE', 'NFCE']);
const NBS_APLICAVEL = new Set(['NFSE']);
const IMPOSTO_SELETIVO_APLICAVEL = new Set(['NFE', 'NFCE']);

/** SiglasDFeEnum.normalizarSigla: toUpperCase() then remove [\s\-_] (Java \s = [ \t\n\x0B\f\r]). */
export const normalizarSigla = (sigla) => (sigla == null ? '' : sigla.toUpperCase().replace(/[ \t\n\x0B\f\r\-_]/g, ''));

/** SiglasDFeEnum.getPorSiglaNormalizada → constant name, or SiglaDFeNaoEncontradaException (raw text). */
export function siglaPorNormalizada(sigla) {
  const n = normalizarSigla(sigla);
  if (Object.hasOwn(SIGLAS_DFE, n)) return n;
  throw new ErroJava('SiglaDFeNaoEncontradaException', `Sigla DFe inválida: ${sigla === null ? 'null' : sigla}`);
}

/** SiglasDFeEnum.corresponde(siglaBanco). */
export const corresponde = (constante, siglaBanco) => constante === normalizarSigla(siglaBanco);
export const ncmAplicavel = (sigla) => NCM_APLICAVEL.has(normalizarSigla(sigla));
export const nbsAplicavel = (sigla) => NBS_APLICAVEL.has(normalizarSigla(sigla));
export const impostoSeletivoAplicavel = (sigla) => IMPOSTO_SELETIVO_APLICAVEL.has(normalizarSigla(sigla));

// ─── AliquotaResultadoDTO (record with a validating compact constructor) ─────────────

export const FORMAS_APLICACAO = Object.freeze(['SUBSTITUICAO', 'ACRESCIMO', 'DECRESCIMO']);

export class AliquotaResultadoDTO {
  /** (BigDecimal valorReferencia, BigDecimal valorPadrao, FormaAplicacaoEnum formaAplicacao) — Dec or null. */
  constructor(valorReferencia, valorPadrao, formaAplicacao) {
    if (valorReferencia == null) throw new ErroJava('AliquotaReferenciaNaoEncontradaException', 'Alíquota de referência não encontrada');
    if (valorReferencia.signum() < 0) throw new ErroJava('AliquotaNegativaException', 'Alíquota de referência não pode ter valor negativo');
    if (valorPadrao != null) {
      if (valorPadrao.signum() < 0) throw new ErroJava('AliquotaNegativaException', 'Alíquota padrão não pode ter valor negativo');
      if (formaAplicacao == null) throw new ErroJava('FormaAplicacaoNaoDefinidaException', 'Forma de aplicação da alíquota própria não definida');
      if (formaAplicacao === 'ACRESCIMO') valorPadrao = valorReferencia.add(valorPadrao);
      else if (formaAplicacao === 'DECRESCIMO') valorPadrao = valorReferencia.sub(valorPadrao);
      else if (formaAplicacao !== 'SUBSTITUICAO') throw new ErroJava('FormaAplicacaoNaoTratadaException', null);
      if (valorPadrao.signum() < 0) throw new ErroJava('AliquotaNegativaException', 'Alíquota aplicável resultante não pode ter valor negativo');
    } else if (formaAplicacao != null) {
      throw new ErroJava('AliquotaPadraoNaoEncontradaException', 'Alíquota padrão não encontrada');
    }
    this.valorReferencia = valorReferencia;
    this.valorPadrao = valorPadrao;
    this.formaAplicacao = formaAplicacao;
    Object.freeze(this);
  }

  valorAplicavel() { return this.valorPadrao != null ? this.valorPadrao : this.valorReferencia; }

  /** Record equals: component-wise, BigDecimal.equals (value and scale). */
  equals(o) {
    const igualDec = (a, b) => (a == null ? b == null : b != null && a.equalsJava(b));
    return o instanceof AliquotaResultadoDTO && igualDec(this.valorReferencia, o.valorReferencia)
      && igualDec(this.valorPadrao, o.valorPadrao) && this.formaAplicacao === o.formaAplicacao;
  }

  /** Equal records give the same hash (the Java value differs; only the contract matters). */
  hashCode() { return `${this.valorReferencia?.toJavaString()}|${this.valorPadrao?.toJavaString()}|${this.formaAplicacao}`; }

  toString() {
    const s = (v) => (v == null ? 'null' : v instanceof Dec ? v.toJavaString() : String(v));
    return `AliquotaResultadoDTO[valorReferencia=${s(this.valorReferencia)}, valorPadrao=${s(this.valorPadrao)}, formaAplicacao=${s(this.formaAplicacao)}]`;
  }
}

/** AliquotaPadraoService.buscarAliquota over a repository returning the JPQL rows (text of the REAL columns). */
export function criarAliquotaPadraoService(repositorio) {
  return {
    buscarAliquota(idTributo, codigoUf, municipio, data) {
      const linhas = repositorio.buscarAliquota(idTributo, codigoUf, municipio, data);
      if (linhas.length > 1) throw new ErroJava('IncorrectResultSizeDataAccessException', `Query did not return a unique result: ${linhas.length} results were returned`);
      if (!linhas.length) {
        throw new ErroJava('AliquotaNaoEncontradaException',
          `Alíquota de referencia ou padrão não encontrada para o tributo com id ${idTributo}, UF ${codigoUf ?? 'null'}, município ${municipio ?? 'null'} e data ${data}`);
      }
      const l = linhas[0];
      try {
        return new AliquotaResultadoDTO(l.valorReferencia == null ? null : Dec.parse(l.valorReferencia),
          l.valorPadrao == null ? null : Dec.parse(l.valorPadrao), l.formaAplicacao ?? null);
      } catch (e) {
        // the record constructor runs inside Hibernate's dynamic instantiation: the cause arrives wrapped (500)
        if (e instanceof ErroJava) throw new ErroJava('JpaSystemException', 'Error performing dynamic instantiation : br.gov.serpro.rtc.domain.model.dto.AliquotaResultadoDTO');
        throw e;
      }
    },
  };
}

// ─── conversions of DadosAbertosService ──────────────────────────────────────────

/**
 * DadosAbertosService.convertToBigDecimal(Object). `tipo` = the Java runtime class of the value
 * ('Float' | 'Double' | 'Integer' | 'Long' | 'String' | 'BigDecimal'); null value → null.
 */
export function converterParaBigDecimal(valor, tipo) {
  if (valor == null) return null;
  switch (tipo) {
    case 'BigDecimal': return valor instanceof Dec ? valor : Dec.parse(String(valor));
    case 'Float': return Dec.parse(javaFloatToString(Number(valor))); // through Float.toString, never double
    case 'Double': return Dec.parse(javaDoubleToString(Number(valor))); // BigDecimal.valueOf(double)
    case 'Integer':
    case 'Long': return new Dec(BigInt(valor), 0);
    default:
      try { return Dec.parse(String(valor)); } catch { return null; }
  }
}

/** DadosAbertosService.parseToLocalDate(m, i): String → LocalDate.parse (ISO, strict); anything else → null. */
export function paraDataLocal(linha, indice) {
  if (linha == null || indice < 0 || indice >= linha.length) return null;
  const v = linha[indice];
  if (v == null) return null;
  const s = String(v);
  if (javaIsBlank(s)) return null;
  return lerIsoLocalDate(s);
}

/** (m[i] != null && ((Integer) m[i]) != 0). */
const flag = (v) => v != null && Number(v) !== 0;

/** Entity LocalDate read by getDate (FastDateFormat "yyyy-MM-dd" parses the prefix). */
const dataEntidade = (texto) => (texto == null ? null : String(texto).slice(0, 10));

// ─── output DTOs (keys in Jackson 3 order) ─────────────────────────────────────

function classificacaoSaida(c) {
  return {
    codigo: c.codigo,
    creditoOperacaoAntecedente: c.creditoOperacaoAntecedente ?? null,
    dataAtualizacao: c.dataAtualizacao ? c.dataAtualizacao.toString() : null,
    descricao: c.descricao,
    descricaoTratamentoTributario: c.descricaoTratamentoTributario,
    exigeGrupoDesoneracao: c.exigeGrupoDesoneracao,
    incompativelComSuspensao: c.incompativelComSuspensao,
    indicaApropriacaoCreditoAdquirenteCbs: c.indicaApropriacaoCreditoAdquirenteCbs ?? false,
    indicaApropriacaoCreditoAdquirenteIbs: c.indicaApropriacaoCreditoAdquirenteIbs ?? false,
    indicaCreditoPresumidoAdquirente: c.indicaCreditoPresumidoAdquirente ?? false,
    indicaCreditoPresumidoFornecedor: c.indicaCreditoPresumidoFornecedor ?? false,
    nomenclatura: c.nomenclatura,
    percentualReducaoCbs: c.percentualReducaoCbs ?? null,
    percentualReducaoIbsMun: c.percentualReducaoIbsMun ?? null,
    percentualReducaoIbsUf: c.percentualReducaoIbsUf ?? null,
    possuiPercentualReducao: c.possuiPercentualReducao,
    tipoAliquota: c.tipoAliquota,
    tipoReceitaBrutaSimplesNacional: c.tipoReceitaBrutaSimplesNacional ?? null,
    tiposDfeClassificacao: c.tiposDfeClassificacao,
  };
}

/** MAP_A: rows of consultarTratamentoClassificacaoPorIdSituacaoTributaria / PorCstETributoTipo. */
const mapaA = (m, tipos) => classificacaoSaida({
  codigo: m[0], descricao: m[1], tipoAliquota: m[2], nomenclatura: m[3], descricaoTratamentoTributario: m[4],
  incompativelComSuspensao: flag(m[5]), exigeGrupoDesoneracao: flag(m[6]), possuiPercentualReducao: flag(m[7]),
  tiposDfeClassificacao: tipos, dataAtualizacao: paraDataLocal(m, 9),
});

/** MAP_B: rows of consultarTratamentoClassificacaoCbsIbs (PERE_VALOR is a Float in Java). */
const mapaB = (m, tipos, comTipoReceita) => classificacaoSaida({
  codigo: m[1], descricao: m[2], tipoAliquota: m[3], nomenclatura: m[4], descricaoTratamentoTributario: m[5],
  incompativelComSuspensao: flag(m[6]), exigeGrupoDesoneracao: flag(m[7]), possuiPercentualReducao: flag(m[8]),
  indicaApropriacaoCreditoAdquirenteCbs: flag(m[9]), indicaApropriacaoCreditoAdquirenteIbs: flag(m[10]),
  indicaCreditoPresumidoFornecedor: flag(m[11]), indicaCreditoPresumidoAdquirente: flag(m[12]),
  creditoOperacaoAntecedente: m[13],
  percentualReducaoCbs: m[14] != null ? converterParaBigDecimal(m[14], 'Float') : null,
  percentualReducaoIbsUf: m[15] != null ? converterParaBigDecimal(m[15], 'Float') : null,
  percentualReducaoIbsMun: m[16] != null ? converterParaBigDecimal(m[16], 'Float') : null,
  tipoReceitaBrutaSimplesNacional: comTipoReceita && m[19] != null ? Number(m[19]) : null,
  tiposDfeClassificacao: tipos, dataAtualizacao: paraDataLocal(m, 18),
});

/**
 * MAP_C: rows of consultarTratamentoClassificacaoImpostoSeletivo. Preserved defect: dataAtualizacao reads
 * index 10 (SITR_IND_GDIF, 0/1), which never parses as a date, so it is never written.
 */
const mapaC = (m, tipos) => classificacaoSaida({
  codigo: m[1], descricao: m[2], tipoAliquota: m[3], nomenclatura: m[4], descricaoTratamentoTributario: m[5],
  incompativelComSuspensao: flag(m[6]), exigeGrupoDesoneracao: flag(m[7]), possuiPercentualReducao: flag(m[8]),
  tiposDfeClassificacao: tipos, dataAtualizacao: paraDataLocal(m, 10),
});

/** agruparCstsComClassificacoes: LinkedHashMap by codigo_cst in arrival order. */
function agruparCstsComClassificacoes(linhas) {
  const mapa = new Map();
  for (const r of linhas) {
    if (!mapa.has(r[1])) mapa.set(r[1], { classificacoesTributarias: [], codigo: r[1], descricao: r[2], id: r[0] == null ? null : r[0] });
    mapa.get(r[1]).classificacoesTributarias.push({ codigo: r[3], descricao: r[4] });
  }
  return [...mapa.values()];
}

/** flagSqlite(valor, padrao): Boolean → itself, Number → != 0, else the default. */
const flagSqlite = (v, padrao) => (typeof v === 'boolean' ? v : typeof v === 'number' || typeof v === 'bigint' ? Number(v) !== 0 : padrao);

// ─── services used by DadosAbertosService ─────────────────────────────────────────

/** NcmAplicavelService.validarNcmAplicavel over a repository { tem, temNcmAplicavel, temExcecaoNcmAplicavel, temNcmAplicavelSemExcecao }. */
export function criarNcmAplicavelService(repo) {
  return {
    validarNcmAplicavel(ncm, idClassificacaoTributaria, codigoClassificacaoTributaria, data, tributos) {
      const possuiNcmCompleto = (ncm == null ? 0 : ncm.length) === 8;
      const tem = repo.tem(idClassificacaoTributaria, data);
      if (tem && !possuiNcmCompleto) throw new ErroJava('NcmCompletoNaoInformadoException', 'NCM completo não informado');
      if (possuiNcmCompleto && tem) {
        const naoVinculada = () => new ErroJava('NcmNaoVinculadaException',
          `NCM de código ${ncm} não vinculada à Classificação Tributária de código ${codigoClassificacaoTributaria} (${tributos})`);
        if (!repo.temNcmAplicavel(ncm, idClassificacaoTributaria, data)) throw naoVinculada();
        if (repo.temExcecaoNcmAplicavel(ncm, idClassificacaoTributaria, data) && !repo.temNcmAplicavelSemExcecao(ncm, idClassificacaoTributaria, data)) throw naoVinculada();
      }
      return true;
    },
  };
}

/** NbsAplicavelService.validarNbsAplicavel over a repository { tem, temNbsAplicavel, temExcecaoNbsAplicavel, temNbsAplicavelSemExcecao }. */
export function criarNbsAplicavelService(repo) {
  return {
    validarNbsAplicavel(nbs, idClassificacaoTributaria, codigoClassificacaoTributaria, data, tributos) {
      const possuiNbsCompleto = (nbs == null ? 0 : nbs.length) === 9;
      const tem = repo.tem(idClassificacaoTributaria, data);
      if (tem && !possuiNbsCompleto) throw new ErroJava('NbsCompletoNaoInformadoException', 'NBS completo não informado');
      if (possuiNbsCompleto && tem) {
        const naoVinculada = () => new ErroJava('NbsNaoVinculadaException',
          `NBS de código ${nbs} não vinculada à Classificação Tributária de código ${codigoClassificacaoTributaria} (${tributos})`);
        if (!repo.temNbsAplicavel(nbs, idClassificacaoTributaria, data)) throw naoVinculada();
        if (repo.temExcecaoNbsAplicavel(nbs, idClassificacaoTributaria, data) && !repo.temNbsAplicavelSemExcecao(nbs, idClassificacaoTributaria, data)) throw naoVinculada();
      }
      return true;
    },
  };
}

/** NcmService (pure delegation to NcmRepository { existeNcm, buscarTodosNcmsVigentes }). */
export function criarNcmService(repo) {
  return {
    existeNcm: (ncm, data) => repo.existeNcm(ncm, data),
    /** → [NcmVigenciaOutput { ncm, descricao }] (record: component order). */
    consultarNcmsVigentes: (data) => repo.buscarTodosNcmsVigentes(data).map((r) => ({ ncm: r.ncm, descricao: r.descricao })),
  };
}

/** Default repositories over the shared read-only database. */
export function repositorios(base) {
  return {
    ncmAplicavel: {
      tem: (id, data) => Q.ncmAplicavelTem(base, id, data),
      temNcmAplicavel: (ncm, id, data) => Q.temNcmAplicavel(base, ncm, id, data),
      temExcecaoNcmAplicavel: (ncm, id, data) => Q.temExcecaoNcmAplicavel(base, ncm, id, data),
      temNcmAplicavelSemExcecao: (ncm, id, data) => Q.temNcmAplicavelSemExcecao(base, ncm, id, data),
    },
    nbsAplicavel: {
      tem: (id, data) => Q.nbsAplicavelTem(base, id, data),
      temNbsAplicavel: (nbs, id, data) => Q.temNbsAplicavel(base, nbs, id, data),
      temExcecaoNbsAplicavel: (nbs, id, data) => Q.temExcecaoNbsAplicavel(base, nbs, id, data),
      temNbsAplicavelSemExcecao: (nbs, id, data) => Q.temNbsAplicavelSemExcecao(base, nbs, id, data),
    },
    ncm: {
      existeNcm: (ncm, data) => Q.existeNcm(base, ncm, data),
      buscarTodosNcmsVigentes: (data) => Q.buscarTodosNcmsVigentes(base, data).map((r) => ({ ncm: r.NCM_CD, descricao: r.NCM_DESCRICAO })),
    },
    aliquotaPadrao: {
      buscarAliquota: (idTributo, codigoUf, municipio, data) => Q.buscarAliquotaPadrao(base, idTributo, codigoUf, municipio, data),
    },
  };
}

// ─── DadosAbertosService ─────────────────────────────────────────────────────

const ID_TRIBUTO_CBS = 2;

/** jakarta.validation.ValidationException (not the domain ValidacaoException): 500 in the ApiExceptionHandler. */
const validacaoJakarta = (mensagem) => new ErroJava('ValidationException', mensagem);

function validarNcm(ncm) {
  if (ncm == null) throw validacaoJakarta('O campo NCM é obrigatório.');
  if (!/^[0-9]+$/.test(ncm)) throw validacaoJakarta('O campo NCM deve conter somente dígitos.');
}

function validarNbs(nbs) {
  if (nbs == null) throw validacaoJakarta('O campo NBS é obrigatório.');
  if (!/^[0-9]+$/.test(nbs)) throw validacaoJakarta('O campo NBS deve conter somente dígitos.');
}

/**
 * DadosAbertosService. `sobrescritas` replaces collaborators in unit tests (Mockito stubs of the Java
 * tests): { aliquotaPadraoService, ncmAplicavelService, nbsAplicavelService, ncmService, hoje }.
 */
export function criarServicoDadosAbertos(base, sobrescritas = {}) {
  const repos = repositorios(base);
  const aliquotaPadraoService = sobrescritas.aliquotaPadraoService ?? criarAliquotaPadraoService(repos.aliquotaPadrao);
  const ncmAplicavelService = sobrescritas.ncmAplicavelService ?? criarNcmAplicavelService(repos.ncmAplicavel);
  const nbsAplicavelService = sobrescritas.nbsAplicavelService ?? criarNbsAplicavelService(repos.nbsAplicavel);
  const ncmService = sobrescritas.ncmService ?? criarNcmService(repos.ncm);
  const hoje = sobrescritas.hoje ?? (() => DataLocal.hoje());

  /** TipoDfeClassificacaoService.buscar → TipoDfeClassificacaoDadosAbertosOutput[] {descricao, sigla, tipo}. */
  const obterListaDfeClassificacaoTributaria = (id, data) => Q.buscarTiposDfeClassificacao(base, id, data)
    .map((t) => ({ descricao: t.TPDF_DESCRICAO, sigla: t.TPDF_SIGLA, tipo: t.TPDF_TIPO }));

  /** ClassificacaoTributariaService.buscarClassificacaoTributariaCbsIbs → { id, codigo, nomenclatura, cst }. */
  function buscarClassificacaoTributariaCbsIbs(codigo, data) {
    const linhas = Q.buscarClassificacaoTributaria(base, codigo, ID_TRIBUTO_CBS, data);
    if (linhas.length > 1) throw new ErroJava('IncorrectResultSizeDataAccessException', `Query did not return a unique result: ${linhas.length} results were returned`);
    if (!linhas.length) throw classificacaoNaoEncontrada(codigo, 'CBS e IBS', data);
    return linhas[0];
  }

  function classificacaoNaoEncontrada(codigo, tributo, data) {
    return new ErroJava('ClassificacaoTributariaNaoEncontradaException',
      `Classificação tributária não encontrada para código ${codigo} e data ${data} (${tributo})`);
  }

  /** NomenclaturaService.determinarNomenclatura (404 of the classification before the 422 of the sigla). */
  function determinarNomenclatura(siglaDfe, cClassTrib, data) {
    const classificacao = buscarClassificacaoTributariaCbsIbs(cClassTrib, data);
    const id = classificacao.id;
    const tipos = Q.buscarTiposDfeClassificacao(base, id, data);
    const sigla = siglaPorNormalizada(siglaDfe);
    if (!tipos.some((t) => corresponde(sigla, t.TPDF_SIGLA))) return 'SEM';
    const temNcm = Q.ncmAplicavelTem(base, id, data);
    const temNbs = Q.nbsAplicavelTem(base, id, data);
    if (cClassTrib === '200038' || cClassTrib === '515001') {
      const s = siglaPorNormalizada(siglaDfe);
      if (s === 'NFE' || s === 'NFCE') return 'EXCECAO_NCM';
      if (s === 'NFSE') return 'EXCECAO_NBS';
      return 'SEM';
    }
    if (ncmAplicavel(siglaDfe) && !nbsAplicavel(siglaDfe)) return temNcm ? 'NCM' : 'SEM';
    if (nbsAplicavel(siglaDfe)) {
      if (temNcm && temNbs) return 'MISTO';
      if (temNcm) return 'NCM';
      if (temNbs) return 'NBS';
      return 'SEM';
    }
    return 'SEM';
  }

  const servico = {
    buscarClassificacaoTributariaCbsIbs,
    determinarNomenclatura,

    consultarUfs: () => Q.consultarUfs(base).map((u) => ({ codigo: u.UF_CD, nome: u.UF_NOME, sigla: u.UF_SIGLA })),

    consultarMunicipiosPorSiglaUf: (siglaUf) => Q.consultarMunicipiosPorSiglaUf(base, siglaUf).map((m) => ({ codigo: m.MUNI_CD, nome: m.MUNI_NOME })),

    consultarSituacoesTributarias: (idTributo, data) => Q.consultarSituacoesPorIdTributo(base, idTributo, data)
      .map((s) => ({ codigo: s.SITR_CD, descricao: s.SITR_DESCRICAO, id: s.SITR_ID })),

    consultarClassificacoesTributariasPorIdSituacaoTributaria: (idSituacaoTributaria, data) => Q.consultarTratamentoPorIdSituacao(base, idSituacaoTributaria, data)
      .map((m) => mapaA(m, obterListaDfeClassificacaoTributaria(m[8], data))),

    consultarClassificacoesTributariasPorCstETributoTipo: (cst, tributos, data) => Q.consultarTratamentoPorCstETributoTipo(base, cst, tributos, data)
      .map((m) => mapaA(m, obterListaDfeClassificacaoTributaria(m[8], data))),

    consultarClassificacoesTributariasCbsIbs: (data) => Q.consultarTratamentoCbsIbs(base, null, data)
      .map((m) => mapaB(m, obterListaDfeClassificacaoTributaria(m[0], data), false)),

    consultarClassificacoesTributariasCbsIbsPorAtores(data, fornecedor, adquirente, siglaDfe) {
      const classificacoes = servico.consultarClassificacoesTributariasCbsIbs(data);
      if (fornecedor == null && adquirente == null && siglaDfe == null) return classificacoes;
      // the sigla is only normalized, never validated: an unknown one admits nothing
      const siglaNormalizada = siglaDfe != null ? normalizarSigla(siglaDfe) : null;
      const admitidos = new Set(Q.listarCodigosClassificacoesPorAtores(base, data, fornecedor, adquirente, siglaNormalizada));
      return classificacoes.filter((c) => admitidos.has(c.codigo));
    },

    consultarClassificacaoTributariaCbsIbsPorCodigo(cClassTrib, data) {
      const r = Q.consultarTratamentoCbsIbs(base, cClassTrib, data);
      if (!r.length) throw classificacaoNaoEncontrada(cClassTrib, 'CBS e IBS', data);
      return mapaB(r[0], obterListaDfeClassificacaoTributaria(r[0][0], data), true);
    },

    consultarClassificacaoTributariaIsPorCodigo(cClassTrib, data) {
      const r = Q.consultarTratamentoImpostoSeletivo(base, cClassTrib, data);
      if (!r.length) throw classificacaoNaoEncontrada(cClassTrib, 'IS', data);
      return mapaC(r[0], obterListaDfeClassificacaoTributaria(r[0][0], data));
    },

    consultarClassificacoesTributariasImpostoSeletivo: (data) => Q.consultarTratamentoImpostoSeletivo(base, null, data)
      .map((m) => mapaC(m, obterListaDfeClassificacaoTributaria(m[0], data))),

    consultarNcm(ncm, data) {
      validarNcm(ncm);
      if (!Q.existeNcm(base, ncm, data)) throw new ErroJava('NcmNaoEncontradaException', `NCM de código ${ncm} não encontrada para a data ${data}`);
      const adVal = Q.buscarAliquotaAdValoremProduto(base, ncm, 1, data);
      const adRem = Q.buscarAliquotaAdRemProduto(base, ncm, 1, data);
      // IS incidence = existence of the rate row, even when its value is still undefined (NULL)
      const temAdVal = adVal != null;
      const temAdRem = adRem != null;
      const valor = (x) => (x?.valor == null ? null : Dec.parse(x.valor));
      return {
        aliquotaAdRem: temAdRem ? valor(adRem) : null,
        aliquotaAdValorem: temAdVal ? valor(adVal) : null,
        capitulo: Q.buscarDescricaoNcm(base, ncm, 2, data),
        item: Q.buscarDescricaoNcm(base, ncm, 7, data),
        posicao: Q.buscarDescricaoNcm(base, ncm, 4, data),
        subitem: Q.buscarDescricaoNcm(base, ncm, 8, data),
        subposicao: Q.buscarDescricaoNcm(base, ncm, 6, data),
        temAliquotaAdRem: temAdRem,
        temAliquotaAdValorem: temAdVal,
        tributadoPeloImpostoSeletivo: temAdVal || temAdRem,
        unidade: adRem != null ? adRem.unidadeMedida : null,
      };
    },

    consultarNbs(nbs, data) {
      validarNbs(nbs);
      if (!Q.existeNbs(base, nbs, data)) throw new ErroJava('NbsNaoEncontradaException', `NBS de código ${nbs} não encontrada para a data ${data}`);
      const linhas = Q.buscarAliquotaAdValoremServico(base, nbs, 1, null, data);
      if (linhas.length > 1) throw new ErroJava('ErroGenericoValidacaoException', 'Consulta retornou múltiplos valores quando apenas um era esperado.');
      const adVal = linhas[0] ?? null;
      const temAdVal = adVal != null;
      return {
        aliquotaAdValorem: temAdVal && adVal.valor != null ? Dec.parse(adVal.valor) : null,
        capitulo: Q.buscarDescricaoNbs(base, nbs, 5, data),
        item: Q.buscarDescricaoNbs(base, nbs, 9, data),
        posicao: Q.buscarDescricaoNbs(base, nbs, 6, data),
        subposicao1: Q.buscarDescricaoNbs(base, nbs, 7, data),
        subposicao2: Q.buscarDescricaoNbs(base, nbs, 8, data),
        temAliquotaAdValorem: temAdVal,
        tributadoPeloImpostoSeletivo: temAdVal,
      };
    },

    consultarNcmsVigentes: (data) => ncmService.consultarNcmsVigentes(data),

    listarNbs: (data) => Q.listarNbs(base, data).map((n) => ({ codigo: n.NBS_CD, descricao: n.NBS_DESCRICAO })),

    consultarFundamentacoesLegais(data) {
      const tributos = new Map();
      const r = [];
      for (const x of Q.buscarFundamentacoes(base, data)) {
        if (!tributos.has(x.SITR_ID)) tributos.set(x.SITR_ID, Q.consultarTributoPorIdSituacao(base, x.SITR_ID, data));
        const idTributo = tributos.get(x.SITR_ID);
        // TributoSituacaoTributariaNaoEncontradoException: its format string makes String.format throw first
        if (idTributo == null) throw new ErroJava('IllegalFormatFlagsException', "Flags = ' '");
        if (idTributo === 1) continue; // Imposto Seletivo entries are removed
        r.push({
          codigoClassificacaoTributaria: x.CLTR_CD,
          codigoSituacaoTributaria: x.SITR_CD,
          conjuntoTributo: 'CBS e IBS',
          descricaoClassificacaoTributaria: x.CLTR_DESCRICAO,
          descricaoSituacaoTributaria: x.SITR_DESCRICAO,
          referenciaNormativa: x.FDLG_REFERENCIA_NORMATIVA,
          texto: x.FDLG_TEXTO,
          textoCurto: x.FDLG_TEXTO_CURTO,
        });
      }
      return r;
    },

    /** → AliquotaDadosAbertosOutput { aliquotaPropria?, aliquotaReferencia, formaAplicacao? }. */
    consultarAliquota(idTributo, codigoUf, codigoMunicipio, data) {
      const a = aliquotaPadraoService.buscarAliquota(idTributo, codigoUf, codigoMunicipio, data);
      return { aliquotaPropria: a.valorPadrao, aliquotaReferencia: a.valorReferencia, formaAplicacao: a.formaAplicacao };
    },

    consultarValidadeDfeClassificacaoTributaria(siglaDfe, cClassTrib, data) {
      const r = Q.consultarValidadeDfe(base, cClassTrib, data);
      if (!r.length) throw classificacaoNaoEncontrada(cClassTrib, siglaDfe, data);
      const linha = r[0];
      if (typeof linha[0] !== 'number' && typeof linha[0] !== 'bigint') throw new ErroJava('ErroGenericoValidacaoException', 'ID da classificação tributária inválido.');
      const tipos = obterListaDfeClassificacaoTributaria(linha[0], data);
      const sigla = siglaPorNormalizada(siglaDfe);
      const n = (v) => (v == null ? null : Number(v));
      return {
        exigeGrupoIbsCbs: linha[5] != null && n(linha[5]) === 1,
        exigeGrupoTributacaoRegular: linha[2] != null && n(linha[2]) !== 0,
        nomenclatura: linha[1],
        permiteDiferimento: linha[3] != null && n(linha[3]) !== 0,
        possibilidadeCreditoPresumido: linha[4] != null && n(linha[4]) === 1,
        siglaDfeInformado: siglaDfe,
        validoParaSiglaDfeInformado: tipos.some((t) => corresponde(sigla, t.sigla)),
      };
    },

    consultarCstsComClassificacoesCbsIbs(siglaDfe, data) {
      const linhas = siglaDfe == null || javaIsBlank(siglaDfe)
        ? Q.buscarCstsComClassificacoesCbsIbsTodosDfes(base, data)
        : Q.buscarCstsComClassificacoesCbsIbs(base, siglaPorNormalizada(siglaDfe), data);
      return agruparCstsComClassificacoes(linhas);
    },

    consultarCstsComClassificacoesIs(siglaDfe, data) {
      // TODO of the Java code: the IS has no DF-e link yet, so the sigla only gates NF-e / NFC-e
      if (siglaDfe != null && !javaIsBlank(siglaDfe) && !impostoSeletivoAplicavel(siglaPorNormalizada(siglaDfe))) return [];
      return agruparCstsComClassificacoes(Q.buscarCstsComClassificacoesIs(base, data));
    },

    consultarRedutoresCompraGovernamental: () => Q.buscarRedutoresCompraGovernamental(base)
      .map((r) => ({ fimVigencia: dataEntidade(r.fim), inicioVigencia: dataEntidade(r.inicio), valor: r.valor == null ? null : Dec.parse(r.valor) })),

    consultarTransferenciasCBS: () => Q.buscarTransferenciasCbs(base)
      .map((t) => ({ fimVigencia: dataEntidade(t.fim), inicioVigencia: dataEntidade(t.inicio), valor: t.valor == null ? null : Dec.parse(t.valor) })),

    /** Constant list (BigDecimal.ZERO and BigDecimal.valueOf(100): no ".0"). */
    consultarTransferenciasIBS: () => [
      { fimVigencia: '2026-12-31', inicioVigencia: '2026-01-01', valor: new Dec(0n, 0) },
      { fimVigencia: null, inicioVigencia: '2027-01-01', valor: new Dec(100n, 0) },
    ],

    listarNbsAplicaveisPorClassificacao(cClassTrib, data) {
      const c = buscarClassificacaoTributariaCbsIbs(cClassTrib, data);
      if (c.nomenclatura == null) throw new ErroJava('NullPointerException', 'Cannot invoke "String.contains(java.lang.CharSequence)" because the return value of "br.gov.serpro.rtc.domain.model.dto.ClassificacaoTributariaDTO.nomenclatura()" is null');
      if (!c.nomenclatura.includes('NBS')) return [];
      if (Q.existeVinculoParaClassificacao(base, c.id) !== 1) return servico.listarNbs(data);
      return Q.listarNbsAplicaveisPorClassificacao(base, c.id, data).map((r) => ({ codigo: r[0], descricao: r[1] }));
    },

    /** Preserved: linked codes followed by the codes without link, duplicates kept. */
    listarClassificacaoAplicavelPorNbs(nbs, data) {
      if (!Q.existeNbs(base, nbs, data)) throw new ErroJava('NbsNaoEncontradaException', `NBS de código ${nbs} não encontrada para a data ${data}`);
      return [...Q.listarCodigosClassificacoesVinculadasPorNbs(base, nbs, data), ...Q.listarCodigosClassificacoesServicoSemVinculoNbs(base, data)];
    },

    /** TipoWarningDadosSimulados.CASO_GERAL (1) from 2027-01-01, else null. */
    getWarningDadosSimuladosPorData: (data) => (data.antesDe(new DataLocal(2027, 1, 1)) ? null : 1),

    validarNbsAplicavel(cClassTrib, nbs, data) {
      validarNbs(nbs);
      if (nbs.length !== 9) throw validacaoJakarta('O campo NBS deve ter exatamente 9 dígitos.');
      const c = buscarClassificacaoTributariaCbsIbs(cClassTrib, data);
      let valido;
      try {
        valido = nbsAplicavelService.validarNbsAplicavel(nbs, c.id, cClassTrib, data, 'CBS e IBS');
      } catch (e) {
        if (!(e instanceof ErroJava && e.classeJava === 'NbsNaoVinculadaException')) throw e;
        valido = false;
      }
      return { cClassTrib, dataOcorrenciaFatoGerador: data.toString(), nbs, valido };
    },

    validarNcmAplicavel(cClassTrib, ncm, data) {
      validarNcm(ncm);
      if (ncm.length !== 8) throw validacaoJakarta('O campo NCM deve ter exatamente 8 dígitos.');
      const c = buscarClassificacaoTributariaCbsIbs(cClassTrib, data);
      let valido;
      try {
        valido = ncmAplicavelService.validarNcmAplicavel(ncm, c.id, cClassTrib, data, 'CBS e IBS');
      } catch (e) {
        if (!(e instanceof ErroJava && e.classeJava === 'NcmNaoVinculadaException')) throw e;
        valido = false;
      }
      return { cClassTrib, dataOcorrenciaFatoGerador: data.toString(), ncm, valido };
    },

    consultarTiposDfeAgrupados(data) {
      const dataConsulta = data ?? hoje();
      const grupos = new Map();
      for (const r of Q.buscarTiposDfeAgrupados(base, dataConsulta)) {
        const grupoId = r[0];
        if (!grupos.has(grupoId)) grupos.set(grupoId, { id: String(grupoId), ordem: null, tipos: [], titulo: r[1] });
        const g = grupos.get(grupoId);
        g.tipos.push({
          codigo: normalizarSigla(r[2]),
          descricao: null, // never filled
          modelo: r[4] != null ? String(Number(r[4]) | 0) : null,
          ordem: g.tipos.length + 1,
          permiteNcmZero: flagSqlite(r[6], false),
          suportado: flagSqlite(r[5], true),
          titulo: r[3],
        });
      }
      let ordem = 1;
      for (const g of grupos.values()) g.ordem = ordem++;
      return [...grupos.values()];
    },

    consultarNomenclatura(siglaDfe, cClassTrib, data) {
      const nomenclatura = determinarNomenclatura(siglaDfe, cClassTrib, data);
      const sem = nomenclatura === 'SEM';
      const sigla = siglaPorNormalizada(siglaDfe);
      return {
        cClassTrib, data: data.toString(), nbsOpcional: sem && sigla === 'NFSE', ncmOpcional: sem && (sigla === 'NFE' || sigla === 'NFCE'),
        nomenclatura, obrigatorio: !sem, siglaDfe,
      };
    },

    /** papel: PapelAtorEnum name or null → GrupoAtorDadosAbertosOutput[] {atores, descricao, id, ordem}. */
    consultarAtoresAgrupados(data, papel) {
      const papelDb = papel === 'FORNECEDOR' ? 'Fornecedor' : papel === 'ADQUIRENTE' ? 'Adquirente' : null;
      const grupos = new Map();
      for (const r of Q.buscarAtoresAgrupados(base, data, papelDb)) {
        if (!grupos.has(r[0])) grupos.set(r[0], { atores: [], descricao: r[1], id: r[0], ordem: r[2] });
        grupos.get(r[0]).atores.push({ descricao: r[4], id: r[3], ordem: r[5] });
      }
      return [...grupos.values()];
    },
  };
  return servico;
}
