// NCM/NBS validation of calculadora-rtc-simples-nacional 1.0.2, with the Java structure kept so the
// official unit tests (which mock each collaborator) run against it:
//   domain: SiglasDFeEnum, NomenclaturaService, NcmAplicavelService, NbsAplicavelService,
//           ValidacaoNomenclaturaService and the exceptions of domain/service/exception;
//   api:    ValidacaoNomenclaturaAdapter (structural check + exception → VSN code translation).
// Collaborators are passed in (constructor injection in Java); `criarNomenclatura(db)` wires the
// real repositories of rtc/db.js.

// ── exceptions (messages = String.format templates of the Java classes) ──────
export class NomenclaturaException extends Error {
  get name() { return this.constructor.name; }
}
export class NcmNbsSimultaneasException extends NomenclaturaException {
  constructor() { super('Não é permitido informar NCM e NBS simultaneamente para um item'); }
}
export class NcmNaoEncontradaException extends NomenclaturaException {
  constructor(ncm, data) { super(`NCM de código ${ncm} não encontrada para a data ${data}`); }
}
export class NbsNaoEncontradaException extends NomenclaturaException {
  constructor(nbs, data) { super(`NBS de código ${nbs} não encontrada para a data ${data}`); }
}
export class NcmCompletoNaoInformadoException extends NomenclaturaException {
  constructor() { super('NCM completo não informado'); }
}
export class NbsCompletoNaoInformadoException extends NomenclaturaException {
  constructor() { super('NBS completo não informado'); }
}
export class NomenclaturaObrigatoriaNaoInformadaException extends NomenclaturaException {
  constructor(cClassTrib, siglaDfe) { super(`A Classificação Tributária de código ${cClassTrib} exige NCM ou NBS completo para o tipo de documento ${siglaDfe}`); }
}
export class NomenclaturaIncompativelTipoDfeException extends NomenclaturaException {
  constructor(nomenclatura, cClassTrib, siglaDfe) { super(`${nomenclatura} não permitida para a Classificação Tributária de código ${cClassTrib} no tipo de documento ${siglaDfe}`); }
}
export class NomenclaturaNaoPermitidaTipoDfeException extends NomenclaturaException {
  constructor(cClassTrib, siglaDfe) { super(`NCM/NBS não permitido para a Classificação Tributária de código ${cClassTrib} no tipo de documento ${siglaDfe}`); }
}
export class NcmNaoVinculadaException extends NomenclaturaException {
  constructor(ncm, cClassTrib, tributo) { super(`NCM de código ${ncm} não vinculada à Classificação Tributária de código ${cClassTrib} (${tributo})`); }
}
export class NbsNaoVinculadaException extends NomenclaturaException {
  constructor(nbs, cClassTrib, tributo) { super(`NBS de código ${nbs} não vinculada à Classificação Tributária de código ${cClassTrib} (${tributo})`); }
}
export class SiglaDFeNaoEncontradaException extends NomenclaturaException {
  constructor(sigla) { super(`Sigla DFe inválida: ${sigla}`); }
}
/** ValidacaoNomenclaturaAdapter.FormatoNomenclaturaInvalidoException (private in Java). */
export class FormatoNomenclaturaInvalidoException extends NomenclaturaException {
  constructor(campo) {
    super(`O ${campo.toUpperCase()} deve conter exclusivamente ${campo === 'ncm' ? 8 : 9} dígitos ASCII, sem espaços ou símbolos.`);
    this.campo = campo;
  }
}

// ── SiglasDFeEnum ────────────────────────────────────────────────────────────
export const SIGLAS_DFE = Object.freeze({
  NFEABI: 'NFe ABI', NFE: 'NFe', NFCE: 'NFCe', CTE: 'CTe', CTEOS: 'CTe OS', CTESIMPLIFICADO: 'CT-e Simplificado', BPE: 'BPe',
  BPETA: 'BPe TA', BPETM: 'BPe TM', NF3E: 'NF3e', NFSE: 'NFSe', NFSEVIA: 'NFSe Via', NFCOM: 'NFCom', DERE: 'DERE', DIR: 'DIR',
  DUIMP: 'Duimp', NFAG: 'NFAg', NFGAS: 'NFGas',
});
/** SiglasDFeEnum.normalizarSigla: upper case without Java whitespace (\s = [ \t\n\x0B\f\r]), '-' and '_'. */
export const normalizarSigla = (s) => (s == null ? '' : s.toUpperCase().replace(/[ \t\n\x0B\f\r\-_]/g, ''));
/** SiglasDFeEnum.getPorSiglaNormalizada → { nome, sigla } (enum constant). */
export function siglaPorNormalizada(sigla) {
  const nome = normalizarSigla(sigla);
  if (!Object.hasOwn(SIGLAS_DFE, nome)) throw new SiglaDFeNaoEncontradaException(sigla);
  return { nome, sigla: SIGLAS_DFE[nome] };
}
const NCM_APLICAVEL = new Set(['NFSE', 'NFE', 'NFCE']);
const NBS_APLICAVEL = new Set(['NFSE']);

// ── NomenclaturaService.determinarNomenclatura ───────────────────────────────
/**
 * @param {object} deps
 *   classificacaoCbsIbs(cClassTrib, data) → [{id}] (ClassificacaoTributariaService, single result),
 *   siglasTipoDfe(id, data) → [sigla] (TipoDfeClassificacaoService.buscar),
 *   temNcm(id, data), temNbs(id, data) (NcmAplicavelRepository.tem / NbsAplicavelRepository.tem)
 */
export function criarNomenclaturaService({ classificacaoCbsIbs, siglasTipoDfe, temNcm, temNbs }) {
  function determinarResultado(siglaDfe, cClassTrib, ncmAplicavel, nbsAplicavel) {
    if (cClassTrib === '200038') { // EXCEPTION_CLASSIFICACOES → tratarCasoExcecao
      const s = siglaPorNormalizada(siglaDfe).nome;
      return s === 'NFE' || s === 'NFCE' ? 'EXCECAO_NCM' : s === 'NFSE' ? 'EXCECAO_NBS' : 'SEM';
    }
    const norm = normalizarSigla(siglaDfe);
    if (NCM_APLICAVEL.has(norm) && !NBS_APLICAVEL.has(norm)) return ncmAplicavel ? 'NCM' : 'SEM';
    if (NBS_APLICAVEL.has(norm)) {
      if (ncmAplicavel && nbsAplicavel) return 'MISTO';
      if (ncmAplicavel) return 'NCM';
      if (nbsAplicavel) return 'NBS';
      return 'SEM';
    }
    return 'SEM';
  }
  return {
    determinarNomenclatura(siglaDfe, cClassTrib, data) {
      const rows = classificacaoCbsIbs(cClassTrib, data);
      if (rows.length === 0) throw new Error(`Classificação tributária não encontrada para código ${cClassTrib} e data ${data} (CBS e IBS)`);
      if (rows.length > 1) throw new Error(`Incorrect result size: expected 1, actual ${rows.length}`);
      const id = rows[0].id;
      // siglaDfeCompativel: linked document types, then the informed sigla (validated), compared normalized
      const tiposDfe = siglasTipoDfe(id, data);
      const sigla = siglaPorNormalizada(siglaDfe);
      if (!tiposDfe.some((s) => sigla.nome === normalizarSigla(s))) return 'SEM';
      return determinarResultado(siglaDfe, cClassTrib, temNcm(id, data), temNbs(id, data));
    },
  };
}

// ── NcmAplicavelService / NbsAplicavelService ────────────────────────────────
/**
 * @param {object} repo  { tem(id, data), temAplicavel(codigo, id, data), temExcecaoAplicavel(codigo, id, data), temAplicavelSemExcecao(codigo, id, data) }
 * @param {'NCM'|'NBS'} tipo
 */
function criarAplicavelService(repo, tipo) {
  const tamanho = tipo === 'NCM' ? 8 : 9;
  const Incompleto = tipo === 'NCM' ? NcmCompletoNaoInformadoException : NbsCompletoNaoInformadoException;
  const NaoVinculada = tipo === 'NCM' ? NcmNaoVinculadaException : NbsNaoVinculadaException;
  function criticar(codigo, id, cClassTrib, data, tributos, temClassificacao) {
    if (!temClassificacao) return; // classification without annex: accepted without check
    if (!repo.temAplicavel(codigo, id, data)) throw new NaoVinculada(codigo, cClassTrib, tributos);
    if (repo.temExcecaoAplicavel(codigo, id, data) && !repo.temAplicavelSemExcecao(codigo, id, data)) {
      throw new NaoVinculada(codigo, cClassTrib, tributos);
    }
  }
  return {
    /** validarNcmAplicavel / validarNbsAplicavel */
    validar(codigo, id, cClassTrib, data, tributos) {
      const completo = (codigo == null ? 0 : codigo.length) === tamanho; // StringUtils.length
      const tem = repo.tem(id, data);
      if (tem && !completo) throw new Incompleto();
      if (completo) criticar(codigo, id, cClassTrib, data, tributos, tem);
      return true;
    },
    /** criticarNcmContraAnexo / criticarNbsContraAnexo */
    criticarContraAnexo(codigo, id, cClassTrib, data, tributos) {
      criticar(codigo, id, cClassTrib, data, tributos, repo.tem(id, data));
    },
  };
}
export const criarNcmAplicavelService = (repo) => criarAplicavelService(repo, 'NCM');
export const criarNbsAplicavelService = (repo) => criarAplicavelService(repo, 'NBS');

// ── ValidacaoNomenclaturaService.validar ─────────────────────────────────────
/** StringUtils.isNotBlank: some char that is not Character.isWhitespace. */
const JAVA_WS = /^[\t\n\u000B\f\r\u001C-\u001F\u0020\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]*$/;
const naoBranco = (s) => s != null && !JAVA_WS.test(s);
const comprimento = (s) => (s == null ? 0 : s.length);
const TRIO_RIGIDO = new Set(['NFE', 'NFCE', 'NFSE']);

/** @param {object} deps { nomenclaturaService, ncmAplicavelService, nbsAplicavelService } */
export function criarValidacaoNomenclaturaService({ nomenclaturaService, ncmAplicavelService, nbsAplicavelService }) {
  function exigirNcm(sigla, id, codigo, ncm, nbs, data, tributos) {
    if (naoBranco(nbs)) throw new NomenclaturaIncompativelTipoDfeException('NBS', codigo, sigla.sigla);
    if (comprimento(ncm) !== 8) throw new NcmCompletoNaoInformadoException();
    ncmAplicavelService.criticarContraAnexo(ncm, id, codigo, data, tributos);
  }
  function exigirNbs(sigla, id, codigo, ncm, nbs, data, tributos) {
    if (naoBranco(ncm)) throw new NomenclaturaIncompativelTipoDfeException('NCM', codigo, sigla.sigla);
    if (comprimento(nbs) !== 9) throw new NbsCompletoNaoInformadoException();
    nbsAplicavelService.criticarContraAnexo(nbs, id, codigo, data, tributos);
  }
  function exigirNcmOuNbs(sigla, id, codigo, ncm, nbs, data, tributos) {
    if (naoBranco(ncm)) {
      if (comprimento(ncm) !== 8) throw new NcmCompletoNaoInformadoException();
      ncmAplicavelService.criticarContraAnexo(ncm, id, codigo, data, tributos);
    } else if (naoBranco(nbs)) {
      if (comprimento(nbs) !== 9) throw new NbsCompletoNaoInformadoException();
      nbsAplicavelService.criticarContraAnexo(nbs, id, codigo, data, tributos);
    } else {
      throw new NomenclaturaObrigatoriaNaoInformadaException(codigo, sigla.sigla);
    }
  }
  function validarSemExigencia(sigla, id, codigo, ncm, nbs, data, tributos, modo) {
    const ncmInformado = naoBranco(ncm);
    const nbsInformado = naoBranco(nbs);
    if (!ncmInformado && !nbsInformado) return;
    if (TRIO_RIGIDO.has(sigla.nome)) {
      if (sigla.nome === 'NFSE') {
        if (ncmInformado) throw new NomenclaturaIncompativelTipoDfeException('NCM', codigo, sigla.sigla);
      } else if (nbsInformado) {
        throw new NomenclaturaIncompativelTipoDfeException('NBS', codigo, sigla.sigla);
      }
      return;
    }
    if (modo === 'RIGIDO') throw new NomenclaturaNaoPermitidaTipoDfeException(codigo, sigla.sigla);
    if (ncmInformado) ncmAplicavelService.validar(ncm, id, codigo, data, tributos);
    else nbsAplicavelService.validar(nbs, id, codigo, data, tributos);
  }
  return {
    /** validar(siglaDfe: SiglasDFeEnum constant name, id, codigo, ncm, nbs, data, tributos, modo) */
    validar(siglaDfe, id, codigo, ncm, nbs, data, tributos, modo) {
      const sigla = { nome: siglaDfe, sigla: SIGLAS_DFE[siglaDfe] };
      const resultado = nomenclaturaService.determinarNomenclatura(siglaDfe, codigo, data);
      switch (resultado) {
        case 'NCM': case 'EXCECAO_NCM': return exigirNcm(sigla, id, codigo, ncm, nbs, data, tributos);
        case 'NBS': case 'EXCECAO_NBS': return exigirNbs(sigla, id, codigo, ncm, nbs, data, tributos);
        case 'MISTO': return exigirNcmOuNbs(sigla, id, codigo, ncm, nbs, data, tributos);
        case 'SEM': return validarSemExigencia(sigla, id, codigo, ncm, nbs, data, tributos, modo);
        default: throw new TypeError(`No enum constant br.gov.serpro.rtc.domain.model.enumeration.NomenclaturaResultEnum.${resultado}`);
      }
    },
  };
}

// ── ValidacaoNomenclaturaAdapter ─────────────────────────────────────────────
const isNullOrEmpty = (s) => s == null || s === '';
/** traduzirErroConhecido: exception → [CodigoValidacaoSimples name, campo] or null (unknown → FALHA_TECNICA). */
function traduzirErroConhecido(ex, ncm, nbs) {
  if (ex instanceof NcmNbsSimultaneasException) return ['NCM_NBS_SIMULTANEOS', 'ncm'];
  if (ex instanceof NcmNaoEncontradaException) return ['NCM_NAO_ENCONTRADO', 'ncm'];
  if (ex instanceof NbsNaoEncontradaException) return ['NBS_NAO_ENCONTRADO', 'nbs'];
  if (ex instanceof NcmCompletoNaoInformadoException) return ['NCM_INCOMPLETO', 'ncm'];
  if (ex instanceof NbsCompletoNaoInformadoException) return ['NBS_INCOMPLETO', 'nbs'];
  if (ex instanceof NomenclaturaObrigatoriaNaoInformadaException) return ['NOMENCLATURA_OBRIGATORIA', null];
  if (ex instanceof NomenclaturaIncompativelTipoDfeException) return ['NOMENCLATURA_INCOMPATIVEL', !isNullOrEmpty(ncm) ? 'ncm' : !isNullOrEmpty(nbs) ? 'nbs' : null];
  if (ex instanceof NomenclaturaNaoPermitidaTipoDfeException) return ['NOMENCLATURA_NAO_PERMITIDA', null];
  if (ex instanceof NcmNaoVinculadaException) return ['NCM_NAO_APLICAVEL', 'ncm'];
  if (ex instanceof NbsNaoVinculadaException) return ['NBS_NAO_APLICAVEL', 'nbs'];
  if (ex instanceof FormatoNomenclaturaInvalidoException) return ['NOMENCLATURA_FORMATO_INVALIDO', ex.campo];
  return null;
}

/**
 * @param {object} deps { existeNcm(ncm, data), existeNbs(nbs, data), validacaoNomenclaturaService }
 * The collector is the engine's ItemCollectorSimples (addErroValidacao / addFalhaTecnica / hasErros).
 */
export function criarValidacaoNomenclaturaAdapter({ existeNcm, existeNbs, validacaoNomenclaturaService }) {
  function validarNcmNbs(ncm, nbs, data) {
    if (!isNullOrEmpty(ncm) && !isNullOrEmpty(nbs)) throw new NcmNbsSimultaneasException();
    if (!isNullOrEmpty(ncm) && !/^[0-9]{8}$/.test(ncm)) throw new FormatoNomenclaturaInvalidoException('ncm');
    if (!isNullOrEmpty(nbs) && !/^[0-9]{9}$/.test(nbs)) throw new FormatoNomenclaturaInvalidoException('nbs');
    if (!isNullOrEmpty(ncm) && !existeNcm(ncm, data)) throw new NcmNaoEncontradaException(ncm, data);
    if (!isNullOrEmpty(nbs) && !existeNbs(nbs, data)) throw new NbsNaoEncontradaException(nbs, data);
  }
  function registrar(ex, ncm, nbs, collector) {
    const t = traduzirErroConhecido(ex, ncm, nbs);
    if (t) collector.addErroValidacao(t[0], t[1], ex.message);
    else collector.addFalhaTecnica(ex);
  }
  return {
    validarEstrutural(ncm, nbs, data, collector) {
      try { validarNcmNbs(ncm, nbs, data); return true; } catch (ex) { registrar(ex, ncm, nbs, collector); return false; }
    },
    validarPorClassificacao(ncm, nbs, data, siglaDfe, classificacao, estruturaValida, collector) {
      if (!estruturaValida || collector.hasErros() || classificacao == null) return;
      try {
        if (siglaDfe == null) throw new Error('Sigla TIPO_DFE ausente para o documento habilitado na data');
        validacaoNomenclaturaService.validar(siglaPorNormalizada(siglaDfe).nome, classificacao.id, classificacao.codigo, ncm, nbs, data, 'CBS e IBS', 'PERMISSIVO');
      } catch (ex) { registrar(ex, ncm, nbs, collector); }
    },
  };
}

/** Wiring with the real repositories (rtc/db.js). */
export function criarNomenclatura(db, { validacaoNomenclaturaService } = {}) {
  const ncmAplicavelService = criarNcmAplicavelService({
    tem: db.temNcmAplicavelClassificacao, temAplicavel: db.temNcmAplicavel,
    temExcecaoAplicavel: db.temExcecaoNcmAplicavel, temAplicavelSemExcecao: db.temNcmAplicavelSemExcecao,
  });
  const nbsAplicavelService = criarNbsAplicavelService({
    tem: db.temNbsAplicavelClassificacao, temAplicavel: db.temNbsAplicavel,
    temExcecaoAplicavel: db.temExcecaoNbsAplicavel, temAplicavelSemExcecao: db.temNbsAplicavelSemExcecao,
  });
  const nomenclaturaService = criarNomenclaturaService({
    classificacaoCbsIbs: db.classificacaoCbsIbs, siglasTipoDfe: db.siglasTipoDfeDaClassificacao,
    temNcm: db.temNcmAplicavelClassificacao, temNbs: db.temNbsAplicavelClassificacao,
  });
  const validacao = validacaoNomenclaturaService ?? criarValidacaoNomenclaturaService({ nomenclaturaService, ncmAplicavelService, nbsAplicavelService });
  return {
    ncmAplicavelService, nbsAplicavelService, nomenclaturaService, validacaoNomenclaturaService: validacao,
    adapter: criarValidacaoNomenclaturaAdapter({ existeNcm: db.existeNcm, existeNbs: db.existeNbs, validacaoNomenclaturaService: validacao }),
  };
}
