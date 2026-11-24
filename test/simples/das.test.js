import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Dec } from '../../src/core/decimal.js';
import { criarDas } from '../../src/simples/das.js';
import { ATIVIDADES } from '../../src/simples/atividades.js';

const tabelas = JSON.parse(readFileSync(new URL('../../data/anexos.json', import.meta.url)));
const das = criarDas(tabelas);
const D = (v) => Dec.of(v);
const regra = (id) => ATIVIDADES.find((a) => a.id === id).das;

test('tabelas 2018-2026 idênticas à transcrição independente da LC 123 (244 células)', () => {
  const indep = JSON.parse(readFileSync(new URL('../fixtures/simples/anexos-2018-2026-independente.json', import.meta.url))).periodos[0].anexos;
  const atual = tabelas.periodos.find((p) => p.id === 'lc123-lc155-2018-2026').anexos;
  for (const a of ['I', 'II', 'III', 'IV', 'V']) {
    for (let i = 0; i < 6; i++) {
      const x = indep[a].faixas[i], y = atual[a].faixas[i];
      assert.equal(D(x.aliquota).cmp(y.aliquota), 0, `${a} f${i + 1} alíquota`);
      assert.equal(D(x.deduzir).cmp(y.deduzir), 0, `${a} f${i + 1} PD`);
      assert.deepEqual(Object.keys(x.reparticao).sort(), Object.keys(y.reparticao).sort(), `${a} f${i + 1} tributos`);
      for (const t of Object.keys(x.reparticao)) assert.equal(D(x.reparticao[t]).cmp(y.reparticao[t]), 0, `${a} f${i + 1} ${t}`);
      if (x.tetoIss) for (const t of Object.keys(x.tetoIss.excedente)) assert.equal(D(x.tetoIss.excedente[t]).cmp(y.tetoIss.excedente[t]), 0, `${a} teto ${t}`);
    }
  }
});

test('toda partilha soma 100% em todos os períodos, anexos e faixas', () => {
  for (const p of tabelas.periodos) for (const [a, ax] of Object.entries(p.anexos)) ax.faixas.forEach((f, i) => {
    const soma = Object.values(f.reparticao).reduce((s, v) => s.add(D(v)), Dec.ZERO);
    assert.equal(soma.cmp('100'), 0, `${p.id} ${a} f${i + 1} = ${soma}`);
  });
});

test('soma dos percentuais efetivos = alíquota efetiva (sem exclusões), para RBT12 variados', () => {
  for (const p of tabelas.periodos) for (const a of ['I', 'II', 'III', 'IV', 'V']) for (const r of ['1000', '180000', '180000.01', '240000', '500000', '719999.99', '1500000', '2500000', '3000000', '3600000']) {
    const part = das.partilha(p, a, D(r), { comRedistribuicao: true });
    const soma = Object.values(part.percentuais).reduce((s, v) => s.add(v), Dec.ZERO);
    // exact: the centesimal difference (art. 18 §1-B, II) goes to the largest share
    assert.equal(soma.cmp(part.ae), 0, `${p.id} ${a} ${r}: ${soma} != ${part.ae}`);
  }
});

test('alíquota efetiva: exemplo clássico Anexo III, RBT12 R$ 500.000 → 9,972%', () => {
  const p = das.periodo('2026-10');
  assert.equal(das.aliquotaEfetiva(p, 'III', D('500000')).ae.cmp('9.972'), 0);
  assert.equal(das.aliquotaEfetiva(p, 'III', D('180000')).faixa, 1, '180.000,00 é 1ª faixa (inclusive)');
  assert.equal(das.aliquotaEfetiva(p, 'III', D('180000.01')).faixa, 2);
});

test('ISS do Anexo III na 2ª faixa: AE × 32%, conferido à mão (valores fictícios)', () => {
  // ISS = AE × 32% (Anexo III, 2ª faixa); 2,40% ⇔ AE = 7,50% ⇔ RBT12 = 9.360 / (11,20% − 7,50%) ≈ 252.972,97.
  // The same check against the ISS printed on real NFS-e runs with the author's private fixtures
  // (test/simples/notas-e-calculo.test.js, 'DANFSe reais').
  const rbt12 = D('252972.97');
  for (const [valor, iss] of [['1000.00', '24.00'], ['12345.60', '296.29'], ['4000.00', '96.00']]) {
    const r = das.calcularReceita({ competencia: '2026-10', rbt12, folha12: null, valor: D(valor), das: regra('servicos-iii') });
    assert.equal(r.tributos.ISS.valor.toString(), iss, `ISS de ${valor}`);
    assert.equal(r.tributos.ISS.percentual.setScale(2).toString(), '2.40');
  }
});

test('teto do ISS na 5ª faixa do Anexo III (2027): ISS 5% e excedente pelos coeficientes da nota', () => {
  const p = das.periodo('2027-01');
  const part = das.partilha(p, 'III', D('2500000'), { comRedistribuicao: true });
  assert.equal(part.ae.cmp('15.9744'), 0);
  assert.ok(part.tetoIssAplicado);
  assert.equal(part.percentuais.ISS.cmp('5'), 0);
  assert.equal(part.percentuais.CBS.setScale(4).toString(), '2.5461'); // (15,9744 − 5) × 23,20%
  assert.equal(part.percentuais.IBS.setScale(6).toString(), '0.028533'); // (15,9744 − 5) × 0,26%
  const sem = das.partilha(p, 'III', D('2500000'), { comRedistribuicao: false });
  assert.equal(sem.percentuais.CBS.setScale(4).toString(), '2.4648'); // 15,9744 × 15,43%
});

test('teto do ISS na 5ª faixa do Anexo IV (2027): CBS = (AE − 5%) × 36,27%', () => {
  const part = das.partilha(das.periodo('2027-06'), 'IV', D('3000000'), { comRedistribuicao: true });
  assert.equal(part.ae.cmp('15.874'), 0);
  assert.equal(part.percentuais.CBS.setScale(4).toString(), '3.9440');
});

test('diferença centesimal (art. 18 §1-B, II): Anexo IV 2029, coeficientes somam 100,01%', () => {
  const part = das.partilha(das.periodo('2029-05'), 'IV', D('2500000'), { comRedistribuicao: true });
  assert.ok(part.tetoIssAplicado);
  // excess (AE − 4,5%) × 100,01% passes AE by 0,01% of the excess; IRPJ/CSLL/CBS/IBS coefficients 29,38/30,00/34,38/6,25
  const bruto = part.ae.sub('4.5').mul('34.38').movePointLeft(2);
  assert.ok(part.percentuais.CBS.cmp(bruto) < 0, 'CBS (maior coeficiente) absorve a diferença');
});

test('2027: Anexo III faixa 3 usa CBS 16,41% (redação da LC 227/2026)', () => {
  const part = das.partilha(das.periodo('2027-03'), 'III', D('500000'));
  assert.equal(part.percentuais.CBS.setScale(6).toString(), '1.636405');
});

test('Fator r: 28% exatos vão para o Anexo III; abaixo, Anexo V', () => {
  const base = { competencia: '2026-10', rbt12: D('300000'), valor: D('1000'), das: regra('servicos-fator-r') };
  assert.equal(das.calcularReceita({ ...base, folha12: D('84000') }).anexo, 'III');
  assert.equal(das.calcularReceita({ ...base, folha12: D('83999.99') }).anexo, 'V');
  assert.throws(() => das.calcularReceita({ ...base, folha12: null }), /folha de salários/);
});

test('exclusões: ISS retido, exportação, ICMS-ST e atividade sem ISS', () => {
  const p = { competencia: '2026-10', rbt12: D('500000'), folha12: null, valor: D('10000') };
  const ret = das.calcularReceita({ ...p, das: regra('servicos-iii'), issRetido: true });
  assert.ok(!('ISS' in ret.tributos));
  assert.equal(ret.total.toString(), '673.11'); // 9,972% × (1 − 32,5%)
  const exp = das.calcularReceita({ ...p, das: regra('servicos-iii'), exportacao: true });
  assert.deepEqual(Object.keys(exp.tributos).sort(), ['CPP', 'CSLL', 'IRPJ']);
  const st = das.calcularReceita({ ...p, das: regra('comercio'), icmsSt: true });
  assert.ok(!('ICMS' in st.tributos));
  const loc = das.calcularReceita({ ...p, das: regra('sem-iss') });
  assert.ok(!('ISS' in loc.tributos));
});

test('valores do DAS arredondados meio para cima (Res. CGSN 190 art. 45-A)', () => {
  // Anexo I, 1ª faixa: ICMS = 4% × 34% = 1,36%; R$ 6,25 × 1,36% = 0,085 exatos → 0,09 (HALF_EVEN daria 0,08)
  const r = das.calcularReceita({ competencia: '2027-01', rbt12: D('100000'), folha12: null, valor: D('6.25'), das: regra('comercio') });
  assert.equal(r.tributos.ICMS.valor.toString(), '0.09');
});

test('linha de alíquotas efetivas para a calculadora oficial (2027) e nula até 2026', () => {
  assert.equal(das.linhaAliquotasEfetivas('2026-10', D('240000'), null), null);
  const l = das.linhaAliquotasEfetivas('2027-10', D('240000'), D('50000'));
  assert.equal(l.fatorR, false);
  assert.equal(l.impedimentoSublimite, false);
  assert.equal(Dec.of(l.anexoIII.pCBSSN).setScale(4).toString(), '1.2344'); // 7,30% × 16,91%
  assert.ok(l.anexoIII.semRedistribuicaoISS);
  const alto = das.linhaAliquotasEfetivas('2027-10', D('4000000'), null);
  assert.equal(alto.impedimentoSublimite, true);
  assert.equal(alto.anexoI.pIBSSN, null);
});
