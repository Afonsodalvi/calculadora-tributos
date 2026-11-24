// Regression tests of the DoS review, batch B-dos-core:
//   DOS-1 Dec.cmp (and the other scale-aligning methods) built 10^|Δscale|: 1E-300000000 cost 10 s per field;
//   DOS-5 official calculation routes: items per operation capped at 10000 (413, documented divergence);
//   DOS-6 internal DTD: ATTLIST duplicate check was O(n²);
//   DOS-7 XSD qrCode URL patterns backtracked quadratically before maxLength was checked;
//   DOS-8 /api/simples/calcular had no cap on notas / items.
// Timing limits are generous (the fixed code answers in milliseconds; the old one took 7–40 s).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '../../src/core/decimal.js';
import { subir } from '../lib/servidor.js';
import { vetoresUnitarios } from '../lib/vetores.js';
import { restringir, TIPOS_EMBUTIDOS, ErroTipo, LIMITE_TEXTO_PADROES } from '../../src/regime-regular/xml/validacao/tipos-simples.js';
import { LIMITE_ITENS_OPERACAO } from '../../src/regime-regular/calculo/rotas.js';
import { LIMITE_ITENS_OPERACAO as LIMITE_ITENS_SIMPLES } from '../../src/simples/modulo.js';
import { verificarLimites, LIMITE_NOTAS, LIMITE_ITENS } from '../../src/simples/calculo.js';

const s = await subir();
after(() => s.fechar());

/** [result, elapsed ms] of a sync or async call. */
async function cronometrar(fn) {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}
const postar = (path, body, contentType = 'application/json') =>
  s.chamar(path, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json', 'accept-language': 'pt-BR' }, body });
const erroDe = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ─── DOS-1 ─────────────────────────────────────────────────────────────────────────────────────

test('DOS-1: cmp/compareTo/max/min de valores com expoentes enormes em O(1)', async () => {
  const minusculo = Dec.parse('1e-300000000'), enorme = Dec.parse('1e300000000');
  const [r, ms] = await cronometrar(() => [
    minusculo.cmp(Dec.of('100.00')), minusculo.compareTo(Dec.of('0')), enorme.cmp(Dec.of('0.00')), enorme.cmp(Dec.of('100.00')),
    Dec.parse('-1e300000000').cmp(Dec.parse('-1e-300000000')), Dec.parse('-1e-300000000').cmp(Dec.of('0')),
    minusculo.max(Dec.of('100.00')).toString(), enorme.min(Dec.of('1')).toString(),
  ]);
  assert.deepEqual(r, [-1, 1, 1, 1, -1, -1, '100.00', '1']);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('DOS-1: cmp continua idêntico ao alinhamento exato das escalas', () => {
  // deterministic sweep (LCG) over signs, magnitudes, trailing zeros and scale gaps up to ±60
  let x = 12345;
  const rnd = (k) => { x = (x * 1103515245 + 12345) % 2147483648; return x % k; };
  const referencia = (a, b) => {
    const sc = Math.max(a.s, b.s);
    const ua = a.u * 10n ** BigInt(sc - a.s), ub = b.u * 10n ** BigInt(sc - b.s);
    return ua < ub ? -1 : ua > ub ? 1 : 0;
  };
  const gerar = () => {
    let u = rnd(4) === 0 ? 0n : BigInt(rnd(1000000)) * 10n ** BigInt(rnd(6));
    if (rnd(2)) u = -u;
    return Dec.valueOf(u, rnd(3) ? rnd(12) - 4 : rnd(121) - 60);
  };
  for (let i = 0; i < 50000; i++) {
    const a = gerar(), b = gerar();
    assert.equal(a.cmp(b), referencia(a, b), `${a.u}E${-a.s} vs ${b.u}E${-b.s}`);
  }
});

test('DOS-1: setScale/div/toBigInteger/intValueExact/zeros sem 10^|Δescala|', async () => {
  const minusculo = Dec.parse('1e-300000000'), enorme = Dec.parse('1e300000000');
  const zeroNegativo = Dec.valueOf(0n, -300000000), zeroPositivo = Dec.valueOf(0n, 300000000);
  const t = (v) => `${v.u}|${v.s}`;
  const [r, ms] = await cronometrar(() => [
    t(minusculo.setScale(2)), t(minusculo.setScale(2, 'UP')), t(minusculo.negate().setScale(2, 'FLOOR')), erroDe(() => minusculo.setScale(2, 'UNNECESSARY')),
    t(zeroNegativo.setScale(2)), t(zeroNegativo.movePointRight(2)), t(Dec.of('1.5').add(zeroNegativo)), t(Dec.of('1.5').sub(zeroNegativo)), zeroPositivo.cmp(Dec.ZERO),
    String(minusculo.toBigInteger()), String(zeroNegativo.toBigInteger()),
    erroDe(() => minusculo.intValueExact()), erroDe(() => enorme.intValueExact()), zeroNegativo.intValueExact(),
    t(minusculo.div(Dec.of('3'), 2, 'CEILING')), t(zeroPositivo.div(Dec.of('7'), 4)), t(Dec.of('5').div(enorme, 2, 'UP')), t(Dec.of('5').div(enorme, 2)),
  ]);
  assert.deepEqual(r, [
    '0|2', '1|2', '-1|2', 'Rounding necessary',
    '0|2', '0|0', '15|1', '15|1', 0,
    '0', '0',
    'Rounding necessary', 'Overflow', 0,
    '1|2', '0|4', '1|2', '0|2',
  ]);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('DOS-1: intValueExact segue a ordem do JDK (longValueExact: Overflow antes de Rounding necessary)', () => {
  // values checked on JDK 17 (same code in 25): new BigDecimal(x).intValueExact()
  const casos = {
    '12345678901234567890.5': 'Overflow', '123456789012345678901.5': 'Overflow', '1234567890123456789.5': 'Rounding necessary',
    '0.5': 'Rounding necessary', '-0.000001': 'Rounding necessary', '12.30': 'Rounding necessary', '2147483648': 'Overflow',
    '99999999999999999999': 'Overflow', '1E+300000000': 'Overflow', '1E-300000000': 'Rounding necessary',
  };
  for (const [x, msg] of Object.entries(casos)) assert.equal(erroDe(() => Dec.parse(x).intValueExact()), msg, x);
  assert.equal(Dec.parse('2147483647.0').intValueExact(), 2147483647);
  assert.equal(Dec.parse('-2147483648').intValueExact(), -2147483648);
  assert.equal(Dec.parse('0E-300000000').intValueExact(), 0);
  assert.equal(Dec.parse('12E+2').intValueExact(), 1200);
});

const OPERACAO_2027 = (cbs) => `{"id":"6194602ea71cbf9431c236de4409d920","versao":"0.0.1","dataHoraEmissao":"2027-01-01T09:50:05-03:00","municipio":4314902,"uf":"RS","itens":[{"numero":1,"ncm":"24021000","cst":"000","cClassTrib":"000001","baseCalculo":200,"quantidade":1,"unidade":"VN","impostoSeletivo":{"cst":"000","baseCalculo":200,"quantidade":1,"unidade":"VN","impostoInformado":0,"cClassTrib":"000001"},"aliquotasNominais":{"cbs":${cbs},"ibsEstadual":0.05,"ibsMunicipal":0.05,"impostoSeletivo":{"adValorem":13,"adRem":21.3}}}]}`;

test('DOS-1: rotas oficiais com alíquota 1e-300000000 respondem em milissegundos (como o Java)', async () => {
  const [rg, ms1] = await cronometrar(() => postar('/api/calculadora/regime-geral', OPERACAO_2027('1e-300000000')));
  assert.equal(rg.status, 400);
  assert.match(rg.json.detail, /itens\[0\]\.aliquotasNominais\.cbs/);
  assert.ok(ms1 < 2000, `${ms1} ms`);
  const [obs, ms2] = await cronometrar(() => postar('/api/calculadora/observabilidade/regime-geral', OPERACAO_2027('1e300000000')));
  assert.equal(obs.status, 200);
  assert.equal(obs.json.objetos[0].estadoItem, 'INCONSISTENCIA_ENTRADA');
  assert.ok(ms2 < 2000, `${ms2} ms`);
});

test('DOS-1: /api/regime-regular/calcular com aliquotas.cbs "1e-300000000" não trava o servidor', async () => {
  const corpo = {
    operacoes: [1, 2].map((n) => ({ notaId: `n${n}`, numero: String(n), tipo: 'NF-e', data: '2027-03-10', municipio: 4314902, tpDoc: 55, itens: [{ numero: 1, ncm: '24021000', cst: '000', cClassTrib: '000001', baseCalculo: '100.00', quantidade: '1', unidade: 'UN' }] })),
    aliquotas: { cbs: '1e-300000000', ibsEstadual: '0.1', ibsMunicipal: '0.0' },
  };
  const [r, ms] = await cronometrar(() => postar('/api/regime-regular/calcular', JSON.stringify(corpo)));
  assert.equal(r.status, 200);
  assert.equal(r.json.resultados.length, 2);
  assert.ok(ms < 2000, `${ms} ms`);
});

// ─── DOS-5 ─────────────────────────────────────────────────────────────────────────────────────

const itensVazios = (n, item = '{}') => Array(n).fill(item).join(',');
const operacaoSimples = (itens) => `{"id":"x","versao":"1.0.0","data":"2027-03-15","tpDoc":"55","CRT":"1","itens":[${itens}]}`;
const operacaoRegular = (itens) => `{"id":"x","versao":"1.0.0","dhFatoGerador":"2027-03-15T10:00:00-03:00","municipio":4314902,"itens":[${itens}]}`;

test('DOS-5: limite de 10000 itens por operação nas rotas oficiais de cálculo (413 da aplicação)', async () => {
  assert.equal(LIMITE_ITENS_OPERACAO, 10000);
  assert.equal(LIMITE_ITENS_SIMPLES, 10000);
  const casos = [
    ['/api/calculadora/observabilidade/simples-nacional', operacaoSimples(itensVazios(10001))],
    ['/api/calculadora/observabilidade/simples-nacional/nao-assistido', operacaoSimples(itensVazios(150000))],
    ['/api/calculadora/regime-geral', operacaoRegular(itensVazios(10001, '{"numero":1}'))],
    ['/api/calculadora/observabilidade/regime-geral', operacaoRegular(itensVazios(120000, '{"numero":1}'))],
  ];
  for (const [rota, corpo] of casos) {
    const [r, ms] = await cronometrar(() => postar(rota, corpo));
    assert.equal(r.status, 413, `${rota}: ${r.texto.slice(0, 200)}`);
    assert.match(r.json.erro, /^Operação com \d+ itens: esta implementação aceita até 10000 itens por operação/, rota);
    assert.ok(ms < 3000, `${rota}: ${ms} ms`);
  }
});

test('DOS-5: o limite vem depois do Jackson (corpo inválido mantém a resposta oficial) e não barra 10000 itens', async () => {
  // a binding error in item 10001 is still Jackson's 400 (HttpMessageNotReadableException), as in Java
  const simplesRuim = await postar('/api/calculadora/observabilidade/simples-nacional', operacaoSimples(`${itensVazios(10000)},{"numero":"x"}`));
  assert.equal(simplesRuim.status, 400);
  assert.match(simplesRuim.json.detail, /JSON parse error/);
  const regularRuim = await postar('/api/calculadora/regime-geral', operacaoRegular(`${itensVazios(10000, '{"numero":1}')},{"numero":"x"}`));
  assert.equal(regularRuim.status, 400);
  assert.match(regularRuim.json.detail, /JSON parse error/);
  // exactly at the limit: the official answer (not the 413)
  const noLimite = await postar('/api/calculadora/observabilidade/simples-nacional', operacaoSimples(itensVazios(10000)));
  assert.notEqual(noLimite.status, 413);
});

// ─── DOS-6 ─────────────────────────────────────────────────────────────────────────────────────

const VALIDAR = (tipo, subtipo) => `/api/calculadora/xml/validate?tipo=${tipo}&subtipo=${subtipo}`;
const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';

test('DOS-6: DTD interno com 40000 ATTLIST é linear', async () => {
  const decls = Array.from({ length: 40000 }, (_, i) => `<!ATTLIST r a${i} CDATA "v">`).join('');
  const [r, ms] = await cronometrar(() => postar(VALIDAR('nfe', 'GRUPO'), `<!DOCTYPE r [${decls}]><r/>`, 'application/xml'));
  assert.equal(r.status, 422);
  assert.match(r.json.detail, /cvc-elt\.1\.a: Não foi possível encontrar a declaração do elemento 'r'\./);
  assert.ok(ms < 3000, `${ms} ms`);
});

test('DOS-6: a primeira declaração de um atributo continua valendo (mensagens iguais às do Java)', async () => {
  const primeiro = await postar(VALIDAR('nfe', 'GRUPO'), `<!DOCTYPE infNFe [<!ATTLIST infNFe xmlns CDATA "${NS_NFE}"><!ATTLIST infNFe xmlns CDATA "urn:x">]><infNFe><det/></infNFe>`, 'application/xml');
  assert.equal(primeiro.json.detail, "Erro na validação do XML: Erro na linha 1, coluna 138: cvc-complex-type.4: O atributo 'nItem' deve aparecer no elemento 'det'.");
  const segundo = await postar(VALIDAR('nfe', 'GRUPO'), `<!DOCTYPE infNFe [<!ATTLIST infNFe xmlns CDATA "urn:x"><!ATTLIST infNFe xmlns CDATA "${NS_NFE}">]><infNFe><det/></infNFe>`, 'application/xml');
  assert.equal(segundo.json.detail, "Erro na validação do XML: Erro na linha 1, coluna 132: cvc-elt.1.a: Não foi possível encontrar a declaração do elemento 'infNFe'.");
  const padrao = await postar(VALIDAR('nfe', 'GRUPO'), `<!DOCTYPE infNFe [<!ATTLIST det z CDATA "7"><!ATTLIST det nItem CDATA "8">]><infNFe xmlns="${NS_NFE}"><det/></infNFe>`, 'application/xml');
  assert.equal(padrao.json.detail, "Erro na validação do XML: Erro na linha 1, coluna 134: cvc-complex-type.3.2.2: O atributo 'z' não pode aparecer no elemento 'det'.");
});

// ─── DOS-7 ─────────────────────────────────────────────────────────────────────────────────────

const PADRAO_QR_CTE = '((HTTPS?|https?)://.*\\?chCTe=[0-9]{6}[A-Z0-9]{12}[0-9]{26}&tpAmb=[1-2](&sign=[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}|[!-ÿ]{1})?)';
const qrAdversario = (n) => `https://h${'?chCTe=26250111111111000111570100000000841000008495&tpAmb=1&sign=ab'.repeat(n)}Ā`;

test('DOS-7: texto muito acima do maxLength pula os padrões (cvc-maxLength-valid em milissegundos)', async () => {
  const tipo = restringir(TIPOS_EMBUTIDOS.get('string'), {
    nome: 'TQrCode', ns: 'urn:t', anonimo: false,
    facetas: [{ tipo: 'minLength', valor: '50' }, { tipo: 'maxLength', valor: '1000' }, { tipo: 'pattern', valor: PADRAO_QR_CTE }],
  });
  const chave = (v) => { try { tipo.validar(v); return 'ok'; } catch (e) { assert.ok(e instanceof ErroTipo); return e.chave; } };
  const [r, ms] = await cronometrar(() => chave(qrAdversario(20000))); // 1.3 MB: 22 s before
  assert.equal(r, 'cvc-maxLength-valid');
  assert.ok(ms < 2000, `${ms} ms`);
  // realistic oversize values (up to the 64 KB bound) keep Xerces' order: pattern first
  assert.equal(chave(qrAdversario(15)), 'cvc-pattern-valid');
  assert.ok(qrAdversario(975).length <= LIMITE_TEXTO_PADROES);
  assert.equal(chave(qrAdversario(975)), 'cvc-pattern-valid');
  assert.equal(chave(`https://h${'x'.repeat(1000)}?chCTe=26250111111111000111570100000000841000008495&tpAmb=1`), 'cvc-maxLength-valid');
  assert.equal(chave('https://h?chCTe=26250111111111000111570100000000841000008495&tpAmb=1&sign=ab'), 'ok');
});

test('DOS-7: CT-e com qrCodCTe de 1,3 MB responde 422 rápido; qrCodCTe de 1 KB mantém a mensagem do Java', async () => {
  const cte = vetoresUnitarios('dados-unit', 'XmlUtil.getSchema+validate').find((v) => v.id === 'xml-01-09-valido-CTE-NOTA').input.xml;
  const comQr = (qr) => cte.replace(/<qrCodCTe>[^<]*<\/qrCodCTe>/, `<qrCodCTe>${qr.replaceAll('&', '&amp;')}</qrCodCTe>`);
  const [grande, ms] = await cronometrar(() => postar(VALIDAR('cte', 'NOTA'), comQr(qrAdversario(20000)), 'application/xml'));
  assert.equal(grande.status, 422);
  assert.match(grande.json.detail, /^Erro na validação do XML: Erro na linha \d+, coluna \d+: cvc-maxLength-valid: /);
  assert.ok(ms < 3000, `${ms} ms`);
  const realista = await postar(VALIDAR('cte', 'NOTA'), comQr(qrAdversario(15)), 'application/xml');
  assert.equal(realista.status, 422);
  assert.match(realista.json.detail, /^Erro na validação do XML: Erro na linha \d+, coluna \d+: cvc-pattern-valid: /);
});

// ─── DOS-8 ─────────────────────────────────────────────────────────────────────────────────────

const notaManual = (i, extra = {}) => ({ id: `x${i}`, tipo: 'manual', competencia: '2027-03', valor: '100.00', atividade: 'servicos-iii', ...extra });

test('DOS-8: /api/simples/calcular limita notas e itens (400 antes de qualquer cálculo)', async () => {
  assert.equal(LIMITE_NOTAS, 2000);
  assert.equal(LIMITE_ITENS, 10000);
  const empresa = { '2027-03': { rbt12: '500000.00' } };
  const [muitas, ms] = await cronometrar(() => postar('/api/simples/calcular', JSON.stringify({ notas: Array.from({ length: 20000 }, (_, i) => notaManual(i)), empresa })));
  assert.equal(muitas.status, 400);
  assert.equal(muitas.json.erro, 'Envie até 2000 notas por cálculo (recebidas 20000).');
  assert.ok(ms < 2000, `${ms} ms`);
  const itens = Array.from({ length: 10001 }, () => ({ valor: '1.00' }));
  const muitosItens = await postar('/api/simples/calcular', JSON.stringify({ notas: [notaManual(1, { tipo: 'NF-e', atividade: 'comercio', itens })], empresa }));
  assert.equal(muitosItens.status, 400);
  assert.equal(muitosItens.json.erro, 'Envie até 10000 itens de nota por cálculo (recebidos 10001).');
  const objeto = await postar('/api/simples/calcular', JSON.stringify({ notas: { a: 1 }, empresa }));
  assert.equal(objeto.status, 400);
  assert.equal(objeto.json.erro, 'Envie as notas como uma lista.');
  const poucas = await postar('/api/simples/calcular', JSON.stringify({ notas: [notaManual(1), notaManual(2)], empresa }));
  assert.equal(poucas.status, 200);
  assert.deepEqual(poucas.json.meses[0].notas, ['x1', 'x2']);
});

test('DOS-8: verificarLimites nos limites exatos', () => {
  assert.equal(verificarLimites(undefined), null);
  assert.equal(verificarLimites(Array(LIMITE_NOTAS).fill({})), null);
  assert.match(verificarLimites(Array(LIMITE_NOTAS + 1).fill({})), /até 2000 notas/);
  assert.equal(verificarLimites([{ itens: Array(LIMITE_ITENS).fill({}) }]), null);
  assert.match(verificarLimites([{ itens: Array(LIMITE_ITENS - 1).fill({}) }, { itens: [{}, {}] }]), /até 10000 itens/);
  assert.match(verificarLimites('abc'), /lista/);
});

test('DOS-8: nota com vários itens no mesmo grupo aparece uma vez (Set no lugar de includes)', async () => {
  const notas = [notaManual(1, { tipo: 'NF-e', atividade: 'comercio', valor: '30.00', itens: [{ valor: '10.00' }, { valor: '20.00' }] }), notaManual(2, { atividade: 'comercio' }), notaManual(1, { atividade: 'comercio', valor: '5.00' })];
  const r = await postar('/api/simples/calcular', JSON.stringify({ notas, empresa: { '2027-03': { rbt12: '500000.00' } }, simularReforma: false }));
  assert.equal(r.status, 200);
  const linhas = r.json.meses[0].das.linhas;
  assert.equal(linhas.length, 1);
  assert.deepEqual(linhas[0].notas, ['x1', 'x2']);
  assert.equal(linhas[0].receita, '135.00');
});
