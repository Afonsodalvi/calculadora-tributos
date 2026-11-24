// Unit-level vectors of the official repo (pure functions): calcularItem and escolher.
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Dec } from '../../src/core/decimal.js';
import { openDb } from '../../src/simples/rtc/db.js';
import { createEngine } from '../../src/simples/rtc/engine.js';

const { vectors } = JSON.parse(readFileSync(new URL('../fixtures/simples/official-vectors.json', import.meta.url)));
const { calcularItem, escolher } = createEngine(openDb(fileURLToPath(new URL('../../data/calculadora-pro.db', import.meta.url))))._internals;
const d = (v) => (v == null ? null : Dec.of(v));
const at = (o, path) => path.split('.').reduce((c, k) => (c == null ? undefined : c[k]), o);

/** numeric fields compared like BigDecimal.compareTo; everything else as text */
function cmp(actual, expected) {
  if (expected === '<null>') return actual == null;
  if (expected === '<present>') return actual != null;
  if (actual instanceof Dec) return /^-?\d+(\.\d+)?$/.test(expected) && actual.cmp(expected) === 0;
  if (actual != null && typeof actual === 'object') return JSON.stringify(actual) === expected;
  return String(actual) === expected;
}

for (const v of vectors.filter((x) => x.endpoint === 'unit:SimplesNacionalCalculoService.calcularItem')) {
  test(v.id, () => {
    const i = v.input;
    const r = calcularItem({
      regime: i.regime,
      tipoReceita: { codigo: i.tipoReceitaBruta.codigo, descricao: i.tipoReceitaBruta.descricao, compoeReceita: i.tipoReceitaBruta.compoeReceita === true, isCompoeReceita: i.tipoReceitaBruta.impostoSeletivoCompoeReceita === true, fatorReceita: d(i.tipoReceitaBruta.fatorReceita), pendenteSuspenso: i.tipoReceitaBruta.pendenteSuspenso === true, exigeAliquota: i.tipoReceitaBruta.exigeAliquota === true },
      motivoNaoCalculo: i.motivoNaoCalculo, baseCalculo: d(i.baseCalculo), valorIs: d(i.valorImpostoSeletivo),
      pIBSSN: d(i.pIBSSN), pCBSSN: d(i.pCBSSN), tpEnteGov: i.tpEnteGov, fator: d(i.fatorTransicaoCompraGov), casas: i.casasAliquotaCalculo,
    });
    const val = (k) => (k === 'vIBSSN+vCBSSN' ? r.tribCalc.vIBSSN.add(r.tribCalc.vCBSSN) : at(r, k));
    const ok = (k, e) => (e === '<same-instance-as-input.motivoNaoCalculo>' ? at(r, k) === i.motivoNaoCalculo : cmp(val(k), e));
    const fails = Object.entries(v.expected).filter(([k, e]) => !ok(k, e)).map(([k, e]) => `${k}: ${String(val(k))} != ${e}`);
    assert.deepEqual(fails, []);
  });
}

const linhaDe = (l) => ({
  fatorR: l.fatorR, impedimentoSublimite: l.impedimentoSublimite === true,
  anexos: Object.fromEntries(['I', 'II', 'III', 'IV', 'V'].map((a) => {
    const x = l['anexo' + a];
    const par = (p) => (p == null ? null : { pCBSSN: d(p.pCBSSN), pIBSSN: d(p.pIBSSN) });
    return [a, x == null ? null : { par: par(x.par), sem: par(x.semRedistribuicaoISS) }];
  })),
});
for (const v of vectors.filter((x) => x.endpoint === 'unit:EscolhaParAliquotasService.escolher')) {
  test(v.id, () => {
    const i = v.input;
    const e = escolher(i.atividade, i.admissivel, linhaDe(i.linha), new Map(Object.entries(i.fatos ?? {})), i.situacoes);
    const view = { anexo: e.anexo, tipoAliquota: e.tipoAliquota, regra: e.regra, motivo: e.motivo, parSemRedistribuicaoAusente: e.parSemRedistribuicaoAusente, caminhoPar: e.caminhoPar, par: e.par, 'par.pCBSSN': e.par?.pCBSSN, 'par.pIBSSN': e.par?.pIBSSN };
    const fails = Object.entries(v.expected).filter(([k, ex]) => {
      const a = k in view ? view[k] : at(e, k);
      if (a instanceof Dec) return a.toString() !== ex; // record equals → BigDecimal.equals (scale-sensitive)
      return !cmp(a, ex);
    }).map(([k, ex]) => `${k}: ${String(k in view ? view[k] : at(e, k))} != ${ex}`);
    assert.deepEqual(fails, [], JSON.stringify(v.expected));
  });
}
