// Review fixes in invoice reading (batch C-notas): DANFSe regex bound (DOS-2), PDF decompression and
// time limits (DOS-4/SEC-4), cancellation events (F12/R2), Simples-only warnings (F11), uploader
// pause on 429 (F8) and a malformed x-filename (F9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { deflateSync, createDeflate, constants } from 'node:zlib';
import { subir } from '../lib/servidor.js';
import { parsePercent, gridFromItems, parseDanfse } from '../../src/notas/danfse-pdf.js';
import { verificarPdf, lerDanfseIsolado, LIMITE_DESCOMPACTADO, MAX_FILA_PDF, MAX_FILA_PDF_CLIENTE, FilaPdfCheia } from '../../src/notas/pdf-items.js';
import { lerEventoCancelamento, marcarEmitentesDiferentes } from '../../src/notas/notas.js';
import { receberLeitura } from '../../public/js/simples.js';

const fx = (f) => readFileSync(new URL(`../fixtures/notas/${f}`, import.meta.url));
const nota = (s, bytes, nome = 'nota.xml') => s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': encodeURIComponent(nome) }, body: Buffer.from(bytes) });

/** One-page PDF whose /Contents stream has `dict` (LEN = data length) and `dados`. */
function pdf(dict, dados) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    Buffer.concat([Buffer.from(`${dict.replace('LEN', dados.length)}\nstream\n`), dados, Buffer.from('\nendstream')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let b = Buffer.from('%PDF-1.4\n');
  const offs = [];
  objs.forEach((o, i) => { offs.push(b.length); b = Buffer.concat([b, Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n')]); });
  const xref = b.length;
  return Buffer.concat([b, Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}
const TEXTO = Buffer.from('BT /F1 8 Tf 50 780 Td (DANFSe) Tj ET');
const flate = (b) => deflateSync(b, { level: 9 });
const bomba = () => flate(Buffer.concat([Buffer.alloc(LIMITE_DESCOMPACTADO + (1 << 20), 0x20), TEXTO])); // 33 MiB → ~33 KB
/** ASCII85 encoding (with the ~> end), as old generators wrap Flate data. */
function ascii85(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 4) {
    const g = Buffer.alloc(4);
    b.copy(g, 0, i, i + 4);
    let t = g.readUInt32BE(0);
    const n = Math.min(4, b.length - i);
    if (t === 0 && n === 4) { s += 'z'; continue; }
    const c = [];
    for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + (t % 85))); t = Math.floor(t / 85); }
    s += c.join('').slice(0, n + 1);
  }
  return Buffer.from(`${s}~>`);
}

test('DOS-2: parsePercent and DANFSe cells stay linear on a long run of digits', async () => {
  assert.equal(parsePercent('5,00%'), '5.00');
  assert.equal(parsePercent('2,5 %'), '2.5');
  let t0 = performance.now();
  assert.equal(parsePercent('1'.repeat(200_000)), null);
  assert.ok(performance.now() - t0 < 200, `parsePercent took ${performance.now() - t0} ms`);
  assert.equal(gridFromItems([{ x: 0, y: 0, str: '9'.repeat(10_000) }]).cells[0].str.length, 2000);

  // end to end: the 866-byte DANFSe of the report (200k '1's under "Aliquota Aplicada") took 18 s
  const conteudo = Buffer.from(`BT /F1 8 Tf 50 780 Td (DANFSe) Tj ET BT /F1 8 Tf 50 700 Td (Aliquota Aplicada) Tj ET BT /F1 0.0004 Tf 50 690 Td (${'1'.repeat(200_000)}) Tj ET`);
  const s = await subir({});
  try {
    t0 = performance.now();
    const r = await nota(s, pdf('<< /Length LEN /Filter /FlateDecode >>', flate(conteudo)), 'pct.pdf');
    assert.equal(r.status, 200);
    assert.equal(r.json.nota.issAliquota, null);
    assert.ok(performance.now() - t0 < 3000, `upload took ${performance.now() - t0} ms`);
  } finally { await s.fechar(); }
});

test('DOS-4/SEC-4: decompression is capped before pdf.js, whatever the PDF claims', async () => {
  const b = bomba();
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter /FlateDecode >>', b)), /grande demais/);
  // chained filters, #-escaped filter name, indirect /Filter and a lying /Length
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter [/FlateDecode /FlateDecode] >>', flate(b))), /grande demais/);
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter /Flate#44ecode >>', b)), /grande demais/);
  await assert.rejects(verificarPdf(pdf('<< /Length 3 /Filter 9 0 R >>', b)), /grande demais/);
  // "endstream" inside the compressed data (a stored block) before the bomb
  const z = createDeflate({ level: 0 });
  const partes = [];
  z.on('data', (c) => partes.push(c));
  const fim = new Promise((r) => z.on('end', r));
  z.write(Buffer.from('\nendstream\nendobj\n'));
  z.flush(constants.Z_FULL_FLUSH, () => {});
  await new Promise((r) => z.params(9, 0, r));
  z.end(Buffer.alloc(LIMITE_DESCOMPACTADO + (1 << 20), 0x20));
  await fim;
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter /FlateDecode >>', Buffer.concat(partes))), /grande demais/);
  // ASCII85 / ASCIIHex in front of Flate are decoded too (Illustrator-style), small ones pass
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter [/ASCII85Decode /FlateDecode] >>', ascii85(b))), /grande demais/);
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter [/AHx /Fl] >>', Buffer.from(`${b.toString('hex')}>`))), /grande demais/);
  await verificarPdf(pdf('<< /Length LEN /Filter [/ASCII85Decode /FlateDecode] >>', ascii85(flate(TEXTO))));
  // filters it does not decode and encryption are refused
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter /LZWDecode >>', Buffer.from('x'))), /não lê/);
  await assert.rejects(verificarPdf(pdf('<< /Length LEN /Filter /R#4C >>', Buffer.from('x'))), /não lê/);
  await assert.rejects(verificarPdf(Buffer.concat([pdf('<< /Length LEN >>', TEXTO), Buffer.from('trailer << /Encrypt 7 0 R >>')])), /não lê/);
  // a normal page passes
  await verificarPdf(pdf('<< /Length LEN /Filter /FlateDecode >>', flate(TEXTO)));
});

test('DOS-4/SEC-4: POST /api/notas answers 422 to a Flate bomb at once and caps the body', async () => {
  const s = await subir({});
  try {
    const bytes = pdf('<< /Length LEN /Filter /FlateDecode >>', bomba());
    const t0 = performance.now();
    const [r, saude] = await Promise.all([nota(s, bytes, 'bomba.pdf'), s.chamar('/api/saude')]);
    assert.equal(r.status, 422);
    assert.match(r.json.erro, /grande demais/);
    assert.equal(saude.status, 200);
    assert.ok(performance.now() - t0 < 3000);
    // the limit was 15 MB (2.5 MB was read and answered 422); now 413, or a reset while the client still writes
    const grande = await s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': 'grande.pdf', connection: 'close' }, body: Buffer.alloc(2.5 * 1024 * 1024, 0x20) })
      .catch((e) => ({ status: e.code }));
    assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(grande.status), String(grande.status));
  } finally { await s.fechar(); }
});

test('DOS-4: pdf.js runs in a worker with a time limit, and the next PDF still reads', async () => {
  const bytes = new Uint8Array(pdf('<< /Length LEN /Filter /FlateDecode >>', flate(TEXTO)));
  await assert.rejects(lerDanfseIsolado(bytes.slice(), { tempo: 1 }), /demorou demais/);
  const nf = await lerDanfseIsolado(bytes.slice());
  assert.equal(nf.tipo, 'NFS-e');
  const dir = new URL('../fixtures/private/', import.meta.url);
  const real = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.pdf')) : null;
  if (real) assert.match((await lerDanfseIsolado(new Uint8Array(readFileSync(new URL(real, dir))))).chave, /^\d{50}$/);
});

// ── F12 / R2: cancellation ──────────────────────────────────────────────────
const CHAVE_NFE = '21250911111111000111558890000000051003360290';
const eventoNfe = ({ tp = '110111', cStat = '135', chave = CHAVE_NFE } = {}) => `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento versao="1.00"><infEvento Id="ID${tp}${chave}01"><cOrgao>21</cOrgao><tpAmb>1</tpAmb><CNPJ>11111111000111</CNPJ><chNFe>${chave}</chNFe><dhEvento>2025-09-02T10:00:00-03:00</dhEvento><tpEvento>${tp}</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>121250000000001</nProt><xJust>Erro na emissao da nota fiscal</xJust></detEvento></infEvento></evento><retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><cStat>${cStat}</cStat><chNFe>${chave}</chNFe><tpEvento>${tp}</tpEvento></infEvento></retEvento></procEventoNFe>`;
const CHAVE_NFSE = '41137002211111111000111000000000022826054848833960';
const eventoNfse = (grupo = 'e101101') => `<?xml version="1.0" encoding="UTF-8"?><evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infEvento Id="EVT${CHAVE_NFSE}1011010001"><nSeqEvento>1</nSeqEvento><pedRegEvento versao="1.00"><infPedReg Id="PRE${CHAVE_NFSE}101101001"><tpAmb>1</tpAmb><verAplic>1</verAplic><dhEvento>2026-05-20T10:00:00-03:00</dhEvento><CNPJAutor>11111111000111</CNPJAutor><chNFSe>${CHAVE_NFSE}</chNFSe><nPedRegEvento>1</nPedRegEvento><${grupo}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro na emissao</xMotivo></${grupo}></infPedReg></pedRegEvento></infEvento></evento>`;

test('F12/R2: POST /api/notas reads cancellation events of NF-e/NFC-e and NFS-e', async () => {
  const s = await subir({});
  try {
    const r = await nota(s, eventoNfe(), 'canc.xml');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { evento: { tipo: 'cancelamento', chave: CHAVE_NFE, descricao: 'Cancelamento de NF-e/NFC-e' } });
    const r2 = await nota(s, eventoNfse(), 'canc-nfse.xml');
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.json.evento, { tipo: 'cancelamento', chave: CHAVE_NFSE, descricao: 'Cancelamento de NFS-e' });
    // refused by SEFAZ, or an event that does not cancel: the note stands, with a message
    const recusado = await nota(s, eventoNfe({ cStat: '573' }));
    assert.equal(recusado.status, 422);
    assert.match(recusado.json.erro, /não registrado.*573/);
    assert.match((await nota(s, eventoNfe({ tp: '110110' }))).json.erro, /não é de cancelamento/);
    assert.match((await nota(s, eventoNfse('e202201'))).json.erro, /não é de cancelamento/);
    // an NF-e exported after cancellation (protNFe cStat 101) and a note bundled with its event
    const cancelada = await nota(s, fx('oficiais/nfce_valido.xml').toString().replace('<cStat>100</cStat>', '<cStat>101</cStat>'));
    assert.equal(cancelada.json.nota.ignorar, 'nota cancelada');
    const valido = fx('oficiais/nfe_valido.xml').toString();
    assert.equal((await nota(s, valido)).json.nota.ignorar, null);
    const junto = valido.replace(/(<\/\w+>\s*)$/, `${eventoNfe().replace(/^<\?xml[^>]*>/, '')}$1`); // event inside the root
    assert.equal((await nota(s, junto)).json.nota.ignorar, 'nota cancelada');
  } finally { await s.fechar(); }
  assert.equal(lerEventoCancelamento(fx('oficiais/nfe_valido.xml').toString()), null);
});

test('F12: the Simples panel marks the cancelled note, also when the event comes first', async () => {
  const s = await subir({});
  try {
    const n = (await nota(s, fx('oficiais/nfe_valido.xml'))).json.nota;
    const ev = (await nota(s, eventoNfe())).json.evento;
    const estado = { notas: [], canceladas: new Set() };
    assert.deepEqual(receberLeitura(estado, [], [ev]), { lidas: 0, repetidas: 0, canceladas: 0 });
    assert.deepEqual(receberLeitura(estado, [structuredClone(n)], []), { lidas: 1, repetidas: 0, canceladas: 1 });
    assert.equal(estado.notas[0].ignorar, 'cancelada (evento de cancelamento enviado)');
    const outro = { notas: [structuredClone(n)], canceladas: new Set() };
    assert.equal(receberLeitura(outro, [], [ev]).canceladas, 1);
    // and the calculation leaves it out, saying why
    const nf = { ...estado.notas[0], atividade: 'industria' };
    const calc = await s.chamar('/api/simples/calcular', { method: 'POST', body: { notas: [nf], empresa: { [nf.competencia]: { rbt12: '100000' } }, simularReforma: false } });
    assert.equal(calc.status, 200);
    assert.match(calc.json.meses[0].pendencias.join(' '), /cancelada \(evento de cancelamento enviado\)/);
  } finally { await s.fechar(); }
});

test('F11: Simples-only warnings do not go to the shared avisos (Regime Regular panel)', async () => {
  const s = await subir({});
  try {
    const x = fx('nfe-exemplo.xml').toString().replace('<CFOP>5102</CFOP>', '<CFOP>6101</CFOP>').replace(/<CFOP>5102<\/CFOP>/, '<CFOP>5405</CFOP>');
    const n = (await nota(s, x)).json.nota;
    assert.deepEqual(n.itens.map((i) => i.cfop), ['6101', '5405']);
    assert.ok(!n.avisos.some((a) => /CFOPs|DAS/.test(a)), n.avisos.join(' | '));
    assert.equal(n.avisosSimples.length, 2);
    assert.match(n.avisosSimples.join(' '), /tipos de venda diferentes/);
    assert.match(n.avisosSimples.join(' '), /sai do DAS/);
  } finally { await s.fechar(); }
});

test('F9: a malformed x-filename is kept as sent instead of a 500', async () => {
  const s = await subir({});
  try {
    const r = await s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': '100%.xml' }, body: fx('oficiais/nfse_valido_com_IBSCBS.xml') });
    assert.equal(r.status, 200);
    assert.equal(r.json.nota.arquivo, '100%.xml');
    const r2 = await s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': '%E0%A4%A.pdf' }, body: Buffer.from('nada') });
    assert.equal(r2.status, 422);
    assert.equal(r2.json.arquivo, '%E0%A4%A.pdf');
  } finally { await s.fechar(); }
});

// ── F8: uploader (public/js/comum.js) with a tiny DOM stand-in ──────────────
function falsoElemento(tag) {
  return {
    tag, kids: [], attrs: {}, style: {}, className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    append(...k) { this.kids.push(...k); },
    get textContent() { return this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); },
  };
}

test('F8: the uploader pauses on 429 (Retry-After capped at 30 s), one file at a time, and passes events on', async () => {
  const s = await subir({});
  const globais = { document: globalThis.document, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const pausas = [];
  let emVoo = 0, maxEmVoo = 0, chamadas = 0;
  try {
    globalThis.document = { createElement: falsoElemento };
    globalThis.sessionStorage = { getItem: () => null, setItem() {} };
    globalThis.fetch = async (path, { method, headers, body }) => {
      emVoo++;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      try {
        // the 2nd and 3rd requests hit the per-minute limit, as RATE_LIMIT does in server mode
        if (++chamadas === 2 || chamadas === 3) return new Response('{"erro":"Muitas requisições."}', { status: 429, headers: { 'retry-after': chamadas === 2 ? '600' : '2' } });
        const r = await s.chamar(path, { method, headers, body: Buffer.from(await body.arrayBuffer()) });
        return new Response(r.texto, { status: r.status, headers: { 'content-type': 'application/json' } });
      } finally { emVoo--; }
    };
    globalThis.setTimeout = (fn, ms, ...a) => { if (ms === 1000) { pausas.push(ms); return setImmediate(fn, ...a); } return globais.setTimeout(fn, ms, ...a); };
    const { criarUploader } = await import('../../public/js/comum.js');

    const zona = Object.assign(new EventTarget(), { classList: { add() {}, remove() {} } });
    const input = Object.assign(new EventTarget(), { files: [], value: '', click() {} });
    const historico = [];
    const status = { set textContent(t) { historico.push(t); }, final: null, replaceChildren(...k) { this.final = k.map((x) => (typeof x === 'string' ? x : x.textContent)).join(' '); } };
    let lido;
    const pronto = new Promise((r) => { lido = r; });
    criarUploader({ zona, input, status, aoLer: (notas, eventos) => { lido({ notas, eventos }); return { lidas: notas.length, repetidas: 0 }; } });
    input.files = [
      new File([fx('oficiais/nfe_valido.xml')], 'a.xml'),
      new File([fx('oficiais/nfse_valido_com_IBSCBS.xml')], 'b.xml'),
      new File([eventoNfe()], 'cancelamento.xml'),
    ];
    input.dispatchEvent(new Event('change'));
    const { notas, eventos } = await pronto;
    assert.equal(notas.length, 2);
    assert.deepEqual(eventos.map((e) => [e.tipo, e.chave]), [['cancelamento', CHAVE_NFE]]);
    assert.equal(pausas.length, 30 + 2); // Retry-After 600 → 30 s, then 2 s
    assert.equal(maxEmVoo, 1);
    assert.ok(historico.some((t) => /Lendo 2 de 3/.test(t)));
    assert.ok(historico.some((t) => /pausa.*continuando em 30 s/.test(t)));
    assert.match(status.final, /2 nota\(s\) lida\(s\)\. 1 evento\(s\) de cancelamento lido\(s\)\./);
    assert.doesNotMatch(status.final, /Muitas/);
  } finally {
    Object.assign(globalThis, globais);
    await s.fechar();
  }
});

// ── Regression review of the fixes ──────────────────────────────────────────
test('Regressão (DOS-4): fila de PDFs tem teto (429 + Retry-After) e a próxima leitura funciona', async () => {
  const bytes = pdf('<< /Length LEN /Filter /FlateDecode >>', flate(TEXTO));
  const jobs = Array.from({ length: MAX_FILA_PDF + 3 }, () => lerDanfseIsolado(new Uint8Array(bytes)));
  const r = await Promise.allSettled(jobs);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, MAX_FILA_PDF);
  assert.ok(r.slice(MAX_FILA_PDF).every((x) => x.reason instanceof FilaPdfCheia));
  assert.equal((await lerDanfseIsolado(new Uint8Array(bytes))).tipo, 'NFS-e', 'a fila esvazia e volta a aceitar');
  // a job whose client gave up is skipped when its turn comes
  await assert.rejects(lerDanfseIsolado(new Uint8Array(bytes), { desistiu: () => true }), /cancelado/);

  const s = await subir();
  try {
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': `p${i}.pdf` }, body: bytes })));
    const ocupado = rs.filter((x) => x.status === 429);
    assert.ok(ocupado.length > 0, 'com 30 PDFs ao mesmo tempo, alguns esperam');
    assert.ok(ocupado.every((x) => x.headers['retry-after'] === '10' && /Muitos PDFs/.test(x.json.erro)));
    assert.ok(rs.every((x) => [200, 429].includes(x.status)));
  } finally { await s.fechar(); }
});

test('Regressão (DOS-4): um cliente ocupa no máximo 2 lugares da fila de PDFs', async () => {
  const bytes = pdf('<< /Length LEN /Filter /FlateDecode >>', flate(TEXTO));
  const a = Array.from({ length: MAX_FILA_PDF_CLIENTE + 1 }, () => lerDanfseIsolado(new Uint8Array(bytes), { cliente: '203.0.113.9' }));
  const b = lerDanfseIsolado(new Uint8Array(bytes), { cliente: '2001:db8:1:2::/64' });
  const r = await Promise.allSettled([...a, b]);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.ok(r[2].reason instanceof FilaPdfCheia);
  assert.equal((await lerDanfseIsolado(new Uint8Array(bytes), { cliente: '203.0.113.9' })).tipo, 'NFS-e', 'lugares liberados');
});

test('Regressão (DOS-4): muitas palavras "stream" na mesma linha descompactam os dados uma vez só', async () => {
  // zlib stream of 400k EMPTY stored blocks: 2 MB to parse, 0 bytes out (the size cap never trips)
  const vazio = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);
  const dados = Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.concat(Array(400_000).fill(vazio)), Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01])]);
  const arq = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Filter /FlateDecode >> ${'stream'.repeat(2000)}\n`), dados]);
  const t0 = performance.now();
  await verificarPdf(new Uint8Array(arq)).catch(() => {});
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`);
});

test('Regressão (DOS-4): procurar "stream" numa linha enorme é linear', async () => {
  const t0 = performance.now();
  await verificarPdf(new Uint8Array(Buffer.from(`%PDF-1.4\n${'stream'.repeat(300_000)}`))).catch(() => {});
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
});

test('Regressão (F2): no Simples, filial da mesma empresa (raiz do CNPJ) não é "outro CNPJ"', () => {
  const n = (doc) => ({ tipo: 'NFS-e', prestador: { doc } });
  const notas = [n('11111111000111'), n('11111111000111'), n('11111111000200'), n('99999999000199')];
  marcarEmitentesDiferentes(notas);
  assert.deepEqual(notas.map((x) => x.ignorar ?? null), [null, null, null, 'emitida por outro CNPJ/CPF (99999999000199), não é receita da empresa']);
});

test('Regressão (CNPJ alfanumérico): chave de acesso lida também sem o rótulo, e só se for uma chave', () => {
  const ler = (str) => parseDanfse([{ x: 10, y: 10, str: 'DANFSe' }, { x: 10, y: 50, str }]).chave;
  const alfanum = '4113700212ABC34501DE350000000000228260548488339600'; // CNPJ 12ABC34501DE35 (IN RFB 2.229/2024)
  assert.equal(ler(alfanum), alfanum);
  assert.equal(ler('41137002211111111000111000000000022826054848833960'), '41137002211111111000111000000000022826054848833960');
  assert.equal(ler('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWX'), null, 'texto de 50 letras não é chave');
});
