// Runs every HTTP-level test vector of the official repo's endpoint
// POST /calculadora/observabilidade/simples-nacional/nao-assistido against our port.
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/simples/rtc/db.js';
import { createEngine } from '../../src/simples/rtc/engine.js';
import { check } from '../lib/jsonpath.js';

const { vectors } = JSON.parse(readFileSync(new URL('../fixtures/simples/official-vectors.json', import.meta.url)));
const engine = createEngine(openDb(fileURLToPath(new URL('../../data/calculadora-pro.db', import.meta.url))));

for (const v of vectors.filter((x) => x.endpoint === 'nao-assistido' || x.endpoint === 'classic')) {
  test(`${v.id} (${v.source.split('/').pop()})`, () => {
    const { status, body } = v.endpoint === 'classic' ? engine.classico(v.input) : engine.naoAssistido(v.input);
    const fails = Object.entries(v.expected).map(([k, e]) => check(status, body, k, e)).filter(Boolean);
    assert.deepEqual(fails, [], JSON.stringify(body).slice(0, 1500));
  });
}
