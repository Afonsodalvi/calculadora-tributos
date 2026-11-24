// Official HTTP vectors of calculadora-rtc-simples-nacional run through the real server
// (routing, query params, status codes), not only the engine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { subir, caminho } from '../lib/servidor.js';
import { check } from '../lib/jsonpath.js';

const { vectors } = JSON.parse(readFileSync(new URL('../fixtures/simples/official-vectors.json', import.meta.url)));
const s = await subir();
after(() => s.fechar());

const OFICIAL = '/calculadora/observabilidade/simples-nacional';
for (const v of vectors.filter((x) => ['erros', 'nao-assistido', 'classic'].includes(x.endpoint))) {
  test(`${v.id} via HTTP`, async () => {
    const req = v.endpoint === 'erros'
      ? { path: caminho(v.input.path, v.input.query), method: v.input.method }
      : { path: `/api${OFICIAL}${v.endpoint === 'nao-assistido' ? '/nao-assistido' : ''}`, method: 'POST', body: JSON.stringify(v.input), headers: { 'content-type': 'application/json' } };
    const r = await s.chamar(req.path, req);
    const falhas = Object.entries(v.expected).map(([k, e]) => check(r.status, r.json, k, e)).filter(Boolean);
    assert.deepEqual(falhas, [], r.texto.slice(0, 800));
  });
}
