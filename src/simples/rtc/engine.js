// Port of the Receita Federal / SERPRO "calculadora-rtc-simples-nacional" (release 1.0.2)
// unified calculation — POST calculadora/observabilidade/simples-nacional/nao-assistido —
// i.e. CalculoSimplesUnificadoService + ProcessadorItemSimples + EscolhaParAliquotasService +
// SimplesNacionalCalculoService + ValidacaoNomenclatura* + TotalSimplesDomain.
// Every rule, message, rounding step and output field mirrors the Java source; comments cite
// the Java method each block comes from. Arithmetic is exact (BigInt decimals), HALF_EVEN.
import { Dec } from '../../core/decimal.js';
import CODIGOS from './codigos.json' with { type: 'json' };
import { criarNomenclatura } from './nomenclatura.js';
import * as A from './arredondamento.js';

// ── ArredondamentoUtils (rtc/arredondamento.js) ─────────────────────────────
const valorFiscal = A.arredondarValorFiscal;
/** ArredondamentoUtils.totalizar over the non-null values (the Java callers filter Objects::nonNull). */
const totalizar = (list) => A.totalizar(list.filter((v) => v != null));
const { MODO, formatarMoeda, formatarAliquota } = A;
/** java.text.DecimalFormat("#,##0.00" / "#,##0.00##", pt-BR, HALF_EVEN) */
function decimalFormatBR(v, minFrac, maxFrac) {
  let s = (v ?? Dec.ZERO).setScale(maxFrac, MODO);
  while (s.s > minFrac && s.u % 10n === 0n) s = new Dec(s.u / 10n, s.s - 1);
  const neg = s.u < 0n;
  const [int, frac = ''] = (neg ? s.neg() : s).toString().split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + grouped + (frac ? ',' + frac : '');
}

// ── Input helpers ────────────────────────────────────────────────────────────
/** java.lang.String.trim(): strips chars <= U+0020 at both ends. */
const javaTrim = (s) => s.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
/** java.lang.String.isBlank(): every char is Character.isWhitespace (no-break spaces are not). */
const JAVA_WS = /^[\t\n\u000B\f\r\u001C-\u001F\u0020\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]*$/;
const informado = (v) => v != null && !JAVA_WS.test(String(v));
const isBlank = (v) => v == null || JAVA_WS.test(String(v));

/** Request is not readable as the Java contract (Jackson would answer 400). */
export class RequisicaoInvalida extends Error {}
/** Jackson coercion of a JSON value into a java.lang.Boolean field. */
function jBoolean(v, campo) {
  if (v == null || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === 'null') return null;
    if (/^true$/i.test(s)) return true;
    if (/^false$/i.test(s)) return false;
  }
  if (typeof v === 'number' && Number.isInteger(v)) return v !== 0;
  throw new RequisicaoInvalida(`Valor inválido para ${campo}: ${JSON.stringify(v)}`);
}
/** Jackson coercion of a JSON value into a java.lang.Integer field (floats truncated). */
function jInteger(v, campo) {
  if (v == null) return null;
  let n = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === 'null') return null;
    if (/^[+-]?\d+$/.test(s)) n = Number(s);
  }
  if (n == null || n < -2147483648 || n > 2147483647) throw new RequisicaoInvalida(`Valor inválido para ${campo}: ${JSON.stringify(v)}`);
  return n;
}
/** EscolhaParAliquotasService.inteiro: Integer.valueOf(trim) or null. */
function inteiro(v) {
  if (!informado(v)) return null;
  const t = javaTrim(String(v));
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}
/** LocalDate.parse (ISO_LOCAL_DATE, strict calendar). */
function parseLocalDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return null;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim ? text : null;
}
const FORMATO_ALIQUOTA = /^\d{1,3}(\.\d{1,34})?$/;
const FORMATO_VALOR = /^\d{1,13}(\.\d{1,2})?$/;
const DESCRICAO_FORMATO_ALIQUOTA = 'até 3 dígitos inteiros e até 34 casas decimais, sem notação científica (ex.: 1.6839)';
const DESCRICAO_FORMATO_VALOR = 'até 13 dígitos inteiros e até 2 casas decimais, sem notação científica (ex.: 1000.00)';
const str = (v) => (v == null ? null : typeof v === 'string' ? v : String(v));

// ── Errors ───────────────────────────────────────────────────────────────────
const erroType = (baseURL, code) => `${baseURL}/calculadora/observabilidade/simples-nacional/erros?codigo=${code}`;
function erroGlobal(nome, campo, detail, baseURL) {
  const c = CODIGOS[nome];
  return { type: erroType(baseURL, c.code), title: c.title, code: c.code, pointer: `#/${campo}`, detail };
}
export class ErrosCalculo extends Error {
  constructor(erros) { super('Erros de cálculo encontrados'); this.erros = erros; }
}

/** ItemCollectorSimples */
class Collector {
  constructor(index, baseURL) { this.index = index; this.baseURL = baseURL; this.erros = []; this.estado = 'CALCULADO'; }
  #add(nome, pointer, detail) {
    const c = CODIGOS[nome];
    this.erros.push({ type: erroType(this.baseURL, c.code), title: c.title, code: c.code, pointer, detail });
  }
  addErroValidacao(nome, campo, detail) {
    if (this.estado === 'CALCULADO') this.estado = 'INCONSISTENCIA_ENTRADA';
    this.#add(nome, campo == null ? `#/itens/${this.index}` : `#/itens/${this.index}/${campo}`, detail);
  }
  addErroValidacaoNoPonteiro(nome, ponteiro, detail) {
    if (this.estado === 'CALCULADO') this.estado = 'INCONSISTENCIA_ENTRADA';
    this.#add(nome, ponteiro, detail);
  }
  addNaoImplementado(nome, campo, detail) {
    this.estado = 'NAO_IMPLEMENTADO';
    this.#add(nome, `#/itens/${this.index}/${campo}`, detail);
  }
  addFalhaTecnica(ex) {
    this.estado = 'FALHA_TECNICA';
    this.#add('FALHA_TECNICA', `#/itens/${this.index}`, ex?.message ?? null);
  }
  hasErros() { return this.erros.length > 0; }
}

// ── MotivoNaoCalculoSimplesEnum ──────────────────────────────────────────────
const MOTIVOS = {
  REGIME_SOMENTE_RECEITA: 'O optante apura o IBS e a CBS pelo regime regular, fora do Simples Nacional; o item leva ao Simples apenas a receita bruta.',
  CATIVSN_AUSENTE: 'O código de atividade do Simples Nacional (cAtivSN) não foi informado; sem ele o IBS e a CBS do item não são calculados (NT 2026.005, §5.3.3).',
  CATIVSN_DESCONHECIDO: "O código de atividade '%s' não existe ou não está vigente na data do fato gerador; o IBS e a CBS do item não são calculados.",
  CATIVSN_INADMISSIVEL_NO_DOCUMENTO: "A atividade '%s' não é admitida no tipo de documento %s (tpDoc %s); o IBS e a CBS do item não são calculados.",
  ANEXO_SEM_ALIQUOTA_CBS: 'A Tabela de Alíquotas Efetivas do Simples Nacional não traz a alíquota de CBS do Anexo %s para o contribuinte no período; o IBS e a CBS do item não são calculados.',
};
const fmt = (template, ...args) => { let i = 0; return template.replace(/%[sd]/g, () => String(args[i++])); };
const motivo = (codigo, ...args) => ({ codigo, descricao: args.length ? fmt(MOTIVOS[codigo], ...args) : MOTIVOS[codigo] });

// ── ProcessadorItemSimples.ContextoItemSimples ───────────────────────────────
/** Classic endpoint: default tpRBSN row, cAtivSN as received, IS admitted, full rate precision. */
export const contextoClassico = (data, tpDoc, regime, tpEnteGov, fator, siglaDfe, permiteNcmZero) => ({
  data, tpDoc, regime, tpEnteGov, fator, vocabulario: null, vocabularioTipoReceita: null, normalizarCAtivSN: false,
  admiteIs: true, casas: null, siglaDfe, permiteNcmZero,
});
/** Unified (não assistido) endpoint: parametrization of the document (TIPO_DFE_CALCULO_SIMPLES_NACIONAL). */
export const contextoUnificado = (data, tpDoc, regime, tpEnteGov, fator, documento, siglaDfe, permiteNcmZero) => ({
  data, tpDoc, regime, tpEnteGov, fator, vocabulario: documento.vocabulario, vocabularioTipoReceita: documento.vocabulario,
  normalizarCAtivSN: true, admiteIs: Number(documento.admiteIs) === 1, casas: documento.casas == null ? null : Number(documento.casas),
  siglaDfe, permiteNcmZero,
});
/** EscolhaParAliquotasService.avisoParSemRedistribuicaoAusente */
export const avisoParSemRedistribuicaoAusente = (anexo) => `Par sem redistribuição do ISS ausente no anexo ${anexo}; aplicado o par com redistribuição, igual quando o ISS não passa do teto.`;

/**
 * @param {object} db repositories (rtc/db.js, or mocks in the official unit tests)
 * @param {object} [opcoes] { validacaoNomenclaturaService } to replace the real one (unit tests)
 */
function createEngine(db, opcoes = {}) {
  const nomenclatura = criarNomenclatura(db, opcoes);
  // ── ProcessadorItemSimples helpers ─────────────────────────────────────────
  function converterNoFormato(valor, formato, descricao, collector, campo, codigoInvalido) {
    const texto = javaTrim(String(valor));
    if (formato.test(texto)) return Dec.of(texto);
    if (texto.startsWith('-') && formato.test(texto.slice(1))) {
      collector.addErroValidacao(codigoInvalido, campo, `O valor não pode ser negativo, recebido: '${valor}'.`);
    } else {
      collector.addErroValidacao(codigoInvalido, campo, `O valor não é um número decimal válido, recebido: '${valor}'. Informe ${descricao}.`);
    }
    return null;
  }
  function validarDecimal(valor, collector, campo, codigoAusente, codigoInvalido) {
    if (isBlank(valor)) { collector.addErroValidacao(codigoAusente, campo, 'O campo é obrigatório e não foi informado.'); return null; }
    return converterNoFormato(valor, FORMATO_VALOR, DESCRICAO_FORMATO_VALOR, collector, campo, codigoInvalido);
  }
  function validarImpostoSeletivoNaoAdmitido(valor, collector) {
    if (isBlank(valor)) return null;
    const c = converterNoFormato(valor, FORMATO_VALOR, DESCRICAO_FORMATO_VALOR, collector, 'valorImpostoSeletivo', 'IS_INVALIDO');
    if (c != null && c.signum() !== 0) {
      collector.addErroValidacao('IS_NAO_ADMITIDO', 'valorImpostoSeletivo', `O documento não tem Imposto Seletivo: o valor deve ser zero ou não ser informado, recebido: '${valor}'.`);
    }
    return null;
  }
  const normalizarCAtivSN = (v, completarZero) => {
    if (isBlank(v)) return null;
    const c = javaTrim(String(v));
    return completarZero && /^\d$/.test(c) ? '0' + c : c;
  };
  const bool = (v) => v != null && Number(v) === 1;

  function resolverTipoReceitaBruta(cClassTrib, ctx, collector) {
    if (isBlank(cClassTrib)) {
      collector.addErroValidacao('CCLASSTRIB_AUSENTE', 'cClassTrib', 'O código de classificação tributária (cClassTrib) é obrigatório e não foi informado.');
      return null;
    }
    const codigo = javaTrim(String(cClassTrib));
    const vigentes = db.buscarClassificacoesVigentes(codigo, ctx.data);
    if (vigentes.length === 0) {
      collector.addErroValidacao('CCLASSTRIB_DESCONHECIDO', 'cClassTrib', `O cClassTrib '${codigo}' não existe ou não está vigente na data '${ctx.data}': o tpRBSN não pôde ser determinado.`);
      return null;
    }
    const classificacao = vigentes[0];
    if (db.contarVinculosClassificacaoTpDoc(codigo, ctx.tpDoc, ctx.data) === 0) {
      collector.addErroValidacao('CCLASSTRIB_INCOMPATIVEL_TPDOC', 'cClassTrib', `O cClassTrib '${codigo}' não é admissível para o tipo de documento fiscal ${ctx.tpDoc}.`);
      return null;
    }
    const tpRBSN = Number(classificacao.tpRBSN);
    const tr = db.buscarTipoReceitaBruta(tpRBSN, ctx.vocabularioTipoReceita, ctx.data);
    const tipoReceita = tr && {
      codigo: Number(tr.codigo), descricao: tr.descricao, compoeReceita: bool(tr.compoeReceita),
      isCompoeReceita: bool(tr.isCompoeReceita), fatorReceita: Dec.of(tr.fatorReceita),
      pendenteSuspenso: bool(tr.pendenteSuspenso), exigeAliquota: bool(tr.exigeAliquota),
      vedadoNaoTributavel: bool(tr.vedadoNaoTributavel),
    };
    if (!tipoReceita) {
      collector.addErroValidacao('PARAMETRIZACAO_INDISPONIVEL', 'cClassTrib', `Não há parametrização de efeito vigente para o tipo de receita bruta tpRBSN=${tpRBSN} na data '${ctx.data}'.`);
    }
    return { classificacao: { id: classificacao.id, codigo: classificacao.codigo }, tipoReceita: tipoReceita ?? null };
  }

  function validarCAtivSN(cAtivSN, tipoReceita, ctx, collector) {
    const codigo = normalizarCAtivSN(cAtivSN, ctx.normalizarCAtivSN);
    if (codigo == null) return { cAtivSN: null, atividade: null, admissivel: false };
    const a = db.buscarAtividadeVigente(codigo, ctx.data);
    if (!a) return { cAtivSN: codigo, atividade: null, admissivel: false };
    const atividade = {
      id: a.id, cAtivSN: a.cAtivSN, anexoSemFatorR: a.anexoSemFatorR, anexoComFatorR: a.anexoComFatorR,
      naoTributavel: bool(a.naoTributavel), issNoSimples: bool(a.issNoSimples), admiteBeneficioMunicipal: bool(a.admiteBeneficioMunicipal),
    };
    if (db.contarVinculosAtividadeTpDoc(atividade.id, ctx.tpDoc, ctx.data) === 0) return { cAtivSN: codigo, atividade, admissivel: false };
    if (atividade.naoTributavel && tipoReceita != null && tipoReceita.vedadoNaoTributavel) {
      collector.addErroValidacao('CATIVSN_INCOMPATIVEL_CCLASSTRIB', 'cAtivSN', `O código de atividade '${codigo}' (Operações não Tributáveis) é incompatível com cClassTrib de tpRBSN=${tipoReceita.codigo}.`);
    }
    return { cAtivSN: codigo, atividade, admissivel: true };
  }

  // ── EscolhaParAliquotasService ─────────────────────────────────────────────
  function avaliarCamposIss(vocabulario, atividade, campos, collector) {
    const avisos = [];
    const tribInf = informado(campos.tribISSQN), retInf = informado(campos.tpRetISSQN), bmInf = informado(campos.tpBM);
    if (vocabulario !== 'NFSE') {
      const desc = [];
      if (tribInf) desc.push('tribISSQN');
      if (retInf) desc.push('tpRetISSQN');
      if (bmInf) desc.push('tpBM');
      if (desc.length) avisos.push(`${desc.join(', ')} desconsiderado(s): os campos do ISS só valem na NFS-e.`);
      return { tribISSQN: null, tpRetISSQN: null, tpBM: null, avisos };
    }
    const issNoSimples = atividade.issNoSimples;
    const cAtivSN = atividade.cAtivSN;
    let tribISSQN = inteiro(campos.tribISSQN);
    if (tribInf && (tribISSQN == null || ![1, 2, 3, 4].includes(tribISSQN))) {
      collector.addErroValidacao('TRIBISSQN_INVALIDO', 'tribISSQN', `A tributação do ISSQN (tribISSQN) deve ser 1, 2, 3 ou 4, recebido: '${campos.tribISSQN}'.`);
      tribISSQN = null;
    } else if (!tribInf && issNoSimples) {
      collector.addErroValidacao('TRIBISSQN_INVALIDO', 'tribISSQN', `A tributação do ISSQN (tribISSQN) é obrigatória para a atividade ${cAtivSN}, que tem ISS no Simples Nacional.`);
    }
    let tpRetISSQN = null;
    if (retInf && tribISSQN != null && tribISSQN !== 1) {
      avisos.push(`tpRetISSQN desconsiderado: não há retenção do ISS com tribISSQN ${tribISSQN} (a NFS-e recusaria a combinação: regra E0580).`);
    } else if (retInf) {
      tpRetISSQN = inteiro(campos.tpRetISSQN);
      if (tpRetISSQN == null || ![1, 2, 3].includes(tpRetISSQN)) {
        collector.addErroValidacao('TPRETISSQN_INVALIDO', 'tpRetISSQN', `O tipo de retenção do ISSQN (tpRetISSQN) deve ser 1, 2 ou 3, recebido: '${campos.tpRetISSQN}'.`);
        tpRetISSQN = null;
      }
    } else if (issNoSimples && tribISSQN === 1) {
      collector.addErroValidacao('TPRETISSQN_INVALIDO', 'tpRetISSQN', `O tipo de retenção do ISSQN (tpRetISSQN) é obrigatório com tribISSQN = 1 na atividade ${cAtivSN}, que tem ISS no Simples Nacional.`);
    }
    let tpBM = null;
    if (bmInf && !atividade.admiteBeneficioMunicipal) {
      avisos.push(`tpBM desconsiderado: a atividade ${cAtivSN} não admite benefício municipal do ISS (regra E0536 da NFS-e: só os subitens 7.02 e 7.05, atividades 12 e 13).`);
    } else if (bmInf) {
      tpBM = inteiro(campos.tpBM);
      if (tpBM == null || ![1, 2, 3, 4].includes(tpBM)) {
        collector.addErroValidacao('TPBM_INVALIDO', 'tpBM', `O tipo de benefício municipal (tpBM) deve ser 1, 2, 3 ou 4, recebido: '${campos.tpBM}'.`);
        tpBM = null;
      }
    }
    if (tpBM === 1 && tpRetISSQN != null && [2, 3].includes(tpRetISSQN)) {
      avisos.push(`tpBM 1 (isenção) com tpRetISSQN ${tpRetISSQN}: combinação recusada pela NFS-e (regra E0594); vale a isenção municipal (par sem redistribuição).`);
    }
    return { tribISSQN, tpRetISSQN, tpBM, avisos };
  }

  const anexoComIss = (anexo) => ['III', 'IV', 'V'].includes(anexo);
  function escolhido(anexo, tipo, regra, par, semAusente, caminho) {
    const m = par == null || par.pCBSSN == null ? 'ANEXO_SEM_ALIQUOTA' : 'RESOLVIDA';
    return { anexo, tipoAliquota: tipo, regra, par, parSemRedistribuicaoAusente: semAusente, caminhoPar: caminho, motivo: m };
  }
  const situacao = (regra, fatos, situacoes) =>
    situacoes.find((s) => s.regra === regra && fatos.has(s.campo) && Number(s.valor) === fatos.get(s.campo)) ?? null;

  function escolher(atividade, admissivel, linha, fatos, situacoes) {
    if (!admissivel) return { anexo: null, tipoAliquota: null, regra: 'DOCUMENTO', par: null, parSemRedistribuicaoAusente: false, caminhoPar: null, motivo: 'ATIVIDADE_INADMISSIVEL_NO_DOCUMENTO' };
    const { anexoComFatorR, anexoSemFatorR } = atividade;
    if (anexoComFatorR == null && anexoSemFatorR == null) {
      return { anexo: null, tipoAliquota: 'SEM_ALIQUOTA', regra: 'ATIVIDADE_NAO_TRIBUTADA', par: { pCBSSN: Dec.ZERO, pIBSSN: Dec.ZERO }, parSemRedistribuicaoAusente: false, caminhoPar: null, motivo: 'ATIVIDADE_SEM_ANEXO' };
    }
    let anexo = anexoSemFatorR;
    if (anexoComFatorR != null) {
      if (linha.fatorR == null) return { anexo: null, tipoAliquota: null, regra: null, par: null, parSemRedistribuicaoAusente: false, caminhoPar: null, motivo: 'FATOR_R_AUSENTE' };
      anexo = linha.fatorR ? anexoComFatorR : anexoSemFatorR;
    }
    const aliqAnexo = linha.anexos[anexo] ?? null;
    const parDoAnexo = aliqAnexo == null ? null : aliqAnexo.par;
    const caminhoAnexo = 'anexo' + anexo;
    if (!anexoComIss(anexo)) return escolhido(anexo, 'PAR_UNICO', 'ANEXO_SEM_ISS', parDoAnexo, false, caminhoAnexo);

    let regra = 'PADRAO', tipo = 'COM_REDISTRIBUICAO', s;
    if (linha.impedimentoSublimite) { regra = 'ISS_FORA_DO_SIMPLES'; tipo = 'SEM_REDISTRIBUICAO'; }
    else if ((s = situacao('ISS_FORA_DO_SIMPLES', fatos, situacoes)) != null) { regra = s.regra; tipo = s.tipoAliquota; }
    else if (!atividade.issNoSimples) { regra = 'ATIVIDADE_SEM_ISS'; tipo = 'SEM_REDISTRIBUICAO'; }
    else {
      for (const c of ['ISS_NAO_INCIDE', 'ISENCAO_MUNICIPAL', 'ISS_RETIDO']) {
        s = situacao(c, fatos, situacoes);
        if (s != null) { regra = s.regra; tipo = s.tipoAliquota; break; }
      }
    }
    if (tipo !== 'SEM_REDISTRIBUICAO') return escolhido(anexo, tipo, regra, parDoAnexo, false, caminhoAnexo);
    const sem = aliqAnexo == null ? null : aliqAnexo.sem;
    if (sem == null) return escolhido(anexo, tipo, regra, parDoAnexo, true, caminhoAnexo);
    return escolhido(anexo, tipo, regra, sem, false, caminhoAnexo + '/semRedistribuicaoISS');
  }

  // ── SimplesNacionalCalculoService.calcularItem ─────────────────────────────
  function calcularItem(ins) {
    const tr = ins.tipoReceita;
    const vRBSNitem = tr.compoeReceita
      ? valorFiscal(totalizar(tr.isCompoeReceita ? [ins.baseCalculo, ins.valorIs] : [ins.baseCalculo]))
      : Dec.ZERO;
    const m = ins.regime.calculaTributos === false ? motivo('REGIME_SOMENTE_RECEITA') : ins.motivoNaoCalculo;
    if (m != null) {
      return { estadoItem: 'NAO_CALCULADO', motivoEstado: m, tribCalc: { vRBSNitem, tpRBSN: tr.codigo, tpRBSNDescricao: tr.descricao } };
    }
    // compra governamental pipeline: redutor (identity) → deslocamento → casas do leiaute
    let pIbs = ins.pIBSSN, pCbs = ins.pCBSSN;
    if (ins.tpEnteGov != null && !(pIbs == null && pCbs == null)) {
      const i0 = pIbs ?? Dec.ZERO, c0 = pCbs ?? Dec.ZERO;
      if (ins.tpEnteGov === 1) { pIbs = Dec.ZERO; pCbs = totalizar([c0, i0]); }
      else {
        if (ins.fator == null) throw new Error(`Fator de transição de compra governamental não resolvido para tpEnteGov ${ins.tpEnteGov}`);
        pIbs = totalizar([i0, ins.fator.mul(c0)]);
        pCbs = Dec.ONE.sub(ins.fator).mul(c0);
      }
    }
    if (ins.casas != null) {
      pIbs = pIbs == null ? null : pIbs.setScale(ins.casas, MODO);
      pCbs = pCbs == null ? null : pCbs.setScale(ins.casas, MODO);
    }
    const fatorReceita = tr.fatorReceita;
    const vBC = valorFiscal(vRBSNitem.mul(fatorReceita));
    const valorTributo = (aliq) => (aliq == null || fatorReceita.signum() === 0 ? Dec.ZERO : vRBSNitem.mul(fatorReceita).mul(aliq.movePointLeft(2)));
    const valorIbs = valorFiscal(valorTributo(pIbs));
    const valorCbs = valorFiscal(valorTributo(pCbs));
    const repartir = (valor) => {
      const destino = tr.pendenteSuspenso ? ins.regime.destinoPendenteSuspenso : ins.regime.destinoDevido;
      if (destino === 'DEVIDO') return { devido: valor, pend: Dec.ZERO };
      if (destino === 'PENDENTE_SUSPENSO') return { devido: Dec.ZERO, pend: valor };
      if (destino === 'ZERO') return { devido: Dec.ZERO, pend: Dec.ZERO };
      throw new Error(`Destino de regime desconhecido: ${destino}`);
    };
    const geraIbs = ins.regime.geraIbs === true;
    const ibs = geraIbs ? repartir(valorIbs) : null;
    const cbs = repartir(valorCbs);
    const valorIs = ins.valorIs;
    const totalItem = totalizar([ibs ? ibs.devido : null, cbs.devido, valorIs]);
    const memoria = (aliq, v) => `Receita bruta do Simples Nacional de R$ ${decimalFormatBR(vRBSNitem, 2, 2)} (${tr.descricao}). A base de cálculo utilizada é de R$ ${decimalFormatBR(vBC, 2, 2)}, com alíquota efetiva de ${decimalFormatBR(aliq, 2, 4)}%. Valor devido de R$ ${decimalFormatBR(v.devido, 2, 2)} e pendente/suspenso de R$ ${decimalFormatBR(v.pend, 2, 2)}.`;
    return {
      estadoItem: 'CALCULADO', motivoEstado: null,
      tribCalc: {
        vRBSNitem, tpRBSN: tr.codigo, tpRBSNDescricao: tr.descricao, vBC,
        pIBSSN: geraIbs ? pIbs : null, vIBSSN: ibs ? ibs.devido : null, vIBSPendSusp: ibs ? ibs.pend : null,
        pCBSSN: pCbs, vCBSSN: cbs.devido, vCBSPendSusp: cbs.pend,
        IS: valorIs != null ? { valor: valorIs } : null,
        totalItem,
        memoriaCalculo: { cbs: memoria(pCbs, cbs), ibs: ibs ? memoria(pIbs, ibs) : null },
      },
    };
  }

  function motivoNaoCalculo(atividade, aliquotas, ctx) {
    if (atividade.cAtivSN == null) return motivo('CATIVSN_AUSENTE');
    if (atividade.atividade == null) return motivo('CATIVSN_DESCONHECIDO', atividade.cAtivSN);
    if (!atividade.admissivel) return motivo('CATIVSN_INADMISSIVEL_NO_DOCUMENTO', atividade.cAtivSN, ctx.siglaDfe ?? 'informado', ctx.tpDoc);
    if (aliquotas.naoCalcular) return motivo('ANEXO_SEM_ALIQUOTA_CBS', aliquotas.resolucao?.anexoAplicado ?? 'aplicado');
    return null;
  }

  // ── ProcessadorItemSimples.processarItem ───────────────────────────────────
  function processarItem(item, index, ctx, resolvedor, baseURL) {
    const collector = new Collector(index, baseURL);
    const nObj = item.numero ?? null;
    if (nObj == null) collector.addErroValidacao('NUMERO_AUSENTE', 'numero', 'O número do item é obrigatório.');

    if (!isBlank(item.cClassTrib)) {
      const codigo = javaTrim(String(item.cClassTrib));
      if (db.contarTratamentosNaoImplementados(codigo, ctx.data) > 0) {
        collector.addNaoImplementado('CCLASSTRIB_NAO_IMPLEMENTADO', 'cClassTrib', `A classificação tributária '${codigo}' ainda não possui tratamento implementado no cálculo do Simples Nacional na data '${ctx.data}'. Essa funcionalidade está prevista no roadmap e será disponibilizada em versão futura.`);
        return { objeto: { nObj: nObj ?? index + 1, estadoItem: collector.estado, erros: collector.erros }, resolucao: resolvedor.naoAvaliado() };
      }
    }
    const ncm = ctx.permiteNcmZero && (item.NCM === '00' || item.NCM === '00000000') ? null : item.NCM;
    const baseCalculo = validarDecimal(item.baseCalculo, collector, 'baseCalculo', 'BASE_AUSENTE', 'BASE_INVALIDA');
    const estruturaValida = nomenclatura.adapter.validarEstrutural(ncm, item.NBS, ctx.data, collector);
    const valorIs = ctx.admiteIs
      ? validarDecimal(item.valorImpostoSeletivo, collector, 'valorImpostoSeletivo', 'IS_INVALIDO', 'IS_INVALIDO')
      : validarImpostoSeletivoNaoAdmitido(item.valorImpostoSeletivo, collector);
    const rc = resolverTipoReceitaBruta(item.cClassTrib, ctx, collector);
    const tipoReceita = rc == null ? null : rc.tipoReceita;
    nomenclatura.adapter.validarPorClassificacao(ncm, item.NBS, ctx.data, ctx.siglaDfe, rc == null ? null : rc.classificacao, estruturaValida, collector);

    const calculaTributos = ctx.regime.calculaTributos !== false;
    let atividade = { cAtivSN: null, atividade: null, admissivel: false };
    let aliquotas = { pIBSSN: null, pCBSSN: null, naoCalcular: false, resolucao: null };
    if (calculaTributos) {
      atividade = validarCAtivSN(item.cAtivSN, tipoReceita, ctx, collector);
      const valida = atividade.atividade != null && atividade.admissivel;
      const exigidas = valida && tipoReceita != null && tipoReceita.exigeAliquota;
      aliquotas = resolvedor.resolver({ index, atividade, tipoReceita, cbsExigida: exigidas, ibsExigida: exigidas && ctx.regime.geraIbs === true }, collector);
    }
    if (collector.hasErros()) {
      return { objeto: { nObj: nObj ?? index + 1, estadoItem: collector.estado, erros: collector.erros }, resolucao: aliquotas.resolucao };
    }
    const mnc = calculaTributos ? motivoNaoCalculo(atividade, aliquotas, ctx) : null;
    try {
      const r = calcularItem({
        regime: ctx.regime, tipoReceita, motivoNaoCalculo: mnc, baseCalculo, valorIs,
        pIBSSN: aliquotas.pIBSSN, pCBSSN: aliquotas.pCBSSN, tpEnteGov: ctx.tpEnteGov, fator: ctx.fator, casas: ctx.casas,
      });
      return { objeto: { nObj, estadoItem: r.estadoItem, motivoEstado: r.motivoEstado, tribCalc: r.tribCalc }, resolucao: aliquotas.resolucao };
    } catch (ex) {
      collector.addFalhaTecnica(ex);
      return { objeto: { nObj: nObj ?? index + 1, estadoItem: collector.estado, erros: collector.erros }, resolucao: aliquotas.resolucao };
    }
  }

  // ── CalculoSimplesUnificadoService.resolvedor (não assistido: linha da requisição) ──
  function resolvedor(item, vocabulario, linha, fatosDaOperacao, situacoes) {
    const ponteiroLinha = (caminho) => '#/aliquotasEfetivas/' + caminho;
    const semPar = (numero, cAtivSN, motivoRes) => ({ pIBSSN: null, pCBSSN: null, naoCalcular: false, resolucao: { numero, cAtivSN, anexoAplicado: null, tipoAliquota: null, regraAliquota: null, pIBSSN: null, pCBSSN: null, motivo: motivoRes, avisos: [] } });
    return {
      resolver(dados, collector) {
        const cAtivSN = dados.atividade.cAtivSN;
        if (dados.atividade.atividade == null) return semPar(item.numero ?? null, cAtivSN, 'ATIVIDADE_DESCONHECIDA');
        const avisos = [];
        const fatos = new Map(fatosDaOperacao);
        if (dados.atividade.admissivel) {
          const iss = avaliarCamposIss(vocabulario, dados.atividade.atividade, { tribISSQN: item.tribISSQN, tpRetISSQN: item.tpRetISSQN, tpBM: item.tpBM }, collector);
          avisos.push(...iss.avisos);
          if (iss.tribISSQN != null) fatos.set('tribISSQN', iss.tribISSQN);
          if (iss.tpRetISSQN != null) fatos.set('tpRetISSQN', iss.tpRetISSQN);
          if (iss.tpBM != null) fatos.set('tpBM', iss.tpBM);
        }
        const e = escolher(dados.atividade.atividade, dados.atividade.admissivel, linha, fatos, situacoes);
        if (e.motivo === 'FATOR_R_AUSENTE') {
          collector.addErroValidacaoNoPonteiro('FATOR_R_AUSENTE', ponteiroLinha('fatorR'), `O fatorR é exigido: a atividade ${cAtivSN} é sujeita ao fator "r" (Anexo III ou V).`);
        }
        if (e.parSemRedistribuicaoAusente) avisos.push(avisoParSemRedistribuicaoAusente(e.anexo));
        const pCbs = e.par == null ? null : e.par.pCBSSN;
        const pIbs = e.par == null ? null : e.par.pIBSSN;
        if (e.caminhoPar != null) {
          const exigir = (exigida, aliq, codigo, campo) => {
            if (!exigida || aliq != null) return;
            const par = e.tipoAliquota === 'SEM_REDISTRIBUICAO' && !e.parSemRedistribuicaoAusente ? 'sem' : 'com';
            const detalhe = e.tipoAliquota === 'PAR_UNICO'
              ? `A alíquota ${campo} do anexo ${e.anexo} é exigida para o cálculo do item e não está na linha de alíquotas.`
              : `A alíquota ${campo} do anexo ${e.anexo} (par ${par} redistribuição do ISS, regra ${e.regra}) é exigida para o cálculo do item e não está na linha de alíquotas.`;
            collector.addErroValidacaoNoPonteiro(codigo, ponteiroLinha(e.caminhoPar + '/' + campo), detalhe);
          };
          exigir(dados.cbsExigida, pCbs, 'ALIQUOTA_CBS_AUSENTE', 'pCBSSN');
          exigir(dados.ibsExigida, pIbs, 'ALIQUOTA_IBS_AUSENTE', 'pIBSSN');
        }
        return { pIBSSN: pIbs, pCBSSN: pCbs, naoCalcular: false, resolucao: { numero: item.numero ?? null, cAtivSN, anexoAplicado: e.anexo, tipoAliquota: e.tipoAliquota, regraAliquota: e.regra, pIBSSN: pIbs, pCBSSN: pCbs, motivo: e.motivo, avisos } };
      },
      naoAvaliado() { return semPar(item.numero ?? null, normalizarCAtivSN(item.cAtivSN, true), 'ITEM_NAO_IMPLEMENTADO').resolucao; },
    };
  }
  const SEM_ALIQUOTAS = { resolver: () => ({ pIBSSN: null, pCBSSN: null, naoCalcular: false, resolucao: null }), naoAvaliado: () => null };

  // ── SimplesNacionalNaoAssistidoService.FonteRequisicao.obter ───────────────
  function obterLinha(aliq, baseURL) {
    if (aliq == null) throw new ErrosCalculo([erroGlobal('ALIQUOTAS_EFETIVAS_AUSENTES', 'aliquotasEfetivas', 'A linha de alíquotas efetivas do contribuinte (aliquotasEfetivas) é obrigatória no cálculo não assistido quando o regime calcula tributos.', baseURL)]);
    const erros = [];
    const aliquota = (valor, caminho, codigo) => {
      if (!informado(valor)) return null;
      const texto = javaTrim(String(valor));
      if (FORMATO_ALIQUOTA.test(texto)) return Dec.of(texto);
      const neg = texto.startsWith('-') && FORMATO_ALIQUOTA.test(texto.slice(1));
      erros.push(erroGlobal(codigo, 'aliquotasEfetivas/' + caminho, neg ? `O valor não pode ser negativo, recebido: '${valor}'.` : `O valor não é um número decimal válido, recebido: '${valor}'. Informe ${DESCRICAO_FORMATO_ALIQUOTA}.`, baseURL));
      return null;
    };
    const par = (pCBSSN, pIBSSN, caminho) => ({ pCBSSN: aliquota(pCBSSN, caminho + '/pCBSSN', 'ALIQUOTA_CBS_INVALIDA'), pIBSSN: aliquota(pIBSSN, caminho + '/pIBSSN', 'ALIQUOTA_IBS_INVALIDA') });
    const anexo = (a, caminho, comIss) => {
      if (a == null) return null;
      const sem = comIss ? a.semRedistribuicaoISS : null;
      const semInf = sem != null && (informado(sem.pCBSSN) || informado(sem.pIBSSN));
      return { par: par(a.pCBSSN, a.pIBSSN, caminho), sem: semInf ? par(sem.pCBSSN, sem.pIBSSN, caminho + '/semRedistribuicaoISS') : null };
    };
    const linha = {
      fatorR: jBoolean(aliq.fatorR, 'fatorR'),
      impedimentoSublimite: jBoolean(aliq.impedimentoSublimite, 'impedimentoSublimite') === true,
      anexos: { I: anexo(aliq.anexoI, 'anexoI', false), II: anexo(aliq.anexoII, 'anexoII', false), III: anexo(aliq.anexoIII, 'anexoIII', true), IV: anexo(aliq.anexoIV, 'anexoIV', true), V: anexo(aliq.anexoV, 'anexoV', true) },
    };
    if (erros.length) throw new ErrosCalculo(erros);
    return linha;
  }

  // ── CalculoSimplesUnificadoService.processar ───────────────────────────────
  function validarRegimeNfse(op, erros, baseURL) {
    const opSimpNac = inteiro(op.opSimpNac);
    if (opSimpNac == null || opSimpNac < 1 || opSimpNac > 4) {
      erros.push(erroGlobal('OPSIMPNAC_INVALIDO', 'opSimpNac', `A situação perante o Simples Nacional (opSimpNac) é obrigatória na NFS-e e deve ser 1, 2, 3 ou 4, recebido: '${op.opSimpNac ?? null}'.`, baseURL));
      return;
    }
    const campo = (valor, nome, codigo, regraObrigatorio) => {
      const optante = opSimpNac === 3 || opSimpNac === 4;
      if (informado(valor)) {
        const v = inteiro(valor);
        if (v == null || v < 1 || v > 3) erros.push(erroGlobal(codigo, nome, `O ${nome} deve ser 1, 2 ou 3, recebido: '${valor}'.`, baseURL));
        else if (!optante) erros.push(erroGlobal(codigo, nome, `O ${nome} não pode ser informado com opSimpNac=${opSimpNac} (não optante ou MEI)${nome === 'regApTribSN' ? ' (regra E0162 da NFS-e)' : ''}.`, baseURL));
      } else if (optante) {
        erros.push(erroGlobal(codigo, nome, `O ${nome} é obrigatório com opSimpNac=${opSimpNac} (${regraObrigatorio}).`, baseURL));
      }
    };
    campo(op.regApIBSCBSSN, 'regApIBSCBSSN', 'REGAPIBSCBSSN_INVALIDO', 'regra 313 da NFS-e');
    campo(op.regApTribSN, 'regApTribSN', 'REGAPTRIBSN_INVALIDO', 'regra E0166 da NFS-e, estendida pela NT 009');
  }
  function validarRegimeCrt(op, erros, baseURL) {
    const crt = inteiro(op.CRT);
    if (crt == null || crt < 1 || crt > 4) {
      erros.push(erroGlobal('CRT_INVALIDO', 'CRT', `O Código de Regime Tributário (CRT) é obrigatório e deve ser 1, 2, 3 ou 4, recebido: '${op.CRT ?? null}'.`, baseURL));
      return;
    }
    if (!informado(op.tpRegimeIBSCBS)) return;
    const tp = inteiro(op.tpRegimeIBSCBS);
    if (tp == null || (tp !== 1 && tp !== 2)) {
      erros.push(erroGlobal('TPREGIMEIBSCBS_INVALIDO', 'tpRegimeIBSCBS', `Tipo de regime de apuração do IBS/CBS inválido, recebido: '${op.tpRegimeIBSCBS}' (esperado 1 ou 2).`, baseURL));
      return;
    }
    if (crt === 4) erros.push(erroGlobal('TPREGIMEIBSCBS_INCOMPATIVEL', 'tpRegimeIBSCBS', tp === 2 ? 'CRT=4 (MEI) não admite tpRegimeIBSCBS algum (regras C21a-10 e C21a-30 da NT 2026.005).' : 'CRT=4 (MEI) não admite tpRegimeIBSCBS algum (regra C21a-30 da NT 2026.005).', baseURL));
    else if ((crt === 1 || crt === 2) && tp === 2) erros.push(erroGlobal('TPREGIMEIBSCBS_INCOMPATIVEL', 'tpRegimeIBSCBS', `CRT=${crt} não admite tpRegimeIBSCBS=2 (regra C21a-10 da NT 2026.005).`, baseURL));
    else if (crt === 3 && tp === 1) erros.push(erroGlobal('TPREGIMEIBSCBS_INCOMPATIVEL', 'tpRegimeIBSCBS', 'CRT=3 não admite tpRegimeIBSCBS=1 (regra C21a-20 da NT 2026.005).', baseURL));
  }
  const proibido = (valor, campo, documento, erros, baseURL) => {
    if (informado(valor)) erros.push(erroGlobal('CAMPO_REGIME_PROIBIDO', campo, `O campo ${campo} não pertence ao vocabulário de regime do ${documento}, recebido: '${valor}'.`, baseURL));
  };

  /**
   * POST /calculadora/observabilidade/simples-nacional/nao-assistido
   * @returns {{status: number, body: object}} 200 with the ObservabilidadeSimplesDomain, or 422 with ProblemDetail
   */
  function naoAssistido(input, { baseURL = 'http://localhost', instance = '/api/calculadora/observabilidade/simples-nacional/nao-assistido' } = {}) {
    try {
      return { status: 200, body: processar(input ?? {}, baseURL) };
    } catch (ex) {
      return respostaDeErro(ex, instance, baseURL);
    }
  }

  function processar(op, baseURL) {
    op = { ...op, data: str(op.data), tpDoc: str(op.tpDoc), CRT: str(op.CRT), tpRegimeIBSCBS: str(op.tpRegimeIBSCBS), opSimpNac: str(op.opSimpNac), regApIBSCBSSN: str(op.regApIBSCBSSN), regApTribSN: str(op.regApTribSN), tpEnteGov: str(op.tpEnteGov) };
    const erros = [];
    // validarCamposGlobais
    if (isBlank(op.id)) erros.push(erroGlobal('DADO_GLOBAL_AUSENTE', 'id', 'O identificador da operação (id) é obrigatório.', baseURL));
    if (isBlank(op.versao)) erros.push(erroGlobal('DADO_GLOBAL_AUSENTE', 'versao', 'A versão do payload (versao) é obrigatória.', baseURL));
    let data = null;
    if (isBlank(op.data)) erros.push(erroGlobal('DATA_INVALIDA', 'data', 'A data do fato gerador é obrigatória.', baseURL));
    else {
      data = parseLocalDate(javaTrim(op.data));
      if (data == null) erros.push(erroGlobal('DATA_INVALIDA', 'data', `Data inválida, recebido: '${op.data}' (esperado YYYY-MM-DD).`, baseURL));
    }
    if (informado(op.tpEnteGov)) {
      const t = inteiro(op.tpEnteGov);
      if (t == null || t < 1 || t > 4) erros.push(erroGlobal('TPENTEGOV_INVALIDO', 'tpEnteGov', `Tipo de ente governamental inválido, recebido: '${op.tpEnteGov}' (esperado 1, 2, 3 ou 4).`, baseURL));
    }
    const itensIn = Array.isArray(op.itens) ? op.itens : null;
    if (itensIn == null || itensIn.length === 0) erros.push(erroGlobal('ITENS_VAZIOS', 'itens', 'A lista de itens é obrigatória e não pode estar vazia.', baseURL));

    // validarDocumento
    let documento = null;
    if (isBlank(op.tpDoc)) {
      erros.push(erroGlobal('TPDOC_AUSENTE', 'tpDoc', 'O tipo de documento fiscal (tpDoc) é obrigatório e não foi informado.', baseURL));
    } else {
      const tpDoc = inteiro(op.tpDoc);
      if (tpDoc != null && data != null && db.contarSemTratamentoCalculadoraVigentes(tpDoc, data) > 0) {
        erros.push(erroGlobal('TPDOC_NAO_SUPORTADO', 'tpDoc', `Tipo de documento fiscal (tpDoc) de código ${tpDoc} ainda não possui tratamento implementado no cálculo do Simples Nacional.`, baseURL));
      } else if (tpDoc == null || data == null) {
        if (tpDoc == null) erros.push(erroGlobal('TPDOC_NAO_SUPORTADO', 'tpDoc', `Tipo de documento não suportado pelo cálculo do Simples Nacional, recebido: '${op.tpDoc}'.`, baseURL));
      } else {
        documento = db.buscarTipoDfeCalculo(tpDoc, data);
        if (!documento) erros.push(erroGlobal('TPDOC_NAO_SUPORTADO', 'tpDoc', `Tipo de documento não suportado pelo cálculo do Simples Nacional, recebido: '${op.tpDoc}'.`, baseURL));
      }
    }
    if (documento) {
      if (documento.vocabulario === 'NFSE') {
        proibido(op.CRT, 'CRT', 'NFS-e', erros, baseURL);
        proibido(op.tpRegimeIBSCBS, 'tpRegimeIBSCBS', 'NFS-e', erros, baseURL);
        validarRegimeNfse(op, erros, baseURL);
      } else {
        proibido(op.opSimpNac, 'opSimpNac', 'documento com CRT', erros, baseURL);
        proibido(op.regApIBSCBSSN, 'regApIBSCBSSN', 'documento com CRT', erros, baseURL);
        proibido(op.regApTribSN, 'regApTribSN', 'documento com CRT', erros, baseURL);
        validarRegimeCrt(op, erros, baseURL);
      }
      const maximo = documento.maximoItens;
      if (maximo != null && itensIn != null && itensIn.length > maximo) {
        erros.push(erroGlobal('QUANTIDADE_ITENS_INVALIDA', 'itens', `O documento ${javaTrim(op.tpDoc)} admite ${maximo === 1 ? 'exatamente 1 item' : 'no máximo ' + maximo + ' itens'}, recebidos ${itensIn.length}.`, baseURL));
      }
    }
    if (erros.length) throw new ErrosCalculo(erros);

    const vocabulario = documento.vocabulario;
    const siglaDfe = db.buscarSiglaVigentePorId(documento.tipoDfeId, data);
    const permiteNcmZero = db.permiteNcmZeroVigentePorId(documento.tipoDfeId, data);
    const inf = { crt: inteiro(op.CRT), tpRegimeIBSCBS: inteiro(op.tpRegimeIBSCBS), opSimpNac: inteiro(op.opSimpNac), regApIBSCBSSN: inteiro(op.regApIBSCBSSN), regApTribSN: inteiro(op.regApTribSN) };

    const r = db.buscarRegimeApuracao(vocabulario, inf.crt, inf.tpRegimeIBSCBS, inf.opSimpNac, inf.regApIBSCBSSN, data);
    if (!r) throw new ErrosCalculo([erroForaDoEscopo(vocabulario, inf, data, baseURL)]);
    const regime = {
      codigo: r.codigo, calculaTributos: Number(r.calculaTributos) === 1,
      geraIbs: r.geraIbs == null ? null : Number(r.geraIbs) === 1,
      destinoDevido: r.destinoDevido, destinoPendenteSuspenso: r.destinoPendenteSuspenso,
    };
    const calculaTributos = regime.calculaTributos;

    const tpEnteGov = inteiro(op.tpEnteGov);
    let fator = null;
    if (tpEnteGov != null && tpEnteGov !== 1) {
      const f = db.buscarFatorTransicaoCompraGov(data);
      if (f == null) throw new ErrosCalculo([erroGlobal('COMPRA_GOV_SEM_VIGENCIA', 'tpEnteGov', `Não há parametrização de transição de compra governamental vigente para a data '${data}'.`, baseURL)]);
      fator = Dec.of(f);
    }
    const linha = calculaTributos ? obterLinha(op.aliquotasEfetivas ?? null, baseURL) : null;
    const situacoes = calculaTributos ? db.buscarSituacoesIss(data) : [];
    const avisos = [];
    if (linha != null && (regime.geraIbs === true) === linha.impedimentoSublimite) {
      avisos.push(`Regime de apuração ${regime.codigo} (${descreverRegime(vocabulario, inf)}) diverge do indicador de impedimento por sublimite da linha de alíquotas (${linha.impedimentoSublimite})`);
    }
    if (inf.regApIBSCBSSN === 2 && inf.regApTribSN === 1) {
      avisos.push('regApIBSCBSSN 2 (excesso de sublimite) com regApTribSN 1: incoerente — quem excede o sublimite tem o ISS fora do Simples Nacional');
    }
    const ctx = contextoUnificado(data, Number.parseInt(javaTrim(op.tpDoc), 10), regime, tpEnteGov, fator, documento, siglaDfe, permiteNcmZero);
    const fatos = new Map();
    if (inf.crt != null) fatos.set('CRT', inf.crt);
    if (inf.regApIBSCBSSN != null) fatos.set('regApIBSCBSSN', inf.regApIBSCBSSN);
    if (inf.regApTribSN != null) fatos.set('regApTribSN', inf.regApTribSN);

    const processados = itensIn.map((raw, i) => {
      const item = raw ?? {};
      const entrada = { numero: jInteger(item.numero, 'numero'), cAtivSN: str(item.cAtivSN), cClassTrib: str(item.cClassTrib), baseCalculo: str(item.baseCalculo), valorImpostoSeletivo: str(item.valorImpostoSeletivo), NCM: str(item.ncm ?? item.NCM), NBS: str(item.nbs ?? item.NBS), tribISSQN: str(item.tribISSQN), tpRetISSQN: str(item.tpRetISSQN), tpBM: str(item.tpBM) };
      return processarItem(entrada, i, ctx, calculaTributos ? resolvedor(entrada, vocabulario, linha, fatos, situacoes) : SEM_ALIQUOTAS, baseURL);
    });
    const objetos = processados.map((p) => p.objeto).map((o, i) => ({ o, i }))
      .sort((a, b) => (a.o.nObj == null ? (b.o.nObj == null ? a.i - b.i : -1) : b.o.nObj == null ? 1 : a.o.nObj - b.o.nObj || a.i - b.i))
      .map((x) => x.o);
    const resolucaoAliquotas = calculaTributos ? { fatorR: linha.fatorR, indSublimite: linha.impedimentoSublimite, itens: processados.map((p) => p.resolucao), avisos } : null;
    return serializar({
      oper: { data: op.data, tpDoc: op.tpDoc, CRT: op.CRT, tpRegimeIBSCBS: op.tpRegimeIBSCBS, opSimpNac: op.opSimpNac, regApIBSCBSSN: op.regApIBSCBSSN, regApTribSN: op.regApTribSN, tpEnteGov: op.tpEnteGov, regimeApuracao: regime.codigo },
      resolucaoAliquotas, objetos, total: totalizarObjetos(objetos),
    });
  }

  function descreverRegime(vocabulario, inf) {
    if (vocabulario === 'NFSE') return `opSimpNac=${inf.opSimpNac}, regApIBSCBSSN=${inf.regApIBSCBSSN}`;
    return inf.tpRegimeIBSCBS == null ? `CRT=${inf.crt}` : `CRT=${inf.crt}, tpRegimeIBSCBS=${inf.tpRegimeIBSCBS}`;
  }
  function erroForaDoEscopo(vocabulario, inf, data, baseURL) {
    let m, campo;
    if (vocabulario === 'NFSE') {
      campo = 'opSimpNac';
      m = inf.opSimpNac === 1 ? 'prestador não optante pelo Simples Nacional (opSimpNac=1)'
        : inf.opSimpNac === 2 ? 'MEI (opSimpNac=2) está fora do cálculo do IBS e da CBS pelo Simples Nacional'
          : `não há enquadramento vigente na data '${data}' para opSimpNac=${inf.opSimpNac} e regApIBSCBSSN=${inf.regApIBSCBSSN}`;
    } else {
      campo = 'CRT';
      if (inf.crt === 4) m = 'MEI (CRT=4) está fora do Evento de Tributação do Simples Nacional';
      else if (inf.crt === 3 && inf.tpRegimeIBSCBS == null) m = 'CRT=3 sem tpRegimeIBSCBS=2 (regime normal puro) não é Simples Nacional';
      else m = `não há enquadramento vigente na data '${data}' para ${descreverRegime(vocabulario, inf)}`;
    }
    return erroGlobal('OPERACAO_FORA_ESCOPO', campo, `Operação fora do escopo do cálculo do Simples Nacional: ${m}.`, baseURL);
  }

  // ── SimplesNacionalObservabilidadeService (endpoint clássico: alíquotas por item) ──
  function validarAliquota(valor, exigida, collector, campo, codigoAusente, codigoInvalido) {
    if (isBlank(valor)) {
      if (exigida) collector.addErroValidacao(codigoAusente, campo, 'A alíquota é exigida para o cálculo do item e não foi informada.');
      return null;
    }
    return converterNoFormato(valor, FORMATO_ALIQUOTA, DESCRICAO_FORMATO_ALIQUOTA, collector, campo, codigoInvalido);
  }
  function classicoProcessar(op, baseURL) {
    op = { ...op, data: str(op.data), tpDoc: str(op.tpDoc), CRT: str(op.CRT), tpRegimeIBSCBS: str(op.tpRegimeIBSCBS), tpEnteGov: str(op.tpEnteGov) };
    const erros = [];
    if (isBlank(op.id)) erros.push(erroGlobal('DADO_GLOBAL_AUSENTE', 'id', 'O identificador da operação (id) é obrigatório.', baseURL));
    if (isBlank(op.versao)) erros.push(erroGlobal('DADO_GLOBAL_AUSENTE', 'versao', 'A versão do payload (versao) é obrigatória.', baseURL));
    let data = null;
    if (isBlank(op.data)) erros.push(erroGlobal('DATA_INVALIDA', 'data', 'A data do fato gerador é obrigatória.', baseURL));
    else {
      data = parseLocalDate(javaTrim(op.data));
      if (data == null) erros.push(erroGlobal('DATA_INVALIDA', 'data', `Data inválida, recebido: '${op.data}' (esperado YYYY-MM-DD).`, baseURL));
    }
    // validarEscopo
    if (isBlank(op.tpDoc)) erros.push(erroGlobal('TPDOC_AUSENTE', 'tpDoc', 'O tipo de documento fiscal (tpDoc) é obrigatório e não foi informado.', baseURL));
    else {
      const tpDoc = inteiro(op.tpDoc);
      if (tpDoc == null) erros.push(erroGlobal('TPDOC_NAO_SUPORTADO', 'tpDoc', `Tipo de documento não suportado pelo cálculo do Simples Nacional, recebido: '${op.tpDoc}'.`, baseURL));
      else if (data != null && db.contarSemTratamentoCalculadoraVigentes(tpDoc, data) > 0) erros.push(erroGlobal('TPDOC_NAO_SUPORTADO', 'tpDoc', `Tipo de documento fiscal (tpDoc) de código ${tpDoc} ainda não possui tratamento implementado no cálculo do Simples Nacional.`, baseURL));
      else if (data != null && db.contarVinculosVigentesTipoDfeCalculo(tpDoc, data) === 0) erros.push(erroGlobal('TPDOC_NAO_SUPORTADO', 'tpDoc', `Tipo de documento não suportado pelo cálculo do Simples Nacional, recebido: '${op.tpDoc}'.`, baseURL));
    }
    const crt = inteiro(op.CRT);
    if (crt == null || crt < 1 || crt > 4) {
      erros.push(erroGlobal('CRT_INVALIDO', 'CRT', `O Código de Regime Tributário (CRT) é obrigatório e deve ser 1, 2, 3 ou 4, recebido: '${op.CRT ?? null}'.`, baseURL));
    } else {
      const tpInf = informado(op.tpRegimeIBSCBS);
      let tp = null, abort = false;
      if (tpInf) {
        tp = inteiro(op.tpRegimeIBSCBS);
        if (tp == null || (tp !== 1 && tp !== 2)) {
          erros.push(erroGlobal('TPREGIMEIBSCBS_INVALIDO', 'tpRegimeIBSCBS', `Tipo de regime de apuração do IBS/CBS inválido, recebido: '${op.tpRegimeIBSCBS}' (esperado 1 ou 2).`, baseURL));
          abort = true;
        }
      }
      if (!abort) {
        if (crt === 4 && tpInf) erros.push(erroGlobal('TPREGIMEIBSCBS_INCOMPATIVEL', 'tpRegimeIBSCBS', 'CRT=4 (MEI) não admite tpRegimeIBSCBS algum (regra C21a-30 da NT 2026.005).', baseURL));
        else if ((crt === 1 || crt === 2) && tp === 2) erros.push(erroGlobal('TPREGIMEIBSCBS_INCOMPATIVEL', 'tpRegimeIBSCBS', `CRT=${crt} não admite tpRegimeIBSCBS=2 (regra C21a-10 da NT 2026.005).`, baseURL));
        else if (crt === 3 && tp === 1) erros.push(erroGlobal('TPREGIMEIBSCBS_INCOMPATIVEL', 'tpRegimeIBSCBS', 'CRT=3 não admite tpRegimeIBSCBS=1 (regra C21a-20 da NT 2026.005).', baseURL));
        if (crt === 4) erros.push(erroGlobal('OPERACAO_FORA_ESCOPO', 'CRT', 'Operação fora do escopo do cálculo do Simples Nacional: MEI (CRT=4) está fora do Evento de Tributação do Simples Nacional.', baseURL));
        if (tp === 1) erros.push(erroGlobal('OPERACAO_FORA_ESCOPO', 'tpRegimeIBSCBS', 'Operação fora do escopo do cálculo do Simples Nacional: optante pelo regime regular do IBS/CBS (tpRegimeIBSCBS=1) tem a tributação calculada pelo regime regular, não por este endpoint.', baseURL));
        if (crt === 3 && !tpInf) erros.push(erroGlobal('OPERACAO_FORA_ESCOPO', 'CRT', 'Operação fora do escopo do cálculo do Simples Nacional: CRT=3 sem tpRegimeIBSCBS=2 (regime normal puro) não é Simples Nacional.', baseURL));
      }
    }
    if (informado(op.tpEnteGov)) {
      const v = inteiro(op.tpEnteGov);
      if (v == null || v < 1 || v > 4) erros.push(erroGlobal('TPENTEGOV_INVALIDO', 'tpEnteGov', `Tipo de ente governamental inválido, recebido: '${op.tpEnteGov}' (esperado 1, 2, 3 ou 4).`, baseURL));
    }
    const itensIn = Array.isArray(op.itens) ? op.itens : null;
    if (itensIn == null || itensIn.length === 0) erros.push(erroGlobal('ITENS_VAZIOS', 'itens', 'A lista de itens é obrigatória e não pode estar vazia.', baseURL));
    if (erros.length) throw new ErrosCalculo(erros);

    const crtN = Number.parseInt(javaTrim(op.CRT), 10);
    const r = crtN === 1 ? db.buscarRegimeApuracao('CRT', 1, null, null, null, data)
      : crtN === 2 ? db.buscarRegimeApuracao('CRT', 2, null, null, null, data)
        : db.buscarRegimeApuracao('CRT', 3, 2, null, null, data);
    if (!r) throw new ErrosCalculo([erroGlobal('PARAMETRIZACAO_INDISPONIVEL', 'CRT', `Não há parametrização de regime de apuração do Simples Nacional vigente para CRT=${op.CRT} e tpRegimeIBSCBS=${op.tpRegimeIBSCBS ?? null} na data '${data}'.`, baseURL)]);
    const regime = { codigo: r.codigo, calculaTributos: Number(r.calculaTributos) === 1, geraIbs: r.geraIbs == null ? null : Number(r.geraIbs) === 1, destinoDevido: r.destinoDevido, destinoPendenteSuspenso: r.destinoPendenteSuspenso };
    const tpEnteGov = inteiro(op.tpEnteGov);
    let fator = null;
    if (tpEnteGov != null && tpEnteGov !== 1) {
      const f = db.buscarFatorTransicaoCompraGov(data);
      if (f == null) throw new ErrosCalculo([erroGlobal('COMPRA_GOV_SEM_VIGENCIA', 'tpEnteGov', `Não há parametrização de transição de compra governamental vigente para a data '${data}'.`, baseURL)]);
      fator = Dec.of(f);
    }
    const tpDoc = Number.parseInt(javaTrim(op.tpDoc), 10);
    const documento = db.buscarTipoDfeCalculo(tpDoc, data);
    const siglaDfe = documento ? db.buscarSiglaVigentePorId(documento.tipoDfeId, data) : null;
    const permiteNcmZero = documento ? db.permiteNcmZeroVigentePorId(documento.tipoDfeId, data) : false;
    const ctx = contextoClassico(data, tpDoc, regime, tpEnteGov, fator, siglaDfe, permiteNcmZero);
    const objetos = itensIn.map((raw, i) => {
      // the classic service has no itemSeguro: a null item is a NullPointerException (HTTP 500) in Java
      if (raw == null) throw new Error('Cannot invoke "br.gov.serpro.rtc.api.simplesnacional.model.input.ItemSimplesInput.numero()" because "item" is null');
      const item = raw;
      const entrada = { numero: jInteger(item.numero, 'numero'), cAtivSN: str(item.cAtivSN), cClassTrib: str(item.cClassTrib), baseCalculo: str(item.baseCalculo), valorImpostoSeletivo: str(item.valorImpostoSeletivo), NCM: str(item.ncm ?? item.NCM), NBS: str(item.nbs ?? item.NBS) };
      const resolver = {
        resolver: (dados, collector) => {
          const pCbs = validarAliquota(str(item.pCBSSN), dados.cbsExigida, collector, 'pCBSSN', 'ALIQUOTA_CBS_AUSENTE', 'ALIQUOTA_CBS_INVALIDA');
          const pIbs = validarAliquota(str(item.pIBSSN), dados.ibsExigida, collector, 'pIBSSN', 'ALIQUOTA_IBS_AUSENTE', 'ALIQUOTA_IBS_INVALIDA');
          return { pIBSSN: pIbs, pCBSSN: pCbs, naoCalcular: false, resolucao: null };
        },
        naoAvaliado: () => null,
      };
      return processarItem(entrada, i, ctx, resolver, baseURL).objeto;
    }).map((o, i) => ({ o, i }))
      .sort((a, b) => (a.o.nObj == null ? (b.o.nObj == null ? a.i - b.i : -1) : b.o.nObj == null ? 1 : a.o.nObj - b.o.nObj || a.i - b.i))
      .map((x) => x.o);
    return serializar({ oper: { data: op.data, tpDoc: op.tpDoc, CRT: op.CRT, tpRegimeIBSCBS: op.tpRegimeIBSCBS, tpEnteGov: op.tpEnteGov }, resolucaoAliquotas: null, objetos, total: totalizarObjetos(objetos) });
  }
  function classico(input, { baseURL = 'http://localhost', instance = '/api/calculadora/observabilidade/simples-nacional' } = {}) {
    try {
      return { status: 200, body: classicoProcessar(input ?? {}, baseURL) };
    } catch (ex) {
      return respostaDeErro(ex, instance, baseURL);
    }
  }

  return {
    naoAssistido, classico, listarAtividades: (data) => db.listarAtividades(data), db,
    _internals: { calcularItem, escolher, avaliarCamposIss, processarItem, resolvedor, Collector, normalizarCAtivSN, nomenclatura, obterLinha },
  };
}

/**
 * ApiExceptionHandler: 422 ProblemDetail for calculation errors (ErrosCalculoException), 400 for an
 * unreadable request (HttpMessageNotReadableException → ProblemType MENSAGEM_INCOMPREENSIVEL) and
 * 500 otherwise (ProblemType ERRO_SISTEMA: {baseURL}/errors/erro-de-sistema-nao-previsto).
 */
function respostaDeErro(ex, instance, baseURL) {
  const timestamp = new Date().toISOString();
  if (ex instanceof ErrosCalculo) {
    return { status: 422, body: { type: 'about:blank', title: 'Erros no processamento do cálculo do Simples Nacional', status: 422, detail: `O cálculo contém ${ex.erros.length} erro(s).`, instance, timestamp, errors: ex.erros } };
  }
  if (ex instanceof RequisicaoInvalida) return { status: 400, body: { type: `${baseURL}/errors/mensagem-incompreensivel`, title: 'Mensagem incompreensível', status: 400, detail: ex.message, instance, timestamp } };
  const detail = ex?.message ? { detail: ex.message } : {};
  return { status: 500, body: { type: `${baseURL}/errors/erro-de-sistema-nao-previsto`, title: 'Erro de sistema não previsto', status: 500, ...detail, instance, timestamp } };
}

// ── TotalSimplesDomain.totalizar ─────────────────────────────────────────────
function totalizarObjetos(objetos) {
  const com = objetos.filter((o) => o.tribCalc != null);
  if (!com.length) return null;
  const somar = (f) => { const v = com.map((o) => f(o.tribCalc)).filter((x) => x != null); return v.length ? totalizar(v) : null; };
  const vIBSSNtot = somar((t) => t.vIBSSN), vCBSSNtot = somar((t) => t.vCBSSN), totalIs = somar((t) => t.IS?.valor ?? null);
  const totalTributos = vIBSSNtot != null || vCBSSNtot != null || totalIs != null ? totalizar([vIBSSNtot, vCBSSNtot, totalIs]) : null;
  return { vRBSNtot: somar((t) => t.vRBSNitem), vBC: somar((t) => t.vBC), vIBSSNtot, vIBSSNtotPendSusp: somar((t) => t.vIBSPendSusp), vCBSSNtot, vCBSSNtotPendSusp: somar((t) => t.vCBSPendSusp), totalIs, totalTributos };
}

// ── Jackson serialization (NON_NULL / ALWAYS, TDec1302, TDec0302_04, texto integral) ──
const money = (v) => (v == null ? undefined : formatarMoeda(v));
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
function serializar({ oper, resolucaoAliquotas, objetos, total }) {
  const trib = (t) => t && prune({
    vRBSNitem: money(t.vRBSNitem), tpRBSN: t.tpRBSN, tpRBSNDescricao: t.tpRBSNDescricao, vBC: money(t.vBC),
    pIBSSN: t.pIBSSN == null ? undefined : formatarAliquota(t.pIBSSN), vIBSSN: money(t.vIBSSN), vIBSPendSusp: money(t.vIBSPendSusp),
    pCBSSN: t.pCBSSN == null ? undefined : formatarAliquota(t.pCBSSN), vCBSSN: money(t.vCBSSN), vCBSPendSusp: money(t.vCBSPendSusp),
    IS: t.IS ? prune({ valor: money(t.IS.valor) }) : undefined, totalItem: money(t.totalItem),
    memoriaCalculo: t.memoriaCalculo ? prune({ cbs: t.memoriaCalculo.cbs, ibs: t.memoriaCalculo.ibs }) : undefined,
  });
  const res = (r) => (r == null ? null : { numero: r.numero, cAtivSN: r.cAtivSN, anexoAplicado: r.anexoAplicado, tipoAliquota: r.tipoAliquota, regraAliquota: r.regraAliquota, pIBSSN: r.pIBSSN == null ? null : r.pIBSSN.toString(), pCBSSN: r.pCBSSN == null ? null : r.pCBSSN.toString(), motivo: r.motivo, avisos: r.avisos });
  return prune({
    oper: prune(oper),
    resolucaoAliquotas: resolucaoAliquotas && { fatorR: resolucaoAliquotas.fatorR, indSublimite: resolucaoAliquotas.indSublimite, itens: resolucaoAliquotas.itens.map(res), avisos: resolucaoAliquotas.avisos },
    objetos: objetos.map((o) => prune({ nObj: o.nObj, estadoItem: o.estadoItem, motivoEstado: o.motivoEstado ?? undefined, tribCalc: trib(o.tribCalc), erros: o.erros?.map(prune) })),
    total: total && prune(Object.fromEntries(Object.entries(total).map(([k, v]) => [k, money(v)]))),
  });
}

export { createEngine };
