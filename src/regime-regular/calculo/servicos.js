// Domain services called by the calculation pipeline (domain/service/*.java), ported one by one:
// UfService, MunicipioService, TipoDfeService, TipoDfeClassificacaoService, SituacaoTributariaService,
// ClassificacaoTributariaService, TratamentoClassificacaoService, NcmService, NbsService,
// NcmAplicavelService, NbsAplicavelService, NomenclaturaService, ValidacaoNomenclaturaService,
// AliquotaAdValoremProdutoService, AliquotaAdRemProdutoService, AliquotaAdValoremServicoService,
// RedutorCompraGovernamentalService, SiglasDFeEnum; BaseCalculoUnificadaService.calcular(componentes,
// ano, natureza, tpDoc) comes from the base-calculo slice.
// Exceptions are ErroJava(<simple Java class name>, <getMessage()>), built by ./excecoes.js.
// The Java @Cacheable layers are omitted: the database is read-only and no cached method's result
// depends on anything but its arguments (processing.md §13).
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';
import { javaIsBlank } from '../comum/java.js';
import * as E from './excecoes.js';
import { criarConsultas } from './consultas.js';
import {
  ELEMENTOS as ELEMENTOS_BASE, campoCompoeBase, getValor as getValorComponente, calcularComponentes,
} from '../base-calculo/base-calculo.js';

/** TributoEnum codes. */
export const TRIBUTO = Object.freeze({ IS: 1, CBS: 2, IBS_ESTADUAL: 3, IBS_MUNICIPAL: 4 });

/** commons-lang3 StringUtils.isBlank / isNotBlank / length. */
export const isBlank = (s) => s == null || javaIsBlank(s);
export const isNotBlank = (s) => !isBlank(s);
export const comprimento = (s) => (s == null ? 0 : s.length);

// ─── SiglasDFeEnum ───────────────────────────────────────────────────────────

/** Constants in declaration order: name() → getSigla(). */
export const SIGLAS_DFE = Object.freeze([
  ['NFEABI', 'NFe ABI'], ['NFE', 'NFe'], ['NFCE', 'NFCe'], ['CTE', 'CTe'], ['CTEOS', 'CTe OS'], ['CTESIMPLIFICADO', 'CT-e Simplificado'],
  ['BPE', 'BPe'], ['BPETA', 'BPe TA'], ['BPETM', 'BPe TM'], ['NF3E', 'NF3e'], ['NFSE', 'NFSe'], ['NFSEVIA', 'NFSe Via'], ['NFCOM', 'NFCom'],
  ['DERE', 'DERE'], ['DIR', 'DIR'], ['DUIMP', 'Duimp'], ['NFAG', 'NFAg'], ['NFGAS', 'NFGas'],
].map(([nome, sigla]) => Object.freeze({ nome, sigla })));

/** SiglasDFeEnum.normalizarSigla: toUpperCase() and remove [\s\-_] (Java \s = ASCII whitespace). */
export const normalizarSigla = (sigla) => (sigla == null ? '' : sigla.toUpperCase().replace(/[ \t\n\x0B\f\r\-_]/g, ''));

/** SiglasDFeEnum.getPorSiglaNormalizada: the constant or SiglaDFeNaoEncontradaException. */
export function siglaPorNormalizada(sigla) {
  const n = normalizarSigla(sigla);
  const s = SIGLAS_DFE.find((e) => e.nome === n);
  if (!s) throw E.siglaDfeNaoEncontrada(sigla);
  return s;
}
const corresponde = (constante, sigla) => constante.nome === normalizarSigla(sigla);
export const ncmAplicavelSigla = (sigla) => ['NFSE', 'NFE', 'NFCE'].includes(normalizarSigla(sigla));
export const nbsAplicavelSigla = (sigla) => normalizarSigla(sigla) === 'NFSE';
export const impostoSeletivoAplicavelSigla = (sigla) => ['NFE', 'NFCE'].includes(normalizarSigla(sigla));

// ─── BaseCalculoUnificadaService.calcular (componentes) ─────────────────────────

/**
 * BaseCalculoUnificadaService.calcular(ComponentesBaseCalculoInput, int, BaseCalculoNatureza, Integer):
 * exact bases (no rounding) and the notices, from the base-calculo slice. `antesDeSomar(valor)` runs,
 * in declaration order, on every value that enters the exact sums (the caller's scale guard), before
 * any of them is added.
 */
export function calcularBaseUnificada(componentes, ano, natureza, tpDoc, antesDeSomar = () => {}) {
  for (const el of ELEMENTOS_BASE) {
    const valor = getValorComponente(componentes, el);
    if (valor != null && valor.signum() !== 0 && campoCompoeBase(el, ano, natureza, tpDoc)) antesDeSomar(valor);
  }
  return calcularComponentes(componentes, ano, natureza, tpDoc);
}

// ─── Services bound to the database ─────────────────────────────────────────

/**
 * All the services of the pipeline over the shared read-only connection. `consultas` (tests) replaces
 * the repositories, like the Mockito mocks of the official unit tests.
 */
export function criarServicos(base, { consultas } = {}) {
  const q = consultas ?? criarConsultas(base);

  const ufService = {
    validarUf(sigla) {
      if (!q.existeUf(sigla)) throw E.ufNaoEncontrada(sigla);
    },
    buscar(sigla) {
      const codigo = q.consultarUfPorSigla(sigla);
      if (codigo == null) throw E.ufNaoEncontrada(sigla);
      return codigo;
    },
  };

  const municipioService = {
    validarMunicipio(codigoMunicipio, siglaUf) {
      const r = q.validarMunicipio(codigoMunicipio, siglaUf);
      if (r === 1) throw E.municipioNaoEncontrado(codigoMunicipio);
      if (r === 2) throw E.municipioNaoPertencente(codigoMunicipio, siglaUf);
    },
    buscarUfPorMunicipio(codigoMunicipio) {
      // CrudRepository.findById(null) → IllegalArgumentException translated by Spring
      if (codigoMunicipio == null) throw new ErroJava('InvalidDataAccessApiUsageException', 'The given id must not be null');
      const m = q.municipioPorId(codigoMunicipio);
      if (!m) throw E.municipioNaoEncontrado(codigoMunicipio);
      return m.uf.sigla;
    },
  };

  const tipoDfeService = {
    buscarPorTipo(tpDoc, data) {
      if (tpDoc == null) return null;
      const t = q.tipoDfePorTipo(tpDoc, data);
      if (!t) throw E.tipoDfeNaoEncontrado(tpDoc, data);
      if (!t.possuiTratamento) throw E.tipoDfeNaoTratado(t);
      return t;
    },
  };

  const tipoDfeClassificacaoService = {
    buscar: (idClassificacaoTributaria, data) => q.tipoDfeClassificacao(idClassificacaoTributaria, data),
    validarVinculo(tipoDfe, idClassificacaoTributaria, cClassTrib, data, tributos) {
      const vinculado = q.tipoDfeClassificacao(idClassificacaoTributaria, data).some((t) => t.tipoDfe.id === tipoDfe.id);
      if (!vinculado) {
        throw E.classificacaoNaoVinculadaTipoDfe(cClassTrib, tipoDfe.tipo, tributos);
      }
    },
  };

  const situacaoTributariaService = {
    validarCst(cst, idTributo, data) {
      if (!q.existeCst(cst, idTributo, data)) {
        const tributo = idTributo === 1 ? 'Imposto Seletivo' : 'CBS e IBS';
        throw E.situacaoTributariaNaoEncontrada(cst, tributo, data);
      }
    },
    consultarSituacaoTributariaPorCodigo: (cst, idTributo, data) => q.situacaoTributariaPorCodigo(cst, idTributo, data),
  };

  const buscarClassificacao = (codigo, idTributo, data, tipo) => {
    const c = q.classificacaoTributaria(codigo, idTributo, data);
    if (c == null) throw E.classificacaoTributariaNaoEncontrada(codigo, tipo, data);
    return c;
  };
  const classificacaoTributariaService = {
    buscarClassificacaoTributariaCbsIbs: (codigo, data) => buscarClassificacao(codigo, 2, data, 'CBS e IBS'),
    buscarClassificacaoTributariaImpostoSeletivo: (codigo, data) => buscarClassificacao(codigo, 1, data, 'Imposto Seletivo'),
  };

  const tratamentoClassificacaoService = {
    buscarTratamentoClassificacao(idClassificacaoTributaria, data) {
      const t = q.tratamentoClassificacao(idClassificacaoTributaria, data);
      if (t == null) {
        throw E.tratamentoClassificacaoNaoEncontrado(idClassificacaoTributaria, data);
      }
      return t;
    },
  };

  const ncmService = { existeNcm: (ncm, data) => q.existeNcm(ncm, data) };
  const nbsService = { existeNbs: (nbs, data) => q.existeNbs(nbs, data) };

  /** NcmAplicavelService / NbsAplicavelService share the same shape (length 8 / 9). */
  const aplicavel = (tipo) => {
    const ncm = tipo === 'NCM';
    const tamanhoCompleto = ncm ? 8 : 9;
    const tem = ncm ? q.ncmTem : q.nbsTem;
    const temAplicavel = ncm ? q.temNcmAplicavel : q.temNbsAplicavel;
    const temExcecao = ncm ? q.temExcecaoNcmAplicavel : q.temExcecaoNbsAplicavel;
    const temSemExcecao = ncm ? q.temNcmAplicavelSemExcecao : q.temNbsAplicavelSemExcecao;
    const naoVinculada = ncm ? E.ncmNaoVinculada : E.nbsNaoVinculada;
    const completoNaoInformado = ncm ? E.ncmCompletoNaoInformado : E.nbsCompletoNaoInformado;
    const criticar = (codigo, id, cClassTrib, data, tributos, temClassificacao) => {
      if (!temClassificacao) return; // classification without annex: accepted without check
      if (!temAplicavel(codigo, id, data)) throw naoVinculada(codigo, cClassTrib, tributos);
      if (temExcecao(codigo, id, data) && !temSemExcecao(codigo, id, data)) throw naoVinculada(codigo, cClassTrib, tributos);
    };
    return {
      /** validarNcmAplicavel / validarNbsAplicavel (always true; exceptions are not cached). */
      validar(codigo, id, cClassTrib, data, tributos) {
        const completo = comprimento(codigo) === tamanhoCompleto;
        const temClassificacao = tem(id, data);
        if (temClassificacao && !completo) throw completoNaoInformado();
        if (completo) criticar(codigo, id, cClassTrib, data, tributos, temClassificacao);
        return true;
      },
      /** criticarNcmContraAnexo / criticarNbsContraAnexo. */
      criticarContraAnexo(codigo, id, cClassTrib, data, tributos) {
        criticar(codigo, id, cClassTrib, data, tributos, tem(id, data));
      },
      completoNaoInformado,
    };
  };
  const ncmAplicavelService = aplicavel('NCM');
  const nbsAplicavelService = aplicavel('NBS');

  const EXCECOES_NOMENCLATURA = new Set(['200038', '515001']);
  const nomenclaturaService = {
    /** NomenclaturaService.determinarNomenclatura → 'SEM' | 'NCM' | 'NBS' | 'MISTO' | 'EXCECAO_NCM' | 'EXCECAO_NBS'. */
    determinarNomenclatura(siglaDfe, cClassTrib, data) {
      const classificacao = classificacaoTributariaService.buscarClassificacaoTributariaCbsIbs(cClassTrib, data);
      const id = classificacao.id;
      const tipos = tipoDfeClassificacaoService.buscar(id, data);
      const normalizada = siglaPorNormalizada(siglaDfe);
      if (!tipos.some((t) => corresponde(normalizada, t.tipoDfe.sigla))) return 'SEM';
      const ncmAplicavel = q.ncmTem(id, data);
      const nbsAplicavel = q.nbsTem(id, data);
      if (EXCECOES_NOMENCLATURA.has(cClassTrib)) {
        const s = siglaPorNormalizada(siglaDfe);
        if (s.nome === 'NFE' || s.nome === 'NFCE') return 'EXCECAO_NCM';
        if (s.nome === 'NFSE') return 'EXCECAO_NBS';
        return 'SEM';
      }
      if (ncmAplicavelSigla(siglaDfe) && !nbsAplicavelSigla(siglaDfe)) return ncmAplicavel ? 'NCM' : 'SEM';
      if (nbsAplicavelSigla(siglaDfe)) {
        if (ncmAplicavel && nbsAplicavel) return 'MISTO';
        if (ncmAplicavel) return 'NCM';
        if (nbsAplicavel) return 'NBS';
        return 'SEM';
      }
      return 'SEM';
    },
  };

  const TRIO_RIGIDO = new Set(['NFE', 'NFCE', 'NFSE']);
  const incompativel = (nomenclatura, codigo, sigla) => E.nomenclaturaIncompativelTipoDfe(nomenclatura, codigo, sigla.sigla);
  const validacaoNomenclaturaService = {
    /** ValidacaoNomenclaturaService.validar(sigla (constant), id, codigo, ncm, nbs, data, tributos, modo). */
    validar(sigla, id, codigo, ncm, nbs, data, tributos, modo) {
      const resultado = nomenclaturaService.determinarNomenclatura(sigla.nome, codigo, data);
      switch (resultado) {
        case 'NCM': case 'EXCECAO_NCM':
          if (isNotBlank(nbs)) throw incompativel('NBS', codigo, sigla);
          if (comprimento(ncm) !== 8) throw ncmAplicavelService.completoNaoInformado();
          ncmAplicavelService.criticarContraAnexo(ncm, id, codigo, data, tributos);
          return;
        case 'NBS': case 'EXCECAO_NBS':
          if (isNotBlank(ncm)) throw incompativel('NCM', codigo, sigla);
          if (comprimento(nbs) !== 9) throw nbsAplicavelService.completoNaoInformado();
          nbsAplicavelService.criticarContraAnexo(nbs, id, codigo, data, tributos);
          return;
        case 'MISTO':
          if (isNotBlank(ncm)) {
            if (comprimento(ncm) !== 8) throw ncmAplicavelService.completoNaoInformado();
            ncmAplicavelService.criticarContraAnexo(ncm, id, codigo, data, tributos);
          } else if (isNotBlank(nbs)) {
            if (comprimento(nbs) !== 9) throw nbsAplicavelService.completoNaoInformado();
            nbsAplicavelService.criticarContraAnexo(nbs, id, codigo, data, tributos);
          } else {
            throw E.nomenclaturaObrigatoriaNaoInformada(codigo, sigla.sigla);
          }
          return;
        default: { // SEM
          const ncmInformado = isNotBlank(ncm);
          const nbsInformado = isNotBlank(nbs);
          if (!ncmInformado && !nbsInformado) return;
          if (TRIO_RIGIDO.has(sigla.nome)) {
            if (sigla.nome === 'NFSE') { if (ncmInformado) throw incompativel('NCM', codigo, sigla); } else if (nbsInformado) throw incompativel('NBS', codigo, sigla);
            return;
          }
          if (modo === 'RIGIDO') throw E.nomenclaturaNaoPermitidaTipoDfe(codigo, sigla.sigla);
          if (ncmInformado) ncmAplicavelService.validar(ncm, id, codigo, data, tributos);
          else nbsAplicavelService.validar(nbs, id, codigo, data, tributos);
        }
      }
    },
  };

  const aliquotaAdValoremProdutoService = {
    buscarAliquotaAdValorem: (ncm, idTributo, data) => q.aliquotaAdValoremProduto(ncm, idTributo, data),
    existeNcmAdValorem: (ncm, tributo, data) => q.existeNcmAdValorem(ncm, tributo, data),
  };
  const aliquotaAdRemProdutoService = {
    buscarAliquotaAdRem: (ncm, idTributo, data) => q.aliquotaAdRemProduto(ncm, idTributo, data),
  };
  const aliquotaAdValoremServicoService = {
    buscarAliquotaAdValorem(nbs, idTributo, idClassificacaoTributaria, data) {
      const dto = this.buscarAliquotaAdValoremDto(nbs, idTributo, idClassificacaoTributaria, data);
      return dto != null ? dto.valor : null;
    },
    buscarAliquotaAdValoremDto(nbs, idTributo, idClassificacaoTributaria, data) {
      try {
        return q.aliquotaAdValoremServico(nbs, idTributo, idClassificacaoTributaria, data);
      } catch (e) {
        if (e?.classeJava !== 'IncorrectResultSizeDataAccessException') throw e;
        throw E.erroGenericoValidacao('Consulta retornou múltiplos valores quando apenas um era esperado.');
      }
    },
    existeNbsAdValorem: (nbs, tributo, data) => q.existeNbsAdValorem(nbs, tributo, data),
  };

  const redutorCompraGovernamentalService = {
    buscarValorRedutor(tpEnteGov, data) {
      if (tpEnteGov == null) return Dec.ZERO;
      const r = q.redutorCompraGovernamental(data);
      if (r == null || r.valor == null) throw new ErroJava('RuntimeException', 'Redutor de compra governamental não encontrada.');
      return r.valor;
    },
  };

  return {
    consultas: q,
    ufService, municipioService, tipoDfeService, tipoDfeClassificacaoService, situacaoTributariaService,
    classificacaoTributariaService, tratamentoClassificacaoService, ncmService, nbsService, ncmAplicavelService,
    nbsAplicavelService, nomenclaturaService, validacaoNomenclaturaService, aliquotaAdValoremProdutoService,
    aliquotaAdRemProdutoService, aliquotaAdValoremServicoService, redutorCompraGovernamentalService,
  };
}
