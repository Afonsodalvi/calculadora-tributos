// Differential comparison against the official Java API (oracle): the same raw request (method,
// path+query, headers, body bytes) goes to the oracle and to our app; status, body text and the
// contract headers are compared after normalizing only what the contract allows:
//   - "timestamp" values (Instant / Boot error date) are volatile;
//   - host[:port] inside URLs ("type", "ErroDetalhe.type") — both sides get the same Host anyway;
//   - order of Bean Validation segments "[campo: msg] " when there are 2+ (HashSet order in Java),
//     of VAL-xxx ErroDetalhe lists, and of the Allow tokens (handler registration order);
//   - Vary: accept-encoding (Tomcat compression, not part of the contract).
import { request } from 'node:http';
import { lerResposta } from './jsonpath-regreg.js';
import { escreverJson, lerJsonTexto, JsonObj, JsonArr, JsonNum } from '../../src/regime-regular/comum/json.js';

/** Headers compared (lower case). */
export const CABECALHOS = [
  'content-type', 'allow', 'accept', 'cache-control', 'pragma', 'expires', 'x-content-type-options', 'x-xss-protection',
  'x-frame-options', 'x-calc-app-version', 'x-calc-db-version', 'x-warning-dados-simulados', 'content-disposition',
  'location', 'accept-patch', 'content-language', 'vary',
];

/** Sends a raw request: { metodo, caminho, headers, corpo } to base 'http://host:port'. */
export function enviarCru(base, { metodo = 'GET', caminho, headers = {}, corpo }) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const dados = corpo == null ? null : Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
    if (dados && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) h['content-length'] = String(dados.length);
    const req = request({ host: u.hostname, port: u.port, path: caminho, method: metodo, headers: h, insecureHTTPParser: true }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
      res.on('error', reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(dados ?? undefined);
  });
}

const DETALHE_VALIDACAO = /^(Um ou mais campos são inválidos - )((?:\[(?:[^\]]|\](?! ))*\] )+)$/s;

function ordenarSegmentos(detail) {
  const m = DETALHE_VALIDACAO.exec(detail);
  if (!m) return detail;
  const segs = m[2].match(/\[(?:[^\]]|\](?! ))*\] /g) ?? [m[2]];
  return m[1] + [...segs].sort().join('');
}

/** Normalizes a JSON tree in place (plain values from lerJsonTexto). */
function normalizarNo(n, chave) {
  if (n instanceof JsonObj) {
    for (const e of n.entradas) {
      const [k, v] = e;
      if (k === 'timestamp' && (typeof v === 'string' || v instanceof JsonNum)) e[1] = '<timestamp>';
      else if (k === 'type' && typeof v === 'string') e[1] = v.replace(/^(https?:\/\/)[^/]+/, '$1<host>');
      else if (k === 'detail' && typeof v === 'string') e[1] = ordenarSegmentos(v);
      else e[1] = normalizarNo(v, k);
    }
    return n;
  }
  if (n instanceof JsonArr) {
    n.itens = n.itens.map((x) => normalizarNo(x, chave));
    const validacao = n.itens.length > 1 && n.itens.every((x) => x instanceof JsonObj && /^VAL-/.test(String(x.get('code'))));
    if (validacao && (chave === 'errors' || chave === 'erros')) n.itens.sort((a, b) => (escreverJson(a) < escreverJson(b) ? -1 : 1));
    if (chave === 'avisos') n.itens.sort((a, b) => (escreverJson(a) < escreverJson(b) ? -1 : 1));
    return n;
  }
  return n;
}

/**
 * Body text normalized for comparison. Byte-exact except for the allowed differences: the raw text
 * keeps escapes/number lexemes; only when an unordered list is present (2+ validation segments,
 * VAL-xxx lists) the JSON is reordered and re-written by the port's Jackson-compatible writer.
 */
export function normalizarCorpo(texto, contentType = '') {
  if (texto === '') return '';
  const cru = texto
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<timestamp>"')
    .replace(/("type":"https?:\/\/)[^/"]+/g, '$1<host>')
    .replace(/\[Ljava\.lang\.String;@[0-9a-f]+/g, '[Ljava.lang.String;@<hash>');
  if (!/json/i.test(contentType)) return cru;
  const multiconjunto = /Um ou mais campos são inválidos - \[(?:[^\]]|\](?! ))*\] \[/.test(cru) || (cru.match(/"code":"VAL-/g) ?? []).length > 1
    || /"avisos":\["[^\]]*","/.test(cru); // avisos of base-calculo-unificada come from Set.of (order varies per JVM)
  if (!multiconjunto) return cru;
  try {
    return escreverJson(normalizarNo(lerJsonTexto(cru)), { nulos: true });
  } catch {
    return cru;
  }
}

/** Removes a JVM helpful-NPE detail ("Cannot … because … is null") from a problem body. */
export const semDetalheNpe = (t) => t.replace(/"detail":"Cannot (?:[^"\\]|\\.)*? is null",/, '');

function normalizarCabecalho(nome, valor) {
  if (valor == null) return null;
  let v = Array.isArray(valor) ? valor.join(', ') : String(valor);
  if (nome === 'allow') v = v.split(',').map((x) => x.trim()).sort().join(',') + (v.includes(', ') ? ' (", ")' : ' (",")');
  if (nome === 'vary') {
    const t = v.split(',').map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'accept-encoding');
    v = t.join(', ');
    if (!v) return null;
  }
  return v;
}

/** Readable diff of two texts: first differing position with context. */
export function diffTexto(a, b) {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ini = Math.max(0, i - 60);
  return `posição ${i}:\n    java : …${a.slice(ini, i + 120)}…\n    porte: …${b.slice(ini, i + 120)}…`;
}

/**
 * Sends `req` to both and compares. opcoes: { oraculo: 'http://127.0.0.1:8080', app: base URL of our server,
 * cabecalhos: list }. Returns { igual, divergencias: [..], java, porte, req }.
 */
export async function comparar(req, { oraculo, app, cabecalhos = CABECALHOS }) {
  const [java, porte] = await Promise.all([enviarCru(oraculo, req), enviarCru(app, req)]);
  const divergencias = [];
  if (java.status !== porte.status) divergencias.push(`status: java ${java.status}, porte ${porte.status}`);
  for (const h of cabecalhos) {
    const a = normalizarCabecalho(h, java.headers[h]);
    const b = normalizarCabecalho(h, porte.headers[h]);
    if (a !== b) divergencias.push(`header ${h}: java ${JSON.stringify(a)}, porte ${JSON.stringify(b)}`);
  }
  const notas = [];
  if (req.metodo !== 'HEAD') {
    const ta = normalizarCorpo(java.corpo.toString('utf8'), java.headers['content-type']);
    let tb = normalizarCorpo(porte.corpo.toString('utf8'), porte.headers['content-type']);
    // A warm HotSpot throws NPEs without message (OmitStackTraceInFastThrow): Java's 500 then has no
    // detail, while the port always sends the first-occurrence message. Counted, not hidden.
    const semNpe = semDetalheNpe(tb);
    if (java.status === 500 && porte.status === 500 && !ta.includes('"detail":') && semNpe !== tb) { tb = semNpe; notas.push('npe-sem-mensagem'); }
    const d = diffTexto(ta, tb);
    if (d) divergencias.push(`corpo ${d}`);
  }
  return { igual: divergencias.length === 0, divergencias, notas, java, porte, req };
}

/** JSON body of a response (number lexemes kept), for generators/tests. */
export const jsonDe = (resp) => lerResposta(resp.corpo.toString('utf8'));

/**
 * Starts the app on a random port and returns { base, host, fechar, app }. Requests must carry
 * `Host: <host>` (the app accepts only its own Host in local mode); send the same Host to the oracle
 * so both build the same baseURL (http://localhost).
 */
export async function subirApp(env = {}) {
  const { createServer } = await import('node:http');
  const { lerConfig } = await import('../../src/http/config.js');
  const { criarApp } = await import('../../src/app.js');
  const { raiz } = await import('./servidor.js');
  const cfg = lerConfig({ PORT: '5181', ...env });
  const app = criarApp(cfg, { raiz });
  const server = createServer(app.handler);
  server.requestTimeout = 120_000;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  return {
    app,
    base: `http://127.0.0.1:${porta}`,
    host: `localhost:${cfg.port}`,
    fechar: () => new Promise((r) => server.close(() => { app.fechar(); r(); })),
  };
}

/** Runs requests with bounded concurrency; returns the comparison results in order. */
export async function compararTodos(reqs, opcoes, { concorrencia = 8, aoTerminar } = {}) {
  const r = new Array(reqs.length);
  let i = 0;
  const trabalhador = async () => {
    while (i < reqs.length) {
      const k = i++;
      try {
        try {
          r[k] = await comparar(reqs[k], opcoes);
        } catch (e) {
          if (e.code !== 'ECONNRESET') throw e;
          r[k] = await comparar(reqs[k], opcoes); // idle keep-alive socket closed by the server
        }
      } catch (e) {
        r[k] = { igual: false, divergencias: [`erro de transporte: ${e.message}`], req: reqs[k], java: null, porte: null };
      }
      aoTerminar?.(r[k], k);
    }
  };
  await Promise.all(Array.from({ length: concorrencia }, trabalhador));
  return r;
}
