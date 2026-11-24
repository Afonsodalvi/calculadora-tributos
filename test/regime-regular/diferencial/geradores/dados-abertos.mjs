// Differential cases of the dados-abertos area (GET /api/calculadora/dados-abertos/**, 33 routes):
// real codes from the official database (every UF, a sample of municípios, every CST, every cClassTrib,
// NCM/NBS samples including annexes, exceptions and IS rates), dates on every vigência boundary ±1 day,
// and malformed requests (absent / empty / blank / repeated parameters, Long and LocalDate conversion
// edge cases, locales of Accept-Language, path variables, @Pattern violations, 5-digit years, HEAD,
// Accept). gerar({ seed, n, base }) → [{ metodo, caminho, headers?, rotulo }].

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const R = '/api/calculadora/dados-abertos';
const enc = (s) => encodeURIComponent(s);

/** 'yyyy-mm-dd' ± dias (UTC arithmetic on the calendar date). */
function somarDias(data, dias) {
  const d = new Date(`${data.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Every distinct vigência boundary of the tables this area reads, ±1 day, plus fixed reference dates. */
function datasDeBorda(base) {
  const tabelas = ['CLASSIFICACAO_TRIBUTARIA', 'SITUACAO_TRIBUTARIA', 'TRATAMENTO_CLASSIFICACAO', 'TRATAMENTO_TRIBUTARIO', 'TRIBUTO_SITUACAO_TRIBUTARIA',
    'TRIBUTO', 'PERCENTUAL_REDUCAO', 'TIPO_DFE_CLASSIFICACAO', 'TIPO_DFE', 'GRUPO_DFE', 'ATOR', 'GRUPO_ATOR', 'ATOR_CLASSIFICACAO', 'NCM', 'NBS',
    'NCM_APLICAVEL', 'NBS_APLICAVEL', 'EXCECAO_NCM_APLICAVEL', 'EXCECAO_NBS_APLICAVEL', 'FUNDAMENTACAO_CLASSIFICACAO', 'FUNDAMENTACAO_LEGAL',
    'ALIQUOTA_REFERENCIA', 'ALIQUOTA_PADRAO', 'ALIQUOTA_AD_VALOREM_PRODUTO', 'ALIQUOTA_AD_REM_PRODUTO', 'EXCECAO_AD_VALOREM_PRODUTO',
    'EXCECAO_AD_REM_PRODUTO', 'ALIQUOTA_AD_VALOREM_SERVICO'];
  const datas = new Set(['1900-01-01', '2025-12-31', '2026-01-01', '2026-06-01', '2026-12-31', '2027-01-01', '2028-06-15', '2030-01-01', '2033-01-01', '2040-01-01', '9999-12-31']);
  for (const t of tabelas) {
    const colunas = base.all(`PRAGMA table_info(${t})`).map((c) => c.name).filter((c) => /_(INICIO|FIM)_VIGENCIA$/.test(c));
    for (const c of colunas) {
      for (const { v } of base.all(`SELECT DISTINCT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL`)) {
        const d = String(v).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        for (const x of [-1, 0, 1]) { const y = somarDias(d, x); if (y <= '9999-12-31') datas.add(y); }
      }
    }
  }
  return [...datas].sort();
}

export function gerar({ seed = 1, n = 300, base }) {
  const rnd = prng(seed ^ 0xda7a);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const amostra = (a, k) => { const c = [...a]; for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, k); };
  const casos = [];
  // raw characters outside printable ASCII go percent-encoded (UTF-8), as a client would send them
  const add = (caminho, rotulo, headers = {}, metodo = 'GET') => casos.push({
    metodo, caminho: R + caminho.replace(/[^\x21-\x7e]/gu, (c) => encodeURIComponent(c)), headers, rotulo,
  });

  // ── real data ─────────────────────────────────────────────────────────────
  const datas = datasDeBorda(base);
  const datasLeves = datas; // cheap routes: every boundary
  const datasPesadas = amostra(datas, 24).concat(['2026-01-01', '2026-06-01', '2027-01-01', '2025-12-31', '2026-12-31']); // big bodies
  const ufs = base.all('SELECT UF_CD, UF_SIGLA FROM UF ORDER BY UF_CD');
  const municipios = base.all('SELECT MUNI_CD FROM MUNICIPIO ORDER BY MUNI_CD').map((m) => m.MUNI_CD);
  const situacoes = base.all('SELECT SITR_ID, SITR_CD FROM SITUACAO_TRIBUTARIA ORDER BY SITR_ID');
  const csts = [...new Set(situacoes.map((s) => s.SITR_CD))];
  const classificacoes = base.all('SELECT DISTINCT CLTR_CD FROM CLASSIFICACAO_TRIBUTARIA ORDER BY CLTR_CD').map((c) => c.CLTR_CD);
  const vigenciaClass = new Map();
  for (const c of base.all('SELECT CLTR_CD, CLTR_INICIO_VIGENCIA i, CLTR_FIM_VIGENCIA f FROM CLASSIFICACAO_TRIBUTARIA')) {
    if (!vigenciaClass.has(c.CLTR_CD)) vigenciaClass.set(c.CLTR_CD, new Set());
    for (const d of [c.i, c.f]) if (d) for (const x of [-1, 0]) vigenciaClass.get(c.CLTR_CD).add(somarDias(d, x));
  }
  const siglasBanco = base.all('SELECT TPDF_SIGLA FROM TIPO_DFE ORDER BY TPDF_ID').map((t) => t.TPDF_SIGLA);
  const siglasEnum = ['NFEABI', 'NFE', 'NFCE', 'CTE', 'CTEOS', 'CTESIMPLIFICADO', 'BPE', 'BPETA', 'BPETM', 'NF3E', 'NFSE', 'NFSEVIA', 'NFCOM', 'DERE', 'DIR', 'DUIMP', 'NFAG', 'NFGAS'];
  const siglasEstranhas = ['XYZ', 'nfe', 'nf_e', 'N F e', 'NF\te', ' NFe ', 'NFe\u00a0', 'NFSe Via', 'nfs-e via', 'class-trib', 'NF-E', 'nfce', 'CT-e Simplificado', 'İ', 'ß', 'NFɘ', ''];
  const siglasValidade = [...siglasBanco, ...siglasEnum, 'NFe', 'NFSe', 'XYZ', 'nfe', 'nf_e', ' NFe', 'NF%20e', 'NFe%C2%A0'];
  const ncmIs = base.all(`SELECT AARP_NCM_CD c FROM ALIQUOTA_AD_REM_PRODUTO UNION SELECT AAVP_NCM_CD FROM ALIQUOTA_AD_VALOREM_PRODUTO
                          UNION SELECT EAVP_NCM_CD FROM EXCECAO_AD_VALOREM_PRODUTO UNION SELECT EARP_NCM_CD FROM EXCECAO_AD_REM_PRODUTO`).map((r) => r.c);
  const ncmIsCompletos = base.all(`SELECT DISTINCT n.NCM_CD c FROM NCM n JOIN ALIQUOTA_AD_VALOREM_PRODUTO a ON n.NCM_CD LIKE a.AAVP_NCM_CD || '%' WHERE length(n.NCM_CD) = 8`).map((r) => r.c);
  const ncmTodos = base.all('SELECT NCM_CD c FROM NCM').map((r) => r.c);
  const ncmPorTam = (t) => ncmTodos.filter((c) => c.length === t);
  const ncmAnexo = base.all('SELECT DISTINCT NCMA_NCM_CD c FROM NCM_APLICAVEL').map((r) => r.c);
  const ncmExcecao = base.all('SELECT DISTINCT ENCM_NCM_CD c FROM EXCECAO_NCM_APLICAVEL').map((r) => r.c);
  const nbsTodos = base.all('SELECT NBS_CD c FROM NBS').map((r) => r.c);
  const nbsAnexo = base.all('SELECT DISTINCT NBSA_NBS_CD c FROM NBS_APLICAVEL').map((r) => r.c);
  const classNcmAnexo = base.all('SELECT DISTINCT ct.CLTR_CD c FROM NCM_APLICAVEL n JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = n.NCMA_CLTR_ID').map((r) => r.c);
  const classNbsAnexo = base.all('SELECT DISTINCT ct.CLTR_CD c FROM NBS_APLICAVEL n JOIN CLASSIFICACAO_TRIBUTARIA ct ON ct.CLTR_ID = n.NBSA_CLTR_ID').map((r) => r.c);
  const atores = base.all('SELECT ATOR_ID FROM ATOR ORDER BY ATOR_ID').map((a) => a.ATOR_ID);
  const atoresComVinculo = base.all('SELECT DISTINCT ATCL_ATOR_ID a, ATCL_IN_PAPEL p FROM ATOR_CLASSIFICACAO');
  const fornecedores = atoresComVinculo.filter((x) => x.p === 'Fornecedor').map((x) => x.a);
  const adquirentes = atoresComVinculo.filter((x) => x.p === 'Adquirente').map((x) => x.a);

  // ── parameter conversion: dates, Longs, locales ─────────────────────────────
  const DATAS_RUINS = ['', '%20', '%20%20', '%09', '%E2%80%83', '%C2%A0', 'x', '2026-13-01', '2026-02-30', '2026-02-29', '2024-02-29', '2026-1-01', '2026-01-1', '%202026-01-01',
    '2026-01-01%20', '26-01-01', '%2B2026-01-01', '%2B02026-01-01', '%2B12026-01-01', '%2B10000-01-01', '9999-12-31', '-2026-01-01', '-0001-01-01', '0000-01-01',
    '-9998-01-01', '-9999-01-01', '1582-10-10', '2026-01-01Z', '2026-01-01%2B03:00', '01/02/2026', '1/2/26', '31/02/2026', '30/02/2024', '32/01/2026', '01/13/2026',
    '01/02/26', '01/02/0', '01/02/02026', '01/02/1000000000', '01/02/999999999', '001/02/2026', '%EF%BC%92026-01-01', '2026%2F01%2F01', '20260101', 'null', '2026-06-01T00:00:00'];
  const ACCEPT_LANGUAGE = [undefined, '', 'pt-BR', 'pt', 'en-US', 'en', 'en-GB', 'de', 'de-CH', 'fr', 'ja', 'zh-TW', 'zh-CN', 'zh-HK', 'es-MX', 'es', 'ar', 'ru', 'ko', 'sr-Latn',
    'am-Latn', '*', 'pt_BR', 'xx', 'en-US;q=0', 'fr;q=0.5, en-US;q=0.9', 'de;q=0.5,ja;q=0.5', 'en;q=1.5, de', 'en;q=x, ja', ' , ,en-US', 'en-US, pt-BR', 'iw', 'nb',
    'en-AU', 'pt-PT', 'pt-AO', 'hi-Latn', 'i-default', 'EN-us', 'bg', 'hu', 'ko-KR', 'lt', 'sk'];
  const DATAS_LOCAIS = ['1/2/26', '01/02/2026', '1.2.26', '01.02.26', '01.02.2026', '2026/1/2', '26-01-02', '2026-01-02', '2.1.26', '2026. 1. 2.', '26. 1. 2.', '02/01/2026',
    '1/2/2026', '31/12/25', '2.1.2026', '02-01-2026', '1/2/2', '2/1/26', '13/1/26', '29/2/28'];
  const LONGS = ['', '%20', '%20%20', '%E2%80%83', '%1C', '%C2%A0', '43', '%2043%20', '4%203', '0x2B', '0X2b', '%2343', '-0x2B', '%2B0x2B', '0x', '%23', '-%23', '010', '%2B43', '-43',
    '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809', '0x7FFFFFFFFFFFFFFF', '0x8000000000000000', '-0x8000000000000000',
    '99999999999999999999', 'abc', '4.3', '43L', '%EF%BC%94%EF%BC%93', '%D9%A4%D9%A3', '0x%EF%BC%A1', '1e3', '43&codigoUf=x', 'x&codigoUf=43', '&codigoUf=43', '43&codigoUf='];

  // ── fixed routes ─────────────────────────────────────────────────────────
  for (const h of [{}, { accept: 'application/json' }, { accept: 'text/plain' }, { accept: '*/*' }, { accept: 'application/xml' }]) add('/ufs', 'ufs', h);
  add('/ufs', 'ufs-head', {}, 'HEAD');
  add('/ufs/', 'ufs-barra');
  add('/Ufs', 'ufs-caixa');
  for (const p of ['/versao', '/redutores-compra-governamental', '/transferencias-cbs', '/transferencias-ibs', '/versao?x=1']) add(p, 'fixa');
  for (const p of ['/ufs?a=%ZZ', '/versao?a=%ZZ', '/transferencias-ibs?a=%ZZ']) add(p, 'fixa-consulta-ruim');

  // ── UF / municípios ──────────────────────────────────────────────────────
  for (const u of ufs) {
    add(`/ufs/municipios?siglaUf=${u.UF_SIGLA}`, 'municipios');
    add(`/ufs/municipios?siglaUf=${u.UF_SIGLA.toLowerCase()}`, 'municipios-minusculas');
  }
  for (const s of ['', '%20', 'XX', 'S', 'SPP', '%20SP', 'Sp', 'SP,RJ', 'S%C3%83O', 'sP']) add(`/ufs/municipios?siglaUf=${s}`, 'municipios-sigla');
  for (const q of ['', 'siglaUf', 'siglaUf=SP&siglaUf=RJ', 'siglauf=SP', 'siglaUf=%ZZ', 'siglaUf=SP&data=2026-01-01', 'siglaUf=sp&siglaUf=']) add(`/ufs/municipios?${q}`, 'municipios-consulta');
  add('/ufs/municipios?siglaUf=SP', 'municipios-head', {}, 'HEAD');

  // ── situações tributárias / CSTs com classificações ───────────────────────────
  for (const d of datasLeves) {
    add(`/situacoes-tributarias/imposto-seletivo?data=${d}`, 'situacoes-is');
    add(`/situacoes-tributarias/cbs-ibs?data=${d}`, 'csts-cbs-ibs');
    add(`/situacoes-tributarias/is?data=${d}`, 'csts-is');
  }
  for (const d of ['2026-01-01', '2026-06-01', '2027-01-01', '2025-12-31']) {
    for (const s of [...siglasBanco, ...siglasEnum, ...siglasEstranhas]) {
      add(`/situacoes-tributarias/cbs-ibs?data=${d}&siglaDfe=${enc(s)}`, 'csts-cbs-ibs-sigla');
      add(`/situacoes-tributarias/is?data=${d}&siglaDfe=${enc(s)}`, 'csts-is-sigla');
    }
  }
  for (const q of ['', 'siglaDfe=NFe', 'data=2026-01-01&siglaDfe=NFe&siglaDfe=NFSe', 'data=2026-01-01&siglaDfe', 'data=2026-01-01&siglaDfe=%20', 'data=2026-01-01&siglaDfe=%E2%80%83',
    'data=2026-01-01&siglaDfe=%1C', 'data=%2B10000-01-01&siglaDfe=CTe', 'data=%2B10000-01-01&siglaDfe=NFe', 'data=%2B10000-01-01']) {
    add(`/situacoes-tributarias/cbs-ibs?${q}`, 'csts-cbs-ibs-consulta');
    add(`/situacoes-tributarias/is?${q}`, 'csts-is-consulta');
  }

  // ── classificações por id da situação (deprecated) / por CST ───────────────────
  for (const s of situacoes) for (const d of ['2026-01-01', '2026-06-01', '2027-01-01', '2025-12-31', '2026-12-31', pick(datas)]) add(`/classificacoes-tributarias/${s.SITR_ID}?data=${d}`, 'classificacoes-por-id');
  for (const id of ['0', '26', '-1', '%201', '%20', '0x1', '%2319', 'abc', '99999999999999999999', '9223372036854775807', '1.0', '%EF%BC%91', 'is', 'nbs-aplicavel', 'NCM-aplicavel']) {
    add(`/classificacoes-tributarias/${id}?data=2026-01-01`, 'classificacoes-por-id-var');
    add(`/classificacoes-tributarias/${id}?data=x`, 'classificacoes-por-id-var-data');
    add(`/classificacoes-tributarias/${id}`, 'classificacoes-por-id-var-sem-data');
  }
  for (const cst of [...csts, '0', '0000', 'abc', '%20000', '000%20', 'ABC']) {
    for (const d of ['2026-01-01', '2026-06-01', '2027-01-01', '2025-12-31']) {
      add(`/classificacoes-tributarias/imposto-seletivo/${cst}?data=${d}`, 'classificacoes-is-cst');
      add(`/classificacoes-tributarias/cbs-ibs/${cst}?data=${d}`, 'classificacoes-cbs-ibs-cst');
    }
  }

  // ── classificações CBS/IBS (lista, por atores) e IS (lista) ──────────────────
  for (const d of datasPesadas) {
    add(`/classificacoes-tributarias/cbs-ibs?data=${d}`, 'classificacoes-cbs-ibs');
    add(`/classificacoes-tributarias/imposto-seletivo?data=${d}`, 'classificacoes-is');
    add(`/classificacoes-tributarias/cbs-ibs/por-atores?data=${d}`, 'por-atores-sem-filtro');
  }
  for (const d of datasLeves) add(`/classificacoes-tributarias/imposto-seletivo?data=${d}`, 'classificacoes-is-todas-datas');
  const datasAtores = ['2026-01-01', '2026-06-01', '2027-01-01', '2025-12-31'];
  for (const d of datasAtores) {
    for (const f of [...amostra(fornecedores, 6), 9999, null]) {
      for (const a of [...amostra(adquirentes, 3), null]) {
        for (const s of [null, 'NFSE', 'NFe', 'XYZ', '']) {
          const q = [`data=${d}`];
          if (f != null) q.push(`fornecedor=${f}`);
          if (a != null) q.push(`adquirente=${a}`);
          if (s != null) q.push(`siglaDfe=${enc(s)}`);
          if (f == null && a == null && s == null) continue;
          add(`/classificacoes-tributarias/cbs-ibs/por-atores?${q.join('&')}`, 'por-atores');
        }
      }
    }
  }
  for (const q of ['data=2027-01-01&fornecedor=27&adquirente=28&siglaDfe=NFSE', 'data=2027-01-01&fornecedor=%20&adquirente=28', 'data=2027-01-01&fornecedor=x',
    'data=2027-01-01&fornecedor=27&adquirente=x', 'data=x&fornecedor=x', 'fornecedor=27', 'data=2027-01-01&fornecedor=0x1B', 'data=2027-01-01&fornecedor=27&fornecedor=x',
    'data=2027-01-01&fornecedor=x&fornecedor=27', 'data=2027-01-01&siglaDfe=nfs-e', 'data=2027-01-01&siglaDfe=NFSE&siglaDfe=NFE', 'data=2027-01-01&adquirente=-1',
    'data=2027-01-01&fornecedor=9223372036854775808']) add(`/classificacoes-tributarias/cbs-ibs/por-atores?${q}`, 'por-atores-consulta');

  // ── classificação por código ───────────────────────────────────────────────
  for (const c of [...classificacoes, 'XXXXXX', '00000', '0000001', 'abcdef', '%20000001', '000001%20']) {
    const ds = new Set(['2026-01-01', '2026-06-01', '2027-01-01', ...(vigenciaClass.get(c) ?? [])]);
    for (const d of ds) add(`/classificacoes-tributarias/cbs-ibs/class-trib/${c}?data=${d}`, 'class-trib-cbs-ibs');
    for (const d of ['2026-12-31', '2027-01-01', '2028-06-15']) add(`/classificacoes-tributarias/is/class-trib/${c}?data=${d}`, 'class-trib-is');
  }
  add('/classificacoes-tributarias/cbs-ibs/class-trib/000001', 'class-trib-sem-data');
  add('/classificacoes-tributarias/cbs-ibs/class-trib/', 'class-trib-vazio');
  add('/classificacoes-tributarias/is/class-trib/000001?data=', 'class-trib-is-data-vazia');

  // ── NBS → classificações ─────────────────────────────────────────────────
  for (const nbs of [...nbsAnexo, ...amostra(nbsTodos.filter((x) => x.length === 9), 30)]) {
    for (const d of ['2026-01-01', '2026-06-01', '2027-01-01']) add(`/classificacoes-tributarias/nbs?nbs=${nbs}&data=${d}`, 'nbs-classificacoes');
  }
  for (const nbs of ['', '1', '12345678', '1234567890', 'abcdefghi', '%20114052200', '114052200%20', '999999999', '114052200&nbs=114052200', '\uff11\uff11\uff14\uff10\uff15\uff12\uff12\uff10\uff10']) {
    add(`/classificacoes-tributarias/nbs?nbs=${nbs}&data=2026-06-01`, 'nbs-classificacoes-padrao');
    add(`/classificacoes-tributarias/nbs?nbs=${nbs}&data=x`, 'nbs-classificacoes-padrao-data');
    add(`/classificacoes-tributarias/nbs?nbs=${nbs}`, 'nbs-classificacoes-padrao-sem-data');
  }
  add('/classificacoes-tributarias/nbs?data=2026-06-01', 'nbs-classificacoes-sem-nbs');
  add('/classificacoes-tributarias/nbs?nbs=114052200&data=%2B10000-01-01', 'nbs-classificacoes-ano-5');

  // ── NCM / NBS ──────────────────────────────────────────────────────────────
  const ncms = [...new Set([...ncmIs, ...ncmIsCompletos.slice(0, 40), ...amostra(ncmPorTam(2), 6), ...amostra(ncmPorTam(4), 10), ...amostra(ncmPorTam(6), 10),
    ...amostra(ncmPorTam(7), 10), ...amostra(ncmPorTam(8), 40), '22030000', '24021000', '24022000', '99999999', '00000000', '2402', '240210', '24021'])];
  for (const ncm of ncms) for (const d of ['2026-06-01', '2027-01-01', pick(datas)]) add(`/ncm?ncm=${ncm}&data=${d}`, 'ncm');
  for (const ncm of ['', 'abc', '2402100a', '%202402', '2402%20', '24.02', '-2402', '\uff12\uff14\uff10\uff12', '240210001', '24021000&ncm=22030000']) {
    add(`/ncm?ncm=${ncm}&data=2027-01-01`, 'ncm-invalido');
    add(`/ncm?ncm=${ncm}&data=x`, 'ncm-invalido-data');
  }
  add('/ncm?data=2027-01-01', 'ncm-sem-ncm');
  add('/ncm?ncm=24021000', 'ncm-sem-data');
  add('/ncm?ncm=24021000&data=%2B10000-01-01', 'ncm-ano-5');
  add('/ncm?ncm=abc&data=%2B10000-01-01', 'ncm-invalido-ano-5');
  const nbss = [...new Set([...nbsAnexo.slice(0, 20), ...amostra(nbsTodos, 50), '114052200', '102020000', '1', '11', '999999999'])];
  for (const nbs of nbss) for (const d of ['2026-06-01', '2027-01-01', pick(datas)]) add(`/nbs?nbs=${nbs}&data=${d}`, 'nbs');
  for (const nbs of ['', 'abc', '1140522o0', '%20114052200', '\uff11\uff11\uff14']) add(`/nbs?nbs=${nbs}&data=2027-01-01`, 'nbs-invalido');
  for (const d of datasPesadas.slice(0, 16)) add(`/nbs/lista?data=${d}`, 'nbs-lista');
  for (const d of ['2026-06-01', '2026-01-31', '2026-02-01', '2026-02-02', '2025-12-31', '1900-01-01', '2026-01-01Z', '2026-01-01z', '2026-01-01%2B19:00', '2026-01-01-03:00',
    '2026-01-01%2B05:00:30', '2026-01-01%2B05', '2026-01-01%2B0500', '2026-01-01%2B24:00', '2026-01-01%2B23:60', '2026-01-01%2B05:00:3', '01/02/2026', '%2B02026-01-01',
    '-2026-01-01', '2026-01-01Zx', '2026-01-01ZZ', '', '%20', 'x']) add(`/ncm/vigentes?data=${d}`, 'ncm-vigentes');
  add('/ncm/vigentes', 'ncm-vigentes-sem-data');
  add('/ncm/vigentes?data=01/02/2026', 'ncm-vigentes-locale', { 'accept-language': 'pt-BR' });

  // ── NBS aplicáveis por classificação ─────────────────────────────────────────
  for (const c of classificacoes) for (const d of ['2026-06-01', '2027-01-01']) add(`/nbs-aplicaveis?cClassTrib=${c}&data=${d}`, 'nbs-aplicaveis');
  for (const c of ['', '1', '00000', '0000001', 'abcdef', '%20000001', '000001,000002', '000001&cClassTrib=000002', '\uff19\uff19\uff19\uff19\uff19\uff19', 'XXXXXX']) {
    add(`/nbs-aplicaveis?cClassTrib=${c}&data=2026-06-01`, 'nbs-aplicaveis-padrao');
    add(`/nbs-aplicaveis?cClassTrib=${c}`, 'nbs-aplicaveis-sem-data');
  }
  add('/nbs-aplicaveis?cClassTrib=999999&data=2026-06-01', 'nbs-aplicaveis-404');

  // ── fundamentações legais ─────────────────────────────────────────────────
  for (const d of datasPesadas.slice(0, 18)) add(`/fundamentacoes-legais?data=${d}`, 'fundamentacoes');

  // ── alíquotas ───────────────────────────────────────────────────────────
  for (const d of datasLeves) {
    add(`/aliquota-uniao?data=${d}`, 'aliquota-uniao');
    add(`/aliquota-uf?codigoUf=${pick(ufs).UF_CD}&data=${d}`, 'aliquota-uf');
    add(`/aliquota-municipio?codigoMunicipio=${pick(municipios)}&data=${d}`, 'aliquota-municipio');
  }
  for (const u of ufs) add(`/aliquota-uf?codigoUf=${u.UF_CD}&data=2026-06-01`, 'aliquota-uf-todas');
  for (const m of amostra(municipios, 40)) add(`/aliquota-municipio?codigoMunicipio=${m}&data=2026-06-01`, 'aliquota-municipio-amostra');
  for (const v of LONGS) {
    add(`/aliquota-uf?codigoUf=${v}&data=2026-06-01`, 'aliquota-uf-long');
    add(`/aliquota-municipio?codigoMunicipio=${v}&data=2027-06-01`, 'aliquota-municipio-long');
  }
  for (const q of ['', 'data=2026-06-01', 'codigoUf=43', 'codigoUf=x&data=x', 'codigoUf=43&data=x', 'codigoUf=43&data=', 'codigoUf=43&data=2026-06-01&data=x',
    'codigoUf=43&data=x&data=2026-06-01', 'codigoUf=43&data=&data=2026-06-01', 'codigoUf=43&data=%2B10000-01-01']) add(`/aliquota-uf?${q}`, 'aliquota-uf-consulta');

  // ── datas: formatos e locales (rota que ecoa a data: 404 com a data na mensagem) ───────────
  for (const d of DATAS_RUINS) {
    add(`/classificacoes-tributarias/cbs-ibs/class-trib/XXXXXX?data=${d}`, 'data-formato');
    add(`/classificacoes-tributarias/cbs-ibs/class-trib/000001?data=${d}`, 'data-formato-000001');
  }
  for (const al of ACCEPT_LANGUAGE) {
    for (const d of DATAS_LOCAIS) {
      add(`/classificacoes-tributarias/cbs-ibs/class-trib/XXXXXX?data=${enc(d)}`, `data-locale ${al}`, al === undefined ? {} : { 'accept-language': al });
    }
  }
  for (let i = 0; i < Math.max(60, Math.floor(n / 3)); i++) {
    const al = pick(ACCEPT_LANGUAGE);
    const sep = pick(['/', '.', '-', '. ', ' ']);
    const partes = [String(1 + Math.floor(rnd() * 32)), String(1 + Math.floor(rnd() * 13)), pick(['26', '2026', '0', '99', '1', '12026', '02026'])];
    const zero = (s) => (rnd() < 0.5 && s.length === 1 ? `0${s}` : s);
    const ordem = pick([[0, 1, 2], [1, 0, 2], [2, 1, 0], [2, 0, 1]]);
    const d = ordem.map((k) => (k < 2 ? zero(partes[k]) : partes[k])).join(sep) + (rnd() < 0.2 ? '.' : '');
    add(`/classificacoes-tributarias/cbs-ibs/class-trib/XXXXXX?data=${enc(d)}`, `data-locale-aleatoria ${al}`, al === undefined ? {} : { 'accept-language': al });
  }

  // ── validade DFe × classificação ────────────────────────────────────────────
  for (const c of classificacoes) {
    for (const s of ['NFe', 'NFSe', pick(siglasValidade)]) add(`/classificacoes-tributarias/cbs-ibs/${s}/${c}?data=2026-06-01`, 'validade');
    add(`/classificacoes-tributarias/cbs-ibs/${pick(siglasValidade)}/${c}?data=${pick(['2026-01-01', '2027-01-01', '2025-12-31'])}`, 'validade-data');
  }
  for (const s of siglasValidade) {
    add(`/classificacoes-tributarias/cbs-ibs/${s}/510001?data=2026-06-01`, 'validade-sigla');
    add(`/classificacoes-tributarias/cbs-ibs/${s}/XXXXXX?data=2026-06-01`, 'validade-sigla-404');
  }

  // ── grupos de DF-e / atores ─────────────────────────────────────────────────
  for (const d of datasLeves) add(`/dfe/grupos?data=${d}`, 'dfe-grupos');
  for (const q of ['', 'data=', 'data=%20', 'data=x', 'data=2026-06-01&data=x', 'data=%2B10000-01-01', 'data=-2026-01-01', 'data=1500-01-01']) add(`/dfe/grupos${q ? `?${q}` : ''}`, 'dfe-grupos-consulta');
  for (const d of datasLeves) {
    add(`/ator/grupos?data=${d}`, 'ator-grupos');
    add(`/ator/grupos?data=${d}&papel=${pick(['FORNECEDOR', 'ADQUIRENTE'])}`, 'ator-grupos-papel');
  }
  for (const p of ['FORNECEDOR', 'ADQUIRENTE', 'fornecedor', 'Fornecedor', '%20FORNECEDOR%20', '', '%20', '%E2%80%83', 'FORNECEDOR%E2%80%83', 'X', 'FORNECEDOR&papel=x', 'x&papel=FORNECEDOR',
    '%09ADQUIRENTE', 'ADQUIRENTE%00']) add(`/ator/grupos?data=2027-01-01&papel=${p}`, 'ator-grupos-papel-var');
  add('/ator/grupos', 'ator-grupos-sem-data');
  add('/ator/grupos?papel=FORNECEDOR&data=x', 'ator-grupos-data-ruim');

  // ── nomenclatura ─────────────────────────────────────────────────────────
  for (const c of classificacoes) {
    for (const s of ['NFe', 'NFCe', 'NFSe', 'CTe', pick([...siglasBanco, ...siglasEnum])]) add(`/nomenclatura/${s}/${c}?data=2026-06-01`, 'nomenclatura');
    add(`/nomenclatura/${pick(['NFe', 'NFSe', 'XYZ'])}/${c}?data=${pick(['2026-01-01', '2027-01-01', '2025-12-31', pick(datas)])}`, 'nomenclatura-data');
  }
  for (const s of [...siglasValidade, 'nfse', 'NFS_e', 'N%20F%20S%20e']) {
    add(`/nomenclatura/${s}/200038?data=2026-06-01`, 'nomenclatura-sigla');
    add(`/nomenclatura/${s}/515001?data=2026-06-01`, 'nomenclatura-sigla-515001');
    add(`/nomenclatura/${s}/XXXXXX?data=2026-06-01`, 'nomenclatura-sigla-404');
  }
  add('/nomenclatura/NFe/000001', 'nomenclatura-sem-data');
  add('/nomenclatura/NFe', 'nomenclatura-curta');

  // ── NBS / NCM aplicável ──────────────────────────────────────────────────
  const nbsVal = [...nbsAnexo, ...amostra(nbsTodos.filter((x) => x.length === 9), 10), '000000000', '999999999'];
  for (const c of [...classNbsAnexo, '000001', '200028', 'XXXXXX']) {
    for (const nbs of amostra(nbsVal, 12)) add(`/classificacoes-tributarias/nbs-aplicavel?cClassTrib=${c}&nbs=${nbs}&dataOcorrenciaFatoGerador=${pick(['2026-01-01', '2026-06-01', '2027-01-01'])}`, 'nbs-aplicavel');
  }
  const ncmVal = [...amostra(ncmAnexo.map((x) => x.padEnd(8, '0')), 30), ...ncmExcecao.map((x) => x.padEnd(8, '0')).slice(0, 20), ...amostra(ncmPorTam(8), 10), '00000000', '99999999'];
  for (const c of [...classNcmAnexo, '000001', '200038', 'XXXXXX']) {
    for (const ncm of amostra(ncmVal, 10)) add(`/classificacoes-tributarias/ncm-aplicavel?cClassTrib=${c}&ncm=${ncm}&dataOcorrenciaFatoGerador=${pick(['2026-01-01', '2026-06-01', '2027-01-01'])}`, 'ncm-aplicavel');
  }
  for (const [rota, campo, tam] of [['nbs-aplicavel', 'nbs', 9], ['ncm-aplicavel', 'ncm', 8]]) {
    for (const v of ['', 'abc', '1'.repeat(tam - 1), '1'.repeat(tam + 1), `%20${'1'.repeat(tam)}`, '\uff11'.repeat(tam), '1'.repeat(tam)]) {
      add(`/classificacoes-tributarias/${rota}?cClassTrib=200028&${campo}=${v}&dataOcorrenciaFatoGerador=2026-06-01`, `${rota}-valor`);
      add(`/classificacoes-tributarias/${rota}?cClassTrib=XXXXXX&${campo}=${v}&dataOcorrenciaFatoGerador=2026-06-01`, `${rota}-valor-404`);
    }
    for (const q of ['', `cClassTrib=200028`, `cClassTrib=200028&${campo}=1`, `${campo}=1&dataOcorrenciaFatoGerador=2026-06-01`, `cClassTrib=200028&${campo}=${'1'.repeat(tam)}&data=2026-06-01`,
      `cClassTrib=200028&${campo}=${'1'.repeat(tam)}&dataOcorrenciaFatoGerador=x`, `cClassTrib=200028&${campo}=${'1'.repeat(tam)}&dataOcorrenciaFatoGerador=%2B10000-01-01`,
      `cClassTrib=200028&${campo}=abc&dataOcorrenciaFatoGerador=%2B10000-01-01`]) add(`/classificacoes-tributarias/${rota}?${q}`, `${rota}-consulta`);
  }

  // ── random extras: a route with random valid/invalid parameters ───────────────────
  const geradores = [
    () => `/classificacoes-tributarias/cbs-ibs/class-trib/${pick(classificacoes)}?data=${pick(datas)}`,
    () => `/classificacoes-tributarias/is/class-trib/${pick(classificacoes)}?data=${pick(datas)}`,
    () => `/nomenclatura/${enc(pick([...siglasBanco, ...siglasEnum, ...siglasEstranhas]) || 'x')}/${pick(classificacoes)}?data=${pick(datas)}`,
    () => `/classificacoes-tributarias/cbs-ibs/${enc(pick([...siglasBanco, ...siglasEnum]))}/${pick(classificacoes)}?data=${pick(datas)}`,
    () => `/classificacoes-tributarias/${pick(situacoes).SITR_ID}?data=${pick(datas)}`,
    () => `/classificacoes-tributarias/cbs-ibs/${pick(csts)}?data=${pick(datas)}`,
    () => `/ncm?ncm=${pick(ncms)}&data=${pick(datas)}`,
    () => `/nbs?nbs=${pick(nbss)}&data=${pick(datas)}`,
    () => `/nbs-aplicaveis?cClassTrib=${pick(classificacoes)}&data=${pick(datas)}`,
    () => `/classificacoes-tributarias/nbs?nbs=${pick(nbsAnexo)}&data=${pick(datas)}`,
    () => `/ufs/municipios?siglaUf=${pick(ufs).UF_SIGLA}`,
    () => `/aliquota-municipio?codigoMunicipio=${pick(municipios)}&data=${pick(datas)}`,
    () => `/ator/grupos?data=${pick(datas)}${rnd() < 0.5 ? `&papel=${pick(['FORNECEDOR', 'ADQUIRENTE'])}` : ''}`,
    () => `/classificacoes-tributarias/ncm-aplicavel?cClassTrib=${pick(classNcmAnexo)}&ncm=${pick(ncmVal)}&dataOcorrenciaFatoGerador=${pick(datas)}`,
    () => `/classificacoes-tributarias/nbs-aplicavel?cClassTrib=${pick(classNbsAnexo)}&nbs=${pick(nbsVal)}&dataOcorrenciaFatoGerador=${pick(datas)}`,
    () => `/classificacoes-tributarias/cbs-ibs/por-atores?data=${pick(datasAtores)}&fornecedor=${pick(atores)}&adquirente=${pick(atores)}`,
  ];
  for (let i = 0; i < n; i++) add(pick(geradores)(), 'aleatorio');
  // a few with an Accept header / HEAD on parameterized routes
  for (let i = 0; i < 20; i++) add(pick(geradores)(), 'aleatorio-accept', { accept: pick(['application/json', 'text/html', 'application/*', 'application/xml', 'application/problem+json']) });
  for (let i = 0; i < 10; i++) add(pick(geradores)(), 'aleatorio-head', {}, 'HEAD');
  return casos;
}
