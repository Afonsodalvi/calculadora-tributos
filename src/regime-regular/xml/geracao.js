// XmlService.gerarXml + the 7 *XmlService of domain/service/xml: validations, the ModelMapper
// projection ROC → JAXB tree and the JAXB RI 4.0.9 output (Marshaller with
// JAXB_FORMATTED_OUTPUT: DataWriter, 4-space indent, MinimumEscapeHandler, "\n" at the end).
//
// ModelMapper (verified rule, xml.md §3.4): every destination path is mapped from the source path
// with the same names; a destination group exists iff the homonymous source object is not null
// (even when all its leaves are null → <grupo/>), a leaf exists iff its source value is not null.
// Converters: String → itself, BigDecimal → BigDecimal.toString(), Integer → Integer.toString().
// Never filled: competApur (String → XMLGregorianCalendar has no converter), indDoacao of the NF3e
// (Integer → enum TIndDoacao), refDFeAnt. gCompraGov has an explicit TypeMap (formatarAliquota).
import { Dec } from '../../core/decimal.js';
import { ErroJava } from '../comum/problema.js';

// ─── Destination schemas (order = @XmlType.propOrder = order of the XSD) ──────────────────────
// Leaf: { nome, conv } with conv 'bd' | 'int' | 'str' | 'nunca'; group: { nome, filhos }.
// zeroNoGetter: the source getter returns ZERO for null (MonofasiaDomain.getVTot*MonoItem).
const bd = (nome, opcoes = {}) => ({ nome, conv: 'bd', ...opcoes });
const int = (nome) => ({ nome, conv: 'int' });
const str = (nome) => ({ nome, conv: 'str' });
const nunca = (nome) => ({ nome, conv: 'nunca' });
const grupo = (nome, filhos) => ({ nome, filhos });

const G_DIF = grupo('gDif', [bd('pDif'), bd('vDif')]);
const G_DEV_TRIB = grupo('gDevTrib', [bd('vDevTrib')]);
const G_RED = grupo('gRed', [bd('pRedAliq'), bd('pAliqEfet')]);
const tributoEnte = (nome, p, v) => grupo(nome, [bd(p), G_DIF, G_DEV_TRIB, G_RED, bd(v)]);

/** TCIBS (gIBSCBS). */
const G_IBSCBS = grupo('gIBSCBS', [
  bd('vBC'),
  tributoEnte('gIBSUF', 'pIBSUF', 'vIBSUF'),
  tributoEnte('gIBSMun', 'pIBSMun', 'vIBSMun'),
  bd('vIBS'),
  tributoEnte('gCBS', 'pCBS', 'vCBS'),
  grupo('gTribRegular', [str('CSTReg'), str('cClassTribReg'), bd('pAliqEfetRegIBSUF'), bd('vTribRegIBSUF'), bd('pAliqEfetRegIBSMun'), bd('vTribRegIBSMun'), bd('pAliqEfetRegCBS'), bd('vTribRegCBS')]),
  grupo('gTribCompraGov', [bd('pAliqIBSUF'), bd('vTribIBSUF'), bd('pAliqIBSMun'), bd('vTribIBSMun'), bd('pAliqCBS'), bd('vTribCBS')]),
]);

/** TMonofasia (gIBSCBSMono). */
const G_MONO = grupo('gIBSCBSMono', [
  grupo('gMonoPadrao', [bd('qBCMono'), bd('adRemIBS'), bd('adRemCBS'), bd('vIBSMono'), bd('vCBSMono')]),
  grupo('gMonoReten', [bd('qBCMonoReten'), bd('adRemIBSReten'), bd('vIBSMonoReten'), bd('adRemCBSReten'), bd('vCBSMonoReten')]),
  grupo('gMonoRet', [bd('qBCMonoRet'), bd('adRemIBSRet'), bd('vIBSMonoRet'), bd('adRemCBSRet'), bd('vCBSMonoRet')]),
  grupo('gMonoDif', [bd('pDifIBS'), bd('vIBSMonoDif'), bd('pDifCBS'), bd('vCBSMonoDif')]),
  bd('vTotIBSMonoItem', { zeroNoGetter: true }),
  bd('vTotCBSMonoItem', { zeroNoGetter: true }),
]);

const G_ESTORNO = grupo('gEstornoCred', [bd('vIBSEstCred'), bd('vCBSEstCred')]);
const credPres = (nome) => grupo(nome, [bd('pCredPres'), bd('vCredPres'), bd('vCredPresCondSus')]);

const T_TRIB_NFE = [
  str('CST'), str('cClassTrib'), int('indDoacao'), G_IBSCBS, G_MONO,
  grupo('gTransfCred', [bd('vIBS'), bd('vCBS')]),
  grupo('gAjusteCompet', [nunca('competApur'), bd('vIBS'), bd('vCBS')]),
  G_ESTORNO,
  grupo('gCredPresOper', [bd('vBCCredPres'), int('cCredPres'), credPres('gIBSCredPres'), credPres('gCBSCredPres')]),
  grupo('gCredPresIBSZFM', [nunca('competApur'), int('tpCredPresIBSZFM'), bd('vCredPresIBSZFM')]),
];
const T_TRIB_NFCE = [str('CST'), str('cClassTrib'), int('indDoacao'), G_IBSCBS, G_MONO];
const T_TRIB_CTE_BPE = [str('CST'), str('cClassTrib'), int('indDoacao'), G_IBSCBS, G_ESTORNO];
const T_TRIB_NF3E = [str('CST'), str('cClassTrib'), nunca('indDoacao'), G_IBSCBS, G_ESTORNO];
const T_IS = [str('CSTIS'), str('cClassTribIS'), bd('vBCIS'), bd('pIS'), bd('pISEspec'), str('uTrib'), bd('qTrib'), bd('vIS')];

/** NF-e / NFC-e total (TIBSCBSMonoTot + ISTot). */
const TOTAL_MONO = [
  grupo('ISTot', [bd('vIS')]),
  grupo('IBSCBSTot', [
    bd('vBCIBSCBS'),
    grupo('gIBS', [grupo('gIBSUF', [bd('vDif'), bd('vDevTrib'), bd('vIBSUF')]), grupo('gIBSMun', [bd('vDif'), bd('vDevTrib'), bd('vIBSMun')]), bd('vIBS'), bd('vCredPres'), bd('vCredPresCondSus')]),
    grupo('gCBS', [bd('vDif'), bd('vDevTrib'), bd('vCBS'), bd('vCredPres'), bd('vCredPresCondSus')]),
    grupo('gMono', [bd('vIBSMono'), bd('vCBSMono'), bd('vIBSMonoReten'), bd('vCBSMonoReten'), bd('vIBSMonoRet'), bd('vCBSMonoRet')]),
    G_ESTORNO,
  ]),
];
/** BPe TM / NF3e total (TIBSCBSTot). */
const TOTAL = [
  grupo('IBSCBSTot', [
    bd('vBCIBSCBS'),
    grupo('gIBS', [grupo('gIBSUF', [bd('vDif'), bd('vDevTrib'), bd('vIBSUF')]), grupo('gIBSMun', [bd('vDif'), bd('vDevTrib'), bd('vIBSMun')]), bd('vIBS')]),
    grupo('gCBS', [bd('vDif'), bd('vDevTrib'), bd('vCBS')]),
    G_ESTORNO,
  ]),
];

// ─── Output tree ───────────────────────────────────────────────────────────────────────────────
// Node: { nome, atributos: [[k, v]], filhos: [], texto?: string }
const no = (nome, filhos = [], atributos = []) => ({ nome, filhos, atributos });
const folha = (nome, texto) => ({ nome, filhos: [], atributos: [], texto });

/** Converter of a leaf (StringConverter / AssignableConverter): null stays null (element omitted). */
function converter(conv, valor) {
  if (valor == null) return null;
  switch (conv) {
    case 'bd': return valor.toJavaString();
    case 'int': return String(valor);
    case 'str': return valor;
    default: return null;
  }
}

/** ModelMapper projection of `origem` onto the destination schema. */
function projetar(esquema, origem) {
  const saida = [];
  for (const d of esquema) {
    const valor = origem?.[d.nome] ?? null;
    if (d.filhos) {
      if (valor != null) saida.push(no(d.nome, projetar(d.filhos, valor)));
      continue;
    }
    if (d.conv === 'nunca') continue;
    const texto = converter(d.conv, valor == null && d.zeroNoGetter ? new Dec(0n, 0) : valor);
    if (texto != null) saida.push(folha(d.nome, texto));
  }
  return saida;
}

/** Above this many characters the pRedutor text is refused (Java would hang or overflow BigInteger). */
const LIMITE_TEXTO_ALIQUOTA = 10_000_000;

/**
 * ArredondamentoUtils.formatarAliquota(pRedutor): setScale(4, HALF_EVEN) → stripTrailingZeros →
 * at least 2 decimals → toPlainString. Same result as the Dec version, without building 10^|scale|
 * for extreme exponents.
 */
export function formatarAliquotaRedutor(v) {
  const s = v.scale();
  const p = v.precision();
  if (s > 4) {
    if (p - s <= -5) return '0.00'; // |v| < 10^-5 rounds to zero at 4 decimals
    v = v.setScale(4, 'HALF_EVEN');
  }
  if (v.isZero()) return '0.00';
  const neg = v.signum() < 0;
  let digitos = (neg ? -v.unscaledValue() : v.unscaledValue()).toString();
  let escala = v.scale();
  const semZeros = digitos.replace(/0+$/, '');
  escala -= digitos.length - semZeros.length;
  digitos = semZeros;
  if (escala < 2) {
    if (digitos.length + (2 - escala) > LIMITE_TEXTO_ALIQUOTA) throw new ErroJava('ArithmeticException', 'BigInteger would overflow supported range');
    digitos += '0'.repeat(2 - escala);
    escala = 2;
  }
  if (digitos.length <= escala) digitos = '0'.repeat(escala - digitos.length + 1) + digitos;
  const i = digitos.length - escala;
  return `${neg ? '-' : ''}${digitos.slice(0, i)}.${digitos.slice(i)}`;
}

/** Explicit TypeMap CompraGovernamentalDomain → TCompraGov / TCompraGovReduzido (inside <ide>). */
function ide(roc) {
  const g = roc.oper?.gCompraGov;
  if (roc.oper == null || g == null) return null;
  const filhos = [];
  if (g.tpEnteGov != null) filhos.push(folha('tpEnteGov', String(g.tpEnteGov)));
  if (g.pRedutor != null) filhos.push(folha('pRedutor', formatarAliquotaRedutor(g.pRedutor)));
  if (g.tpOperGov != null) filhos.push(folha('tpOperGov', String(g.tpOperGov)));
  return no('ide', [no('gCompraGov', filhos)]);
}

const erro = (mensagem, classe = 'IllegalArgumentException') => new ErroJava(classe, mensagem);
const NPE = (mensagem) => erro(mensagem, 'NullPointerException');
const OBJETO = 'br.gov.serpro.rtc.api.model.roc.ObjetoDomain';

/** objeto.getNObj().toString() with the helpful NPE messages of the official build. */
function numeroObjeto(o) {
  if (o == null) throw NPE(`Cannot invoke "${OBJETO}.getNObj()" because "r" is null`);
  if (o.nObj == null) throw NPE(`Cannot invoke "java.lang.Integer.toString()" because the return value of "${OBJETO}.getNObj()" is null`);
  return String(o.nObj);
}

/** ModelMapper.map(null, X.class): Assert.notNull(source, "source"). */
function fonte(v) {
  if (v == null) throw erro('source cannot be null');
  return v;
}

/** mapper.map(tribCalc, Imposto/Imp.class): IS (NF-e/NFC-e only) and IBSCBS. */
function imposto(nome, trib, comIS, esquemaTrib) {
  fonte(trib);
  const filhos = [];
  if (comIS && trib.IS != null) filhos.push(no('IS', projetar(T_IS, trib.IS)));
  if (trib.IBSCBS != null) filhos.push(no('IBSCBS', projetar(esquemaTrib, trib.IBSCBS)));
  return no(nome, filhos);
}

const NS = (sigla) => `http://www.portalfiscal.inf.br/${sigla}`;

function exigirTotal(roc) {
  if (roc.total == null || roc.total.tribCalc == null) throw erro('Total do ROC não informado');
}

/** NfeXmlService / NfceXmlService. */
function gerarNfe(roc, nfce) {
  const objetos = roc.objetos;
  if (objetos == null || objetos.length === 0) throw erro('ROC deve conter ao menos um objeto');
  exigirTotal(roc);
  const filhos = [];
  if (!nfce) { const i = ide(roc); if (i) filhos.push(i); }
  for (const o of objetos) {
    const nItem = numeroObjeto(o);
    filhos.push(no('det', [imposto('imposto', o.tribCalc, true, nfce ? T_TRIB_NFCE : T_TRIB_NFE)], [['nItem', nItem]]));
  }
  filhos.push(no('total', projetar(TOTAL_MONO, fonte(roc.total.tribCalc))));
  return { raiz: no('infNFe', filhos), ns: NS('nfe') };
}

/** CteXmlService / CteSimplificadoXmlService / BpeXmlService: imp first (only the first object), then ide. */
function gerarImpUnico(roc, raiz, sigla) {
  const objetos = roc.objetos;
  if (objetos == null || objetos.length === 0 || objetos.length > 1) throw erro('ROC deve conter um item');
  const o = objetos[0];
  if (o == null) throw NPE(`Cannot invoke "${OBJETO}.getTribCalc()" because the return value of "java.util.List.getFirst()" is null`);
  if (o.tribCalc == null) throw NPE(`Cannot invoke "br.gov.serpro.rtc.api.model.roc.TributosDomain.getIBSCBS()" because the return value of "${OBJETO}.getTribCalc()" is null`);
  const ibscbs = no('IBSCBS', projetar(T_TRIB_CTE_BPE, fonte(o.tribCalc.IBSCBS)));
  const filhos = [];
  const i = ide(roc);
  if (i) filhos.push(i);
  filhos.push(no('imp', [ibscbs]));
  return { raiz: no(raiz, filhos), ns: NS(sigla) };
}

/** BpeTMXmlService: ide, detBPeTM/det (single object), total. */
function gerarBpeTm(roc) {
  const objetos = roc.objetos;
  if (objetos == null || objetos.length === 0 || objetos.length > 1) throw erro('ROC deve conter um item');
  exigirTotal(roc);
  const filhos = [];
  const i = ide(roc);
  if (i) filhos.push(i);
  const o = objetos[0];
  const nViagem = numeroObjeto(o);
  filhos.push(no('detBPeTM', [no('det', [imposto('imp', o.tribCalc, false, T_TRIB_CTE_BPE)], [['nViagem', nViagem]])]));
  filhos.push(no('total', projetar(TOTAL, fonte(roc.total.tribCalc))));
  return { raiz: no('infBPe', filhos), ns: NS('bpe') };
}

/** Nf3eXmlService: NFdet/det for every object (built first), then ide, then total. */
function gerarNf3e(roc) {
  const objetos = roc.objetos;
  if (objetos == null || objetos.length === 0) throw erro('ROC deve conter ao menos um item');
  exigirTotal(roc);
  const dets = objetos.map((o) => {
    const nItem = numeroObjeto(o);
    return no('det', [no('detItem', [imposto('imposto', o.tribCalc, false, T_TRIB_NF3E)])], [['nItem', nItem]]);
  });
  const filhos = [];
  const i = ide(roc);
  if (i) filhos.push(i);
  filhos.push(no('NFdet', dets));
  filhos.push(no('total', projetar(TOTAL, fonte(roc.total.tribCalc))));
  return { raiz: no('infNF3e', filhos), ns: NS('nf3e') };
}

/** XmlService.gerarXml(roc, tipo): the JAXB tree of the document type. */
export function montarDocumento(roc, tipo) {
  if (roc == null) throw erro('ROC não pode ser nulo');
  switch (tipo.constante) {
    case 'NFE': return gerarNfe(roc, false);
    case 'NFCE': return gerarNfe(roc, true);
    case 'CTE': case 'CTE_SIMPLIFICADO': return gerarImpUnico(roc, 'infCte', 'cte');
    case 'BPE': return gerarImpUnico(roc, 'infBPe', 'bpe');
    case 'BPE_TM': return gerarBpeTm(roc);
    case 'NF3E': return gerarNf3e(roc);
    default: throw erro(`Tipo de documento não suportado: ${tipo.constante}`);
  }
}

// ─── JAXB RI: XMLWriter + DataWriter (formatted output) + MinimumEscapeHandler ────────────────
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;', '\n': '&#10;' };
const escaparTexto = (s) => s.replace(/[&<>\r]/g, (c) => ESCAPES[c]);
const escaparAtributo = (s) => s.replace(/[&<>\r\n"]/g, (c) => ESCAPES[c]);
const INDENTACAO = '    ';

/** Marshaller.marshal(raiz, StringWriter) with JAXB_FORMATTED_OUTPUT=true. */
export function serializarJaxb({ raiz, ns }) {
  const partes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'];
  const escrever = (n, nivel) => {
    if (nivel > 0) partes.push('\n');
    partes.push(`${INDENTACAO.repeat(nivel)}<${n.nome}`);
    for (const [k, v] of n.atributos) partes.push(` ${k}="${escaparAtributo(v)}"`);
    if (nivel === 0) partes.push(` xmlns="${escaparAtributo(ns)}"`);
    if (n.texto != null) { partes.push(`>${escaparTexto(n.texto)}</${n.nome}>`); return; }
    if (n.filhos.length === 0) { partes.push('/>'); return; }
    partes.push('>');
    for (const f of n.filhos) escrever(f, nivel + 1);
    partes.push(`\n${INDENTACAO.repeat(nivel)}</${n.nome}>`);
  };
  escrever(raiz, 0);
  partes.push('\n');
  return partes.join('');
}

/** XmlService.gerarXml: the XML text. */
export const gerarXml = (roc, tipo) => serializarJaxb(montarDocumento(roc, tipo));

/**
 * String → UTF-8 bytes as the JDK encoder does it for the response (StringHttpMessageConverter):
 * a lone surrogate becomes '?' (Node would write U+FFFD).
 */
export function utf8Java(texto) {
  return Buffer.from(texto.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '?'), 'utf8');
}
