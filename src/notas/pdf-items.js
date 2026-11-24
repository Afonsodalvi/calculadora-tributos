// pdf.js → positioned text items ({x, y, str}, y from the top), first page only
// (a DANFSe is one page). Node only. Two guards against hostile PDFs (Flate bombs, endless parsing):
// verificarPdf caps what the file inflates to before pdf.js sees it, and lerDanfseIsolado runs
// pdf.js + parseDanfse in a worker thread with a time and heap limit, so the API never blocks.
import { createInflate, constants } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const LIMITE_DESCOMPACTADO = 32 * 1024 * 1024; // a DANFSe inflates to well under 1 MB
const MAX_FLUXOS = 2000; // compressed streams (a DANFSe has a few dozen)
const MAX_ITENS = 50_000; // text items on the page (a DANFSe has a few hundred)
const PEDACO = 16 * 1024;
export const TEMPO_PDF = 10_000;

const GRANDE = 'PDF grande demais para um DANFSe: o conteúdo descompactado passa de 32 MB.';
const PESADO = 'PDF pesado demais para ser lido como DANFSe: envie o XML da nota.';
const NAO_SUPORTADO = 'PDF com compactação ou proteção que esta calculadora não lê (um DANFSe não usa): envie o XML da nota.';

// Names pdf.js honours whose output this guard does not decode (LZW, RunLength, Brotli, encryption):
// a DANFSe uses none of them, so they are refused. ASCII85/ASCIIHex (older generators put them before
// Flate) are decoded like pdf.js does. The PDF lexer decodes #xx escapes in names, so the patterns
// accept them too.
const hex = (c) => [...c.charCodeAt(0).toString(16).padStart(2, '0')].map((d) => `[${d}${d.toUpperCase()}]`).join('');
// PDF whitespace and delimiters (not JS \s: \v or \xa0 are name characters for the PDF lexer)
const FIM = '(?![^\\x00\\t\\n\\f\\r ()<>\\[\\]{}/%])'; // a name ends at whitespace or a delimiter
const nomes = (lista) => new RegExp(`/(?:${lista.map((n) => [...n].map((c) => `(?:${c}|#${hex(c)})`).join('')).join('|')})${FIM}`, 'g');
const PROIBIDOS = nomes(['LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'BrotliDecode', 'Encrypt']);
const TEXTUAIS = nomes(['ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx']);
const NOME_FILTRO = nomes(['Filter', 'F']);
const tem = (re, t) => { re.lastIndex = 0; return re.test(t); };

const ESPACO = /[\x00\t\n\f\r ]/;
const DELIM = /[\x00\t\n\f\r ()<>[\]{}/%]/;
/** Skips PDF whitespace and comments from p. */
function pular(t, p) {
  for (;;) {
    while (p < t.length && ESPACO.test(t[p])) p++;
    if (t[p] !== '%') return p;
    while (p < t.length && t[p] !== '\r' && t[p] !== '\n') p++;
  }
}
const fimDoNome = (t, p) => { while (p < t.length && !DELIM.test(t[p])) p++; return p; };
/**
 * False only when every /Filter (or /F) value is a name or an array of names. Anything else (a
 * reference such as "9 0 R", a number…) may point into a compressed object stream, and then the
 * decoded bytes are searched for the refused names too (not always: plain data may hold such
 * words). Linear: the scan never goes back.
 */
function filtroIndireto(t) {
  NOME_FILTRO.lastIndex = 0;
  while (NOME_FILTRO.exec(t)) {
    let p = pular(t, NOME_FILTRO.lastIndex);
    if (t[p] === '[') {
      for (p = pular(t, p + 1); t[p] === '/'; p = pular(t, p)) p = fimDoNome(t, p + 1);
      if (t[p] !== ']') return true;
    } else if (t[p] === '/') {
      p = fimDoNome(t, p + 1);
    } else {
      return true;
    }
    NOME_FILTRO.lastIndex = Math.max(p, NOME_FILTRO.lastIndex);
  }
  return false;
}

const cabecalhoZlib = (b) => b.length >= 2 && (b[0] & 0x0f) === 8 && ((b[0] << 8) | b[1]) % 31 === 0 && !(b[1] & 0x20);
const branco = (c) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;

/** ASCII85Decode exactly as pdf.js (up to '~' or the end), at most `max` bytes. */
function a85(d, max) {
  const out = Buffer.alloc(Math.min(max, 4 * d.length + 4));
  const g = new Uint8Array(5);
  let i = 0, n = 0;
  while (n < out.length) {
    while (branco(d[i])) i++;
    if (i >= d.length || d[i] === 0x7e) break;
    if (d[i] === 0x7a) { i++; for (let k = 0; k < 4 && n < out.length; k++) out[n++] = 0; continue; }
    let lidos = 0;
    g[lidos++] = d[i++];
    for (; lidos < 5; lidos++) {
      while (branco(d[i])) i++;
      if (i >= d.length || d[i] === 0x7e) break;
      g[lidos] = d[i++];
    }
    g.fill(0x75, lidos);
    let t = 0;
    for (const c of g) t = t * 85 + (c - 0x21);
    const b = [0, 0, 0, 0];
    for (let k = 3; k >= 0; k--) { b[k] = t & 0xff; t >>= 8; }
    for (let k = 0; k < lidos - 1 && n < out.length; k++) out[n++] = b[k];
    if (lidos < 5) break;
  }
  return out.subarray(0, n);
}

/** ASCIIHexDecode as pdf.js (up to '>' or the end), at most `max` bytes. */
function ahx(d, max) {
  const out = Buffer.alloc(Math.min(max, (d.length + 1) >> 1));
  let n = 0, primeiro = -1;
  for (let i = 0; i < d.length && n < out.length; i++) {
    const c = d[i];
    let v;
    if (c >= 0x30 && c <= 0x39) v = c & 0x0f;
    else if ((c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) v = (c & 0x0f) + 9;
    else if (c === 0x3e) { if (primeiro >= 0) out[n++] = primeiro << 4; break; } else continue;
    if (primeiro < 0) primeiro = v; else { out[n++] = (primeiro << 4) | v; primeiro = -1; }
  }
  return out.subarray(0, n);
}

/**
 * Throws when the PDF decodes past LIMITE_DESCOMPACTADO or uses a filter/encryption it refuses.
 * Every "stream" keyword in the raw bytes is decoded from its data start to the end of the file, so a
 * lying /Length, an indirect /Filter or a stream reached only by a broken xref cannot hide a bomb;
 * zlib output (and ASCII85/ASCIIHex output, when the file uses them) is decoded again while it is
 * itself a zlib stream, as a chain like [/ASCII85Decode /FlateDecode /FlateDecode] would be.
 */
export async function verificarPdf(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texto = buf.toString('latin1');
  if (tem(PROIBIDOS, texto)) throw new Error(NAO_SUPORTADO);
  const indireto = filtroIndireto(texto);
  const orc = { restante: LIMITE_DESCOMPACTADO, fluxos: 0, indireto, textual: indireto || tem(TEXTUAIS, texto) };
  let fimLinha = -1; // end of the line found by the last scan: several keywords on one line share it (linear)
  let ultimo = -1;
  for (let i = texto.indexOf('stream'); i !== -1; i = texto.indexOf('stream', i + 6)) {
    if (texto.startsWith('end', i - 3)) continue;
    // data starts after the end of the keyword's line (pdf.js skipToNextLine)
    if (fimLinha < i + 6) { fimLinha = i + 6; while (fimLinha < texto.length && texto[fimLinha] !== '\r' && texto[fimLinha] !== '\n') fimLinha++; }
    const p = fimLinha + (texto[fimLinha] === '\r' && texto[fimLinha + 1] === '\n' ? 2 : 1);
    if (p === ultimo) continue; // same data as the previous keyword: decoded once
    ultimo = p;
    await decodificar(buf.subarray(p), orc, 0);
  }
}

async function decodificar(dados, orc, nivel) {
  if (nivel > 16) throw new Error(NAO_SUPORTADO);
  if (cabecalhoZlib(dados)) {
    if (++orc.fluxos > MAX_FLUXOS) throw new Error('PDF com objetos compactados demais para um DANFSe.');
    await decodificar(await inflar(dados, orc), orc, nivel + 1);
  }
  if (!orc.textual) return;
  for (const dec of [a85, ahx]) {
    if (!cabecalhoZlib(dec(dados, 2))) continue; // only a zlib stream underneath can grow
    const saida = dec(dados, orc.restante + 1);
    orc.restante -= saida.length;
    if (orc.restante < 0) throw new Error(GRANDE);
    await decodificar(saida, orc, nivel + 1);
  }
}

/** Inflates within the budget; corrupt or truncated data ends the stream (pdf.js reads it the same way). */
function inflar(dados, orc) {
  return new Promise((resolve, reject) => {
    const z = createInflate({ finishFlush: constants.Z_SYNC_FLUSH, chunkSize: PEDACO });
    const partes = [];
    let cauda = '', guardar = orc.textual || null;
    const parar = (erro) => {
      z.removeAllListeners();
      z.on('error', () => {});
      z.destroy();
      if (erro) reject(new Error(erro)); else resolve(Buffer.concat(partes));
    };
    z.on('data', (c) => {
      orc.restante -= c.length;
      if (orc.restante < 0) return parar(GRANDE);
      if (orc.indireto) {
        const t = cauda + c.toString('latin1');
        if (tem(PROIBIDOS, t)) return parar(NAO_SUPORTADO); // e.g. /Filter 9 0 R with 9 = /LZWDecode in an object stream
        cauda = t.slice(-32);
      }
      guardar ??= cabecalhoZlib(c); // only a nested zlib stream needs the bytes
      if (guardar) partes.push(c);
    });
    z.on('end', () => parar());
    // zlib drops the last partial chunk on a data error (pdf.js would still use it): charge it
    z.on('error', () => { orc.restante -= PEDACO; parar(orc.restante < 0 ? GRANDE : null); });
    z.end(dados);
  });
}

export async function pdfToItems(pdfjs, bytes) {
  await verificarPdf(bytes);
  const task = pdfjs.getDocument({ data: bytes, verbosity: 0, isEvalSupported: false });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const { height } = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    if (tc.items.length > MAX_ITENS) throw new Error('PDF com texto demais para um DANFSe.');
    return tc.items.map((it) => ({ x: it.transform[4], y: height - it.transform[5], str: it.str }));
  } finally {
    await task.destroy();
  }
}

// ── Worker thread: pdf.js runs on the main thread in Node (fake worker), so it is isolated here ──
let trabalhador = null; // kept between PDFs; recreated after a timeout or a crash
let fila = Promise.resolve(); // one PDF at a time, so a timeout only ends its own job
let naFila = 0;
const porCliente = new Map();
// Bounded queue: hostile PDFs cost up to TEMPO_PDF each, so a long queue would hold bodies in memory
// and starve everyone's PDFs. Counts the PDF being read. Above it the caller answers 429 (the UI
// waits Retry-After and resends). One client holds at most MAX_FILA_PDF_CLIENTE places.
export const MAX_FILA_PDF = 8;
export const MAX_FILA_PDF_CLIENTE = 2;

export class FilaPdfCheia extends Error {}

/**
 * Reads a DANFSe PDF (pdfToItems + parseDanfse) in a worker; rejects after `tempo` ms.
 * `desistiu()` is checked when the job's turn comes (client gone → skipped); `cliente` = rate-limit key.
 */
export function lerDanfseIsolado(bytes, { tempo = TEMPO_PDF, desistiu = () => false, cliente = null } = {}) {
  const doCliente = cliente == null ? 0 : (porCliente.get(cliente) ?? 0);
  if (naFila >= MAX_FILA_PDF || doCliente >= MAX_FILA_PDF_CLIENTE) {
    return Promise.reject(new FilaPdfCheia('Muitos PDFs sendo lidos agora: tente de novo em alguns segundos, ou envie o XML da nota.'));
  }
  naFila += 1;
  if (cliente != null) porCliente.set(cliente, doCliente + 1);
  const sair = () => {
    naFila -= 1;
    if (cliente == null) return;
    const n = porCliente.get(cliente) - 1;
    if (n) porCliente.set(cliente, n); else porCliente.delete(cliente);
  };
  const job = fila.then(() => (desistiu() ? Promise.reject(new Error('Envio cancelado.')) : rodar(bytes, tempo))).finally(sair);
  fila = job.catch(() => {});
  return job;
}

function rodar(bytes, tempo) {
  return new Promise((resolve, reject) => {
    const w = (trabalhador ??= criarTrabalhador());
    const descartar = () => { if (trabalhador === w) trabalhador = null; w.terminate(); };
    const fim = (erro, nf) => {
      clearTimeout(relogio);
      w.off('message', mensagem).off('error', falha).off('exit', saiu);
      if (erro) reject(erro); else resolve(nf);
    };
    const relogio = setTimeout(() => { descartar(); fim(new Error(`O PDF demorou demais para ser lido (mais de ${Math.ceil(tempo / 1000)} s): envie o XML da nota.`)); }, tempo);
    const mensagem = (m) => fim(m.erro ? new Error(m.erro) : null, m.nf);
    const falha = (e) => { descartar(); fim(new Error(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? PESADO : 'Não foi possível ler o PDF.')); };
    const saiu = () => { if (trabalhador === w) trabalhador = null; fim(new Error('Não foi possível ler o PDF.')); };
    w.on('message', mensagem).on('error', falha).on('exit', saiu);
    w.postMessage(bytes);
  });
}

function criarTrabalhador() {
  // the V8 heap limit covers pdf.js objects; decoded buffers are bounded by verificarPdf
  const w = new Worker(new URL(import.meta.url), { workerData: { lerDanfse: true }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  w.on('error', () => {}).on('exit', () => { if (trabalhador === w) trabalhador = null; }); // a crash between jobs
  w.unref(); // an idle worker does not keep the process alive
  return w;
}

if (!isMainThread && workerData?.lerDanfse) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { parseDanfse } = await import('./danfse-pdf.js');
  parentPort.on('message', async (bytes) => {
    try {
      parentPort.postMessage({ nf: parseDanfse(await pdfToItems(pdfjs, bytes)) });
    } catch (e) {
      parentPort.postMessage({ erro: e?.message ?? String(e) });
    }
  });
}
