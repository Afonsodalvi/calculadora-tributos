import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { D, Dec } from '../../src/core/decimal.js';
import { pdfToItems } from '../../src/notas/pdf-items.js';
import { parseDanfse, parseMoney } from '../../src/notas/danfse-pdf.js';
import { parseNfeXml, parseNfseXml, detectXmlKind } from '../../src/notas/xml-nf.js';
import { sugerirAtividade, sugerirPorCfop, ATIVIDADES } from '../../src/simples/atividades.js';
import { criarDas } from '../../src/simples/das.js';
import { openDb } from '../../src/simples/rtc/db.js';
import { createEngine } from '../../src/simples/rtc/engine.js';
import { calcular } from '../../src/simples/calculo.js';

const fx = (n) => new URL(`../fixtures/${n}`, import.meta.url);
const calcularRegra = (id) => ATIVIDADES.find((a) => a.id === id).das;
const das = criarDas(JSON.parse(readFileSync(new URL('../../data/anexos.json', import.meta.url))));
const engine = createEngine(openDb(fileURLToPath(new URL('../../data/calculadora-pro.db', import.meta.url))));

test('decimal exato com HALF_EVEN igual ao BigDecimal do Java', () => {
  assert.equal(D('2.345').setScale(2).toString(), '2.34');
  assert.equal(D('2.355').setScale(2).toString(), '2.36');
  assert.equal(D('-2.345').setScale(2).toString(), '-2.34');
  assert.equal(D('0.085').setScale(2, 'HALF_UP').toString(), '0.09');
  assert.equal(D('1').div('3', 4).toString(), '0.3333');
  assert.equal(D('1.25').movePointLeft(2).toString(), '0.0125');
  assert.equal(D('60.0000').stripTrailingZeros().toString(), '60');
});

test('valores do DANFSe: "R$ 12.345,67" e "-"', () => {
  assert.equal(parseMoney('R$ 12.345,67'), '12345.67');
  assert.equal(parseMoney('-'), null);
});

test('XML de NFS-e padrão nacional', () => {
  const x = readFileSync(fx('notas/nfse-exemplo.xml'), 'utf8');
  assert.equal(detectXmlKind(x), 'NFSE');
  const n = parseNfseXml(x);
  assert.equal(n.competencia, '2027-02-01');
  assert.equal(n.valores.vServ, '3200.00');
  assert.equal(n.valores.vDescIncond, '200.00');
  assert.equal(n.servico.cTribNac, '010101');
  assert.equal(n.iss.tpRetISSQN, '2');
  assert.equal(n.simples.cAtivSN, '9');
  assert.equal(n.tomador.nome, 'CLIENTE & CIA LTDA');
});

test('XML de NF-e com itens', () => {
  const x = readFileSync(fx('notas/nfe-exemplo.xml'), 'utf8');
  assert.equal(detectXmlKind(x), 'NFE');
  const n = parseNfeXml(x);
  assert.equal(n.tpDoc, '55');
  assert.equal(n.itens.length, 2);
  assert.equal(n.itens[1].vFrete, '15.00');
});

test('sugestão de atividade pelo código de serviço e pelo CFOP', () => {
  assert.equal(sugerirAtividade('080201').atividade, 'servicos-iii');
  assert.equal(sugerirAtividade('17.09.01').atividade, 'servicos-fator-r');
  assert.equal(sugerirAtividade('171401').atividade, 'servicos-iv');
  assert.equal(sugerirAtividade('070201').atividade, 'construcao-iv');
  assert.equal(sugerirAtividade('160101').atividade, 'transporte-municipal');
  assert.equal(sugerirPorCfop('5102').atividade, 'comercio');
  assert.equal(sugerirPorCfop('5101').atividade, 'industria');
  assert.equal(sugerirPorCfop('5949').atividade, 'nao-tributavel');
});

// Real DANFSe of the author's company stay in test/fixtures/private (outside git), with the values read
// from them in esperado.json there: nothing of them is in the repository.
const privados = existsSync(fx('private')) ? readdirSync(fx('private')).filter((f) => f.endsWith('.pdf')) : [];
const esperado = existsSync(fx('private/esperado.json')) ? JSON.parse(readFileSync(fx('private/esperado.json'), 'utf8')) : null;
test('DANFSe reais (PDF) da empresa', { skip: privados.length === 0 && 'sem PDFs privados' }, async () => {
  const lidas = {};
  const docs = new Set();
  for (const f of privados) {
    const n = parseDanfse(await pdfToItems(pdfjs, new Uint8Array(readFileSync(new URL(`../fixtures/private/${f}`, import.meta.url)))));
    assert.match(n.chave, /^\d{50}$/, f);
    assert.match(n.prestador.doc, /^\d{14}$/, f);
    docs.add(n.prestador.doc);
    assert.equal(n.simples.opSimpNac, '3', f);
    assert.equal(n.simples.regApTribSN, '1', f);
    lidas[n.numero] = { valor: n.valores.vServ, comp: n.competencia, c: n.servico.cTribNac, ret: n.iss.tpRetISSQN };
  }
  assert.equal(docs.size, 1, 'todas as notas são do mesmo emitente');
  if (!esperado) return;
  assert.deepEqual([...docs], [esperado.doc]);
  assert.deepEqual(lidas, esperado.notas);
  // the ISS this calculator gives equals the ISS printed on the real NFS-e
  const { competencia, rbt12, atividade, notas } = esperado.iss;
  const regra = calcularRegra(atividade);
  for (const [valor, issNf] of notas) {
    const r = das.calcularReceita({ competencia, rbt12: D(rbt12), folha12: null, valor: D(valor), das: regra });
    assert.equal(r.tributos.ISS.valor.toString(), issNf, `ISS de ${valor}`);
  }
});

const nota = (o) => ({ tipo: 'NFS-e', tribISSQN: '1', tpRetISSQN: '1', regApTribSN: '1', opSimpNac: '3', ...o });
// Fictitious service company (values made up for the test; checked by hand in the comments)
const NOTAS_EXEMPLO = [
  nota({ id: '101', numero: '101', competencia: '2026-10', dataEmissao: '2026-10-07', valor: '6000.00', atividade: 'servicos-iii', nbs: '122051900' }),
  nota({ id: '102', numero: '102', competencia: '2026-10', dataEmissao: '2026-10-07', valor: '12500.00', atividade: 'servicos-iii', nbs: '122051900' }),
  nota({ id: '103', numero: '103', competencia: '2026-10', dataEmissao: '2026-10-08', valor: '3500.00', atividade: 'servicos-iii', nbs: '122051900' }),
  nota({ id: '104', numero: '104', competencia: '2026-10', dataEmissao: '2026-10-08', valor: '7000.00', atividade: 'servicos-fator-r', nbs: '114044900' }),
  nota({ id: '105', numero: '105', competencia: '2026-10', dataEmissao: '2026-10-19', valor: '9000.00', atividade: 'servicos-fator-r', nbs: '114044900' }),
];

test('DAS de outubro/2026 de uma empresa de serviços (cenário fictício) e CBS/IBS oficiais simulados em 2027', () => {
  const r = calcular({ notas: NOTAS_EXEMPLO, empresa: { '2026-10': { rbt12: '240000.00', folha12: '50000' } }, simularReforma: true }, { das, engine });
  const m = r.meses[0];
  assert.deepEqual(m.pendencias, []);
  const iii = m.das.linhas.find((l) => l.atividade === 'servicos-iii');
  const fr = m.das.linhas.find((l) => l.atividade === 'servicos-fator-r');
  assert.equal(iii.receita, '22000.00');
  assert.equal(iii.anexo, 'III');
  // AE = (240.000 × 11,20% − 9.360) / 240.000 = 7,30%; ISS = 7,30% × 32% = 2,336%
  assert.equal(iii.tributos.ISS.valor, '513.92'); // 140,16 + 292,00 + 81,76 das três NFs
  assert.equal(fr.anexo, 'V'); // r = 50.000 / 240.000 = 20,83% < 28%
  assert.equal(fr.total, '2580.00'); // AE V = (240.000 × 18% − 4.500) / 240.000 = 16,125% × 16.000,00
  assert.equal(m.das.total, Dec.of(iii.total).add(Dec.of(fr.total)).toString());
  // official engine: NFS-e rate is rounded to 2 decimals before base × rate
  const of = m.reforma.oficial;
  assert.ok(m.reforma.simulacao);
  assert.ok(of.resultados.every((x) => x.status === 200 && x.resposta.objetos[0].estadoItem === 'CALCULADO'));
  const n102 = of.resultados.find((x) => x.nota === '102').resposta.objetos[0].tribCalc;
  assert.equal(n102.pCBSSN, '1.23'); // 7,30% × 16,91% = 1,2344% → 1,23%
  assert.equal(n102.vCBSSN, '153.75'); // 12.500,00 × 1,23%
  assert.equal(of.total.vRBSN, '38000.00');
});

test('sem RBT12 o mês fica pendente, sem inventar alíquota', () => {
  const r = calcular({ notas: NOTAS_EXEMPLO.slice(0, 1), empresa: {}, simularReforma: false }, { das, engine });
  assert.equal(r.meses[0].das, undefined);
  assert.match(r.meses[0].pendencias[0], /RBT12/);
});

test('NF-e de comércio em 2027 passa pela calculadora oficial (tpDoc 55, CRT 1)', () => {
  const n = { id: 'nfe1', tipo: 'NF-e', competencia: '2027-03', dataEmissao: '2027-03-15', valor: '255.00', atividade: 'comercio',
    itens: [{ ncm: '61091000', cClassTrib: '000001', valor: '90.00' }, { ncm: '62034200', cClassTrib: '000001', valor: '165.00' }] };
  const r = calcular({ notas: [n], empresa: { '2027-03': { rbt12: '720000' } }, simularReforma: true }, { das, engine });
  const res = r.meses[0].reforma.oficial.resultados[0];
  assert.equal(res.status, 200, JSON.stringify(res.resposta));
  assert.equal(res.requisicao.tpDoc, '55');
  assert.equal(res.resposta.objetos.length, 2);
  assert.ok(res.resposta.objetos.every((o) => o.estadoItem === 'CALCULADO'), JSON.stringify(res.resposta.objetos));
  assert.equal(r.meses[0].reforma.simulacao, false);
});
