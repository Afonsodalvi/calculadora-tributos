// Reads the fields of a DANFSe (Documento Auxiliar da NFS-e, padrão nacional v2.0)
// from positioned text items (what pdf.js getTextContent gives). The DANFSe is a grid:
// every value sits right below its label, in the same column. Works for both DANFSe
// layouts seen in the wild (emissor nacional and municipal emitters).
//
// items: [{ x, y, str }] with y growing downwards (page top = 0).

const norm = (s) => s.slice(0, 400).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
// a DANFSe cell holds a few words; capping it keeps every later regex linear on hostile PDF text
const MAX_CELULA = 2000;

export function gridFromItems(items) {
  const cells = items
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({ x: i.x, y: i.y, str: i.str.trim().slice(0, MAX_CELULA), n: norm(i.str) }));
  cells.sort((a, b) => a.y - b.y || a.x - b.x);

  const findLabel = (re, from = -Infinity, to = Infinity) =>
    cells.find((c) => c.y > from && c.y < to && re.test(c.n));

  /** Value cell right below a label, same column. */
  const below = (label) => {
    if (!label) return null;
    const cands = cells.filter((c) => c.y > label.y + 2 && c.y <= label.y + 16 && Math.abs(c.x - label.x) <= 12);
    cands.sort((a, b) => a.y - b.y);
    return cands[0] ?? null;
  };

  const value = (re, from, to) => below(findLabel(re, from, to))?.str ?? null;
  return { cells, findLabel, below, value };
}

const dash = (v) => (v == null || /^[-\s/]*$/.test(v) ? null : v);

/** "R$ 12.345,67" → "12345.67"; "-" → null. Dots only as thousands separators (groups of 3). */
export function parseMoney(v) {
  v = dash(v);
  if (!v) return null;
  const s = v.slice(0, 60).replace(/R\$|\s/g, '');
  let m = /^(-?)(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(s);
  if (m) return `${m[1]}${m[2].replace(/\./g, '')}.${(m[3] ?? '00').padEnd(2, '0')}`;
  m = /^(-?)(\d+)\.(\d{1,2})$/.exec(s); // decimal point, no comma (non-standard renderings)
  return m ? `${m[1]}${m[2]}.${m[3].padEnd(2, '0')}` : null;
}

/** "5,00%" → "5.00" */
export function parsePercent(v) {
  v = dash(v);
  if (!v) return null;
  // bounded prefix, as in parseMoney: the unanchored [\d.]+ is quadratic on a long run of digits
  const m = /([\d.]+(?:,\d+)?)\s*%/.exec(v.slice(0, 60));
  return m ? m[1].replace(/\./g, '').replace(',', '.') : null;
}

/** "01/11/2026" or "09/11/2026 11:58:14" → "2026-11-01" */
export function parseDateBR(v) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(v ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const digits = (v) => (v ?? '').replace(/\D/g, '');
// CNPJ and access keys: digits, or the alphanumeric CNPJ (IN RFB 2.229/2024, issued from July 2026)
const alfanum = (v) => (v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

function mapOpSimpNac(v) {
  const n = norm(v ?? '');
  if (!n) return null;
  if (n.includes('NAO OPTANTE')) return '1';
  if (n.includes('MEI') || n.includes('MICROEMPREENDEDOR')) return '2';
  if (n.includes('MICROEMPRESA') || n.includes('ME/EPP') || n.includes('PEQUENO PORTE')) return '3';
  if (n.includes('PENDENTE')) return '4';
  return null;
}

function mapRegApTribSN(v) {
  const n = norm(v ?? '');
  if (!n) return null;
  // 1 federais e municipal pelo SN; 2 federais pelo SN e ISS por fora; 3 federais e municipal por fora
  if (/FEDERAIS E MUNICIPAL PELO/.test(n)) return '1';
  if (/FEDERAIS PELO .* ISS.* (POR FORA|FORA)/.test(n) || /ISSQN POR FORA/.test(n)) return '2';
  if (/FEDERAIS E MUNICIPAL POR FORA|POR FORA DO SIMPLES|FORA DO SN/.test(n)) return '3';
  return null;
}

function mapTribISSQN(v) {
  const n = norm(v ?? '');
  if (!n) return null;
  if (n.includes('TRIBUTAVEL')) return '1';
  if (n.includes('IMUNIDADE')) return '2';
  if (n.includes('EXPORTACAO')) return '3';
  if (n.includes('NAO INCIDENCIA')) return '4';
  return null;
}

function mapTpRetISSQN(v) {
  const n = norm(v ?? '');
  if (!n) return null;
  if (n.includes('NAO RETIDO')) return '1';
  if (n.includes('INTERMEDIARIO')) return '3';
  if (n.includes('RETIDO')) return '2';
  return null;
}

function mapTpBM(v) {
  const n = norm(v ?? '');
  if (!n || n === 'NENHUM') return null;
  if (n.includes('ISENCAO')) return '1';
  if (n.includes('PERCENTUAL') || n.includes('%')) return '2';
  if (n.includes('VALOR') || n.includes('R$')) return '3';
  if (n.includes('ALIQUOTA')) return '4';
  return null;
}

/**
 * Parse a DANFSe page. Returns a normalized NF object (same shape as the XML parsers)
 * or throws when the page is not a DANFSe.
 */
export function parseDanfse(items) {
  const g = gridFromItems(items);
  const isDanfse = g.cells.some((c) => /DANFSE|DANFESE|DOCUMENTO AUXILIAR DA NFS-E/.test(c.n));
  const marcaDagua = g.cells.find((c) => /^(CANCELADA|SUBSTITUIDA)$/.test(c.n))?.str ?? null;
  if (!isDanfse) throw new Error('O PDF não parece ser um DANFSe (Documento Auxiliar da NFS-e).');

  const prest = g.findLabel(/^PRESTADOR \/ FORNECEDOR|^EMITENTE DA NFS-E$/);
  const prestHeader = g.findLabel(/^PRESTADOR \/ FORNECEDOR/);
  const toma = g.findLabel(/^TOMADOR \/ ADQUIRENTE/);
  const servico = g.findLabel(/^SERVICO PRESTADO/);
  const yP = (prestHeader ?? prest)?.y ?? 0;
  const yT = toma?.y ?? Infinity;

  // header labels can sit 1-2 units above/below the first label row of the section
  const sectionValue = (re, from, to) => g.value(re, from - 3, to - 3);

  let chave = alfanum(g.value(/^CHAVE DE ACESSO DA NFS-E/));
  if (chave.length !== 50) {
    // a key is 50 characters, all digits except the 12 of an alphanumeric CNPJ
    chave = g.cells.map((c) => c.str).join(' ').match(/\b[0-9A-Z]{50}\b/g)?.find((k) => k.replace(/\D/g, '').length >= 38) ?? null;
  }

  const cTribRaw = g.value(/^CODIGO DE TRIBUTACAO NACIONAL/);
  const cTribNac = (/(\d{2})\.?(\d{2})\.?(\d{2})/.exec(cTribRaw ?? '') ?? []).slice(1).join('') || null;
  const nbs = digits(dash(g.value(/^CODIGO DA NBS/))) || null;

  // service description: every line between "Descrição do Serviço" and the next section header
  const descLabel = g.findLabel(/^DESCRICAO DO SERVICO/);
  const nextSection = g.findLabel(/^TRIBUTACAO MUNICIPAL/, descLabel?.y ?? 0);
  const descricao = descLabel
    ? g.cells.filter((c) => c.y > descLabel.y + 2 && c.y < (nextSection?.y ?? descLabel.y + 60) - 3 && c.x < 300)
      .map((c) => c.str).join(' ')
    : null;
  // the LC 116 item text shown below the service codes in some layouts
  const itemLc116 = servico
    ? g.cells.find((c) => c.y > servico.y + 12 && c.y < (descLabel?.y ?? servico.y + 30) && c.x < 60)?.str ?? null
    : null;

  // "VALOR DA OPERAÇÃO / SERVIÇO" row also holds the Desconto Incondicionado of the totals
  const valorLabel = g.findLabel(/^VALOR DA OPERACAO|^VALOR DO SERVICO/);
  const descIncLabel = valorLabel
    ? g.cells.find((c) => Math.abs(c.y - valorLabel.y) <= 3 && /^DESCONTO INCONDICIONADO/.test(c.n))
    : null;

  const nf = {
    origem: 'DANFSe (PDF)',
    tipo: 'NFS-e',
    tpDoc: '91',
    chave: chave || null,
    numero: dash(g.value(/^NUMERO DA NFS-E/)),
    competencia: parseDateBR(g.value(/^COMPETENCIA DA NFS-E/)),
    dataEmissao: parseDateBR(g.value(/^DATA E HORA DA EMISSAO DA NFS-E/)),
    situacao: marcaDagua ?? dash(g.value(/^SITUACAO DA NFS-E/)),
    prestador: {
      doc: alfanum(sectionValue(/^CNPJ \/ CPF \/ NIF/, yP, yT)) || null,
      nome: dash(sectionValue(/^NOME \/ NOME EMPRESARIAL/, yP, yT)),
      municipio: dash(sectionValue(/^MUNICIPIO \/ SIGLA/, yP, yT)),
    },
    tomador: {
      doc: alfanum(sectionValue(/^CNPJ \/ CPF \/ NIF/, yT, Infinity)) || null,
      nome: dash(sectionValue(/^NOME \/ NOME EMPRESARIAL/, yT, Infinity)),
      municipio: dash(sectionValue(/^MUNICIPIO \/ SIGLA/, yT, Infinity)),
    },
    simples: {
      opSimpNac: mapOpSimpNac(g.value(/^SIMPLES NACIONAL (NA )?DATA DE COMPETENCIA/)),
      regApTribSN: mapRegApTribSN(g.value(/^REGIME DE APURACAO TRIBUTARIA PELO SN/)),
      textoOpcao: dash(g.value(/^SIMPLES NACIONAL (NA )?DATA DE COMPETENCIA/)),
      textoRegime: dash(g.value(/^REGIME DE APURACAO TRIBUTARIA PELO SN/)),
    },
    servico: {
      cTribNac,
      nbs,
      itemLc116,
      descricao,
      localPrestacao: dash(g.value(/^LOCAL DA PRESTACAO/)),
    },
    iss: {
      tribISSQN: mapTribISSQN(g.value(/^TIPO DE TRIBUTACAO DO ISSQN/)),
      tpRetISSQN: mapTpRetISSQN(g.value(/^RETENCAO DO ISSQN/)),
      tpBM: mapTpBM(g.value(/^BENEFICIO MUNICIPAL/)),
      baseCalculo: parseMoney(g.value(/^BC ISSQN/)),
      aliquota: parsePercent(g.value(/^ALIQUOTA APLICADA/)),
      valor: parseMoney(g.value(/^ISSQN APURADO/)),
    },
    valores: {
      vServ: parseMoney(below(valorLabel)?.str),
      vDescIncond: parseMoney(below(descIncLabel)?.str) ?? '0.00',
      vLiquido: parseMoney(g.value(/^VALOR LIQUIDO DA NFS-E$/)),
    },
    ibscbs: {
      cstCClassTrib: dash(g.value(/^CST \/ CCLASSTRIB/)),
      total: parseMoney(g.value(/^TOTAL DO IBS\/CBS/)),
    },
    avisos: [],
  };

  function below(label) { return g.below(label); }

  if (!nf.valores.vServ) nf.avisos.push('Não foi possível ler o valor do serviço no DANFSe.');
  if (!nf.servico.cTribNac) nf.avisos.push('Código de Tributação Nacional (item da LC 116) não encontrado.');
  if (!nf.competencia) nf.avisos.push('Competência não encontrada.');
  return nf;
}
