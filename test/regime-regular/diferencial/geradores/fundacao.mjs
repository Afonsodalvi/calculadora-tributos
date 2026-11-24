// Differential cases of the foundation: /api/versao/status, /api/calculadora/download/url, Spring's
// mapping fallback (404 No static resource, 405 + Allow, OPTIONS, HEAD, 406, 415 on every registered
// official POST route), the request firewall and Tomcat's query-parameter parsing.
// Not generated on purpose (app policy, documented divergences): cross-origin preflights (the app
// answers 403 unless CORS_ORIGINS allows the origin), non-standard HTTP methods (Node's parser
// rejects them before the app), and GET /api/versao (a route of the Simples API on the same port).
import { lerConfig } from '../../../../src/http/config.js';
import { criarApp } from '../../../../src/app.js';
import { raiz } from '../../../lib/servidor.js';

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const ACEITES = [undefined, 'application/json', 'application/yaml', 'application/x-yaml', 'text/plain', '*/*', 'application/*', 'application/problem+json',
  'foo', 'application/json;q=0', 'text/html, application/xml;q=0.9, */*;q=0.8', 'application/xml', 'application/*+json', 'APPLICATION/JSON', 'text/*', ''];
const METODOS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
const CTS_415 = [undefined, '', 'text/plain', 'text/plain;charset=UTF-8', 'application/x+json', 'application/*', '*/*', 'foo', 'application/json;charset=foo',
  'Text/Plain; Charset=utf-8 ; q=1', 'application', 'application/xml', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded'];
const VALORES = ['', '%20', '%20%20', '+', 'windows', 'Linux', 'MAC', 'a%22b%5C', 'a%01b', '%ZZ', '%E9', '%C3', '%41%ZZ', 'a+b', '%2B%26', '%C3%A9', '%F0%9F%98%80',
  '%ED%A0%80', 'x%09y', 'a;b', '%', '%4', '=y', 'win dows'.replace(' ', '%20'), 'linux%0A', 'abc%2Fdef', '..', '%E2%80%A8'];

export function gerar({ seed = 1, n = 300 }) {
  const rnd = prng(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const casos = [];
  const add = (metodo, caminho, headers = {}, corpo, rotulo) => {
    const h = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    casos.push({ metodo, caminho, headers: h, corpo, rotulo });
  };

  // ── /api/versao/status ────────────────────────────────────────────────────
  for (const m of METODOS) add(m, '/api/versao/status', {}, undefined, 'versao-metodo');
  for (const a of ACEITES) add('GET', '/api/versao/status', { accept: a }, undefined, 'versao-accept');
  for (const p of ['/api/versao/status?x=1', '/api/versao/status?=x', '/api/versao/status?a=%ZZ', '/api/versao/status/', '/api/versao/Status',
    '/api/versao/st%61tus', '/api/versao/status.json', '/api/versao/status;a', '/api/versao/', '/api/versao/x', '/api/versao/status/x']) add('GET', p, {}, undefined, 'versao-caminho');
  add('OPTIONS', '/api/versao/status', { origin: 'http://localhost:5181', 'access-control-request-method': 'GET' }, undefined, 'preflight-mesma-origem');
  add('OPTIONS', '/api/calculadora/xyz', { origin: 'http://localhost:5181', 'access-control-request-method': 'POST' }, undefined, 'preflight-mesma-origem');

  // ── /api/calculadora/download/url ─────────────────────────────────────────
  const DL = '/api/calculadora/download/url';
  add('GET', DL, {}, undefined, 'download');
  for (const v of VALORES) add('GET', `${DL}?platform=${v}`, {}, undefined, 'download-valor');
  for (const q of ['platform=a&platform=b', '=x&platform=y', 'platform=y&=x', 'platform', 'platform&platform=z', 'Platform=x', 'pl%61tform=y',
    '&&platform=y', 'platform=y&&', 'a=%ZZ&platform=y', 'platform=y&q=%E9', '%ZZ=1', 'platform=%41&x', '=', '&', 'platform=y#frag']) add('GET', `${DL}?${q}`, {}, undefined, 'download-consulta');
  add('GET', `${DL}?platform=x&${Array.from({ length: 1000 }, (_, i) => `p${i}=1`).join('&')}`, {}, undefined, 'download-1001-parametros');
  add('GET', `${DL}?platform=x&${Array.from({ length: 998 }, (_, i) => `p${i}=1`).join('&')}`, {}, undefined, 'download-999-parametros');
  for (const m of METODOS) add(m, `${DL}?platform=x`, {}, undefined, 'download-metodo');
  for (const a of ACEITES) add('GET', `${DL}?platform=x`, { accept: a }, undefined, 'download-accept');
  add('GET', DL, { accept: 'application/xml' }, undefined, 'download-accept-sem-param');

  // random query strings (Tomcat Parameters: chunks, %-decoding, UTF-8, '+')
  const PEDACOS = ['platform', 'Platform', 'pl%61tform', 'p', '=', '&', '&&', '%', '%4', '%ZZ', '%41', '%E9', '%C3', '%C3%A9', '%F0%9F%98%80', '%ED%A0%80', '+', 'x', '%2B', '%26', '%3D', 'é'.replace('é', '%C3%A9'), ';', ',', '%00', '%0A'];
  for (let i = 0; i < Math.max(40, Math.floor(n / 6)); i++) {
    let q = '';
    const k = 1 + Math.floor(rnd() * 8);
    for (let j = 0; j < k; j++) q += pick(PEDACOS);
    add('GET', `${DL}?${q}`, {}, undefined, 'download-consulta-aleatoria');
  }

  // ── firewall / Tomcat ─────────────────────────────────────────────────────
  for (const p of ['/api/calculadora/a;b', '/api/calculadora/a%3Bb', '/api/calculadora//x', '/api/calculadora/a%25b', '/api/calculadora/a%2eb', '/api/calculadora/./x',
    '/api/calculadora/../x', '/api/calculadora/a/..', '/api/calculadora/..', '/api/versao/../calculadora/xyz', '/api/calculadora/a%2Fb', '/api/calculadora/a%5Cb',
    '/api/calculadora/a%00b', '/api/calculadora/a|b', '/api/calculadora/a%0Ab', '/api/calculadora/a%0Db', '/api/calculadora/a%E2%80%A8b', '/api/calculadora/%FF',
    '/api/calculadora/a%G1', '/api/calculadora/a%', '/api/calculadora/a%2', '/api/calculadora/a%09b', '/api/calculadora/a%7Fb', '/api/calculadora/%C3%A9%2e',
    '/api/calculadora/a/.', '/api/calculadora;x', '/api/versao/status%2F']) add('GET', p, {}, undefined, 'firewall');
  add('TRACE', '/api/versao/status', {}, undefined, 'trace');
  add('TRACE', '/api/calculadora/xyz', {}, undefined, 'trace');

  // ── 405 / 415 / OPTIONS on every registered official route ────────────────
  const app = criarApp(lerConfig({ PORT: '5181' }), { raiz });
  const rotas = app.rotas.filter((r) => r.oficial === 'regime-regular' && typeof r.path === 'string');
  app.fechar();
  for (const r of rotas) {
    for (const m of METODOS) add(m, r.path, {}, undefined, `rota-metodo ${r.method} ${r.path}`);
    if (r.method === 'POST') {
      for (const ct of CTS_415) add('POST', r.path, { 'content-type': ct }, '{}', `rota-415 ${r.path}`);
      add('POST', r.path, {}, undefined, `rota-415-sem-corpo ${r.path}`);
    }
  }

  // ── random 404s under the official prefixes ───────────────────────────────
  const ALFA = 'abcdefghijklmnopqrstuvwxyzABCDEFXYZ0123456789-_~';
  const EXT = ['', '', '', '.json', '.x', '.html', '.txt', '.png', '.svg', '.exe', '.JSON', '.xml', '.b', '.', '..b', '.yml'];
  const ENC = ['', '', '', '%20', '%7C', '%C3%A9', '%22', '%7B', '%40', ':', ',', '!', '$', '&', '=', '+', "'", '(', ')', '*'];
  const seg = () => { let s = ''; const k = 1 + Math.floor(rnd() * 10); for (let i = 0; i < k; i++) s += ALFA[Math.floor(rnd() * ALFA.length)]; return s + pick(ENC); };
  const alvo = Math.max(n, casos.length + 60);
  while (casos.length < alvo) {
    const prefixo = pick(['/api/calculadora', '/api/calculadora', '/api/versao']);
    const segs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, seg);
    let p = `${prefixo}/${segs.join('/')}${pick(EXT)}${rnd() < 0.15 ? '/' : ''}`;
    if (/simples-nacional|^\/api\/versao$/.test(p)) continue;
    if (rnd() < 0.2) p += `?${seg()}=${seg()}`;
    add(pick(METODOS), p, rnd() < 0.3 ? { accept: pick(ACEITES), 'content-type': pick(CTS_415) } : {}, rnd() < 0.2 ? '{"a":1}' : undefined, '404-aleatorio');
  }
  return casos;
}
