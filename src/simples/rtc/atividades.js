// Port of the "atividadesimples" package of calculadora-rtc-simples-nacional 1.0.2:
//   DerivacaoAnexosSimples, ModoFatorR, AtividadeSimplesDomain, AtividadeSimplesService and the
//   parameter conversion of AtividadeSimplesController (converterAnexos).
// Endpoints: GET /api/calculadora/simples-nacional/atividades[/{codigo}]?data&anexos&tpDoc&cClassTrib
// The service receives its repositories (like the Java constructor injection), so the official
// unit tests that mock them can run against this code unchanged.

/** org.springframework.web.server.ResponseStatusException (HTTP status + reason). */
export class ResponseStatusException extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}
/** java.lang.IllegalStateException (inconsistent catalog row: fails early, HTTP 500). */
export class IllegalStateException extends Error {}

// ── ModoFatorR ───────────────────────────────────────────────────────────────
export const ModoFatorR = Object.freeze({
  NAO_APLICAVEL: 'NAO_APLICAVEL', OPCIONAL: 'OPCIONAL', INDISPONIVEL: 'INDISPONIVEL', OBRIGATORIO: 'OBRIGATORIO',
});

// ── DerivacaoAnexosSimples ───────────────────────────────────────────────────
/** Valid annexes, in the canonical roman order. */
export const ANEXOS_VALIDOS = Object.freeze(['I', 'II', 'III', 'IV', 'V']);

/**
 * DerivacaoAnexosSimples.derivar: `anexosConfigurados` null = no filter (all annexes configured),
 * empty set = none configured. Returns { disponivel, anexosFaltantes, modoFatorR }.
 */
export function derivar(anexoSemFatorR, anexoComFatorR, anexosConfigurados) {
  if (anexoComFatorR != null && anexoSemFatorR == null) {
    throw new IllegalStateException(`Atividade inconsistente: anexoComFatorR (${anexoComFatorR}) preenchido sem anexoSemFatorR. Não existe atividade "só com Fator R"; corrija o banco.`);
  }
  const configurados = anexosConfigurados == null ? new Set(ANEXOS_VALIDOS) : new Set(anexosConfigurados);
  const anexosPossiveis = ANEXOS_VALIDOS.filter((anexo) => anexo === anexoSemFatorR || anexo === anexoComFatorR);
  const anexosFaltantes = anexosPossiveis.filter((anexo) => !configurados.has(anexo));
  const disponivel = anexosPossiveis.length === 0 || anexosPossiveis.some((anexo) => configurados.has(anexo));
  let modoFatorR;
  if (anexoComFatorR == null) modoFatorR = ModoFatorR.NAO_APLICAVEL;
  else if (configurados.has(anexoComFatorR)) modoFatorR = configurados.has(anexoSemFatorR) ? ModoFatorR.OPCIONAL : ModoFatorR.OBRIGATORIO;
  else modoFatorR = ModoFatorR.INDISPONIVEL;
  return { disponivel, anexosFaltantes, modoFatorR };
}

// ── AtividadeSimplesDomain (record + factory "de") ───────────────────────────
/** Builds the output record; `sujeitaFatorR` is always derived from anexoComFatorR. */
export function atividadeDomain({ codigo, ordem, descricao, anexoSemFatorR, anexoComFatorR, rotuloAnexo, rotuloCurtoAnexo,
  disponivel, anexosFaltantes, modoFatorR, tpDocsAdmissiveis, admissivelNoDocumento, compativelComClassTrib }) {
  return {
    codigo, ordem, descricao, anexoSemFatorR, anexoComFatorR, sujeitaFatorR: anexoComFatorR != null, rotuloAnexo, rotuloCurtoAnexo,
    disponivel, anexosFaltantes: anexosFaltantes == null ? [] : [...anexosFaltantes], modoFatorR,
    tpDocsAdmissiveis: tpDocsAdmissiveis == null ? [] : [...tpDocsAdmissiveis], admissivelNoDocumento, compativelComClassTrib,
  };
}

/**
 * Jackson view of AtividadeSimplesDomain: @JsonInclude(ALWAYS) with @JsonPropertyOrder, except
 * admissivelNoDocumento and compativelComClassTrib (NON_NULL). Returns a plain object in the
 * Java key order, ready for the JSON writer.
 */
export function serializarAtividade(a) {
  const o = {
    codigo: a.codigo, ordem: a.ordem, descricao: a.descricao, anexoSemFatorR: a.anexoSemFatorR, anexoComFatorR: a.anexoComFatorR,
    sujeitaFatorR: a.sujeitaFatorR, rotuloAnexo: a.rotuloAnexo, rotuloCurtoAnexo: a.rotuloCurtoAnexo, disponivel: a.disponivel,
    anexosFaltantes: a.anexosFaltantes, modoFatorR: a.modoFatorR, tpDocsAdmissiveis: a.tpDocsAdmissiveis,
  };
  if (a.admissivelNoDocumento != null) o.admissivelNoDocumento = a.admissivelNoDocumento;
  if (a.compativelComClassTrib != null) o.compativelComClassTrib = a.compativelComClassTrib;
  return o;
}

// ── java.lang helpers ────────────────────────────────────────────────────────
/** String.isBlank(): every char is Character.isWhitespace (no-break spaces are not). */
const JAVA_WS = /^[\t\n\u000B\f\r\u001C-\u001F\u0020\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]*$/;
export const isBlank = (s) => s == null || JAVA_WS.test(s);
/** String.trim(): strips chars <= U+0020 at both ends. */
export const javaTrim = (s) => s.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');

/** Value of a Unicode decimal digit (Character.digit(c, 10)), or -1. Nd runs are 10 contiguous code points 0..9. */
function digito(cp) {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  if (!/^\p{Nd}$/u.test(String.fromCodePoint(cp))) return -1;
  let zero = cp;
  while (zero > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return (cp - zero) % 10;
}

/** Integer.parseInt(s, 10): optional sign, Unicode decimal digits, int range; null when it would throw. */
export function parseIntJava(s) {
  if (s == null || s.length === 0) return null;
  let i = 0, neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; i = 1; if (s.length === 1) return null; }
  let n = 0n;
  for (const ch of s.slice(i)) {
    if (ch.length !== 1) return null; // supplementary chars are not digits for parseInt (char-based)
    const d = digito(ch.codePointAt(0));
    if (d < 0) return null;
    n = n * 10n + BigInt(d);
    if (n > 2147483648n) return null;
  }
  if (neg) n = -n;
  if (n < -2147483648n || n > 2147483647n) return null;
  return Number(n);
}

// ── AtividadeSimplesService ──────────────────────────────────────────────────
/**
 * @param {object} deps
 * @param {object} deps.atividadeRepository           { buscarVigentes(data), buscarVinculosTpDocVigentes(data), contarTiposDfePorTipo(tpDoc) }
 * @param {object} deps.classificacaoTributariaRepository { buscarVigentes(codigo, data) }
 * @param {object} deps.parametroService              { buscarTipoReceitaBruta(tpRBSN, data) → row | null }
 */
export function criarAtividadeSimplesService({ atividadeRepository, classificacaoTributariaRepository, parametroService }) {
  /** validarTpDoc: null/blank = not informed; otherwise numeric and present in TIPO_DFE, else 400. */
  function validarTpDoc(tpDoc) {
    if (tpDoc == null || isBlank(tpDoc)) return null;
    const informado = javaTrim(tpDoc);
    const tipo = parseIntJava(informado);
    if (tipo == null) {
      throw new ResponseStatusException(400, `Tipo de documento fiscal inválido: '${informado}'. Informe o valor numérico da coluna TPDF_TIPO da TIPO_DFE (ex.: 55, 65, 91).`);
    }
    if (tipo < 0 || atividadeRepository.contarTiposDfePorTipo(tipo) === 0) {
      throw new ResponseStatusException(400, `Tipo de documento fiscal desconhecido: '${informado}'. Não há linha na TIPO_DFE com TPDF_TIPO correspondente.`);
    }
    return String(tipo);
  }

  /** resolverVedadoNaoTributavel: TRBS_IN_VEDADO_NAO_TRIBUTAVEL of the cClassTrib's tpRBSN (CBS group). */
  function resolverVedadoNaoTributavel(cClassTrib, data) {
    if (cClassTrib == null || isBlank(cClassTrib)) return null;
    const codigo = javaTrim(cClassTrib);
    const vigentes = classificacaoTributariaRepository.buscarVigentes(codigo, data);
    if (vigentes.length === 0) {
      throw new ResponseStatusException(400, `Código de classificação tributária desconhecido ou fora de vigência: '${codigo}'. Informe um cClassTrib do grupo da CBS vigente na data de referência.`);
    }
    const tpRBSN = vigentes[0].tpRBSN;
    if (tpRBSN == null) throw new TypeError('Cannot invoke "java.lang.Integer.intValue()" because the return value of "br.gov.serpro.rtc.api.simplesnacional.entity.ClassificacaoTributariaSimples.getTpRBSN()" is null');
    const tipo = parametroService.buscarTipoReceitaBruta(Number(tpRBSN), data);
    if (tipo == null) {
      throw new ResponseStatusException(400, `Não há parametrização de efeito vigente para o tipo de receita bruta tpRBSN=${Number(tpRBSN)} do cClassTrib '${codigo}' na data de referência.`);
    }
    return tipo.vedadoNaoTributavel;
  }

  /** buscarTpDocsAdmissiveis: one query; per activity, TPDF_TIPO sorted numerically, as strings. */
  function buscarTpDocsAdmissiveis(data) {
    const porAtividade = new Map();
    for (const v of atividadeRepository.buscarVinculosTpDocVigentes(data)) {
      const id = Number(v.atividadeId);
      if (!porAtividade.has(id)) porAtividade.set(id, []);
      porAtividade.get(id).push(Number(v.tpDoc));
    }
    for (const [id, tipos] of porAtividade) porAtividade.set(id, tipos.sort((a, b) => a - b).map(String));
    return porAtividade;
  }

  function toDomain(atividade, anexosConfigurados, tpDocsAdmissiveis, tpDoc, vedadoNaoTributavel) {
    const derivacao = derivar(atividade.anexoSemFatorR, atividade.anexoComFatorR, anexosConfigurados);
    const admissivelNoDocumento = tpDoc == null ? null : tpDocsAdmissiveis.includes(tpDoc);
    const compativelComClassTrib = vedadoNaoTributavel == null ? null : !(vedadoNaoTributavel && atividade.naoTributavel === true);
    const disponivel = derivacao.disponivel && admissivelNoDocumento !== false && compativelComClassTrib !== false;
    return atividadeDomain({
      codigo: atividade.cAtivSN, ordem: atividade.ordem, descricao: atividade.descricao,
      anexoSemFatorR: atividade.anexoSemFatorR, anexoComFatorR: atividade.anexoComFatorR,
      rotuloAnexo: atividade.rotulo, rotuloCurtoAnexo: atividade.rotuloCurto, disponivel,
      anexosFaltantes: derivacao.anexosFaltantes, modoFatorR: derivacao.modoFatorR, tpDocsAdmissiveis,
      admissivelNoDocumento, compativelComClassTrib,
    });
  }

  /** listar(data, anexosConfigurados, tpDoc, cClassTrib) */
  function listar(data, anexosConfigurados, tpDoc, cClassTrib) {
    const tpDocValidado = validarTpDoc(tpDoc);
    const vedadoNaoTributavel = resolverVedadoNaoTributavel(cClassTrib, data);
    const tpDocsAdmissiveisPorAtividade = buscarTpDocsAdmissiveis(data);
    return atividadeRepository.buscarVigentes(data).map((atividade) => toDomain(atividade, anexosConfigurados,
      tpDocsAdmissiveisPorAtividade.get(Number(atividade.id)) ?? [], tpDocValidado, vedadoNaoTributavel));
  }

  /** buscarPorCodigo(codigo, data, tpDoc, cClassTrib): Optional → the activity or null. */
  function buscarPorCodigo(codigo, data, tpDoc, cClassTrib) {
    if (codigo == null) return null;
    return listar(data, null, tpDoc, cClassTrib).find((atividade) => atividade.codigo === codigo) ?? null;
  }

  return { listar, buscarPorCodigo };
}

// ── AtividadeSimplesController.converterAnexos ───────────────────────────────
/**
 * `anexos` already converted by Spring to List<String> (null = parameter absent). Accepts CSV and
 * repeated parameters; duplicates tolerated; value outside I..V (case-sensitive) → 400.
 */
export function converterAnexos(anexos) {
  if (anexos == null) return null;
  const configurados = new Set();
  for (const elemento of anexos) {
    for (const anexo of elemento.split(',')) {
      if (anexo === '') continue;
      if (!ANEXOS_VALIDOS.includes(anexo)) {
        throw new ResponseStatusException(400, `Anexo inválido: '${anexo}'. Valores aceitos: ${ANEXOS_VALIDOS.join(', ')}.`);
      }
      configurados.add(anexo);
    }
  }
  return configurados;
}
