// HTTP layer: config validation, Host/Origin guards, token, CORS, rate limit, static files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { lerConfig } from '../../src/http/config.js';
import { criarApp } from '../../src/app.js';

const raiz = fileURLToPath(new URL('../../', import.meta.url));

async function subir(env) {
  const cfg = lerConfig({ PORT: '5181', ...env });
  const app = criarApp(cfg, { raiz });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  const chamar = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: porta, path, method, headers: { host: `localhost:${cfg.port}`, ...headers } }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto: Buffer.concat(partes).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { chamar, fechar: () => new Promise((r) => server.close(() => { app.fechar(); r(); })) };
}

test('config: exposing the API on the network needs API_TOKEN or PUBLIC_API=1', () => {
  assert.throws(() => lerConfig({ HOST: '0.0.0.0' }), /API_TOKEN/);
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: 'curto' }), /16 caracteres/);
  assert.equal(lerConfig({ HOST: '0.0.0.0', PUBLIC_API: '1' }).limitePorMinuto, 120);
  assert.equal(lerConfig({}).local, true);
  assert.equal(lerConfig({}).limitePorMinuto, 0);
  assert.throws(() => lerConfig({ PORT: 'abc' }), /PORT/);
});

test('modo local: só Host/Origin desta máquina', async () => {
  const s = await subir({});
  try {
    assert.equal((await s.chamar('/api/info')).status, 200);
    assert.equal((await s.chamar('/api/info', { headers: { host: 'evil.example:5181' } })).status, 403);
    assert.equal((await s.chamar('/api/info', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.chamar('/api/info', { headers: { origin: 'http://localhost:5181' } })).status, 200);
    assert.equal((await s.chamar('/api/info', { method: 'DELETE' })).status, 405);
    assert.equal((await s.chamar('/api/nao-existe')).status, 404);
  } finally { await s.fechar(); }
});

test('arquivos estáticos: CSP na página e sem escapar da pasta public', async () => {
  const s = await subir({});
  try {
    const pagina = await s.chamar('/');
    assert.equal(pagina.status, 200);
    assert.match(pagina.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(pagina.headers['x-content-type-options'], 'nosniff');
    for (const p of ['/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2fdata%2fcalculadora-pro.db', '/public/../server.js']) {
      assert.ok([403, 404].includes((await s.chamar(p)).status), p);
    }
  } finally { await s.fechar(); }
});

test('modo servidor com token, CORS e limite por IP', async () => {
  const token = 'segredo-de-teste-com-32-caracteres!';
  const s = await subir({ HOST: '0.0.0.0', API_TOKEN: token, ALLOWED_HOSTS: 'calc.exemplo.com.br', CORS_ORIGINS: 'https://app.exemplo.com.br', RATE_LIMIT: '5' });
  try {
    const h = { host: 'calc.exemplo.com.br' };
    assert.equal((await s.chamar('/api/saude', { headers: h })).status, 200, 'saúde é pública');
    assert.equal((await s.chamar('/api/simples/info', { headers: h })).status, 401);
    assert.equal((await s.chamar('/api/simples/info', { headers: { ...h, authorization: 'Bearer errado' } })).status, 401);
    assert.equal((await s.chamar('/api/simples/info', { headers: { ...h, authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await s.chamar('/api/simples/info', { headers: { host: 'outro.com', 'x-api-key': token } })).status, 403, 'host fora de ALLOWED_HOSTS');
    const pre = await s.chamar('/api/simples/calcular', { method: 'OPTIONS', headers: { ...h, origin: 'https://app.exemplo.com.br' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://app.exemplo.com.br');
    assert.equal((await s.chamar('/api/saude', { headers: { ...h, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.chamar('/api/saude', { headers: h })).status, 200, 'quinta requisição contada no minuto');
    const limitado = await s.chamar('/api/saude', { headers: h });
    assert.equal(limitado.status, 429, 'sexta requisição no minuto');
    assert.ok(Number(limitado.headers['retry-after']) > 0);
  } finally { await s.fechar(); }
});

test('corpo grande demais → 413; JSON inválido → 400', async () => {
  const s = await subir({});
  try {
    const grande = await s.chamar('/api/simples/calcular', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) }, body: 'x'.repeat(3 * 1024 * 1024) });
    assert.equal(grande.status, 413);
    assert.equal((await s.chamar('/api/simples/calcular', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  } finally { await s.fechar(); }
});
