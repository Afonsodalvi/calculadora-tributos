// Regressions from the adversarial review (batch A-http): client IP behind a proxy (SEC-1/R5),
// malformed or impossible request paths without 500s or raw logs (SEC-2, DOS-10/F9/R11),
// documentation placeholder / weak API_TOKEN (SEC-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { randomBytes } from 'node:crypto';
import { lerConfig } from '../../src/http/config.js';
import * as seguranca from '../../src/http/seguranca.js';
import { subir } from '../lib/servidor.js';

const TOKEN = 'segredo-de-teste-com-32-caracteres!';

/** Runs fn while collecting everything written with console.error (formatted as the console would). */
async function comLog(fn) {
  const linhas = [];
  const original = console.error;
  console.error = (...a) => { linhas.push(format(...a)); };
  try { return { resultado: await fn(), log: linhas.join('\n') }; } finally { console.error = original; }
}

test('SEC-1/R5: TRUST_PROXY usa a entrada mais à direita do X-Forwarded-For (a que o proxy anexou)', async () => {
  const s = await subir({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '3', TRUST_PROXY: '1' });
  try {
    const st = [];
    // nginx $proxy_add_x_forwarded_for: "<what the client sent>, <real client>"
    for (let i = 0; i < 6; i++) st.push((await s.chamar('/api/saude', { headers: { host: 'x', 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` } })).status);
    assert.deepEqual(st, [200, 200, 200, 429, 429, 429], 'forjar a entrada da esquerda não troca de balde');
    assert.equal((await s.chamar('/api/saude', { headers: { host: 'x', 'x-forwarded-for': '203.0.113.10' } })).status, 200, 'outro cliente real tem o seu balde');
    assert.equal((await s.chamar('/api/saude', { headers: { host: 'x', 'x-forwarded-for': '10.9.9.9, [203.0.113.9]:4431' } })).status, 429, '[ip]:porta é o mesmo cliente');
  } finally { await s.fechar(); }
});

test('SEC-1: sem token, girar o X-Forwarded-For não escapa do limite', async () => {
  const s = await subir({ HOST: '0.0.0.0', API_TOKEN: TOKEN, TRUST_PROXY: '1', RATE_LIMIT: '5' });
  try {
    const a = [];
    for (let i = 0; i < 7; i++) a.push((await s.chamar('/api/simples/info', { headers: { host: 'x' } })).status);
    assert.deepEqual(a, [401, 401, 401, 401, 401, 429, 429]);
    const b = [];
    for (let i = 1; i <= 5; i++) b.push((await s.chamar('/api/simples/info', { headers: { host: 'x', 'x-forwarded-for': `10.0.0.${i}, 127.0.0.1` } })).status);
    assert.deepEqual(b, [429, 429, 429, 429, 429]);
  } finally { await s.fechar(); }
});

test('SEC-1: X-Forwarded-For que não é IP, ou vindo de par fora de TRUSTED_PROXIES, conta para o IP da conexão', async () => {
  const lixo = await subir({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '2', TRUST_PROXY: '1' });
  try {
    const st = [];
    for (let i = 0; i < 3; i++) st.push((await lixo.chamar('/api/saude', { headers: { host: 'x', 'x-forwarded-for': `${i}-${'a'.repeat(4000)}` } })).status);
    assert.deepEqual(st, [200, 200, 429]);
  } finally { await lixo.fechar(); }
  // the test client connects from 127.0.0.1, which is not in this TRUSTED_PROXIES list
  const s = await subir({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '2', TRUST_PROXY: '1', TRUSTED_PROXIES: '192.0.2.1, 198.51.100.0/24' });
  try {
    const st = [];
    for (let i = 0; i < 3; i++) st.push((await s.chamar('/api/saude', { headers: { host: 'x', 'x-forwarded-for': `203.0.113.${i}` } })).status);
    assert.deepEqual(st, [200, 200, 429]);
  } finally { await s.fechar(); }
});

test('SEC-1: a tabela de IPs do limite tem teto (memória limitada sob inundação de IPs)', () => {
  const max = seguranca.MAX_IPS_POR_JANELA ?? 50_000;
  const seg = seguranca.criarSeguranca(lerConfig({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '1000', TRUST_PROXY: '1' }));
  const req = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } });
  const ip = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  for (let n = 0; n < max; n++) assert.equal(seg.limite(req(ip(n))), null);
  // a full table does not lock a new client (maybe with a valid token) out because of the flood
  for (let k = 0; k < 5; k++) assert.equal(seg.limite(req(ip(max + 1))), null, 'IP novo com a tabela cheia não é bloqueado');
  assert.equal(seg.limite(req(ip(0))), null, 'IPs já contados seguem pelo limite normal');
});

test('Regressão (SEC-1): com a tabela cheia o limite continua valendo, por prefixo e depois num balde comum', () => {
  const max = seguranca.MAX_IPS_POR_JANELA;
  const seg = seguranca.criarSeguranca(lerConfig({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '2', TRUST_PROXY: '1' }));
  const req = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } });
  const ip4 = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  for (let n = 0; n < max; n++) seg.limite(req(ip4(n)));
  // newcomers of one /16 share a bucket of 16 × RATE_LIMIT: rotating the address no longer escapes
  const r = Array.from({ length: 40 }, (_, k) => seg.limite(req(`172.20.${k}.1`)));
  assert.equal(r.filter((x) => x === null).length, 32);
  assert.ok(Number(r.at(-1)) > 0);
  // another /16 has its own bucket
  assert.equal(seg.limite(req('192.168.7.7')), null);
  // past MAX_PREFIXOS_POR_JANELA prefixes too: one shared bucket of 64 × RATE_LIMIT, never "no limit"
  for (let p = 0; p < seguranca.MAX_PREFIXOS_POR_JANELA; p++) seg.limite(req(`${11 + (p >> 8)}.${p & 255}.0.1`));
  const comum = Array.from({ length: 200 }, (_, k) => seg.limite(req(`100.${64 + (k >> 8)}.${k & 255}.9`)));
  assert.ok(comum.filter((x) => x === null).length <= 128, 'balde comum limita');
  assert.ok(Number(comum.at(-1)) > 0);
});

test('Regressão (SEC-1): IPv6 conta também o /48 (8 × RATE_LIMIT): girar /64 dentro de um /48 não escapa', () => {
  const seg = seguranca.criarSeguranca(lerConfig({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '2', TRUST_PROXY: '1' }));
  const req = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } });
  const r = Array.from({ length: 30 }, (_, k) => seg.limite(req(`2001:db8:7:${k.toString(16)}::1`)));
  assert.equal(r.filter((x) => x === null).length, 16);
  assert.equal(seg.limite(req('2001:db8:8::1')), null, 'outro /48 tem a sua própria conta');
  assert.equal(seguranca.prefixoIp('2001:db8:7:1f::1', 48), '2001:db8:7::/48');
  assert.equal(seguranca.prefixoIp('2001:db8::1', 32), '2001:db8::/32');
  assert.equal(seguranca.prefixoIp('203.0.113.9', 32), '203.0.0.0/16');
});

test('SEC-1: IPv6 conta por bloco /64 (girar o fim do endereço não escapa do limite)', () => {
  assert.equal(seguranca.chaveLimite('2001:db8:1:2::5'), '2001:db8:1:2::/64');
  assert.equal(seguranca.chaveLimite('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(seguranca.chaveLimite('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(seguranca.chaveLimite('::1'), '0:0:0:0::/64');
  assert.equal(seguranca.chaveLimite('1:2::3:4:5:1.2.3.4'), '1:2:0:3::/64');
  assert.equal(seguranca.chaveLimite('203.0.113.9'), '203.0.113.9');
  const seg = seguranca.criarSeguranca(lerConfig({ HOST: '0.0.0.0', PUBLIC_API: '1', RATE_LIMIT: '3', TRUST_PROXY: '1' }));
  const req = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } });
  const r = [1, 2, 3, 4, 5].map((i) => seg.limite(req(`2001:db8:1:2::${i}`)));
  assert.deepEqual(r.map((x) => x === null), [true, true, true, false, false]);
  assert.equal(seg.limite(req('2001:db8:1:3::1')), null, 'outro /64 tem a sua própria conta');
});

test('SEC-1: ipDe normaliza só endereços IP', () => {
  assert.equal(typeof seguranca.ipDe, 'function');
  assert.equal(seguranca.ipDe(' 203.0.113.9 '), '203.0.113.9');
  assert.equal(seguranca.ipDe('203.0.113.9:443'), '203.0.113.9');
  assert.equal(seguranca.ipDe('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(seguranca.ipDe('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(seguranca.ipDe('2001:db8::1'), '2001:db8::1');
  for (const x of ['', 'unknown', '10.0.0.1, 10.0.0.2', 'a'.repeat(100), undefined]) assert.equal(seguranca.ipDe(x), null, String(x));
});

test('SEC-1: TRUSTED_PROXIES validado na partida', () => {
  assert.throws(() => lerConfig({ TRUST_PROXY: '1', TRUSTED_PROXIES: 'proxy.local' }), /TRUSTED_PROXIES inválido/);
  assert.throws(() => lerConfig({ TRUST_PROXY: '1', TRUSTED_PROXIES: '10.0.0.0/33' }), /TRUSTED_PROXIES inválido/);
  assert.throws(() => lerConfig({ TRUST_PROXY: '1', TRUSTED_PROXIES: '10.0.0.0/8/1' }), /TRUSTED_PROXIES inválido/);
  assert.throws(() => lerConfig({ TRUSTED_PROXIES: '10.0.0.1' }), /TRUST_PROXY=1/);
  assert.deepEqual(lerConfig({ TRUST_PROXY: '1', TRUSTED_PROXIES: '172.17.0.1, fd00::/8' }).proxiesConfiaveis, [
    { endereco: '172.17.0.1', prefixo: 32, tipo: 'ipv4' },
    { endereco: 'fd00::', prefixo: 8, tipo: 'ipv6' },
  ]);
  assert.ok(lerConfig({ TRUST_PROXY: '1' }).proxiesConfiaveis.some((f) => f.endereco === '172.16.0.0' && f.prefixo === 12), 'padrão inclui a ponte do Docker');
});

test('SEC-6: token de exemplo da documentação ou fraco demais é recusado na partida', () => {
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: 'troque-por-um-token-longo' }), /exemplo da documentação/);
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: 'TROQUE-POR-UM-TOKEN-LONGO' }), /exemplo da documentação/);
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: '<token com 16+ caracteres>' }), /exemplo da documentação/);
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa' }), /fraco demais/);
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: '1212121212121212' }), /fraco demais/);
  assert.throws(() => lerConfig({ HOST: '0.0.0.0', API_TOKEN: 'curto' }), /16 caracteres/);
  const forte = randomBytes(24).toString('hex');
  assert.equal(lerConfig({ HOST: '0.0.0.0', API_TOKEN: forte }).token, forte);
  assert.equal(lerConfig({ HOST: '0.0.0.0', API_TOKEN: TOKEN }).token, TOKEN);
});

test('SEC-2/DOS-10/R11: caminhos malformados ou impossíveis → 400/404, sem 500 e sem log', async () => {
  const s = await subir({ HOST: '0.0.0.0', API_TOKEN: TOKEN, ALLOWED_HOSTS: 'calc.exemplo.com.br' });
  const h = { host: 'calc.exemplo.com.br' };
  try {
    const casos = [
      ['/%E0%A4%A', 400], ['/%E0', 400], ['/%00', 404], ['/index.html/x', 404], [`/${'a'.repeat(300)}`, 404],
      [`/index.html/${'A'.repeat(8000)}`, 404],
      ['/index.html/%0a%0aCalculadora%20de%20tributos%20pronta%20em%20http://evil.example:5180%0a', 404],
      ['/nao-existe', 404], ['/..%2f..%2fetc/passwd', 403], ['/', 200],
    ];
    const { resultado, log } = await comLog(async () => {
      const out = [];
      for (const [p] of casos) out.push((await s.chamar(p, { headers: h })).status);
      // absolute-form request targets that new URL() rejects (Tomcat answers 400 too)
      out.push((await s.chamar('http://a:b/', { headers: h })).status);
      out.push((await s.chamar('http://a:b/api/versao', { headers: h })).status);
      out.push((await s.chamar('//a:b/', { headers: h })).status);
      out.push((await s.chamar('http://a:b/', { headers: { host: 'evil.com' } })).status);
      return out;
    });
    assert.deepEqual(resultado, [...casos.map(([, st]) => st), 400, 400, 400, 403]);
    assert.equal(log, '', 'erros do cliente não vão para o log');
  } finally { await s.fechar(); }
});

test('DOS-10/F9/R11: URIError em qualquer rota → 400 (nunca 500), sem log', async () => {
  const s = await subir({});
  s.app.rotas.push({ method: 'GET', path: '/api/teste-urierror', handler: () => decodeURIComponent('%E0%A4%A'), publica: true });
  try {
    const { resultado, log } = await comLog(async () => [
      await s.chamar('/api/teste-urierror'),
      await s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': '%E0%A4%A' }, body: 'x' }),
    ]);
    assert.equal(resultado[0].status, 400);
    assert.match(resultado[0].json.erro, /inválida/);
    assert.notEqual(resultado[1].status, 500, 'x-filename malformado não vira erro interno');
    assert.equal(log, '');
  } finally { await s.fechar(); }
});

test('SEC-2: erro interno genuíno → 500 com uma linha de log escapada, sem pilha nem quebras injetadas', async () => {
  const s = await subir({});
  s.app.rotas.push({
    method: 'GET', path: '/api/teste-500', publica: true,
    handler: () => { throw new Error(`falha\n    at injetado (evil.js:1:1)\nCalculadora de tributos pronta em http://evil.example:5180\n${'x'.repeat(5000)}`); },
  });
  try {
    const { resultado, log } = await comLog(() => s.chamar('/api/teste-500'));
    assert.equal(resultado.status, 500);
    assert.deepEqual(resultado.json, { erro: 'Erro interno.' });
    assert.ok(log.startsWith('Erro interno: '), log.slice(0, 80));
    assert.ok(!log.includes('\n'), 'uma linha só');
    assert.ok(!/^Calculadora de tributos pronta/m.test(log), 'sem linha forjada');
    assert.ok(log.length < 700, `log limitado (${log.length} caracteres)`);
    const linha = JSON.parse(log.slice('Erro interno: '.length));
    assert.equal(linha.tipo, 'Error');
    assert.match(linha.onde, /revisao-seguranca\.test\.js/, 'diz onde falhou (primeiro quadro depois da mensagem)');
  } finally { await s.fechar(); }
});
