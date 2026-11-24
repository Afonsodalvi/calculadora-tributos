// Fiscal XML readers (NF-e/NFC-e modelo 55/65 and NFS-e padrão nacional).
// Fiscal XML is flat, well-formed and namespace-prefixed at most at the root, so a small
// tag reader is enough and runs the same in the browser and in Node (no DOMParser in Node).
// ponytail: indexOf-based tag reader (linear time), not a full XML parser — fine for SEFAZ/ADN
// generated XML; swap for a real parser if someone feeds hand-edited XML with CDATA around tags.

export const LIMITE_XML = 1024 * 1024; // fiscal XMLs are a few KB

function semComentarios(xml) {
  let out = '', i = 0;
  for (;;) {
    const a = xml.indexOf('<!--', i);
    if (a === -1) return out + xml.slice(i);
    const b = xml.indexOf('-->', a + 4);
    if (b === -1) return out + xml.slice(i, a);
    out += xml.slice(i, a);
    i = b + 3;
  }
}
const stripNs = (xml) => {
  if (xml.length > LIMITE_XML) throw new Error('XML grande demais para uma nota fiscal.');
  return semComentarios(xml).replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
};

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/** All inner texts of <tag ...>...</tag> (first closing tag wins, like a non-greedy match). */
export function tags(xml, tag) {
  const out = [];
  const close = `</${tag}>`;
  let i = 0;
  for (;;) {
    const a = xml.indexOf(`<${tag}`, i);
    if (a === -1) return out;
    const next = xml[a + tag.length + 1];
    if (next !== '>' && next !== ' ' && next !== '\t' && next !== '\n' && next !== '\r' && next !== '/') { i = a + 1; continue; }
    const gt = xml.indexOf('>', a);
    if (gt === -1) return out;
    if (xml[gt - 1] === '/') { out.push(''); i = gt + 1; continue; } // <tag/>
    const b = xml.indexOf(close, gt + 1);
    if (b === -1) return out;
    out.push(xml.slice(gt + 1, b));
    i = b + close.length;
  }
}
export function tag(xml, tag) {
  const all = tags(xml ?? '', tag);
  return all.length ? decode(all[0].trim()) : null;
}
const attr = (xml, tagName, name) => {
  const a = (xml ?? '').indexOf(`<${tagName} `);
  if (a === -1) return null;
  const head = xml.slice(a, xml.indexOf('>', a) + 1);
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(head);
  return m ? m[1] : null;
};
const money = (v) => (v == null || v === '' ? null : Number.isNaN(Number(v)) ? null : v);
/** infNFSe without its DPS (first <DPS to the last </DPS>), in linear time: the result groups computed
 *  by the NFS-e system live outside the DPS. Same cut as replace(/<DPS[\s>][\s\S]*<\/DPS>/, ''). */
const semDps = (s) => {
  const a = s.search(/<DPS[\s>]/);
  const b = s.lastIndexOf('</DPS>');
  return a >= 0 && b > a ? s.slice(0, a) + s.slice(b + 6) : s;
};

export function detectXmlKind(text) {
  const x = stripNs(text);
  if (/<infNFe[\s>]/.test(x)) return 'NFE';
  if (/<infNFSe[\s>]|<infDPS[\s>]/.test(x)) return 'NFSE';
  return null;
}

/** NFS-e padrão nacional (NFSe/infNFSe/DPS/infDPS) — also accepts a bare DPS. */
export function parseNfseXml(text) {
  const x = stripNs(text);
  const infNFSe = tags(x, 'infNFSe')[0] ?? '';
  const dps = tags(x, 'infDPS')[0];
  if (!dps) throw new Error('XML não é uma NFS-e do padrão nacional (infDPS ausente).');
  const prest = tags(dps, 'prest')[0] ?? '';
  const regTrib = tags(prest, 'regTrib')[0] ?? '';
  const toma = tags(dps, 'toma')[0] ?? '';
  const serv = tags(dps, 'serv')[0] ?? '';
  const cServ = tags(serv, 'cServ')[0] ?? '';
  const valores = tags(dps, 'valores')[0] ?? '';
  const tribMun = tags(valores, 'tribMun')[0] ?? '';
  const bm = tags(tribMun, 'BM')[0] ?? '';
  const descontos = tags(valores, 'vDescCondIncond')[0] ?? '';
  const ibscbs = tags(dps, 'IBSCBS')[0] ?? '';
  const emit = tags(infNFSe, 'emit')[0] ?? '';
  // result group of the NFS-e (outside the DPS): applied ISS rate, net value, BM type
  const foraDps = semDps(infNFSe);
  const valNfse = tags(foraDps, 'valores')[0] ?? '';
  const dCompet = tag(dps, 'dCompet');
  const dhEmi = tag(dps, 'dhEmi');
  const chave = (attr(x, 'infNFSe', 'Id') ?? '').replace(/^NFS/, '') || null;
  return {
    origem: 'XML NFS-e',
    tipo: 'NFS-e',
    tpDoc: '91',
    chave,
    numero: tag(infNFSe, 'nNFSe') ?? tag(dps, 'nDPS'),
    competencia: dCompet ? `${dCompet.slice(0, 7)}-01` : null,
    dataEmissao: dhEmi ? dhEmi.slice(0, 10) : null,
    prestador: {
      doc: tag(emit, 'CNPJ') ?? tag(emit, 'CPF') ?? tag(prest, 'CNPJ') ?? tag(prest, 'CPF'),
      nome: tag(emit, 'xNome') ?? tag(prest, 'xNome'),
    },
    tomador: { doc: tag(toma, 'CNPJ') ?? tag(toma, 'CPF') ?? tag(toma, 'NIF'), nome: tag(toma, 'xNome') },
    simples: {
      opSimpNac: tag(regTrib, 'opSimpNac'),
      regApTribSN: tag(regTrib, 'regApTribSN'),
      regApIBSCBSSN: tag(regTrib, 'regApIBSCBSSN') ?? tag(dps, 'regApIBSCBSSN'),
      cAtivSN: tag(cServ, 'cAtvSN') ?? tag(dps, 'cAtvSN') ?? tag(dps, 'cAtivSN'),
    },
    servico: {
      cTribNac: tag(cServ, 'cTribNac'),
      nbs: tag(cServ, 'cNBS'),
      descricao: tag(cServ, 'xDescServ'),
    },
    iss: {
      tribISSQN: tag(tribMun, 'tribISSQN'),
      tpRetISSQN: tag(tribMun, 'tpRetISSQN'),
      tpBM: tag(bm, 'tpBM') ?? tag(valNfse, 'tpBM'),
      aliquota: tag(valNfse, 'pAliqAplic') ?? tag(tribMun, 'pAliq'),
      valor: money(tag(valNfse, 'vISSQN')),
    },
    valores: {
      vServ: money(tag(valores, 'vServ')),
      vDescIncond: money(tag(descontos, 'vDescIncond')) ?? '0.00',
      vLiquido: money(tag(valNfse, 'vLiq')),
    },
    ibscbs: { cClassTrib: tag(ibscbs, 'cClassTrib'), cst: tag(ibscbs, 'CST') },
    rtc: rtcNfse(foraDps, dps, { toma, serv, valores, ibscbs, emit, valNfse }),
    substitui: tag(tags(dps, 'subst')[0] ?? '', 'chSubstda'),
    ambiente: tag(dps, 'tpAmb'),
    avisos: [],
  };
}

/** NFS-e fields used by the Regime Regular calculation (CBS/IBS, NT 2025.002 / leiaute 1.01). */
function rtcNfse(foraDps, dps, { toma, serv, valores, ibscbs, emit, valNfse }) {
  const resultado = tags(foraDps, 'IBSCBS')[0] ?? ''; // computed by the NFS-e system (outside the DPS)
  const valRes = tags(resultado, 'valores')[0] ?? '';
  const tot = tags(resultado, 'totCIBS')[0] ?? '';
  const pisCofins = tags(valores, 'piscofins')[0] ?? '';
  return {
    dhEmi: tag(dps, 'dhEmi'),
    dCompet: tag(dps, 'dCompet'),
    cLocIncid: tag(foraDps, 'cLocIncid'),
    cLocPrestacao: tag(tags(serv, 'locPrest')[0] ?? '', 'cLocPrestacao'),
    municipioPrestador: tag(tags(emit, 'enderNac')[0] ?? '', 'cMun'),
    municipioTomador: tag(tags(toma, 'endNac')[0] ?? '', 'cMun'),
    cLocalidadeIncid: tag(resultado, 'cLocalidadeIncid'),
    operacao: {
      finNFSe: tag(ibscbs, 'finNFSe'), indFinal: tag(ibscbs, 'indFinal'), cIndOp: tag(ibscbs, 'cIndOp'),
      tpOper: tag(ibscbs, 'tpOper'), tpEnteGov: tag(ibscbs, 'tpEnteGov'), indDest: tag(ibscbs, 'indDest'),
    },
    vISSQN: money(tag(valNfse, 'vISSQN')),
    vPis: money(tag(pisCofins, 'vPis')),
    vCofins: money(tag(pisCofins, 'vCofins')),
    declarado: resultado ? {
      vBC: money(tag(valRes, 'vBC')), pRedutor: tag(resultado, 'pRedutor'),
      pCBS: tag(valRes, 'pCBS'), pIBSUF: tag(valRes, 'pIBSUF'), pIBSMun: tag(valRes, 'pIBSMun'),
      vCBS: money(tag(tags(tot, 'gCBS')[0] ?? '', 'vCBS')), vIBSUF: money(tag(tot, 'vIBSUF')), vIBSMun: money(tag(tot, 'vIBSMun')),
    } : null,
  };
}

/** NF-e (55) / NFC-e (65): one entry per item (det). */
export function parseNfeXml(text) {
  const x = stripNs(text);
  const inf = tags(x, 'infNFe')[0];
  if (!inf) throw new Error('XML não é uma NF-e/NFC-e (infNFe ausente).');
  const ide = tags(inf, 'ide')[0] ?? '';
  const emit = tags(inf, 'emit')[0] ?? '';
  const dest = tags(inf, 'dest')[0] ?? '';
  const mod = tag(ide, 'mod');
  const dh = tag(ide, 'dhEmi') ?? tag(ide, 'dEmi');
  const itens = tags(inf, 'det').map((det, i) => {
    const prod = tags(det, 'prod')[0] ?? '';
    const g = (t) => money(tag(prod, t)) ?? '0.00';
    return {
      numero: i + 1,
      codigo: tag(prod, 'cProd'),
      descricao: tag(prod, 'xProd'),
      ncm: tag(prod, 'NCM'),
      cfop: tag(prod, 'CFOP'),
      vProd: g('vProd'), vFrete: g('vFrete'), vSeg: g('vSeg'), vOutro: g('vOutro'), vDesc: g('vDesc'),
      cClassTrib: tag(det, 'cClassTrib'),
      rtc: rtcItemNfe(det, prod),
    };
  });
  const tot = tags(inf, 'ICMSTot')[0] ?? '';
  return {
    origem: 'XML NF-e',
    tipo: mod === '65' ? 'NFC-e' : 'NF-e',
    tpDoc: mod === '65' ? '65' : '55',
    chave: (attr(x, 'infNFe', 'Id') ?? '').replace(/^NFe/, '') || null,
    numero: tag(ide, 'nNF'),
    competencia: dh ? `${dh.slice(0, 7)}-01` : null,
    dataEmissao: dh ? dh.slice(0, 10) : null,
    finalidade: tag(ide, 'finNFe'), // 1 normal, 2 complementar, 3 ajuste, 4 devolução
    ambiente: tag(ide, 'tpAmb'), // 2 = homologação (sem valor fiscal)
    protocolo: tag(tags(x, 'protNFe')[0] ?? '', 'cStat'), // 100/150 autorizada; null = XML sem protocolo
    tpNF: tag(ide, 'tpNF'), // 0 entrada, 1 saída
    prestador: { doc: tag(emit, 'CNPJ') ?? tag(emit, 'CPF'), nome: tag(emit, 'xNome'), crt: tag(emit, 'CRT') },
    tomador: { doc: tag(dest, 'CNPJ') ?? tag(dest, 'CPF'), nome: tag(dest, 'xNome') },
    itens,
    valores: { vNF: money(tag(tot, 'vNF')), vProd: money(tag(tot, 'vProd')), vDesc: money(tag(tot, 'vDesc')) },
    rtc: {
      dhEmi: tag(ide, 'dhEmi'),
      cMunFG: tag(ide, 'cMunFG'),
      cMunFGIBS: tag(ide, 'cMunFGIBS'),
      idDest: tag(ide, 'idDest'),
      indFinal: tag(ide, 'indFinal'),
      ufEmitente: tag(tags(emit, 'enderEmit')[0] ?? '', 'UF'),
      municipioEmitente: tag(tags(emit, 'enderEmit')[0] ?? '', 'cMun'),
      ufDestinatario: tag(tags(dest, 'enderDest')[0] ?? '', 'UF'),
      municipioDestinatario: tag(tags(dest, 'enderDest')[0] ?? '', 'cMun'),
      municipioEntrega: tag(tags(inf, 'entrega')[0] ?? '', 'cMun'),
      tpEnteGov: tag(tags(ide, 'gCompraGov')[0] ?? '', 'tpEnteGov'),
    },
    avisos: [],
  };
}

/** Per-item values of an NF-e used by the Regime Regular (base unificada, IS and IBS/CBS groups). */
function rtcItemNfe(det, prod) {
  const imp = tags(det, 'imposto')[0] ?? '';
  const n = (xml, t) => money(tag(xml, t));
  const icms = tags(imp, 'ICMS')[0] ?? '';
  const ufDest = tags(imp, 'ICMSUFDest')[0] ?? ''; // DIFAL of interstate sales to final consumers
  const is = tags(imp, 'IS')[0];
  const ibscbs = tags(imp, 'IBSCBS')[0];
  const g = ibscbs && (tags(ibscbs, 'gIBSCBS')[0] ?? '');
  return {
    uTrib: tag(prod, 'uTrib') ?? tag(prod, 'uCom'),
    qTrib: tag(prod, 'qTrib') ?? tag(prod, 'qCom'),
    vICMS: n(icms, 'vICMS'),
    vFCP: n(icms, 'vFCP'),
    // components the official base subtracts too (tag reader: <vICMSMonoReten>/<vICMSMonoRet> do not match)
    vICMSUFDest: n(ufDest, 'vICMSUFDest'),
    vFCPUFDest: n(ufDest, 'vFCPUFDest'),
    vICMSMono: n(icms, 'vICMSMono'),
    vISSQN: n(tags(imp, 'ISSQN')[0] ?? '', 'vISSQN'), // conjugated NF-e (service item)
    vIPI: n(tags(imp, 'IPI')[0] ?? '', 'vIPI'),
    vII: n(tags(imp, 'II')[0] ?? '', 'vII'),
    vPIS: n(tags(imp, 'PIS')[0] ?? '', 'vPIS'),
    vCOFINS: n(tags(imp, 'COFINS')[0] ?? '', 'vCOFINS'),
    is: is == null ? null : {
      cst: tag(is, 'CSTIS'), cClassTrib: tag(is, 'cClassTribIS'), vBC: n(is, 'vBCIS'),
      pIS: tag(is, 'pIS'), pISEspec: tag(is, 'pISEspec'), uTrib: tag(is, 'uTrib'), qTrib: tag(is, 'qTrib'), vIS: n(is, 'vIS'),
    },
    ibscbs: ibscbs == null ? null : {
      cst: tag(ibscbs, 'CST'), cClassTrib: tag(ibscbs, 'cClassTrib'),
      vBC: n(g, 'vBC'), pCBS: tag(g, 'pCBS'), vCBS: n(g, 'vCBS'),
      pIBSUF: tag(g, 'pIBSUF'), vIBSUF: n(g, 'vIBSUF'), pIBSMun: tag(g, 'pIBSMun'), vIBSMun: n(g, 'vIBSMun'),
      tributacaoRegular: tags(ibscbs, 'gTribRegular')[0] == null ? null
        : { cst: tag(tags(ibscbs, 'gTribRegular')[0], 'CSTReg'), cClassTrib: tag(tags(ibscbs, 'gTribRegular')[0], 'cClassTribReg') },
    },
  };
}
