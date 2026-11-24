// Invoice reading module: POST /api/notas (raw PDF/XML bytes) → normalized invoice, or a
// cancellation event that the panels apply to the invoice with the same access key.
// Used by both regimes; nothing is stored, the bytes live only for this request.
import { normalizarNota, lerEventoCancelamento } from './notas.js';
import { lerDanfseIsolado, FilaPdfCheia } from './pdf-items.js';
import { detectXmlKind, parseNfeXml, parseNfseXml } from './xml-nf.js';

const LIMITE_ARQUIVO = 2 * 1024 * 1024; // a DANFSe has ~85 KB and fiscal XML at most LIMITE_XML (1 MB)

/** → { nota } or { evento: { tipo: 'cancelamento', chave, descricao } }; throws with a user message. */
export async function lerArquivo(bytes, nome, { desistiu, cliente } = {}) {
  const head = bytes.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) {
    // pdf.js runs in a worker with a time/heap limit (src/notas/pdf-items.js)
    return { nota: normalizarNota(await lerDanfseIsolado(bytes, { desistiu, cliente }), nome, bytes) };
  }
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  if (text.trimStart().startsWith('<')) {
    const kind = detectXmlKind(text);
    const parse = kind === 'NFSE' ? parseNfseXml : kind === 'NFE' ? parseNfeXml : null;
    if (parse) {
      const nota = normalizarNota(parse(text), nome, bytes);
      let evento = null;
      try { evento = lerEventoCancelamento(text); } catch { /* another event type: the note stands */ }
      if (evento && evento.chave === nota.chave) nota.ignorar = 'nota cancelada'; // event bundled with the note
      return { nota };
    }
    const evento = lerEventoCancelamento(text);
    if (evento) return { evento };
    throw new Error('XML não reconhecido: envie o XML de uma NFS-e (padrão nacional) ou de uma NF-e/NFC-e, ou o evento de cancelamento de uma delas.');
  }
  if (/^\xFF\xD8|^\x89PNG/.test(head)) throw new Error('Imagens não são lidas. Envie o PDF (DANFSe) ou o XML da nota, ou digite o valor manualmente.');
  throw new Error('Formato não reconhecido. Envie o PDF (DANFSe) ou o XML da nota.');
}

/** Normalized invoice only (a cancellation event is an error here). */
export async function lerNota(bytes, nome) {
  const r = await lerArquivo(bytes, nome);
  if (!r.nota) throw new Error('O arquivo é um evento de cancelamento, não uma nota.');
  return r.nota;
}

/** x-filename is percent-encoded by the UI; a malformed header is kept as sent. */
function nomeArquivo(cabecalho) {
  const bruto = String(cabecalho ?? 'arquivo');
  try { return decodeURIComponent(bruto); } catch { return bruto; }
}

export function moduloNotas() {
  return {
    id: 'notas',
    registrar(r) {
      r.post('/api/notas', async (ctx) => {
        const nome = nomeArquivo(ctx.req.headers['x-filename']);
        const bytes = await ctx.corpo(LIMITE_ARQUIVO);
        try {
          return { status: 200, body: await lerArquivo(bytes, nome, { desistiu: () => Boolean(ctx.req.socket?.destroyed), cliente: ctx.cliente }) };
        } catch (e) {
          if (e instanceof FilaPdfCheia) return { status: 429, body: { erro: e.message, arquivo: nome }, headers: { 'retry-after': '10' } };
          return { status: 422, body: { erro: e.message, arquivo: nome } };
        }
      });
    },
  };
}
