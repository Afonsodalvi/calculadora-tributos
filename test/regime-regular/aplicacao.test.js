// App flow of the Regime Regular: invoice → operation → official calculation (in-process port).
// Expected values come from the invoices themselves (values printed by the NFS-e system) and from
// the official documentation example (docs/exemplos.md of calculadora-rtc-regime-regular).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { subir } from '../lib/servidor.js';

const s = await subir();
after(() => s.fechar());
const xml = (f) => readFileSync(new URL(`../fixtures/notas/oficiais/${f}`, import.meta.url));
async function lerNota(f) {
  const r = await s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': f }, body: xml(f) });
  assert.equal(r.status, 200, r.texto);
  return r.json.nota;
}
const preparar = async (notas) => (await s.chamar('/api/regime-regular/preparar', { method: 'POST', body: { notas } })).json.operacoes;
const calcular = async (operacoes, aliquotas) => (await s.chamar('/api/regime-regular/calcular', { method: 'POST', body: { operacoes, aliquotas } })).json;

test('NFS-e: base pela base unificada oficial (vServ − ISS) e CBS/IBS iguais aos destacados na nota', async () => {
  const [op] = await preparar([await lerNota('nfse_valido_com_IBSCBS.xml')]);
  assert.equal(op.data, '2026-04-29');
  assert.equal(op.municipio, 4113700);
  assert.equal(op.tpDoc, 91);
  assert.equal(op.itens[0].cClassTrib, '000001');
  assert.equal(op.itens[0].baseCalculo, '950');
  const r = await calcular([op]);
  const t = r.resultados[0].resposta.total.tribCalc.IBSCBSTot;
  assert.equal(r.resultados[0].status, 200);
  assert.equal(t.gCBS.vCBS, op.itens[0].declarado.vCBS); // 8.55
  assert.equal(t.gIBS.gIBSUF.vIBSUF, op.itens[0].declarado.vIBSUF); // 0.95
  // notasNaoCalculadas/itensNaoCalculados: what the month total leaves out (review F6), none here
  assert.deepEqual(r.resumo, [{ mes: '2026-04', notas: 1, vBC: '950.00', vCBS: '8.55', vIBSUF: '0.95', vIBSMun: '0.00', vIBS: '0.95', vIS: '0', total: '9.50', notasNaoCalculadas: 0, itensNaoCalculados: 0 }]);
});

test('NF-e com cClassTrib 200022: tributação regular vem do gTribRegular e a base, dos componentes', async () => {
  const [op] = await preparar([await lerNota('nfe_valido.xml')]);
  assert.equal(op.municipio, 3304557);
  assert.deepEqual(op.itens[0].tributacaoRegular, { cst: '000', cClassTrib: '000001' });
  op.data = '2026-09-01'; // the sample is dated 2025, before CBS/IBS exist
  const r = await calcular([op]);
  const o = r.resultados[0].resposta.objetos[0];
  assert.equal(o.estadoItem, 'CALCULADO');
  assert.equal(o.tribCalc.IBSCBS.gIBSCBS.vBC, '2.00');
  assert.equal(o.tribCalc.IBSCBS.gIBSCBS.gCBS.vCBS, '0.00');
});

test('operação digitada de 2027 (educação, 200028): igual ao exemplo da documentação oficial', async () => {
  const op = { notaId: 'm1', tipo: 'Digitado', tpDoc: 91, data: '2027-03-10', municipio: 4314902, itens: [{ numero: 1, nbs: '122011200', cst: '200', cClassTrib: '200028', baseCalculo: '1200.00' }] };
  const r = await calcular([op], { cbs: '8.8', ibsEstadual: '0.05', ibsMunicipal: '0.05' });
  const g = r.resultados[0].resposta.objetos[0].tribCalc.IBSCBS.gIBSCBS;
  assert.equal(r.resultados[0].resposta.objetos[0].estadoItem, 'CALCULO_SIMULADO');
  assert.equal(g.gCBS.vCBS, '42.24');
  assert.equal(g.gIBSUF.vIBSUF, '0.24');
  assert.equal(g.gIBSMun.vIBSMun, '0.24');
  assert.equal(g.gCBS.gRed.pRedAliq, '60.00');
  assert.equal(r.resumo[0].total, '42.72');
});

test('limites de entrada da rota da aplicação', async () => {
  assert.equal((await s.chamar('/api/regime-regular/calcular', { method: 'POST', body: { operacoes: [] } })).status, 400);
  assert.equal((await s.chamar('/api/regime-regular/preparar', { method: 'POST', body: { notas: 'x' } })).status, 400);
});
