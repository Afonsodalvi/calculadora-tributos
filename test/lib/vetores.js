// Generic executor of the official regime-regular vectors (test/fixtures/regime-regular/vectors-*.json)
// through the REAL HTTP server of the app (test/lib/servidor.js). Each slice filters by endpoint:
//
//   import { subir } from '../lib/servidor.js';
//   import { vetoresHttp, executarVetor } from '../lib/vetores.js';
//   const s = await subir(); after(() => s.fechar());
//   for (const item of vetoresHttp({ endpoints: ['dados-abertos', 'nomenclatura'] })) {
//     test(item.vetor.id, async () => {
//       const r = await executarVetor(s, item);
//       assert.deepEqual(r.falhas, [], r.resumo);   // r.naoAplicavel lists keys with no HTTP meaning
//     });
//   }
//
// Conventions understood (union of the three files' meta.expectedConventions): httpStatus (+ <2xx>/<4xx>),
// '$' whole body (matcher or LENIENT object), '$raw', 'body', 'header:<Name>', JSONPath keys with
// [*] / .. / filters / length(), '#n' suffixes, arrays of matchers (allOf), expectedTypes, inputRaw,
// contentType/headers/query, corpus vectors (httpStatus[*], invariantes[*]), <eqLengthOf:id> (runs the
// referenced vector), and the mock-only keys (captured:*, calls) reported as not applicable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caminho as montarCaminho } from './servidor.js';
import { lerResposta, verificarChave } from './jsonpath-regreg.js';

const PASTA = fileURLToPath(new URL('../fixtures/regime-regular/', import.meta.url));
export const ARQUIVOS = { calculo: 'vectors-calculo.json', validacao: 'vectors-validacao.json', 'dados-unit': 'vectors-dados-unit.json' };
const cache = new Map();

/** Loads one vector file ('calculo' | 'validacao' | 'dados-unit'). */
export function carregar(nome) {
  if (!cache.has(nome)) cache.set(nome, JSON.parse(readFileSync(PASTA + ARQUIVOS[nome], 'utf8')));
  return cache.get(nome);
}

/** HTTP vectors (endpoint not 'unit:*'), optionally filtered: { arquivos, endpoints, ids, filtro(v) }. */
export function vetoresHttp({ arquivos = Object.keys(ARQUIVOS), endpoints, ids, filtro } = {}) {
  const r = [];
  for (const arquivo of arquivos) {
    for (const vetor of carregar(arquivo).vectors) {
      if (String(vetor.endpoint).startsWith('unit:')) continue;
      if (endpoints && !endpoints.includes(vetor.endpoint)) continue;
      if (ids && !ids.includes(vetor.id)) continue;
      if (filtro && !filtro(vetor)) continue;
      r.push({ arquivo, vetor });
    }
  }
  return r;
}

/** Unit vectors ('unit:<Classe.metodo>') of a file, for slices that test functions directly. */
export function vetoresUnitarios(arquivo, prefixo) {
  return carregar(arquivo).vectors.filter((v) => String(v.endpoint).startsWith(`unit:${prefixo}`));
}

/** HTTP request of a vector: { method, path, headers, body }. Body = inputRaw (verbatim) or the JSON input. */
export function requisicaoDoVetor(v, corpo) {
  const headers = {};
  headers['content-type'] = v.contentType ?? 'application/json';
  for (const [k, x] of Object.entries(v.headers ?? {})) headers[k.toLowerCase()] = x;
  let body = corpo;
  if (body === undefined) {
    if (v.inputRaw !== undefined) body = v.inputRaw;
    else if (v.input !== undefined && v.input !== null) body = typeof v.input === 'string' ? v.input : JSON.stringify(v.input);
  }
  return { method: v.method ?? 'GET', path: montarCaminho(v.path, v.query), headers, body };
}

const regraTexto = (arquivo) => (arquivo === 'calculo' ? 'string-node' : 'texto');

async function chamar(s, req) {
  const r = await s.chamar(req.path, { method: req.method, headers: { ...req.headers }, body: req.body });
  return { status: r.status, headers: r.headers, texto: r.texto, json: lerResposta(r.texto) };
}

function corpus(v) {
  const linhas = readFileSync(PASTA + v.corpus.file, 'utf8').split('\n').filter(Boolean);
  return linhas.map((l) => JSON.parse(l));
}

/**
 * Runs one vector. contexto: { respostas: Map<id, resp> (shared cache for <eqLengthOf:id>), corpusLimite }.
 * Returns { id, ok, falhas[], naoAplicavel[], resumo, resposta }.
 */
export async function executarVetor(s, item, contexto = {}) {
  const { arquivo, vetor: v } = item;
  const respostas = contexto.respostas ?? new Map();
  const falhas = [];
  const naoAplicavel = [];
  const chaves = Object.entries(v.expected);
  // vectors that only pass with a mocked service (@MockitoBean) have no meaning against the real server
  if (chaves.some(([k]) => k.startsWith('captured:'))) {
    return { id: v.id, ok: true, falhas, naoAplicavel: ['vetor depende de @MockitoBean (serviço simulado devolve 200)'], resumo: '', resposta: null };
  }
  const opcoes = {
    regraTexto: regraTexto(arquivo),
    tipos: v.expectedTypes,
    comprimentoDe: (id) => respostas.get(`len:${id}`) ?? null,
  };
  // referenced vectors (<eqLengthOf:id>) run first
  for (const [, e] of chaves) {
    const m = typeof e === 'string' && /^<(?:eq|lte)LengthOf:(.+)>$/.exec(e);
    if (m && !respostas.has(`len:${m[1]}`)) {
      const ref = vetoresHttp({ arquivos: [arquivo], ids: [m[1]] })[0];
      if (ref) {
        const rr = await chamar(s, requisicaoDoVetor(ref.vetor));
        respostas.set(`len:${m[1]}`, Array.isArray(rr.json) ? rr.json.length : null);
      }
    }
  }
  if (v.corpus) {
    const notas = corpus(v).slice(0, contexto.corpusLimite ?? Infinity);
    for (const nota of notas) {
      const r = await chamar(s, requisicaoDoVetor(v, nota.corpo));
      for (const [k, e] of chaves) {
        const chave = k === 'httpStatus[*]' ? 'httpStatus' : k;
        const res = verificarChave(r, chave, e, opcoes);
        if (res && typeof res === 'object') naoAplicavel.push(res.naoAplicavel);
        else if (res) falhas.push(`nota ${nota.indice}: ${res}`);
      }
      if (falhas.length > 20) break;
    }
    return { id: v.id, ok: falhas.length === 0, falhas, naoAplicavel: [...new Set(naoAplicavel)], resumo: `${notas.length} notas`, resposta: null };
  }
  const resp = await chamar(s, requisicaoDoVetor(v));
  if (Array.isArray(resp.json)) respostas.set(`len:${v.id}`, resp.json.length);
  for (const [k, e] of chaves) {
    const res = verificarChave(resp, k, e, opcoes);
    if (res && typeof res === 'object') naoAplicavel.push(res.naoAplicavel);
    else if (res) falhas.push(res);
  }
  return { id: v.id, ok: falhas.length === 0, falhas, naoAplicavel, resumo: `${resp.status} ${resp.texto.slice(0, 600)}`, resposta: resp };
}

/** Runs a list of vectors sequentially (shared context). */
export async function executarVetores(s, lista, contexto = {}) {
  const ctx = { respostas: new Map(), ...contexto };
  const r = [];
  for (const item of lista) r.push(await executarVetor(s, item, ctx));
  return r;
}
