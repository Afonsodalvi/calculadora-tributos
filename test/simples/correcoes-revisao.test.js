// Regressions for the findings of the adversarial review.
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Dec } from '../../src/core/decimal.js';
import { criarDas } from '../../src/simples/das.js';
import { ATIVIDADES, sugerirPorCfop, sugerirAtividade } from '../../src/simples/atividades.js';
import { normalizarNota, marcarEmitentesDiferentes, marcarSubstituidas } from '../../src/notas/notas.js';
import { parseNfseXml, parseNfeXml, tags } from '../../src/notas/xml-nf.js';
import { openDb } from '../../src/simples/rtc/db.js';
import { createEngine } from '../../src/simples/rtc/engine.js';
import { calcular } from '../../src/simples/calculo.js';

const das = criarDas(JSON.parse(readFileSync(new URL('../../data/anexos.json', import.meta.url))));
const engine = createEngine(openDb(fileURLToPath(new URL('../../data/calculadora-pro.db', import.meta.url))));
const D = (v) => Dec.of(v);
const regra = (id) => ATIVIDADES.find((a) => a.id === id).das;
const xmlNfse = readFileSync(new URL('../fixtures/notas/nfse-exemplo.xml', import.meta.url), 'utf8');
const xmlNfe = readFileSync(new URL('../fixtures/notas/nfe-exemplo.xml', import.meta.url), 'utf8');

test('indústria: Anexo II até 2026 e Anexo I a partir de 2027 (LC 214 art. 517)', () => {
  const p = { rbt12: D('500000'), folha12: null, valor: D('1000'), das: regra('industria') };
  assert.equal(das.calcularReceita({ ...p, competencia: '2026-12' }).anexo, 'II');
  assert.equal(das.calcularReceita({ ...p, competencia: '2027-01' }).anexo, 'I');
  assert.equal(das.calcularReceita({ ...p, competencia: '2027-01', das: regra('industria-zfm') }).anexo, 'II');
});

test('Fator r sem faturamento: 28% com folha, 1% sem (Res. CGSN 140 art. 26 §§6-7)', () => {
  const p = { competencia: '2026-10', rbt12: D('0'), valor: D('1000'), das: regra('servicos-fator-r') };
  assert.equal(das.calcularReceita({ ...p, folha12: D('5000') }).anexo, 'III');
  assert.equal(das.calcularReceita({ ...p, folha12: D('0') }).anexo, 'V');
  assert.equal(das.calcularReceita({ ...p, rbt12: D('100000'), folha12: D('0') }).fatorR.toString(), '0.01');
});

test('6ª faixa com sublimite não excedido: ISS limitado e excedente redistribuído (soma = AE6 + ISS5)', () => {
  const per = das.periodo('2026-06');
  const rbt = D('4500000');
  const part = das.partilha(per, 'V', rbt, { comRedistribuicao: true, sublimiteExcedido: false });
  assert.equal(part.percentuais.ISS.cmp('5'), 0);
  const ae6 = part.ae;
  const ae5 = rbt.mul('23').sub(D('62100').mul('100')).div(rbt, 30);
  const iss5 = ae5.mul('23.5').div('100', 30);
  const soma = Object.values(part.percentuais).reduce((s, v) => s.add(v), Dec.ZERO);
  assert.ok(soma.sub(ae6.add(iss5)).setScale(20, 'HALF_EVEN').isZero(), `${soma} != ${ae6.add(iss5)}`);
});

test('ICMS do Anexo I em transporte não volta quando há ICMS-ST', () => {
  const r = das.calcularReceita({ competencia: '2026-10', rbt12: D('500000'), folha12: null, valor: D('1000'), das: regra('transporte-carga'), icmsSt: true });
  assert.ok(!('ICMS' in r.tributos));
});

test('isenção municipal de ISS (tpBM 1) tira o ISS do DAS', () => {
  const r = das.calcularReceita({ competencia: '2026-10', rbt12: D('500000'), folha12: null, valor: D('1000'), das: regra('construcao-iii'), issIsento: true });
  assert.ok(!('ISS' in r.tributos));
});

test('CFOPs: e-commerce interestadual, ST interestadual, serviço em NF-e conjugada, desconhecido', () => {
  assert.equal(sugerirPorCfop('6107').atividade, 'industria');
  assert.equal(sugerirPorCfop('6108').atividade, 'comercio');
  assert.equal(sugerirPorCfop('6404').atividade, 'comercio');
  assert.equal(sugerirPorCfop('5933').atividade, 'servicos-iii');
  assert.equal(sugerirPorCfop('5656').atividade, 'comercio');
  assert.equal(sugerirPorCfop('5949').atividade, 'nao-tributavel');
  assert.equal(sugerirPorCfop('5129'), null); // unknown CFOP: no silent 'não tributável', the user chooses
  assert.equal(sugerirAtividade('010301').atividade, 'servicos-iii');
  assert.equal(sugerirAtividade('050801').atividade, 'servicos-iii');
});

test('cAtvSN declarado "9" na NFS-e vale como 09 (Fator r) e não é trocado pela sugestão', () => {
  const n = normalizarNota(parseNfseXml(xmlNfse), 'x.xml', Buffer.from(xmlNfse));
  assert.equal(n.atividade, 'servicos-fator-r');
  assert.match(n.sugestao.curto, /declarada/);
  const outro = normalizarNota(parseNfseXml(xmlNfse.replace('<cAtvSN>9</cAtvSN>', '<cAtvSN>7</cAtvSN>')), 'x.xml', Buffer.from('b'));
  assert.equal(outro.atividade, 'servicos-iii');
});

test('notas canceladas, de entrada, de outro CNPJ e substituídas ficam fora do cálculo', () => {
  const canc = normalizarNota({ ...parseNfseXml(xmlNfse), situacao: 'NFS-e Cancelada' }, 'a', Buffer.from('a'));
  assert.equal(canc.ignorar, 'nota cancelada');
  const entrada = normalizarNota(parseNfeXml(xmlNfe.replace('<tpNF>1</tpNF>', '<tpNF>0</tpNF>')), 'b', Buffer.from('b'));
  assert.match(entrada.ignorar, /entrada/);
  const notas = [{ id: '1', prestador: { doc: 'A' } }, { id: '2', prestador: { doc: 'A' } }, { id: '3', prestador: { doc: 'B' } }];
  marcarEmitentesDiferentes(notas);
  assert.ok(!notas[0].ignorar && notas[2].ignorar.includes('outro CNPJ'));
  const subs = [{ id: 'x', chave: 'K1' }, { id: 'y', chave: 'K2', substitui: 'K1' }];
  marcarSubstituidas(subs);
  assert.match(subs[0].ignorar, /substituída/);
  const r = calcular({ notas: [{ ...canc, valor: '100.00', atividade: 'servicos-iii' }], empresa: { '2027-02': { rbt12: '100000' } }, simularReforma: false }, { das, engine });
  assert.equal(r.meses[0].das.total, '0.00');
  assert.match(r.meses[0].pendencias[0], /cancelada/);
});

test('NF-e mista: ICMS-ST só nos itens x405 e exportação só nos 7xxx', () => {
  const x = xmlNfe.replace('<CFOP>5102</CFOP><vProd>150.00</vProd>', '<CFOP>5405</CFOP><vProd>150.00</vProd>');
  const n = normalizarNota(parseNfeXml(x), 'n.xml', Buffer.from(x));
  assert.deepEqual(n.itens.map((i) => i.icmsSt), [false, true]);
  const r = calcular({ notas: [n], empresa: { '2026-10': { rbt12: '100000' } }, simularReforma: false }, { das, engine: null });
  // n.competencia is 2027-02; recompute in 2027 to keep the test self-contained
  const r27 = calcular({ notas: [n], empresa: { '2027-02': { rbt12: '100000' } }, simularReforma: false }, { das, engine });
  const linhas = r27.meses[0].das.linhas;
  assert.equal(linhas.length, 2);
  assert.ok(linhas.some((l) => l.flags.icmsSt && !('ICMS' in l.tributos)));
  assert.ok(linhas.some((l) => !l.flags.icmsSt && 'ICMS' in l.tributos));
  assert.ok(r.meses.length === 1);
});

test('nota sem valor ou com mês inválido vira pendência e não derruba o cálculo', () => {
  const r = calcular({ notas: [
    { id: 'a', tipo: 'NFS-e', numero: '1', competencia: '2026-10', valor: null, atividade: 'servicos-iii' },
    { id: 'b', tipo: 'NFS-e', numero: '2', competencia: '2026-10', valor: '100.00', atividade: 'servicos-iii' },
    { id: 'c', tipo: 'NFS-e', numero: '3', competencia: '2026-13', valor: '100.00', atividade: 'servicos-iii' },
  ], empresa: { '2026-10': { rbt12: '100000' } }, simularReforma: false }, { das, engine });
  assert.equal(r.meses[0].das.receita, '100.00');
  assert.match(r.meses[0].pendencias.join(' '), /sem valor/);
  assert.match(r.erros[0].erro, /mês de competência/);
});

test('RBT12 acima de R$ 3,6 milhões exige resposta sobre o sublimite', () => {
  const n = { id: 'a', tipo: 'NFS-e', competencia: '2026-10', valor: '1000.00', atividade: 'servicos-iii' };
  const sem = calcular({ notas: [n], empresa: { '2026-10': { rbt12: '4000000' } }, simularReforma: false }, { das, engine });
  assert.match(sem.meses[0].pendencias[0], /sublimite/);
  const com = calcular({ notas: [n], empresa: { '2026-10': { rbt12: '4000000', sublimiteExcedido: false } }, simularReforma: false }, { das, engine });
  assert.ok('ISS' in com.meses[0].das.linhas[0].tributos);
});

test('motor oficial: coerção de tipos como o Jackson e item nulo no clássico', () => {
  const base = { id: 'op', versao: '1', data: '2027-03-15', tpDoc: '91', opSimpNac: '3', regApIBSCBSSN: '1', regApTribSN: '1',
    aliquotasEfetivas: { fatorR: 'false', anexoIII: { pCBSSN: '2.2154', pIBSSN: '0.0257' }, anexoV: { pCBSSN: '3.2534', pIBSSN: '0.0363' } },
    itens: [{ numero: '1', cClassTrib: '000001', baseCalculo: '10000.00', cAtivSN: '09', tribISSQN: '1', tpRetISSQN: '1' }] };
  const r = engine.naoAssistido(base);
  assert.equal(r.status, 200);
  assert.equal(r.body.resolucaoAliquotas.itens[0].anexoAplicado, 'V');
  assert.equal(r.body.resolucaoAliquotas.fatorR, false);
  assert.equal(r.body.objetos[0].nObj, 1);
  assert.equal(engine.naoAssistido({ ...base, itens: [{ ...base.itens[0], numero: 'abc' }] }).status, 400);
  const vazio = engine.naoAssistido({ ...base, itens: [{ ...base.itens[0], numero: '' }] });
  assert.equal(vazio.body.objetos[0].erros[0].code, 'VSN-010');
  assert.equal(engine.classico({ id: 'x', versao: '1', data: '2027-03-15', tpDoc: '55', CRT: '1', itens: [null] }).status, 500);
});

test('leitor de XML linear (sem regex quadrática)', () => {
  const t0 = performance.now();
  tags('<a>'.repeat(200000), 'a');
  assert.ok(performance.now() - t0 < 500);
  assert.deepEqual(tags('<a>1</a><ab>x</ab><a x="1">2</a><a/>', 'a'), ['1', '2', '']);
});
