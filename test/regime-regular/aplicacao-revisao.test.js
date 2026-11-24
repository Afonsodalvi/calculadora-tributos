// Regime Regular app flow: regressions of the adversarial review (batch D-regular).
// Official values: each base/CBS below was compared with the Java calculadora-rtc-regime-regular
// 1.7.2 (observabilidade/regime-geral) for the same entrada; the port is checked here only.
process.env.TZ = 'America/Sao_Paulo'; // F10: before the first Date is created
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { subir } from '../lib/servidor.js';
import { parseNfseXml, parseNfeXml } from '../../src/notas/xml-nf.js';
import { separarRepetidas, marcarExclusoes, hoje as hojeRegular, lotes, somarDecimais, juntarCalculos } from '../../public/js/regular.js';
import { hoje as hojeConsultas } from '../../public/js/consultas.js';

const s = await subir();
after(() => s.fechar());
const fx = (f) => readFileSync(new URL(`../fixtures/notas/oficiais/${f}`, import.meta.url), 'utf8');
async function lerNota(texto, nome = 'nota.xml') {
  const r = await s.chamar('/api/notas', { method: 'POST', headers: { 'x-filename': nome }, body: Buffer.from(texto) });
  assert.equal(r.status, 200, r.texto);
  return r.json.nota;
}
const preparar = async (notas) => {
  const r = await s.chamar('/api/regime-regular/preparar', { method: 'POST', body: { notas } });
  assert.equal(r.status, 200, r.texto);
  return r.json.operacoes;
};
const calcular = async (operacoes, aliquotas = null) => {
  const r = await s.chamar('/api/regime-regular/calcular', { method: 'POST', body: { operacoes, aliquotas } });
  assert.equal(r.status, 200, r.texto);
  return r.json;
};
const totIBSCBS = (res) => res.resposta?.total?.tribCalc?.IBSCBSTot;
const ALIQ_2027 = { cbs: '8.8', ibsEstadual: '0.05', ibsMunicipal: '0.05' };

/** NF-e from the official sample with custom items (dated, keyed). */
function nfe({ data = '2026-09-01', chave = 'NFe21260911111111000111558890000000051003360290', itens }) {
  const base = fx('nfe_valido.xml');
  const ini = base.indexOf('<det nItem="1">');
  const fim = base.indexOf('</det>') + '</det>'.length;
  const icms0 = '<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>0.00</vBC><pICMS>7.00</pICMS><vICMS>0.00</vICMS></ICMS00></ICMS>';
  const dets = itens.map((it, i) => `<det nItem="${i + 1}"><prod><cProd>${i + 1}</cProd><cEAN>SEM GTIN</cEAN><xProd>ITEM</xProd><NCM>${it.ncm ?? '76071120'}</NCM><CFOP>6101</CFOP><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>${it.vProd}</vUnCom><vProd>${it.vProd}</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>1.0000</qTrib><vUnTrib>${it.vProd}</vUnTrib><indTot>1</indTot></prod><imposto>${it.icms ?? icms0}${it.extra ?? ''}${it.is ?? ''}<IBSCBS><CST>${it.cst ?? '000'}</CST><cClassTrib>${it.cClassTrib ?? '000001'}</cClassTrib></IBSCBS></imposto></det>`).join('');
  return (base.slice(0, ini) + dets + base.slice(fim))
    .replace(/<dhEmi>[^<]*<\/dhEmi>/, `<dhEmi>${data}T10:00:00-03:00</dhEmi>`)
    .replace(/<dhSaiEnt>[^<]*<\/dhSaiEnt>/, `<dhSaiEnt>${data}T10:00:00-03:00</dhSaiEnt>`)
    .replace(/Id="NFe[0-9]+"/, `Id="${chave}"`);
}

// What regular.js keeps per operation (prepararNotas), to run its client-side rules here.
const comoNaTela = (op, n) => ({ ...op, emitenteDoc: n.prestador?.doc ?? null, chave: n.chave, substitui: n.substitui ?? null, ignorarNota: n.ignorar ?? null });

test('F1: a mesma nota em dois arquivos (mesmo lote ou outro lote) conta uma vez só', async () => {
  const xml = fx('nfse_valido_com_IBSCBS.xml');
  const n1 = await lerNota(xml, 'nota-228.xml');
  const n2 = await lerNota(xml, 'nota-228-copia.xml');
  const lote = separarRepetidas([n1, n2], []);
  assert.equal(lote.novas.length, 1);
  assert.equal(lote.repetidas, 1);
  // a later drop with the same invoice (the first one may still be at /preparar)
  assert.deepEqual(separarRepetidas([n2], lote.novas.map((x) => x.idn)), { novas: [], repetidas: 1 });
  // the DANFSe PDF of the same NFS-e without a readable key: issuer + number + date
  const pdf = { id: 'hash-do-pdf', tipo: 'NFS-e', numero: n1.numero, prestador: n1.prestador, dataEmissao: n1.dataEmissao, chave: null };
  assert.equal(separarRepetidas([pdf], lote.novas.map((x) => x.idn)).repetidas, 1);
  // two different invoices with their own keys are never merged by number
  const outra = { ...n1, id: 'x', chave: '41137002211111111000111000000000022899999999999999' };
  assert.equal(separarRepetidas([outra], lote.novas.map((x) => x.idn)).repetidas, 0);

  const r = await calcular(await preparar(lote.novas.map((x) => x.nota)));
  assert.equal(r.resumo[0].notas, 1);
  assert.equal(r.resumo[0].vBC, '950.00');
  assert.equal(r.resumo[0].total, '9.50');
});

test('F2: nota substituída e nota de outro CNPJ ficam fora do cálculo, como no Simples', async () => {
  const base = fx('nfse_valido_com_IBSCBS.xml');
  const CH228 = '41137002211111111000111000000000022826054848833960';
  const CH229 = '41137002211111111000111000000000022926054848833961';
  const CH300 = '41137002299999999000199000000000030026054848833962';
  const x229 = base.replaceAll(CH228, CH229).replace('<nNFSe>228</nNFSe>', '<nNFSe>229</nNFSe>')
    .replace('<dCompet>2026-04-29</dCompet>', `<dCompet>2026-04-29</dCompet><subst><chSubstda>${CH228}</chSubstda><cMotivo>99</cMotivo><xMotivo>teste</xMotivo></subst>`);
  const x300 = base.replaceAll(CH228, CH300).replace('<nNFSe>228</nNFSe>', '<nNFSe>300</nNFSe>').replaceAll('<CNPJ>11111111000111</CNPJ>', '<CNPJ>99999999000199</CNPJ>');
  const notas = [await lerNota(base, '228.xml'), await lerNota(x229, '229.xml'), await lerNota(x300, '300.xml')];
  const ops = (await preparar(notas)).map((op, i) => comoNaTela(op, notas[i]));
  marcarExclusoes(ops, new Set());
  assert.deepEqual(ops.map((o) => o.ignorar), [
    'substituída por outra nota enviada', null, 'emitida por outro CNPJ/CPF (99999999000199), não é receita da empresa',
  ]);
  const r = await calcular(ops.filter((o) => !o.ignorar));
  assert.deepEqual([r.resumo[0].notas, r.resumo[0].vBC, r.resumo[0].total], [1, '950.00', '9.50']);

  // 'incluir mesmo assim' (same flag the Simples honours), removal of the replacement, cancellation event
  ops[2].incluirMesmoAssim = true;
  marcarExclusoes(ops, new Set());
  assert.equal(ops[2].ignorar, null);
  const semSubstituta = [ops[0], ops[2]];
  marcarExclusoes(semSubstituta, new Set([CH228]));
  assert.equal(ops[0].ignorar, 'cancelada (evento de cancelamento enviado)');
  marcarExclusoes(semSubstituta, new Set());
  assert.equal(ops[0].ignorar, null);
  // a reason given when the file was read is never overwritten
  ops[0].ignorarNota = 'nota cancelada';
  marcarExclusoes(ops, new Set([CH228]));
  assert.equal(ops[0].ignorar, 'nota cancelada');
});

test('F3: DIFAL (vICMSUFDest, vFCPUFDest) e ICMS monofásico (vICMSMono) saem da base, como na fórmula oficial', async () => {
  const icms70 = '<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>1000.00</vBC><pICMS>7.00</pICMS><vICMS>70.00</vICMS></ICMS00></ICMS>';
  const difal = '<ICMSUFDest><vBCUFDest>1000.00</vBCUFDest><vBCFCPUFDest>1000.00</vBCFCPUFDest><pFCPUFDest>2.0000</pFCPUFDest><pICMSUFDest>18.0000</pICMSUFDest><pICMSInter>7.00</pICMSInter><pICMSInterPart>100.0000</pICMSInterPart><vFCPUFDest>20.00</vFCPUFDest><vICMSUFDest>110.00</vICMSUFDest><vICMSUFRemet>0.00</vICMSUFRemet></ICMSUFDest>';
  const mono = '<ICMS><ICMS15><orig>0</orig><CST>15</CST><qBCMono>100.0000</qBCMono><adRemICMS>1.0000</adRemICMS><vICMSMono>100.00</vICMSMono><qBCMonoReten>10.0000</qBCMonoReten><adRemICMSReten>1.0000</adRemICMSReten><vICMSMonoReten>10.00</vICMSMonoReten></ICMS15></ICMS>';
  const it = parseNfeXml(nfe({ itens: [{ vProd: '1000.00', icms: mono, ncm: '27101259' }] })).itens[0].rtc;
  assert.equal(it.vICMSMono, '100.00'); // not vICMSMonoReten

  const casos = [['difal', { vProd: '1000.00', icms: icms70, extra: difal }, '800.00', '7.20'], ['mono', { vProd: '1000.00', icms: mono, ncm: '27101259' }, '900.00', '8.10']];
  for (const [nome, item, vBC, vCBS] of casos) {
    const [op] = await preparar([await lerNota(nfe({ itens: [item] }), `${nome}.xml`)]);
    const t = totIBSCBS((await calcular([op])).resultados[0]);
    assert.deepEqual([t.vBCIBSCBS, t.gCBS.vCBS], [vBC, vCBS], nome); // Java: 800.00/7.20 and 900.00/8.10
  }
});

const grupoIS = '<IS><CSTIS>000</CSTIS><cClassTribIS>000001</cClassTribIS><vBCIS>100000.00</vBCIS><pIS>10.0000</pIS><pISEspec>0.0000</pISEspec><uTrib>UN</uTrib><qTrib>1.0000</qTrib><vIS>10000.00</vIS></IS>';
const notaIS = () => nfe({ data: '2027-03-10', chave: 'NFe21270311111111000111558890000000051003360291', itens: [{ vProd: '100000.00', ncm: '87032100', is: grupoIS }, { vProd: '1000.00' }] });

test('F4: item com Imposto Seletivo tem a base do IBS/CBS = base do IS + IS (não fica zerada)', async () => {
  const [op] = await preparar([await lerNota(notaIS(), 'is.xml')]);
  const r = await calcular([op], { ...ALIQ_2027, impostoSeletivo: { adValorem: '10' } });
  const res = r.resultados[0];
  assert.equal(res.entrada.itens[0].gComponentesBC, undefined); // legacy rule of the official engine
  const g = res.resposta.objetos[0].tribCalc.IBSCBS.gIBSCBS;
  assert.equal(g.vBC, '110000.00'); // Java: 110000.00
  assert.equal(g.gCBS.vCBS, '9680.00'); // Java: 9680.00
  assert.equal(totIBSCBS(res).gCBS.vCBS, '9768.00');
  assert.equal(r.resumo[0].vIS, '10000.00');
});

test('F5: a partir de 2027 a alíquota do IS vem do item (destacada na nota ou editada)', async () => {
  const [op] = await preparar([await lerNota(notaIS(), 'is.xml')]);
  assert.deepEqual(op.itens[0].aliquotasIS, { adValorem: '10.0000' }); // zero ad rem is dropped
  // the aliquotas the UI sends (no IS key): the item's rate is used
  const r = await calcular([op], ALIQ_2027);
  assert.deepEqual(r.resultados[0].resposta.objetos.map((o) => o.estadoItem), ['CALCULO_SIMULADO', 'CALCULO_SIMULADO']);
  assert.equal(r.resumo[0].vIS, '10000.00');
  assert.equal(r.resumo[0].itensNaoCalculados, 0);
  // edited per item
  op.itens[0].aliquotasIS = { adValorem: '5' };
  assert.equal((await calcular([op], ALIQ_2027)).resumo[0].vIS, '5000.00');
  // a rate sent for the whole request still wins
  assert.equal((await calcular([op], { ...ALIQ_2027, impostoSeletivo: { adValorem: '20' } })).resumo[0].vIS, '20000.00');
});

test('F6: o resumo do mês conta notas e itens que ficaram fora do total', async () => {
  const [op] = await preparar([await lerNota(nfe({ itens: [{ vProd: '1000.00' }, { vProd: '500.00', cst: '999', cClassTrib: '999999' }] }), 'f6.xml')]);
  const r = await calcular([op, { ...op, notaId: 'b', data: '' }, { ...op, notaId: 'c', data: '2025-05-01' }]);
  const set = r.resumo.find((m) => m.mes === '2026-09');
  assert.deepEqual([set.notas, set.vBC, set.total, set.itensNaoCalculados, set.notasNaoCalculadas], [1, '1000.00', '10.00', 1, 0]);
  assert.deepEqual(r.resumo.find((m) => m.mes === '2025-05'), { mes: '2025-05', notas: 0, vBC: '0', vCBS: '0', vIBSUF: '0', vIBSMun: '0', vIBS: '0', vIS: '0', total: '0', notasNaoCalculadas: 1, itensNaoCalculados: 0 });
  assert.equal(r.naoCalculadasSemMes, 1);
});

test('F7: NFS-e sem o grupo IBS/CBS: local do IBS = município do tomador, antes do local do ISS', async () => {
  const x = fx('nfse_valido_sem_IBSCBS.xml');
  const a = x.indexOf('<toma>'), b = x.indexOf('</toma>');
  const y = x.slice(0, a) + x.slice(a, b).replace(/<cMun>\d+<\/cMun>/, '<cMun>3550308</cMun>') + x.slice(b);
  const [op] = await preparar([await lerNota(y, 'f7.xml')]);
  assert.equal(op.municipio, 3550308);
  assert.match(op.origem.municipio, /^município do tomador/);
  // DANFSe (PDF): the customer's município printed on it comes before the place of supply
  const [pdf] = await preparar([{ id: 'p1', tipo: 'NFS-e', numero: '1', dataEmissao: '2026-05-06', tomador: { municipio: 'São Paulo / SP' }, servico: { localPrestacao: 'Londrina / PR' }, valores: { vServ: '100.00' } }]);
  assert.equal(pdf.municipio, 3550308);
  assert.match(pdf.origem.municipio, /tomador impresso no DANFSe/);
});

test('F10: data padrão é a data local, não a UTC (31/12 às 22h30 em Brasília)', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T22:30:00-03:00').getTime() });
  try {
    assert.equal(new Date().toISOString().slice(0, 10), '2027-01-01'); // the old default
    assert.equal(hojeRegular(), '2026-12-31');
    assert.equal(hojeConsultas(), '2026-12-31');
  } finally { mock.timers.reset(); }
});

test('DOS-3: NFS-e com milhares de "<DPS " sem fechamento é lida em tempo linear', () => {
  const xml = `<NFSe><infNFSe Id="NFS1">${'<DPS '.repeat(60000)}<infDPS><dCompet>2026-04-29</dCompet></infDPS></infNFSe></NFSe>`;
  const t0 = performance.now();
  parseNfseXml(xml);
  assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0} ms`); // regex version: ~13.6 s
  // same cut as the regex: the result group outside the DPS is still read
  assert.equal(parseNfseXml(fx('nfse_valido_com_IBSCBS.xml')).rtc.cLocalidadeIncid, '4113700');
});

test('DOS-9: nome do município (DANFSe) não renormaliza a tabela oficial a cada nota', async () => {
  const notas = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, tipo: 'NFS-e', numero: String(i), servico: { localPrestacao: 'Porto Alegre' } }));
  await preparar(notas.slice(0, 1)); // index built once
  const t0 = performance.now();
  const ops = await preparar(notas);
  assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0} ms`); // before: ~1.8 s
  assert.equal(ops[499].municipio, 4314902);
});

test('F9: formato inválido nas rotas da aplicação → 400 com {erro}', async () => {
  const post = (path, body) => s.chamar(path, { method: 'POST', body });
  for (const [path, body] of [
    ['/api/regime-regular/preparar', { notas: [null] }],
    ['/api/regime-regular/preparar', { notas: [{ tipo: 'NF-e', itens: 'x' }] }],
    ['/api/regime-regular/preparar', { notas: [{ tipo: 'NF-e', itens: [null] }] }],
    ['/api/regime-regular/preparar', [1]],
    ['/api/regime-regular/calcular', { operacoes: [null] }],
    ['/api/regime-regular/calcular', { operacoes: [{ notaId: 'x', data: '2026-05-01', municipio: 4113700 }] }],
    ['/api/regime-regular/calcular', { operacoes: [{ notaId: 'x', data: '2026-05-01', municipio: 4113700, itens: [] }] }],
    ['/api/regime-regular/calcular', { operacoes: [{ notaId: 'x', data: '2026-05-01', municipio: 4113700, itens: [7] }] }],
  ]) {
    const r = await post(path, body);
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}: ${r.texto}`);
    assert.equal(typeof r.json.erro, 'string');
  }
});

test('SEC-3: limite de itens e de JSON por requisição, e o servidor atende outros pedidos entre as operações', async () => {
  const item = { numero: 1, nbs: '122011200', cst: '200', cClassTrib: '200028', baseCalculo: '1200.00' };
  const op = (i, n = 1) => ({ notaId: `m${i}`, tipo: 'Digitado', tpDoc: 91, data: '2027-03-10', municipio: 4314902, itens: Array.from({ length: n }, (_, k) => ({ ...item, numero: k + 1 })) });
  const muitos = await s.chamar('/api/regime-regular/calcular', { method: 'POST', body: { operacoes: Array.from({ length: 6 }, (_, i) => op(i, 900)), aliquotas: ALIQ_2027 } });
  assert.equal(muitos.status, 400);
  assert.match(muitos.json.erro, /5000 itens/);
  const longa = await s.chamar('/api/regime-regular/calcular', { method: 'POST', body: { operacoes: [op(0, 991)], aliquotas: ALIQ_2027 } });
  assert.equal(longa.status, 400);
  assert.match(longa.json.erro, /990 itens/);
  const grande = await s.chamar('/api/regime-regular/calcular', { method: 'POST', body: { operacoes: [{ ...op(0), lixo: 'x'.repeat(2.2 * 1024 * 1024) }], aliquotas: ALIQ_2027 } });
  assert.equal(grande.status, 413);

  // 500 operations x 10 items: the event loop (shared with this test) is free between operations.
  // Before: one ~1.4 s block for the whole request; now the longest gap is one operation (+ the JSON).
  const corpo = JSON.stringify({ operacoes: Array.from({ length: 500 }, (_, i) => op(i, 10)), aliquotas: ALIQ_2027 });
  let ultimo = performance.now(), maiorPausa = 0, saudeDurante = null;
  const relogio = setInterval(() => { const t = performance.now(); maiorPausa = Math.max(maiorPausa, t - ultimo); ultimo = t; }, 5);
  try {
    const calculo = s.chamar('/api/regime-regular/calcular', { method: 'POST', body: corpo, headers: { 'content-type': 'application/json' } });
    await new Promise((r) => setTimeout(r, 50));
    const saude = s.chamar('/api/saude').then((r) => { saudeDurante ??= r.status; });
    const r = await calculo;
    saudeDurante ??= 'depois do cálculo';
    await saude;
    assert.equal(r.status, 200);
    assert.equal(r.json.resumo[0].notas, 500);
  } finally { clearInterval(relogio); }
  assert.equal(saudeDurante, 200);
  assert.ok(maiorPausa < 400, `event loop parado por ${Math.round(maiorPausa)} ms`);
});

test('Regressão (SEC-3): a tela calcula mais de 5000 itens em lotes e soma o resumo de forma exata', async () => {
  // exact decimal sums (BigDecimal.add: scale = max scale), never Number
  assert.equal(somarDecimais('0.10', '0.20'), '0.30');
  assert.equal(somarDecimais('9007199254740993.01', '0.01'), '9007199254740993.02');
  assert.equal(somarDecimais('1.5', '-2.25'), '-0.75');
  assert.equal(somarDecimais('0', '0.00'), '0.00');
  assert.equal(somarDecimais('1E+2', '0.5'), '100.5');
  assert.throws(() => somarDecimais('abc', '1'), /inválido/);

  const item = { numero: 1, nbs: '122011200', cst: '200', cClassTrib: '200028', baseCalculo: '1200.00' };
  const op = (i, n) => ({ notaId: `l${i}`, tipo: 'Digitado', tpDoc: 91, data: i % 2 ? '2027-04-10' : '2027-03-10', municipio: 4314902, itens: Array.from({ length: n }, (_, k) => ({ ...item, numero: k + 1 })) });
  const operacoes = Array.from({ length: 7 }, (_, i) => op(i, 900)); // 6300 items: one request was refused (400)
  const partes = lotes(operacoes, (x) => x);
  assert.deepEqual(partes.map((p) => p.length), [5, 2]);
  const respostas = [];
  for (const p of partes) respostas.push(await calcular(p, ALIQ_2027));
  const junto = juntarCalculos(respostas);
  assert.equal(junto.resultados.length, 7);
  assert.deepEqual(junto.resumo.map((m) => [m.mes, m.notas]), [['2027-03', 4], ['2027-04', 3]]);
  // same totals as a server-side sum of the same operations (one operation per request)
  const umAUm = juntarCalculos(await Promise.all(operacoes.map((o) => calcular([o], ALIQ_2027))));
  assert.deepEqual(junto.resumo, umAUm.resumo);
  assert.equal(junto.naoCalculadasSemMes, 0);
});

test('Regressão (F2): filial da mesma empresa (mesma raiz de CNPJ) não é "outro CNPJ"', () => {
  const op = (doc, i) => ({ tipo: 'NFS-e', notaId: `f${i}`, emitenteDoc: doc, chave: null, substitui: null, ignorarNota: null });
  const ops = [op('11111111000111', 1), op('11111111000111', 2), op('11111111000200', 3), op('99999999000199', 4), op('12345678909', 5)];
  marcarExclusoes(ops, new Set());
  assert.deepEqual(ops.map((o) => o.ignorar), [null, null, null,
    'emitida por outro CNPJ/CPF (99999999000199), não é receita da empresa',
    'emitida por outro CNPJ/CPF (12345678909), não é receita da empresa']);
});
