// Starts the real app on a random port for HTTP-level tests.
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { lerConfig } from '../../src/http/config.js';
import { criarApp } from '../../src/app.js';

export const raiz = fileURLToPath(new URL('../../', import.meta.url));

export async function subir(env = {}) {
  const cfg = lerConfig({ PORT: '5181', ...env });
  const app = criarApp(cfg, { raiz });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  /** Raw call; body may be a string/Buffer or an object (sent as JSON). */
  const chamar = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const dados = body == null || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { host: `localhost:${cfg.port}`, ...(dados != null && typeof body === 'object' && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers };
    const req = request({ host: '127.0.0.1', port: porta, path, method, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = texto ? JSON.parse(texto) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, texto, json });
      });
    });
    req.on('error', reject);
    req.end(dados);
  });
  return { cfg, app, chamar, fechar: () => new Promise((r) => server.close(() => { app.fechar(); r(); })) };
}

/** Builds "/api<path>?<query>" (repeated params for arrays), like MockMvc .param(). */
export function caminho(path, query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) for (const x of [].concat(v)) qs.append(k, x);
  const s = qs.toString();
  return `/api${path}${s ? `?${s}` : ''}`;
}
