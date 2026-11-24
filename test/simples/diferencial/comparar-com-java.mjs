import { fileURLToPath } from 'node:url';
// Differential test: the same raw HTTP requests to the OFFICIAL Java API (running locally, profile
// offline) and to our server; responses compared byte for byte — status, body (JSON text, key
// order included) and the relevant headers — ignoring only `timestamp`, the host part of error
// `type` URLs and the JVM identity hash of "[Ljava.lang.String;@…".
//
//   JAVA_URL=http://localhost:8082/api CASOS=3000 node --disable-warning=ExperimentalWarning test/simples/diferencial/comparar-com-java.mjs
//   VALIDOS=1 …  → only well-formed calculations (dates/codes in range), the numeric path
//   ROTAS=calculo,atividades,erros,versao,falhas,fallback → subset of the families (default: all)
//
// Families: calculo (official vectors + generated POST classic/nao-assistido), atividades
// (GET list and /{codigo} with random query strings), erros (GET erros?codigo), versao, falhas
// (malformed JSON, wrong types, content types, Accept, empty bodies), fallback (unknown sub-paths
// and wrong methods: answered by the app-level fallback, reported apart — not this module's routes).
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { lerConfig } from '../../../src/http/config.js';
import { criarApp } from '../../../src/app.js';
import CODIGOS from '../../../src/simples/rtc/codigos.json' with { type: 'json' };

const JAVA = new URL(process.env.JAVA_URL ?? 'http://localhost:8082/api');
const N = Number(process.env.CASOS ?? 2000);
const ROTAS = new Set((process.env.ROTAS ?? 'calculo,atividades,erros,versao,falhas,fallback').split(','));
const raiz = fileURLToPath(new URL('../../../', import.meta.url));
const dbPath = fileURLToPath(new URL('../../../data/calculadora-pro.db', import.meta.url));

// deterministic PRNG (mulberry32) so failures are reproducible
let seed = Number(process.env.SEED ?? 20261123);
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');

// real codes from the official DB
const raw = new DatabaseSync(dbPath, { readOnly: true });
const CLASSIF = raw.prepare(`SELECT DISTINCT ct.CLTR_CD c FROM CLASSIFICACAO_TRIBUTARIA ct WHERE ct.CLTR_SITR_ID IN (SELECT TRST_SITR_ID FROM TRIBUTO_SITUACAO_TRIBUTARIA WHERE TRST_TBTO_ID = 2)`).all().map((r) => r.c);
const TODOS_CLASSIF = raw.prepare('SELECT DISTINCT CLTR_CD c FROM CLASSIFICACAO_TRIBUTARIA').all().map((r) => r.c);
const NBS = raw.prepare(`SELECT NBS_CD c FROM NBS WHERE LENGTH(NBS_CD) = 9 ORDER BY RANDOM() LIMIT 60`).all().map((r) => r.c);
const NBS_LIG = raw.prepare(`SELECT DISTINCT NBSA_NBS_CD c FROM NBS_APLICAVEL WHERE LENGTH(NBSA_NBS_CD) = 9 LIMIT 40`).all().map((r) => r.c);
const NCM = raw.prepare(`SELECT NCM_CD c FROM NCM WHERE LENGTH(NCM_CD) = 8 ORDER BY RANDOM() LIMIT 60`).all().map((r) => r.c);
const NCM_LIG = raw.prepare(`SELECT DISTINCT NCMA_NCM_CD c FROM NCM_APLICAVEL WHERE LENGTH(NCMA_NCM_CD) = 8 LIMIT 40`).all().map((r) => r.c);
const COMUNS = ['000001', '000001', '000001', '200028', '200052', '410999', '410001', '220001', '620001', '800001', '820001', '222001', '000002'];

const VALIDOS = process.env.VALIDOS === '1';
const DATAS = VALIDOS ? ['2027-01-01', '2027-03-15', '2027-11-09', '2028-06-30', '2029-02-10', '2030-08-01', '2031-04-15', '2032-12-31', '2033-05-05'] : ['2027-03-15', '2027-01-01', '2026-12-31', '2028-12-31', '2029-06-10', '2030-02-28', '2031-07-01', '2032-12-31', '2033-01-01', '2027-02-30', '15/03/2027', '', ' 2027-03-15 '];
const ATIV_NFSE = ['07', '07', '09', '09', '08', '10', '11', '12', '13', '14', '90', '7', '9'];
const ATIV_CRT = { '55': ['01', '01', '02', '03', '04', '90'], '65': ['01', '02', '03', '90'], '57': ['05', '90'], '67': ['05'], '63': ['05'], '93': ['05'], '62': ['06', '90'] };
const ATIV = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '90', '7', '9', '99', '', ' 07 ', null];
const rate = () => {
  const r = rnd();
  if (!VALIDOS && r < 0.05) return pick(['', '-1.2', 'abc', '1E2', '1234', '0', null]);
  const int = Math.floor(rnd() * 5);
  const casas = pick([0, 2, 4, 6, 26, 28]);
  return casas ? `${int}.${digits(casas)}` : String(int);
};
const money = () => {
  const r = rnd();
  if (!VALIDOS && r < 0.04) return pick(['', '-10.00', '10.001', '1,00', 'x', '99999999999999.00', null]);
  if (r < 0.1) return pick(['0', '0.00', '0.01', '0.05', '1.5']);
  return `${Math.floor(rnd() * 10 ** pick([2, 3, 4, 5, 6]))}.${digits(2)}`;
};
const par = () => (chance(0.1) ? null : { pCBSSN: chance(0.07) ? null : rate(), pIBSSN: chance(0.15) ? null : rate() });
const linha = () => (chance(0.04) ? null : {
  fatorR: pick([true, false, null, true, false]),
  impedimentoSublimite: pick([false, false, false, true, null]),
  anexoI: chance(0.9) ? par() : null, anexoII: chance(0.9) ? par() : null,
  anexoIII: chance(0.92) ? { ...par(), semRedistribuicaoISS: chance(0.6) ? par() : null } : null,
  anexoIV: chance(0.9) ? { ...par(), semRedistribuicaoISS: chance(0.6) ? par() : null } : null,
  anexoV: chance(0.92) ? { ...par(), semRedistribuicaoISS: chance(0.3) ? par() : null } : null,
});

function itemBase(i, nfse, tpDoc) {
  const nom = rnd();
  const it = {
    numero: !VALIDOS && chance(0.03) ? null : i + 1,
    cAtivSN: VALIDOS ? pick(nfse ? ATIV_NFSE : ATIV_CRT[tpDoc] ?? ['01']) : pick(ATIV),
    cClassTrib: VALIDOS ? (chance(0.8) ? '000001' : pick(COMUNS)) : chance(0.6) ? pick(COMUNS) : chance(0.95) ? pick(CLASSIF) : pick(['', '999999', null]),
    baseCalculo: money(),
  };
  if (nfse) {
    if (nom < 0.5) it.nbs = pick(NBS_LIG.length && chance(0.5) ? NBS_LIG : NBS);
    else if (nom < 0.55) it.nbs = pick(['12345', '12345678X']);
    else if (nom < 0.6) it.ncm = pick(NCM);
    if (chance(0.85)) it.tribISSQN = pick(['1', '1', '1', '2', '3', '4', '5', '']);
    if (chance(0.8)) it.tpRetISSQN = pick(['1', '1', '2', '3', '4']);
    if (chance(0.2)) it.tpBM = pick(['1', '2', '3', '4', '9']);
    if (chance(0.05)) it.valorImpostoSeletivo = pick(['0.00', '10.00']);
  } else {
    if (nom < 0.5) it.ncm = pick(NCM_LIG.length && chance(0.5) ? NCM_LIG : NCM);
    else if (nom < 0.55) it.ncm = pick(['00', '00000000', '1234']);
    else if (nom < 0.58) it.nbs = pick(NBS);
    it.valorImpostoSeletivo = chance(0.9) ? pick(['0.00', '0.00', '12.34']) : pick(['', '-1.00', null]);
    if (chance(0.05)) it.tribISSQN = '1';
  }
  return it;
}

function operacaoNaoAssistida() {
  const tpDoc = VALIDOS ? pick(['91', '91', '91', '55', '55', '65', '57', '67', '63', '93', '62']) : pick(['91', '91', '91', '55', '55', '65', '57', '67', '63', '93', '62', '77', '83', '99', '', 'x']);
  const nfse = tpDoc === '91';
  const op = { id: !VALIDOS && chance(0.02) ? '' : 'op-dif', versao: !VALIDOS && chance(0.02) ? null : '3.0.0', data: pick(DATAS), tpDoc };
  if (VALIDOS) {
    if (nfse) { op.opSimpNac = pick(['3', '3', '3', '4']); op.regApIBSCBSSN = pick(['1', '1', '1', '2', '3']); op.regApTribSN = pick(['1', '1', '2', '3']); }
    else { op.CRT = pick(['1', '1', '1', '2', '3']); if (op.CRT === '3') op.tpRegimeIBSCBS = '2'; else if (chance(0.1)) op.tpRegimeIBSCBS = '1'; }
    if (chance(0.2)) op.tpEnteGov = pick(['1', '2', '3', '4']);
    op.aliquotasEfetivas = linha();
    if (op.aliquotasEfetivas == null) op.aliquotasEfetivas = linha() ?? { fatorR: false };
    const n = nfse ? 1 : 1 + Math.floor(rnd() * 4);
    op.itens = Array.from({ length: n }, (_, i) => itemBase(i, nfse, tpDoc));
    return op;
  }
  if (nfse || chance(0.05)) {
    op.opSimpNac = pick(['3', '3', '3', '4', '1', '2', '', '7']);
    if (chance(0.92)) op.regApIBSCBSSN = pick(['1', '1', '2', '3', '5']);
    if (chance(0.92)) op.regApTribSN = pick(['1', '1', '2', '3', '0']);
  }
  if (!nfse || chance(0.05)) {
    op.CRT = pick(['1', '1', '1', '2', '3', '4', '', '9']);
    if (chance(0.25)) op.tpRegimeIBSCBS = pick(['1', '2', '3']);
  }
  if (chance(0.15)) op.tpEnteGov = pick(['1', '2', '3', '4', '5', 'x']);
  op.aliquotasEfetivas = linha();
  const n = nfse ? (chance(0.95) ? 1 : 2) : 1 + Math.floor(rnd() * 4);
  op.itens = chance(0.02) ? [] : Array.from({ length: n }, (_, i) => itemBase(i, nfse, tpDoc));
  return op;
}

function operacaoClassica() {
  const tpDoc = pick(['55', '55', '65', '57', '91', '62', '77', '99', '']);
  const op = { id: 'op-cls', versao: '2.0.0', data: pick(DATAS), tpDoc, CRT: pick(['1', '1', '2', '3', '4', '', 'z']) };
  if (chance(0.25)) op.tpRegimeIBSCBS = pick(['1', '2', '3']);
  if (chance(0.15)) op.tpEnteGov = pick(['1', '2', '3', '4', '0']);
  const n = 1 + Math.floor(rnd() * 3);
  op.itens = Array.from({ length: n }, (_, i) => ({ ...itemBase(i, tpDoc === '91', tpDoc), valorImpostoSeletivo: pick(['0.00', '0.00', '5.00', '']), pIBSSN: chance(0.85) ? rate() : null, pCBSSN: chance(0.9) ? rate() : null }));
  return op;
}

// ── request generators of the other families ────────────────────────────────
const P_CALC = '/calculadora/observabilidade/simples-nacional';
const P_ATIV = '/calculadora/simples-nacional/atividades';
const json = { 'content-type': 'application/json' };
const ACCEPTS = [undefined, undefined, undefined, undefined, 'application/json', '*/*', 'application/*', 'application/*+json', 'application/json;q=0.5, text/html', 'application/xml', 'text/html', 'foo', '*/json', 'application/json;q=2', ''];
const comAccept = (h = {}) => { const a = chance(0.15) ? pick(ACCEPTS) : undefined; return a === undefined ? h : { ...h, accept: a }; };

const DATAS_Q = ['2027-01-01', '2027-01-01', '2027-03-15', '2028-06-30', '2033-12-31', '2026-12-31', '2025-12-31', '2099-01-01', '2028-02-29', '2027-02-29', '2027-13-01', '2027-1-1',
  '01%2F01%2F2027', '', '%20', '%202027-01-01', '2027-01-01Z', '2027-01-01z', '2027-01-01%2B03:00', '2027-01-01-03:00', '2027-01-01%2B24:00', '2027-01-01%2B0300',
  '2027-01-01%2B03', '%2B2027-01-01', '%2B20270-01-01', '-2027-01-01', '0000-01-01', '-0000-01-01', '9999-12-31', 'x', '2027-01-01T00:00', '2027-01-01+'];
const ANEXOS = ['I', 'II', 'III', 'IV', 'V'];
function valorAnexos() {
  const r = rnd();
  if (r < 0.1) return pick(['', '%20', 'X', 'i', 'VI', 'I,X', 'I%20', 'iii', 'I,,V', ',']);
  const sub = ANEXOS.filter(() => chance(0.5));
  return sub.map((a) => (chance(0.1) ? `%20${a}%20` : a)).join(',');
}
const TPDOCS = ['55', '65', '91', '57', '62', '63', '67', '93', '97', '83', '77', '99', '0', '-1', '055', '%2B55', 'abc', '', '%20', '%2055%20', '55,65', '%D9%A5%D9%A5', '2147483648', '1e2', '%F0%9F%98%80', '5%C2%A05'];
const CCLASS = () => (chance(0.7) ? pick(chance(0.5) ? COMUNS : TODOS_CLASSIF) : pick(['999999', '', '%20', '%20000001%20', '000001,000001', 'abc', '410999', '000001%0A']));
function queryAtividades(comData = true) {
  const partes = [];
  if (comData && !chance(0.05)) partes.push(`data=${pick(DATAS_Q)}`);
  if (chance(0.08)) partes.push(`data=${pick(DATAS_Q)}`);
  if (chance(0.45)) partes.push(`anexos=${valorAnexos()}`);
  if (chance(0.12)) partes.push(`anexos=${valorAnexos()}`);
  if (chance(0.4)) partes.push(`tpDoc=${pick(TPDOCS)}`);
  if (chance(0.05)) partes.push(`tpDoc=${pick(TPDOCS)}`);
  if (chance(0.35)) partes.push(`cClassTrib=${CCLASS()}`);
  if (chance(0.04)) partes.push(`cClassTrib=${CCLASS()}`);
  if (chance(0.05)) partes.push(pick(['foo=bar', '=x', '', 'f%ZZo=1', 'x=%C3%28', 'Data=2027-01-01', 'tpdoc=55', 'a+b=c+d', 'data', 'x=%E2%82', 'y=%ED%A0%80']));
  for (let i = partes.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [partes[i], partes[j]] = [partes[j], partes[i]]; }
  return partes.join('&');
}
const CODIGOS_ATIV = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '90', '99', '9', '00', '1', '%30%39', 'abc', '09x', '%C3%A9', '%20%30%39'];
function casoAtividades() {
  if (chance(0.3)) return { metodo: 'GET', caminho: `${P_ATIV}/${pick(CODIGOS_ATIV)}?${queryAtividades()}`, headers: comAccept() };
  return { metodo: 'GET', caminho: `${P_ATIV}?${queryAtividades()}`, headers: comAccept() };
}
const CODIGOS_ERRO = Object.values(CODIGOS).map((c) => c.code);
function casoErros() {
  const q = chance(0.08) ? pick(['', 'codigo', 'Codigo=VSN-001', 'codigo=%ZZ', 'x=1']) : `codigo=${chance(0.75) ? pick(CODIGOS_ERRO) : pick(['VSN-999', '', 'vsn-001', '%20VSN-001', 'VSN-001,VSN-002', 'VAL-001', 'CAL-999', 'VSN-0001'])}${chance(0.05) ? `&codigo=${pick(CODIGOS_ERRO)}` : ''}`;
  return { metodo: 'GET', caminho: `${P_CALC}/erros${q ? `?${q}` : ''}`, headers: comAccept() };
}
function casoVersao() {
  return { metodo: 'GET', caminho: `/versao${chance(0.2) ? '?foo=%ZZ' : ''}`, headers: comAccept() };
}

/** Malformed / mistyped bodies and media types of the two POST endpoints. */
const TIPOS_ERRADOS = ['{}', '[]', '[1]', 'true', 'false', '1.5', '1e400', '"abc"', '""', '"  "', 'null', '99999999999', '"2147483648"', '-0', '1.0E2', '"1.0"', '"x"', '{"a":[1,{"b":null}]}', '" 12 "', '"tRue"', '"True"', '0', '2', '"null"', '99999999999999999999999', '2147483647.9'];
const LIXO = [',', '}', ']', '{', '[', ':', '"', 'x', '1', ' ', '/', '\\', '\n', '\t', '\u0001', 'é', "'", '-', '.', 'e', 'n', 't', '+', '0', '#', '€'];
function mutar(texto) {
  const r = rnd();
  const pos = Math.floor(rnd() * (texto.length + 1));
  if (r < 0.35) return texto.slice(0, pos);
  if (r < 0.65) return texto.slice(0, pos) + pick(LIXO) + texto.slice(pos);
  return texto.slice(0, pos) + texto.slice(pos + 1);
}
function trocarTipo(op) {
  const alvos = [];
  const visitar = (o, cam) => {
    if (o == null || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) { alvos.push([o, k]); visitar(v, `${cam}.${k}`); }
  };
  visitar(op, '$');
  if (!alvos.length) return JSON.stringify(op);
  const [o, k] = pick(alvos);
  const marcador = '"__TROCA__"';
  o[k] = '__TROCA__';
  return JSON.stringify(op).replace(marcador, pick(TIPOS_ERRADOS));
}
const CONTENT_TYPES = ['application/json', 'application/json', 'application/json', 'application/json', undefined, 'text/plain', 'application/json;charset=UTF-8', 'application/JSON', 'application/merge-patch+json', 'foo', '*/*', 'application/json;charset=foo', 'application/json; charset="utf-8"', 'application/x-www-form-urlencoded', 'application/json;q=0.1'];
function casoFalha() {
  const naoAssistido = chance(0.5);
  const caminho = naoAssistido ? `${P_CALC}/nao-assistido` : P_CALC;
  const op = naoAssistido ? operacaoNaoAssistida() : operacaoClassica();
  const r = rnd();
  let corpo;
  if (r < 0.1) corpo = pick(['', ' ', '\n', 'null', ' null ', '[]', '1', '"x"', '""', 'true', '{} x', '{}}', '﻿{}', '{"a":1}// x', '{}\u0000', '1x', '-', 'nul']);
  else if (r < 0.55) corpo = mutar(JSON.stringify(op));
  else corpo = trocarTipo(op);
  const ct = chance(0.25) ? pick(CONTENT_TYPES) : 'application/json';
  const headers = ct === undefined ? {} : { 'content-type': ct };
  return { metodo: 'POST', caminho, headers: comAccept(headers), corpo };
}
/** Paths/methods that are not routes of this module: the answer comes from the app-level fallback. */
function casoFallback() {
  return pick([
    { metodo: 'GET', caminho: `${P_CALC}/xyz` }, { metodo: 'GET', caminho: '/calculadora/simples-nacional/xyz' },
    { metodo: 'GET', caminho: `${P_ATIV}/?data=2027-01-01` }, { metodo: 'GET', caminho: `${P_ATIV}/09/?data=2027-01-01` },
    { metodo: 'GET', caminho: `${P_ATIV}/09/x?data=2027-01-01` }, { metodo: 'POST', caminho: `${P_ATIV}?data=2027-01-01`, headers: json, corpo: '{}' },
    { metodo: 'GET', caminho: P_CALC }, { metodo: 'PUT', caminho: P_CALC, headers: json, corpo: '{}' }, { metodo: 'DELETE', caminho: `${P_CALC}/erros?codigo=VSN-001` },
    { metodo: 'POST', caminho: '/versao', headers: json, corpo: '{}' }, { metodo: 'GET', caminho: `${P_ATIV}/09;x=1?data=2027-01-01` },
    { metodo: 'GET', caminho: `${P_ATIV}/%ZZ?data=2027-01-01` }, { metodo: 'GET', caminho: '/calculadora/x/../simples-nacional/atividades?data=2027-01-01' },
  ]);
}

// ── HTTP: one raw client for both servers ────────────────────────────────────
function chamar(base, { metodo, caminho, headers = {}, corpo }, host) {
  return new Promise((resolve, reject) => {
    const dados = corpo == null ? null : Buffer.from(corpo, 'utf8');
    const h = { ...headers };
    if (host) h.host = host;
    if (dados) h['content-length'] = String(dados.length);
    const req = request({ host: base.hostname, port: base.port, method: metodo, path: base.pathname.replace(/\/$/, '') + caminho, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto: Buffer.concat(partes).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(dados ?? undefined);
  });
}

const HEADERS_COMPARADOS = ['content-type', 'x-calc-app-version', 'x-calc-db-version', 'vary', 'x-content-type-options', 'x-xss-protection', 'cache-control', 'pragma', 'expires', 'x-frame-options', 'accept', 'allow'];
/** Normalization that keeps key order: drop timestamp, strip scheme/host of type URLs and JVM identity hashes. */
function normalizar(texto) {
  let j;
  try { j = JSON.parse(texto); } catch { return texto; }
  return JSON.stringify(j, (k, v) => (k === 'timestamp' ? undefined : k === 'type' && typeof v === 'string' ? v.replace(/^https?:\/\/[^/]+/, '') : typeof v === 'string' ? v.replace(/\[Ljava\.lang\.String;@[0-9a-f]+/g, '[Ljava.lang.String;@HASH') : v));
}
/** Differences that live in src/app.js (not in this module): headers it always adds / cannot omit. */
function diferencasDeApp(j, p) {
  const d = [];
  if (j.texto === '' && j.headers['content-type'] === undefined && p.headers['content-type'] !== undefined) d.push('content-type em resposta sem corpo');
  return d;
}
let npeSemMensagem = 0;
function comparar(j, p) {
  const motivos = [];
  // warm JVM: NPE without message → Java's 500 has no detail (OmitStackTraceInFastThrow). Counted.
  const pt = j.status === 500 && p.status === 500 && !j.texto.includes('"detail":') ? p.texto.replace(/"detail":"Cannot (?:[^"\\]|\\.)*? is null",/, '') : p.texto;
  if (pt !== p.texto) npeSemMensagem++;
  if (j.status !== p.status) motivos.push(`status ${j.status} != ${p.status}`);
  else if (normalizar(j.texto) !== normalizar(pt)) motivos.push('corpo');
  const app = diferencasDeApp(j, p);
  for (const h of HEADERS_COMPARADOS) {
    if ((j.headers[h] ?? null) !== (p.headers[h] ?? null)) motivos.push(`header ${h}: ${j.headers[h]} != ${p.headers[h]}`);
  }
  return { motivos, app };
}

// ── run ──────────────────────────────────────────────────────────────────────
const cfg = lerConfig({ PORT: '5181' });
const app = criarApp(cfg, { raiz });
const servidor = createServer(app.handler);
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const PORTE = new URL(`http://127.0.0.1:${servidor.address().port}/api`);
const HOST_PORTE = '127.0.0.1:5181';

const official = JSON.parse(readFileSync(new URL('../../fixtures/simples/official-vectors.json', import.meta.url))).vectors;
const casos = [];
const post = (caminho, op) => ({ metodo: 'POST', caminho, headers: json, corpo: JSON.stringify(op) });
if (ROTAS.has('calculo')) {
  for (const v of official.filter((x) => x.endpoint === 'nao-assistido' || x.endpoint === 'classic')) casos.push({ familia: 'calculo', origem: v.id, ...post(v.endpoint === 'classic' ? P_CALC : `${P_CALC}/nao-assistido`, v.input) });
  for (let i = 0; i < N; i++) casos.push({ familia: 'calculo', origem: `gerado-${i}`, ...(i % 4 === 3 ? post(P_CALC, operacaoClassica()) : post(`${P_CALC}/nao-assistido`, operacaoNaoAssistida())) });
}
if (!VALIDOS) {
  const qt = Math.max(200, Math.floor(N / 2));
  if (ROTAS.has('atividades')) {
    for (const v of official.filter((x) => x.endpoint === 'atividades')) {
      const qs = new URLSearchParams();
      for (const [k, val] of Object.entries(v.input.query ?? {})) for (const x of [].concat(val)) qs.append(k, x);
      casos.push({ familia: 'atividades', origem: v.id, metodo: 'GET', caminho: `${v.input.path}${qs.size ? `?${qs}` : ''}` });
    }
    for (let i = 0; i < qt; i++) casos.push({ familia: 'atividades', origem: `atividades-${i}`, ...casoAtividades() });
  }
  if (ROTAS.has('erros')) for (let i = 0; i < Math.floor(qt / 3); i++) casos.push({ familia: 'erros', origem: `erros-${i}`, ...casoErros() });
  if (ROTAS.has('versao')) for (let i = 0; i < 30; i++) casos.push({ familia: 'versao', origem: `versao-${i}`, ...casoVersao() });
  if (ROTAS.has('falhas')) for (let i = 0; i < qt; i++) casos.push({ familia: 'falhas', origem: `falhas-${i}`, ...casoFalha() });
  if (ROTAS.has('fallback')) for (let i = 0; i < 26; i++) casos.push({ familia: 'fallback', origem: `fallback-${i}`, ...casoFallback() });
} else if (ROTAS.has('atividades')) {
  for (let i = 0; i < Math.floor(N / 4); i++) {
    const q = `data=${pick(['2027-01-01', '2027-03-15', '2029-06-10', '2033-01-01'])}${chance(0.5) ? `&anexos=${ANEXOS.filter(() => chance(0.5)).join(',')}` : ''}${chance(0.5) ? `&tpDoc=${pick(['55', '65', '91', '57', '62', '63', '67', '93'])}` : ''}${chance(0.5) ? `&cClassTrib=${pick(CLASSIF)}` : ''}`;
    casos.push({ familia: 'atividades', origem: `atividades-validas-${i}`, metodo: 'GET', caminho: chance(0.3) ? `${P_ATIV}/${pick(CODIGOS_ATIV.slice(0, 16))}?${q}` : `${P_ATIV}?${q}` });
  }
}
if (process.env.EXTRA) casos.push(...JSON.parse(readFileSync(process.env.EXTRA, 'utf8')));

const porFamilia = {};
const status = {};
const divergencias = [];
const fallback = [];
const appLevel = {};
for (const c of casos) {
  const f = (porFamilia[c.familia] ??= { casos: 0, iguais: 0, divergentes: 0 });
  f.casos++;
  const j = await chamar(JAVA, c);
  const p = await chamar(PORTE, c, HOST_PORTE);
  status[`${c.familia}:${j.status}`] = (status[`${c.familia}:${j.status}`] ?? 0) + 1;
  const { motivos, app: difApp } = comparar(j, p);
  for (const d of difApp) appLevel[d] = (appLevel[d] ?? 0) + 1;
  if (c.familia === 'fallback') { if (motivos.length) fallback.push({ ...c, motivos, java: j, porte: p }); else f.iguais++; continue; }
  if (motivos.length) { f.divergentes++; divergencias.push({ ...c, motivos, java: j, porte: p }); } else f.iguais++;
}
servidor.close();
app.fechar();

const resumo = { casos: casos.length, divergencias: divergencias.length, porFamilia, status, foraDoModulo: { fallback: fallback.length, diferencasDeApp: appLevel }, npeSemMensagemNoJava: npeSemMensagem };
console.log(JSON.stringify(resumo, null, 1));
writeFileSync(process.env.SAIDA ?? join(tmpdir(), 'divergencias.json'), JSON.stringify([...divergencias, ...fallback].slice(0, 300), null, 1));
for (const d of divergencias.slice(0, Number(process.env.MOSTRAR ?? 3))) {
  console.log('\ndivergência:', d.origem, d.metodo, d.caminho, JSON.stringify(d.headers ?? {}), JSON.stringify(d.corpo ?? '').slice(0, 300));
  console.log('motivos:', d.motivos.join(' | '));
  console.log('java :', d.java.status, normalizar(d.java.texto).slice(0, 700));
  console.log('porte:', d.porte.status, normalizar(d.porte.texto).slice(0, 700));
}
if (divergencias.length) process.exitCode = 1;
