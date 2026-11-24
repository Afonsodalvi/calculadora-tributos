// Port of domain/service/pedagio/PedagioService (E12 POST /calculadora/pedagio) with the pieces it
// depends on: MunicipioService.validarMunicipio, UfService.buscar, AliquotaPadraoService +
// AliquotaResultadoDTO, TributoEnum, the outputs (PedagioOutput, TrechoPedagioOutput,
// TributoPedagioOutput, TotalPedagioOutput, TributoTotalPedagioOutput) and the
// BigDecimalTDec1302Serializer of the totals.
//
// Numeric policy (ADR003): the exact share of each section is base × rate × length ÷ total length
// (MathContext(34, HALF_EVEN) division), apportioned by ArredondamentoUtils.ratearValorFiscal.
import { Dec, ArithmeticException } from '../../core/decimal.js';
import { ErroJava, ErroSerializacao } from '../comum/problema.js';
import {
  arredondarAliquotaPublicada, dividir, formatarMoeda, fracaoParaPercentual, multiplicar, percentualParaFracao, ratearValorFiscal,
} from '../comum/arredondamento.js';
import * as SQL from './consultas.js';
import { dataJdbc } from './nfse.js';

/** TributoEnum (código = id of the TRIBUTO table). */
export const TributoEnum = Object.freeze({
  IS: { nome: 'IS', codigo: 1, descricao: 'Imposto Seletivo' },
  CBS: { nome: 'CBS', codigo: 2, descricao: 'CBS' },
  IBS_ESTADUAL: { nome: 'IBS_ESTADUAL', codigo: 3, descricao: 'IBS Estadual' },
  IBS_MUNICIPAL: { nome: 'IBS_MUNICIPAL', codigo: 4, descricao: 'IBS Municipal' },
});

/** TipoWarningDadosSimulados.CASO_GERAL.getValor(). */
const CASO_GERAL = 1;

/**
 * AliquotaResultadoDTO compact constructor (record): validates and applies the form of the
 * default rate. Its exceptions would surface wrapped by Hibernate (unreachable: ALIQUOTA_PADRAO
 * is empty in the official database).
 */
export function aliquotaResultado(valorReferencia, valorPadrao, formaAplicacao) {
  if (valorReferencia == null) throw new ErroJava('AliquotaReferenciaNaoEncontradaException', null);
  if (valorReferencia.compareTo(Dec.ZERO) < 0) throw new ErroJava('AliquotaNegativaException', 'referencia');
  if (valorPadrao != null) {
    if (valorPadrao.compareTo(Dec.ZERO) < 0) throw new ErroJava('AliquotaNegativaException', 'padrao');
    if (formaAplicacao == null) throw new ErroJava('FormaAplicacaoNaoDefinidaException', null);
    if (formaAplicacao === 'ACRESCIMO') valorPadrao = valorReferencia.add(valorPadrao);
    else if (formaAplicacao === 'DECRESCIMO') valorPadrao = valorReferencia.sub(valorPadrao);
    else if (formaAplicacao !== 'SUBSTITUICAO') throw new ErroJava('FormaAplicacaoNaoTratadaException', null);
    if (valorPadrao.compareTo(Dec.ZERO) < 0) throw new ErroJava('AliquotaNegativaException', 'aplicavel');
  } else if (formaAplicacao != null) {
    throw new ErroJava('AliquotaPadraoNaoEncontradaException', null);
  }
  return { valorReferencia, valorPadrao, formaAplicacao, valorAplicavel: () => (valorPadrao != null ? valorPadrao : valorReferencia) };
}

/** String.format("%s") of a long/Long. */
const s = (v) => (v == null ? 'null' : String(v));

/** Repositories/services over the official database. */
export function criarDependenciasPedagio(base) {
  return {
    /** MunicipioService.validarMunicipio: 1 → 404, 2 → 422, 0 → ok. */
    validarMunicipio(codigoMunicipio, siglaUf) {
      const r = base.count(SQL.VALIDAR_MUNICIPIO, { codigoMunicipio, siglaUf });
      if (r === 1) throw new ErroJava('MunicipioNaoEncontradoException', `Município de código ${codigoMunicipio} não encontrado`);
      if (r === 2) throw new ErroJava('MunicipioNaoPertencenteException', `Município de código ${codigoMunicipio} não pertence à UF de sigla ${siglaUf}`);
    },
    /** UfService.buscar. */
    buscarUf(sigla) {
      const r = base.get(SQL.CONSULTAR_UF_POR_SIGLA, { sigla });
      if (r == null) throw new ErroJava('UfNaoEncontradaException', `UF de sigla ${sigla} não encontrada`);
      return Number(r.UF_CD);
    },
    /** AliquotaPadraoService.buscarAliquota(idTributo, codigoUf, municipio, data). */
    buscarAliquota(idTributo, codigoUf, municipio, data) {
      const linhas = base.all(SQL.BUSCAR_ALIQUOTA, { idTributo, codigoUf, municipio, data: dataJdbc(data) });
      if (linhas.length > 1) {
        throw new ErroJava('IncorrectResultSizeDataAccessException', `Query did not return a unique result: ${linhas.length} results were returned`);
      }
      if (!linhas.length) {
        throw new ErroJava('AliquotaNaoEncontradaException', `Alíquota de referencia ou padrão não encontrada para o tributo com id ${s(idTributo)}, UF ${s(codigoUf)}, município ${s(municipio)} e data ${data}`);
      }
      const l = linhas[0];
      const dec = (x) => (x == null ? null : Dec.parse(String(x)));
      return aliquotaResultado(dec(l.valorReferencia), dec(l.valorPadrao), l.formaAplicacao ?? null);
    },
  };
}

/** PedagioService.buscarAliquotaPadrao: percentualParaFracao(valorAplicavel). */
export function buscarAliquotaPadrao(deps, tributo, data, codigoUf, codigoMunicipio) {
  const aliquota = deps.buscarAliquota(tributo.codigo, codigoUf, codigoMunicipio, data);
  return percentualParaFracao(aliquota.valorAplicavel());
}

/** PedagioInput.getExtensaoTotal(): sum of the non-null lengths from ZERO. */
export function extensaoTotal(entrada) {
  let total = Dec.ZERO;
  for (const t of entrada.trechos ?? []) if (t !== null && t.extensao != null) total = total.add(t.extensao);
  return total;
}

function validarNumerosUnicos(entrada) {
  const vistos = new Set();
  for (const trecho of entrada.trechos) {
    if (trecho === null) {
      throw new ErroJava('NullPointerException', 'Cannot invoke "br.gov.serpro.rtc.api.model.input.pedagio.TrechoPedagioInput.getNumero()" because "trecho" is null');
    }
    if (vistos.has(trecho.numero)) throw new ErroJava('CampoInvalidoException', `Número de trecho duplicado: ${trecho.numero}`);
    vistos.add(trecho.numero);
  }
}

/** ratearTributo: exact shares → apportioned cents; effective rate with 4 decimals. */
function ratearTributo(trechos, aliquotas, baseCalculo, extTotal) {
  const exatas = trechos.map((t, i) => dividir(multiplicar(multiplicar(baseCalculo, aliquotas[i]), t.extensao), extTotal));
  const parcelas = ratearValorFiscal(exatas);
  return trechos.map((t, i) => ({
    aliquota: fracaoParaPercentual(aliquotas[i]),
    aliquotaEfetiva: arredondarAliquotaPublicada(fracaoParaPercentual(dividir(multiplicar(aliquotas[i], t.extensao), extTotal))),
    tributoCalculado: parcelas[i],
  }));
}

/** TributoTotalPedagioOutput.totaliza{Cbs|IbsEstadual|IbsMunicipal}(trechos, totalBC). */
export function totalizar(trechos, totalBaseCalculo, tributo) {
  let total = Dec.ZERO;
  for (const t of trechos) total = total.add(t[tributo].tributoCalculado);
  return { baseCalculo: totalBaseCalculo, valorApurado: total, valorDevido: total, valorTributo: total, valorMontanteDesonerado: null };
}
export const totalizaCbs = (trechos, totalBC) => totalizar(trechos, totalBC, 'cbs');
export const totalizaIbsEstadual = (trechos, totalBC) => totalizar(trechos, totalBC, 'ibsEstadual');
export const totalizaIbsMunicipal = (trechos, totalBC) => totalizar(trechos, totalBC, 'ibsMunicipal');

/** TotalPedagioOutput.getTotal: base of the first section. */
export function getTotal(trechos) {
  const totalBaseCalculo = trechos[0].baseCalculo;
  return {
    cbsTotal: totalizaCbs(trechos, totalBaseCalculo),
    ibsEstadualTotal: totalizaIbsEstadual(trechos, totalBaseCalculo),
    ibsMunicipalTotal: totalizaIbsMunicipal(trechos, totalBaseCalculo),
  };
}

/** PedagioService.calcularCIBS → PedagioOutput (Java field names, Dec values). */
export function calcularPedagio(deps, entrada) {
  validarNumerosUnicos(entrada);
  deps.validarMunicipio(entrada.codigoMunicipioOrigem, entrada.ufMunicipioOrigem);
  for (const t of entrada.trechos) deps.validarMunicipio(t.municipio, t.uf);

  const extTotal = extensaoTotal(entrada);
  const baseCalculo = entrada.baseCalculo;
  const data = entrada.dataHoraEmissao.slice(0, 10); // OffsetDateTime.toLocalDate(): date in the given offset
  // sort by number (Comparator.comparing, stable)
  const trechos = [...entrada.trechos].sort((a, b) => a.numero - b.numero);
  const aliquotasCbs = [];
  const aliquotasIbsEstadual = [];
  const aliquotasIbsMunicipal = [];
  for (const t of trechos) {
    const codigoUf = deps.buscarUf(t.uf);
    const cbs = buscarAliquotaPadrao(deps, TributoEnum.CBS, data, null, null);
    const ibsE = buscarAliquotaPadrao(deps, TributoEnum.IBS_ESTADUAL, data, codigoUf, null);
    const ibsM = buscarAliquotaPadrao(deps, TributoEnum.IBS_MUNICIPAL, data, null, t.municipio);
    if (cbs == null || ibsE == null || ibsM == null) throw new ErroJava('CampoInvalidoException', 'Erro ao obter alíquotas');
    aliquotasCbs.push(cbs);
    aliquotasIbsEstadual.push(ibsE);
    aliquotasIbsMunicipal.push(ibsM);
  }
  let cbs, ibsEstadual, ibsMunicipal;
  try {
    cbs = ratearTributo(trechos, aliquotasCbs, baseCalculo, extTotal);
    ibsEstadual = ratearTributo(trechos, aliquotasIbsEstadual, baseCalculo, extTotal);
    ibsMunicipal = ratearTributo(trechos, aliquotasIbsMunicipal, baseCalculo, extTotal);
  } catch (e) {
    // java.lang.ArithmeticException ("Division by zero", "Division undefined", "Overflow") → 500
    if (e instanceof ArithmeticException) throw new ErroJava('ArithmeticException', e.message);
    throw e;
  }
  const saida = trechos.map((t, i) => ({
    numero: t.numero,
    uf: t.uf,
    municipio: t.municipio,
    baseCalculo,
    cbs: cbs[i],
    ibsEstadual: ibsEstadual[i],
    ibsMunicipal: ibsMunicipal[i],
    extensaoTrecho: t.extensao,
    extensaoTotal: null,
  }));
  return {
    cst: entrada.cst,
    cClassTrib: entrada.cClassTrib,
    extensaoTotal: extTotal,
    dataHoraEmissao: entrada.dataHoraEmissao,
    municipioOrigem: entrada.codigoMunicipioOrigem,
    baseCalculo,
    ufMunicipioOrigem: entrada.ufMunicipioOrigem,
    trechos: saida,
    total: getTotal(saida),
  };
}

/** PedagioService.getWarningDadosSimulados: null before 2027-01-01, else CASO_GERAL. */
export const warningDadosSimulados = (entrada) => (entrada.dataHoraEmissao.slice(0, 10) < '2027-01-01' ? null : CASO_GERAL);

// ─── JSON (Jackson 3: alphabetical, NON_NULL) ─────────────────────────────────

/** BigDecimalTDec1302Serializer: negative → IllegalArgumentException while writing. */
function tdec1302(v) {
  if (v == null) return null;
  if (v.compareTo(Dec.ZERO) < 0) throw new ErroSerializacao('Números negativos não são permitidos para TDec1302');
  return formatarMoeda(v);
}

/** OffsetDateTime as ISO_OFFSET_DATE_TIME: an offset of zero is written 'Z'. */
const dataHoraJson = (texto) => (/[+-]00:00$/.test(texto) ? `${texto.slice(0, 19)}Z` : texto);

const tributoJson = (t) => ({ aliquota: t.aliquota, aliquotaEfetiva: t.aliquotaEfetiva, tributoCalculado: t.tributoCalculado });
const totalJson = (t) => ({
  baseCalculo: tdec1302(t.baseCalculo), valorApurado: tdec1302(t.valorApurado), valorDevido: tdec1302(t.valorDevido),
  valorMontanteDesonerado: tdec1302(t.valorMontanteDesonerado), valorTributo: tdec1302(t.valorTributo),
});

/** PedagioOutput → object in Jackson's key order (throws ErroSerializacao like the serializer). */
export function saidaPedagio(p) {
  return {
    baseCalculo: p.baseCalculo,
    cClassTrib: p.cClassTrib,
    cst: p.cst,
    dataHoraEmissao: dataHoraJson(p.dataHoraEmissao),
    extensaoTotal: p.extensaoTotal,
    municipioOrigem: p.municipioOrigem,
    total: { cbsTotal: totalJson(p.total.cbsTotal), ibsEstadualTotal: totalJson(p.total.ibsEstadualTotal), ibsMunicipalTotal: totalJson(p.total.ibsMunicipalTotal) },
    trechos: p.trechos.map((t) => ({
      baseCalculo: t.baseCalculo,
      cbs: tributoJson(t.cbs),
      extensaoTotal: t.extensaoTotal,
      extensaoTrecho: t.extensaoTrecho,
      ibsEstadual: tributoJson(t.ibsEstadual),
      ibsMunicipal: tributoJson(t.ibsMunicipal),
      municipio: t.municipio,
      numero: t.numero,
      uf: t.uf,
    })),
    ufMunicipioOrigem: p.ufMunicipioOrigem,
  };
}
