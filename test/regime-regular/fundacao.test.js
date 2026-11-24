// Foundation of the regime-regular port: Dec (BigDecimal parity, checked against jshell output),
// Jackson-compatible JSON reader/binders/writer (checked against messages captured from the Java API),
// ProblemDetail/headers, ArredondamentoUtils (official unit vectors), Spring fallback routes and the
// version/download routes (checked against captured oracle answers), and the vector/differential tools.
// With ORACULO_URL set (the official Java API started as in the README, e.g. http://127.0.0.1:8080),
// a live differential also runs; without it the differential is skipped (opt-in).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { Dec, NumberFormatException } from '../../src/core/decimal.js';
import { javaDoubleToString, javaFloatToString, decodificarUtf8Java, javaFormat, javaTrim, javaIsBlank, javaEqualsIgnoreCase } from '../../src/regime-regular/comum/java.js';
import {
  lerDocumentoJson, lerJsonTexto, lerCorpoRequisicao, escreverJson, textoJson, JsonNum, JsonObj, NULO, NumeroCru,
  comoString, comoInteger, comoLong, comoBigDecimal, comoEnumValor, comoObjeto, comoLista, comoDataHora, comoData, ErroJson,
} from '../../src/regime-regular/comum/json.js';
import {
  ErroJava, ErrosCalculo, ErroSerializacao, ErroTipoArgumento, ErroValidacaoCorpo, respostaErro, respostaFalhaEscrita, problemDetail,
  erroDescricao, statusPorClasse, problemTypePorClasse, cabecalhosSeguranca, cabecalhosVersao, VERSAO_APLICACAO, erroDetalhe, codigoValidacaoDaAnotacao,
} from '../../src/regime-regular/comum/problema.js';
import * as A from '../../src/regime-regular/comum/arredondamento.js';
import { lerParametrosTomcat, parametrosTomcat, parametroInteiro, parametroTexto, lerMediaType, mediaTypeTexto, negociar, lerAccept, tratarOficial, estiloOficial, contentDisposition } from '../../src/regime-regular/comum/spring.js';
import { versaoOfflineOutput, versaoOfflineJson, versaoOfflineYaml, criarServicoVersao, resolverDownload } from '../../src/regime-regular/versao/rotas.js';
import { criarRoteador, criarContexto } from '../../src/http/roteador.js';
import { subir, raiz } from '../lib/servidor.js';
import { vetoresHttp, vetoresUnitarios, executarVetor, requisicaoDoVetor } from '../lib/vetores.js';
import { verificarChave, lerResposta, verificarInvariantesArredondamento } from '../lib/jsonpath-regreg.js';
import { normalizarCorpo, diffTexto, enviarCru, subirApp, compararTodos } from '../lib/diferencial.js';
import { lerOperacao } from '../lib/operacao-input-binder.js';
import { abrirBanco } from '../../src/core/db.js';

const fixture = (nome) => JSON.parse(readFileSync(new URL(`../fixtures/regime-regular/${nome}`, import.meta.url), 'utf8'));
const base = abrirBanco(`${raiz}data/calculadora-pro.db`);
after(() => base.close());

// ─── Dec ────────────────────────────────────────────────────────────────────

test('Dec: 735 operações idênticas ao java.math.BigDecimal (valores do jshell)', () => {
  const { casos } = fixture('decimal-jshell.json');
  const q = (d) => `${d.u}|${d.s}`;
  const tentar = (f) => { try { return q(f()); } catch (e) { return `EX:${e.classeJava ?? e.name}:${e.message}`; } };
  const falhas = [];
  for (const c of casos) {
    const [a, b, m] = c.args;
    let js;
    if (c.op === 'unary') { const x = Dec.parse(a); js = [x.toJavaString(), x.toPlainString(), String(x.precision()), q(x.stripTrailingZeros()), String(x.toBigInteger()), String(x.signum())]; }
    else if (c.op === 'binary') { const x = Dec.parse(a), y = Dec.parse(b); js = [q(x.add(y)), q(x.sub(y)), q(x.mul(y)), String(x.compareTo(y)), String(x.equalsJava(y)), tentar(() => x.divideMC(y, 34, 'HALF_EVEN')), tentar(() => x.divideExact(y))]; }
    else { js = [tentar(() => Dec.parse(a).setScale(Number(b), m))]; }
    if (JSON.stringify(js) !== JSON.stringify(c.java)) falhas.push(`${c.op} ${c.args}: java ${c.java} js ${js}`);
  }
  assert.deepEqual(falhas, []);
});

test('Dec.parse: gramática e erros de new BigDecimal(String) (JDK 25)', () => {
  const ok = { '+.5': '5|1', '5.': '5|0', '-.5e-3': '-5|4', '1e2147483647': '1|-2147483647', '1e2147483648': '1|-2147483648', '١٢': '12|0', '1e0001': '1|-1', '00012.3400': '123400|4', '0e5': '0|-5', '-0.00': '0|2' };
  for (const [t, e] of Object.entries(ok)) { const d = Dec.parse(t); assert.equal(`${d.u}|${d.s}`, e, t); }
  const erros = { '': 'null', '+': 'No digits found.', '.': 'No digits found.', abc: 'Character a is neither a decimal digit number, decimal point, nor "e" notation exponential mark.',
    '1.2.3': 'Character array contains more than one decimal point.', ' 1': 'Character   is neither a decimal digit number, decimal point, nor "e" notation exponential mark.',
    '1e-2147483648': 'Exponent overflow.', '1e9999999999': 'Exponent overflow.', '1e+-1': 'Not a digit.', '1e': 'null' };
  for (const [t, m] of Object.entries(erros)) assert.throws(() => Dec.parse(t), (e) => e instanceof NumberFormatException && e.message === m, t);
  assert.equal(Dec.parseAscii('١'), null, 'FastDoubleParser só aceita dígitos ASCII');
  assert.equal(Dec.parseAscii('1e2147483648'), null);
  assert.equal(Dec.parse('1E+3').toJavaString(), '1E+3');
  assert.equal(Dec.parse('0.0000001').toJavaString(), '1E-7');
  assert.equal(Dec.parse('0E+3').toPlainString(), '0');
  assert.equal(Dec.of('1.50').toString(), '1.50', 'toString do Simples continua toPlainString');
  assert.throws(() => Dec.parse('1').divideMC(Dec.ZERO), /Division by zero/);
  assert.throws(() => Dec.ZERO.divideMC(Dec.ZERO), /Division undefined/);
  assert.equal(Dec.parse('1').divideMC(Dec.parse('3')).precision(), 34);
  assert.equal(Dec.parse('2.5').intValueExact.call(Dec.parse('25')), 25);
  assert.throws(() => Dec.parse('2.5').intValueExact(), /Rounding necessary/);
});

// ─── Java helpers ───────────────────────────────────────────────────────────

test('java.js: Double/Float.toString, UTF-8 do JDK, Formatter, trim/isBlank/equalsIgnoreCase', () => {
  for (const [x, s] of [[100, '100.0'], [-1500, '-1500.0'], [Infinity, 'Infinity'], [1.5, '1.5'], [1e7, '1.0E7'], [1e-3, '0.001'], [1e-4, '1.0E-4'], [0, '0.0'], [-0, '-0.0'], [123456789012, '1.23456789012E11'], [0.1 + 0.2, '0.30000000000000004']]) assert.equal(javaDoubleToString(x), s, String(x));
  assert.equal(javaFloatToString(3.285), '3.285');
  assert.equal(javaFloatToString(1e7), '1.0E7');
  assert.equal(decodificarUtf8Java(Buffer.from([0xed, 0xa0, 0x80])), '�', 'surrogate codificado = 1 substituto');
  assert.equal(decodificarUtf8Java(Buffer.from([0xc3])), '�');
  assert.equal(decodificarUtf8Java(Buffer.from([0xe9])), '�');
  assert.equal(decodificarUtf8Java(Buffer.from([0xc3, 0xa9]), false), 'é');
  assert.equal(decodificarUtf8Java(Buffer.from([0xc3]), false), null);
  assert.equal(javaFormat('Município de código %d não pertence à UF de sigla %s', 1, null), 'Município de código 1 não pertence à UF de sigla null');
  assert.equal(javaFormat('%s', Dec.parse('1E+3')), '1E+3');
  assert.equal(javaFormat('%s', [1, 'a']), '[1, a]');
  assert.throws(() => javaFormat('Tributo com id s% não encontrado %s', 1), (e) => e.classeJava === 'IllegalFormatFlagsException' && e.message === "Flags = ' '");
  assert.equal(javaTrim('  x \t'), '  x');
  assert.equal(javaIsBlank(' \t '), true);
  assert.equal(javaIsBlank(' '), false);
  assert.equal(javaEqualsIgnoreCase('Windows', 'wINDOWS'), true);
});

// ─── JSON reader / binders ──────────────────────────────────────────────────

test('leitor JSON + binders: 685 corpos com a resposta do Jackson capturada do oráculo', () => {
  const { casos } = fixture('jackson-mensagens.json');
  const falhas = [];
  for (const c of casos) {
    const r = lerOperacao(Buffer.from(c.corpo, 'base64'));
    const ok = c.erroLeitura ? !r.ok && r.detail === c.erroLeitura : r.ok;
    if (!ok) falhas.push(`${Buffer.from(c.corpo, 'base64').toString('latin1').slice(0, 120)} → java ${c.erroLeitura} | porte ${r.ok ? 'OK' : r.detail}`);
  }
  assert.deepEqual(falhas, []);
});

test('leitor JSON: lexema e tipo do token, duplicatas, BOM, árvore parcial', () => {
  const doc = lerDocumentoJson(Buffer.from('﻿{"a":1.50,"a":"x","b":[1e2,-0,true,null],"c":{}}'));
  const raizNo = doc.raiz;
  assert.ok(raizNo instanceof JsonObj);
  assert.deepEqual(raizNo.entradas.map(([k]) => k), ['a', 'a', 'b', 'c']);
  assert.equal(raizNo.entradas[0][1].src, '1.50');
  assert.equal(raizNo.entradas[0][1].inteiro, false);
  assert.equal(raizNo.get('a'), 'x', 'a última duplicata vence');
  assert.equal(raizNo.get('b').itens[1].src, '-0');
  doc.verificarFim('T');
  // syntax error after a value: earlier coercion error wins (Jackson binds while streaming)
  const r = lerOperacao(Buffer.from('{"tpDoc":"x", "a":'));
  assert.match(r.detail, /java\.lang\.Integer.*from String "x"/);
  assert.equal(lerOperacao(Buffer.from('')).detail.startsWith('Required request body is missing: public'), true);
  assert.equal(lerOperacao(Buffer.from('  ')).detail, 'JSON parse error: No content to map due to end-of-input');
  assert.equal(lerOperacao(Buffer.from('null {}')).detail, 'JSON parse error: Trailing token (`JsonToken.START_OBJECT`) found after value (bound as `br.gov.serpro.rtc.api.model.input.OperacaoInput`): not allowed as per `DeserializationFeature.FAIL_ON_TRAILING_TOKENS`');
  // charset declared by the request (InputStreamReader) and UTF-16 autodetection
  const latin = lerOperacao(Buffer.from('{"id":"\xe9"}', 'latin1'), 'ISO-8859-1');
  assert.equal(latin.valor.id, 'é');
  assert.equal(lerOperacao(Buffer.from('﻿{"id":"é"}', 'utf16le')).valor.id, 'é');
});

test('binders: coerções do Jackson 3 por tipo Java', () => {
  const n = (s, inteiro) => new JsonNum(s, inteiro);
  assert.equal(comoString(n('1.50', false)), '1.50');
  assert.equal(comoString(true), 'true');
  assert.equal(comoInteger(n('1.9', false)), 1);
  assert.equal(comoInteger(n('-1.9', false)), -1);
  assert.equal(comoInteger(' +5 '), 5);
  assert.equal(comoInteger('٥'), 5);
  assert.equal(comoInteger('  '), null);
  assert.equal(comoInteger('null'), null);
  assert.throws(() => comoInteger('2147483648'), /Overflow: numeric value \(2147483648\) out of range of `java.lang.Integer` \(-2147483648 -2147483647\)/);
  assert.throws(() => comoInteger(n('2147483647.9', false)), /out of range of `int`/);
  assert.equal(comoLong(n('9223372036854775807.5', false)), 9223372036854775807n);
  assert.equal(comoLong('9223372036854775807'), 9223372036854775807n);
  assert.throws(() => comoLong('0x5'), /not a valid `java.lang.Long` value/);
  assert.equal(comoBigDecimal(n('200.00', false)).toJavaString(), '200.00');
  assert.equal(comoBigDecimal(n('2e2', false)).toJavaString(), '2E+2');
  assert.equal(comoBigDecimal('\t12\n').toJavaString(), '12');
  assert.throws(() => comoBigDecimal('١'), /not a valid representation/);
  assert.throws(() => comoBigDecimal(n('1e-2147483648', false)), /value exceeds limits/);
  const valores = new Map([['1', 'UNIAO'], ['2', 'ESTADO']]);
  assert.equal(comoEnumValor(n('2', true), { tipoJava: 'E', valores }), 'ESTADO');
  assert.equal(comoEnumValor(' 1 ', { tipoJava: 'E', valores }), 'UNIAO');
  assert.throws(() => comoEnumValor('  ', { tipoJava: 'E', valores }), /Cannot coerce empty String/);
  assert.throws(() => comoEnumValor(n('2.0', false), { tipoJava: 'E', valores }), /from Floating-point value/);
  assert.equal(comoDataHora('2026-01-01T10:00:00-00:00', 'dh'), '2026-01-01T10:00:00-00:00');
  for (const ruim of ['2026-02-29T10:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T10:00:00+18:01', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00+0300']) assert.throws(() => comoDataHora(ruim, 'dh'), /Campo 'dh' \[/, ruim);
  assert.equal(comoData('2028-02-29', 'd'), '2028-02-29');
  assert.throws(() => comoData('2026-02-29', 'd'), /Formato esperado: 'yyyy-MM-dd'/);
  const obj = comoObjeto(lerJsonTexto('{"a":"1","b":[1,2],"zz":{"x":[]}}'), 'T', { a: comoInteger, b: (v) => comoLista(v, 'L', comoInteger) });
  assert.deepEqual(obj, { a: 1, b: [1, 2] });
  assert.throws(() => comoObjeto(' x ', 'T', {}), /from String value \('x'\)/);
});

test('escritor JSON: paridade com o jackson-core (escapes, ordem, números)', () => {
  assert.equal(textoJson('a/b"c\\\u0001\u001f\u007f é'), '"a/b\\"c\\\\\\u0001\\u001F\u007f é"');
  assert.equal(textoJson('\ud800x\udc00'), '"\\uD800x\\uDC00"');
  assert.equal(textoJson('😀'), '"😀"');
  assert.equal(escreverJson({ b: 1, a: null, c: undefined, d: [null, 1], e: Dec.parse('60.0'), f: Dec.parse('1E+3'), g: new NumeroCru('1.0'), h: NULO, i: 1.5, j: 10n }),
    '{"b":1,"d":[null,1],"e":60.0,"f":1E+3,"g":1.0,"h":null,"i":1.5,"j":10}');
  assert.equal(escreverJson({ a: null }, { nulos: true }), '{"a":null}');
  assert.equal(escreverJson(lerJsonTexto('{"x":1.50}')), '{"x":1.50}');
});

// ─── ProblemDetail / errors ─────────────────────────────────────────────────

const ctx = { baseURL: 'http://localhost', instance: '/api/calculadora/regime-geral' };
const semTs = (s) => s.replace(/"timestamp":"[^"]*"/, '"timestamp":"T"');

test('ProblemDetail: ordem do Jackson 3 e despacho do ApiExceptionHandler por classe Java', () => {
  const r1 = respostaErro(new ErroJava('NcmNbsSimultaneasException', 'Não é permitido informar NCM e NBS simultaneamente para um item'), ctx);
  assert.equal(r1.status, 422);
  assert.equal(r1.tipo, 'application/problem+json');
  assert.equal(semTs(r1.body), '{"detail":"Não é permitido informar NCM e NBS simultaneamente para um item","instance":"/api/calculadora/regime-geral","status":422,"title":"NCM e NBS informadas simultaneamente","type":"http://localhost/errors/ncm-nbs-simultaneas","timestamp":"T"}');
  assert.match(r1.body, /"timestamp":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z"/);
  assert.equal(statusPorClasse('DataFatoGeradorNaoInformadaException'), 400);
  assert.equal(statusPorClasse('IndicadorOperacaoNaoEncontradoException'), 404);
  assert.equal(problemTypePorClasse('IndicadorOperacaoNaoEncontradoException').nome, 'ERRO_SISTEMA');
  assert.equal(statusPorClasse('CaptchaException'), 422);
  assert.equal(statusPorClasse('FormaAplicacaoNaoTratadaException'), 500);
  assert.equal(statusPorClasse('ArithmeticException'), 500);
  const bug = new ErroJava('TributoSituacaoTributariaNaoEncontradoException', 'x');
  assert.equal(bug.classeJava, 'IllegalFormatFlagsException');
  assert.equal(semTs(respostaErro(bug, ctx).body), '{"detail":"Flags = \' \'","instance":"/api/calculadora/regime-geral","status":500,"title":"Erro de sistema não previsto","type":"http://localhost/errors/erro-de-sistema-nao-previsto","timestamp":"T"}');
  const nulo = respostaErro(new ErroJava('NcmCompletoNaoInformadoException', null), ctx);
  assert.ok(!nulo.body.includes('"detail"'), 'NON_EMPTY: detail nulo omitido');
  const tipoArg = respostaErro(new ErroTipoArgumento('data', '2026-99-99'), ctx);
  assert.equal(semTs(tipoArg.body), '{"detail":"Parâmetro inválido [data: 2026-99-99] ","instance":"/api/calculadora/regime-geral","status":400,"title":"Tipo de argumento inválido","type":"http://localhost/errors/tipo-argumento-invalido","timestamp":"T"}');
  const val = respostaErro(new ErroValidacaoCorpo([['itens[0].cst', 'must not be null']]), ctx);
  assert.equal(semTs(val.body), '{"detail":"Um ou mais campos são inválidos - [itens[0].cst: must not be null] ","instance":"/api/calculadora/regime-geral","status":400,"title":"Campos inválidos.","type":"http://localhost/errors/erro-de-sistema-nao-previsto","timestamp":"T"}');
  const e422 = respostaErro(new ErrosCalculo([erroDetalhe({ type: 'http://localhost/calculadora/observabilidade/erros?codigo=VAL-001', title: 'Campo obrigatório não informado', code: 'VAL-001', pointer: '#/id', detail: "Campo 'id' must not be null" })]), { ...ctx, instance: '/api/calculadora/observabilidade/regime-geral' });
  assert.equal(semTs(e422.body), '{"detail":"O cálculo contém 1 erro(s).","instance":"/api/calculadora/observabilidade/regime-geral","status":422,"title":"Erros no processamento do cálculo","type":"about:blank","timestamp":"T","errors":[{"type":"http://localhost/calculadora/observabilidade/erros?codigo=VAL-001","title":"Campo obrigatório não informado","code":"VAL-001","pointer":"#/id","detail":"Campo \'id\' must not be null"}]}');
  assert.equal(respostaFalhaEscrita('/api/x').body, '{"detail":"Failed to write request","instance":"/api/x","status":500,"title":"Internal Server Error"}');
  assert.ok(new ErroSerializacao('Números negativos não são permitidos para TDec1302') instanceof ErroJava);
  // oracle: impostoSeletivo.unidade with 8 chars → StringUTribSerializer fails → this exact body (X-CALC-* kept)
  assert.equal(respostaErro(new ErroSerializacao('uTrib deve ter entre 1 e 6 caracteres', 'DatabindException'), ctx).body, '{"detail":"Failed to write request","instance":"/api/calculadora/regime-geral","status":500,"title":"Internal Server Error"}');
  assert.deepEqual(erroDescricao('REG-011'), { codigo: 'REG-011', titulo: 'NCM não vinculada', descricao: 'O código NCM informado não está vinculado a nenhuma classificação tributária vigente.' });
  assert.equal(erroDescricao('REG-017'), null);
  assert.equal(erroDescricao('VAL-009').titulo, 'Formato inválido');
  assert.equal(codigoValidacaoDaAnotacao('Digits'), 'VAL-010');
  assert.equal(codigoValidacaoDaAnotacao('Qualquer'), 'VAL-000');
  assert.equal(problemDetail({ detail: '', instance: '/i', status: 404 }), '{"instance":"/i","status":404,"title":"Not Found"}');
  assert.deepEqual(cabecalhosVersao(base), { 'X-CALC-APP-VERSION': VERSAO_APLICACAO, 'X-CALC-DB-VERSION': 'V0073' });
  assert.deepEqual(Object.keys(cabecalhosSeguranca({ cacheControl: 'max-age=3600, public' })), ['X-Content-Type-Options', 'X-XSS-Protection', 'Cache-Control', 'X-Frame-Options']);
});

// ─── ArredondamentoUtils (official unit vectors) ────────────────────────────

function javaRandom(seed) {
  const MASK = (1n << 48n) - 1n;
  let s = (BigInt(seed) ^ 0x5deece66dn) & MASK;
  const next = (bits) => { s = (s * 0x5deece66dn + 0xbn) & MASK; return BigInt.asIntN(32, s >> BigInt(48 - bits)); };
  return {
    nextInt(bound) {
      if ((bound & -bound) === bound) return Number((BigInt(bound) * next(31)) >> 31n);
      let bits, val;
      do { bits = Number(next(31)); val = bits % bound; } while (bits - val + (bound - 1) > 2147483647);
      return val;
    },
    nextLong() { return BigInt.asIntN(64, (next(32) << 32n) + next(32)); },
  };
}

for (const v of vetoresUnitarios('dados-unit', 'ArredondamentoUtils.')) {
  test(`vetor ${v.id}`, () => {
    const metodo = v.endpoint.split('.')[1];
    if (metodo === 'MODO') {
      assert.equal(A.MODO, v.expected.MODO);
      assert.equal(A.CONTEXTO_DIVISAO.roundingMode, v.expected['CONTEXTO_DIVISAO.roundingMode']);
      assert.equal(String(A.CONTEXTO_DIVISAO.precision), v.expected['CONTEXTO_DIVISAO.precision']);
      return;
    }
    if (v.input.generator) {
      const r = javaRandom(20261117n);
      for (let k = 0; k < 2000; k++) {
        if (metodo === 'ratearValorFiscal') {
          const n = 1 + r.nextInt(12);
          const exatas = Array.from({ length: n }, () => Dec.valueOf(r.nextInt(5_000_000), 6));
          const parcelas = A.ratearValorFiscal(exatas);
          assert.equal(A.totalizar(parcelas).compareTo(A.arredondarValorFiscal(A.totalizar(exatas))), 0);
          parcelas.forEach((p, i) => { assert.equal(p.scale(), 2); assert.ok(p.sub(exatas[i]).abs().compareTo(Dec.parse('0.01')) < 0); });
        } else if (metodo === 'formatarMoeda') {
          let l = r.nextLong() % 1_000_000_000_000n; if (l < 0n) l = -l;
          const val = A.arredondarValorFiscal(Dec.valueOf(l, 5));
          assert.equal(Dec.parse(A.formatarMoeda(val)).compareTo(val), 0);
        } else {
          const a = A.arredondarAliquotaPublicada(Dec.valueOf(r.nextInt(100_000_000), 6));
          assert.equal(Dec.parse(A.formatarAliquota(a)).compareTo(a), 0);
        }
      }
      return;
    }
    const arg = (x) => (x === null ? null : Array.isArray(x) ? x.map((y) => Dec.parse(y)) : typeof x === 'number' ? x : Dec.parse(x));
    const args = v.input.args.map(arg);
    const res = A[metodo](...args);
    for (const [k, e] of Object.entries(v.expected)) {
      if (k === 'result.precision()') { assert.equal(String(res.precision()), e); continue; }
      if (e === '<null>') { assert.equal(res, null); continue; }
      if (Array.isArray(res)) { assert.equal(JSON.stringify(res.map((d) => d.toPlainString())), e); continue; }
      // assertEquals on BigDecimal = value AND scale
      if (res instanceof Dec) assert.ok(res.equalsJava(Dec.parse(e)), `${res.toJavaString()} != ${e}`);
      else assert.equal(res, e);
    }
  });
}

test('ArredondamentoUtils: formatadores e dividir (calc-core §2)', () => {
  assert.equal(A.formatarAliquota(Dec.parse('0.2080')), '0.208');
  assert.equal(A.formatarAliquota(Dec.parse('100')), '100.00');
  assert.equal(A.formatarAliquota(Dec.parse('0.00015')), '0.0002');
  assert.equal(A.formatarQuantidade(Dec.parse('1E+3')), '1000');
  assert.equal(A.formatarQuantidade(Dec.parse('0.00')), '0');
  assert.equal(A.formatarQuantidade(Dec.parse('0.00001')), '0.0000');
  assert.equal(A.dividir(Dec.parse('30'), Dec.parse('70')).toPlainString(), '0.4285714285714285714285714285714286');
  assert.equal(A.dividir(Dec.parse('40'), Dec.parse('100')).toPlainString(), '0.4');
  assert.equal(A.dividir(Dec.parse('0.0'), Dec.parse('100')).toJavaString(), '0.0');
});

// ─── Spring/Tomcat helpers ──────────────────────────────────────────────────

test('@RequestParam Long/String: conversões do Spring (observadas no oráculo)', () => {
  const p = (q) => parametrosTomcat(q);
  assert.equal(parametroInteiro(p('codigoUf=0x1A'), 'codigoUf'), 26);
  assert.equal(parametroInteiro(p('codigoUf=-0x10'), 'codigoUf'), -16);
  assert.equal(parametroInteiro(p('codigoUf=%2035%20'), 'codigoUf'), 35);
  assert.equal(parametroInteiro(p('codigoUf=3%205'), 'codigoUf'), 35);
  assert.equal(parametroInteiro(p('codigoUf=035'), 'codigoUf'), 35);
  assert.equal(parametroInteiro(p('codigoUf=%D9%A5'), 'codigoUf'), 5);
  assert.equal(parametroInteiro(p('codigoUf=35&codigoUf=x'), 'codigoUf'), 35);
  for (const q of ['', 'codigoUf=', 'codigoUf=%20']) assert.throws(() => parametroInteiro(p(q), 'codigoUf'), (e) => e.status === 400 && e.detail === "Required parameter 'codigoUf' is not present.");
  for (const [q, v] of [['codigoUf=abc', 'abc'], ['codigoUf=%23Z', '#Z'], ['codigoUf=99999999999999999999', '99999999999999999999']]) {
    assert.throws(() => parametroInteiro(p(q), 'codigoUf'), (e) => e instanceof ErroTipoArgumento && e.valor === v);
  }
  assert.throws(() => parametroInteiro(p('codigoUf=x&codigoUf=35'), 'codigoUf'), (e) => /^\[Ljava\.lang\.String;@[0-9a-f]+$/.test(e.valor));
  assert.equal(parametroTexto(p('codigo=A&codigo=B'), 'codigo'), 'A,B');
  assert.equal(parametroTexto(p('codigo='), 'codigo'), '');
  assert.throws(() => parametroTexto(p(''), 'codigo'), /Required parameter 'codigo'/);
});

test('Tomcat: parâmetros de consulta e mensagens de falha', () => {
  assert.deepEqual([...lerParametrosTomcat('platform&platform=z&a+b=c%20d').mapa], [['platform', ['', 'z']], ['a b', ['c d']]]);
  assert.equal(lerParametrosTomcat('platform=y&=x').erro, 'Invalid chunk starting at byte [11] and ending at byte [13] with a value of [=x] ignored');
  assert.match(lerParametrosTomcat('platform=%41%ZZ').erro, /Parameter \[platform\] with value \[A41%ZZ\]/);
  assert.match(lerParametrosTomcat('platform=a+%E9b%41').erro, /with value \[a �bA\]/);
  assert.match(lerParametrosTomcat('%C3%A9%E9%ZZ').erro, /Parameter \[Ã©é%A9%E9%ZZ\]/);
  assert.match(lerParametrosTomcat(Array.from({ length: 1001 }, (_, i) => `p${i}=1`).join('&')).erro, /\(\[1,000\]\)/);
  assert.equal(mediaTypeTexto(lerMediaType('Text/Plain; Charset=utf-8 ; q=1')), 'text/plain;Charset=utf-8;q=1');
  assert.equal(lerMediaType('application/json;charset=foo'), null);
  assert.equal(lerMediaType('application'), null);
  assert.equal(lerAccept('foo'), null);
  assert.equal(negociar(lerAccept('application/problem+json'), ['application/json', 'application/*+json', 'application/yaml']), 'application/problem+json');
  assert.equal(negociar(lerAccept(''), ['application/json', 'application/*+json', 'application/yaml']), 'application/json');
  assert.equal(negociar(lerAccept('application/yaml'), ['application/json', 'application/*+json', 'application/yaml']), 'application/yaml');
  assert.equal(estiloOficial('/api/calculadora/observabilidade/simples-nacional'), 'simples');
  assert.equal(estiloOficial('/api/versao/status?x'), 'regime-regular');
  assert.equal(estiloOficial('/api/simples/calcular'), null);
  assert.equal(contentDisposition('/api/.x'), 'inline;filename=f.txt');
  assert.equal(contentDisposition('/api/a.json'), null);
  assert.equal(contentDisposition('/api/a.svg'), null);
});

// ─── HTTP: fallback + version routes vs captured oracle answers ─────────────

const s = await subir();
after(() => s.fechar());

const CABECALHOS = ['content-type', 'allow', 'accept', 'cache-control', 'pragma', 'expires', 'x-content-type-options', 'x-xss-protection', 'x-frame-options', 'content-disposition', 'location', 'accept-patch', 'content-language'];

test('rotas oficiais da fundação = respostas capturadas do oráculo (250 casos)', async () => {
  const { casos } = fixture('oraculo-fundacao.json');
  const falhas = [];
  for (const c of casos) {
    const corpo = c.req.corpo ?? undefined;
    const headers = corpo === undefined ? c.req.headers : { ...c.req.headers, 'content-length': String(Buffer.byteLength(corpo)) };
    const r = await s.chamar(c.req.caminho, { method: c.req.metodo, headers, body: corpo });
    if (r.status !== c.status) { falhas.push(`${c.req.metodo} ${c.req.caminho}: status ${r.status} != ${c.status}`); continue; }
    for (const h of CABECALHOS) {
      const a = c.headers[h] ?? null, b = r.headers[h] ?? null;
      const n = (x) => (x == null ? null : h === 'allow' ? String(x).split(/,\s*/).sort().join(',') : Array.isArray(x) ? x.join(', ') : String(x));
      if (n(a) !== n(b)) falhas.push(`${c.req.metodo} ${c.req.caminho}: header ${h} ${b} != ${a}`);
    }
    const d = diffTexto(normalizarCorpo(c.corpo, c.headers['content-type']), normalizarCorpo(r.texto, r.headers['content-type']));
    if (d && c.req.metodo !== 'HEAD') falhas.push(`${c.req.metodo} ${c.req.caminho}: corpo ${d}`);
  }
  assert.deepEqual(falhas, []);
});

test('415/405/406/OPTIONS numa rota POST oficial (roteador sintético) = oráculo de /calculadora/regime-geral', async () => {
  const r = criarRoteador();
  r.post('/api/calculadora/regime-geral', () => ({ status: 200, tipo: 'application/json', body: '{}' }), { oficial: 'regime-regular', produz: ['application/json'] });
  const srv = createServer((req, res) => tratarOficial(req, res, { rotas: r.rotas, estilo: 'regime-regular', criarContexto, enviarApp: () => assert.fail('não oficial') }));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const porta = srv.address().port;
  const chamar = (method, headers = {}, body) => new Promise((ok, erro) => {
    const q = request({ host: '127.0.0.1', port: porta, path: '/api/calculadora/regime-geral', method, headers }, (res) => { const p = []; res.on('data', (x) => p.push(x)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, texto: Buffer.concat(p).toString() })); });
    q.on('error', erro);
    q.end(body);
  });
  try {
    const sem = await chamar('POST');
    assert.equal(sem.status, 415);
    assert.equal(sem.headers.accept, 'application/json');
    assert.equal(sem.texto, '{"detail":"Content-Type \'null\' is not supported.","instance":"/api/calculadora/regime-geral","status":415,"title":"Unsupported Media Type"}');
    assert.equal((await chamar('POST', { 'content-type': 'Text/Plain; Charset=utf-8 ; q=1' }, '{}')).texto, '{"detail":"Content-Type \'text/plain;Charset=utf-8;q=1\' is not supported.","instance":"/api/calculadora/regime-geral","status":415,"title":"Unsupported Media Type"}');
    assert.equal((await chamar('POST', { 'content-type': 'application/json;charset=foo' }, '{}')).texto, '{"detail":"Could not parse Content-Type.","instance":"/api/calculadora/regime-geral","status":415,"title":"Unsupported Media Type"}');
    const g = await chamar('GET');
    assert.equal(g.status, 405);
    assert.equal(g.headers.allow, 'POST');
    assert.equal(g.texto, '{"detail":"Method \'GET\' is not supported.","instance":"/api/calculadora/regime-geral","status":405,"title":"Method Not Allowed"}');
    const o = await chamar('OPTIONS');
    assert.equal(o.status, 200);
    assert.equal(o.headers.allow, 'POST,OPTIONS');
    const x = await chamar('POST', { 'content-type': 'application/json', accept: 'application/xml' }, '{}');
    assert.equal(x.status, 406);
    assert.equal(x.texto, '{"detail":"Acceptable representations: [application/json].","instance":"/api/calculadora/regime-geral","status":406,"title":"Not Acceptable"}');
    const bad = await chamar('POST', { 'content-type': 'application/json', accept: 'foo' }, '{}');
    assert.equal(bad.status, 406);
    assert.equal(bad.texto, '');
    const ok = await chamar('POST', { 'content-type': 'APPLICATION/JSON; charset=UTF-8' }, '{}');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(ok.headers['cache-control'], 'no-cache, no-store, max-age=0, must-revalidate');
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test('GET /api/versao/status: JSON alfabético, YAML na ordem de declaração, 406', async () => {
  const j = await s.chamar('/api/versao/status');
  assert.equal(j.status, 200);
  assert.equal(j.headers['content-type'], 'application/json');
  assert.equal(j.texto, '{"aplicacaoAtualizada":false,"dataDbAtualizada":false,"dataDbLocal":"2026-11-09","dbAtualizada":false,"versaoAplicacaoLocal":"1.7.2","versaoDbLocal":"V0073"}');
  const y = await s.chamar('/api/versao/status', { headers: { accept: 'application/yaml' } });
  assert.equal(y.texto, '---\naplicacaoAtualizada: false\ndbAtualizada: false\ndataDbAtualizada: false\nversaoAplicacaoLocal: "1.7.2"\nversaoAplicacaoRemota: null\nversaoDbLocal: "V0073"\nversaoDbRemota: null\ndataDbLocal: "2026-11-09"\ndataDbRemota: null\n');
  assert.equal(Buffer.byteLength(y.texto), 222);
  const t = await s.chamar('/api/versao/status', { headers: { accept: 'text/plain' } });
  assert.equal(t.status, 406);
  assert.equal(t.headers.accept, 'application/json, application/*+json, application/yaml');
});

test('download/url: plataformas do ambiente, 204 e 404 com o valor original', () => {
  const p = new Map([['windows', 'https://x/w.zip'], ['linux', '']]);
  assert.deepEqual(resolverDownload(p, ' WINDOWS '), { platform: 'windows', downloadUrl: 'https://x/w.zip' });
  assert.throws(() => resolverDownload(p, ' mac'), (e) => e.classeJava === 'PlataformaDownloadNaoEncontradaException' && e.mensagem === "Plataforma de download ' mac' não encontrada. Plataformas disponíveis: [windows, linux]");
  assert.throws(() => resolverDownload(new Map(), ''), (e) => e.status === 404 && e.mensagem === "Plataforma de download '' não encontrada. Plataformas disponíveis: []");
});

for (const v of vetoresUnitarios('dados-unit', 'VersaoOfflineOutput.<init>')) {
  test(`vetor ${v.id}`, () => {
    const o = versaoOfflineOutput(v.input.local, v.input.remota);
    for (const [k, e] of Object.entries(v.expected)) assert.equal(e === '<null>' ? o[k] : String(o[k]), e === '<null>' ? null : e, k);
  });
}

test('VersaoOfflineOutput: JSON omite nulos e ordena como o Jackson 3', () => {
  const o = versaoOfflineOutput({ versaoApp: '1.7.2', versaoDb: 'V0073', dataVersaoDb: '2026-11-09' }, { versaoApp: '1.7.2-753903df', versaoDb: 'V0073', dataVersaoDb: '2026-11-09' });
  assert.equal(versaoOfflineJson(o), '{"aplicacaoAtualizada":true,"dataDbAtualizada":true,"dataDbLocal":"2026-11-09","dataDbRemota":"2026-11-09","dbAtualizada":true,"versaoAplicacaoLocal":"1.7.2","versaoAplicacaoRemota":"1.7.2-753903df","versaoDbLocal":"V0073","versaoDbRemota":"V0073"}');
  assert.ok(versaoOfflineYaml(o).startsWith('---\naplicacaoAtualizada: true\n'));
});

// VersaoOfflineService against a local stand-in of the online installation
for (const v of vetoresUnitarios('dados-unit', 'VersaoOfflineService.')) {
  test(`vetor ${v.id}`, async () => {
    const remoto = v.input.remote;
    let pedidos = 0;
    const srv = createServer((req, res) => {
      pedidos++;
      if (remoto.real || /Timeout/.test(remoto.exception ?? '')) return; // never answers
      res.writeHead(remoto.status, remoto.contentType ? { 'content-type': remoto.contentType } : {});
      res.end(remoto.body ?? '');
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const porta = srv.address().port;
    const fechado = /recusada|nothing listening|ConnectException/.test(JSON.stringify(remoto));
    if (fechado) await new Promise((ok) => srv.close(ok));
    const url = `http://127.0.0.1:${porta}/api/calculadora/dados-abertos/versao`;
    const logs = [];
    const log = { warn: (m) => logs.push({ level: 'WARN', formattedMessage: m }), info: (m) => logs.push({ level: 'INFO', formattedMessage: m }) };
    const servico = criarServicoVersao({ base, url, connectTimeout: 2000, readTimeout: remoto.real || /Timeout/.test(remoto.exception ?? '') ? 300 : 10000, versaoAplicacao: '1.7.2-c7512f9a', log });
    const inicio = Date.now();
    let result = null, erro = null;
    try { result = await (v.endpoint.endsWith('NaInicializacao') ? servico.verificarVersaoNaInicializacao() : servico.verificarVersao()); } catch (e) { erro = e; }
    const decorrido = Date.now() - inicio;
    if (!fechado) await new Promise((ok) => { srv.closeAllConnections(); srv.close(ok); });
    const avisos = logs.filter((l) => l.level === 'WARN');
    for (const [k, e] of Object.entries(v.expected)) {
      if (k.startsWith('result.')) { const x = result[k.slice(7)]; assert.equal(e === '<null>' ? x : String(x), e === '<null>' ? null : e, k); }
      else if (k === 'remoteRequests') assert.equal(String(fechado ? 1 : pedidos), e, k);
      else if (k === 'logs[level=WARN].length()') assert.equal(String(avisos.length), e, k);
      else if (k === 'logs[level=WARN][0].formattedMessage') assert.ok(avisos[0].formattedMessage.includes(url), avisos[0].formattedMessage);
      else if (k === 'logs.length()') assert.equal(String(logs.length), e);
      else if (k === 'logs[*].formattedMessage') { for (const linha of JSON.parse(/^<containsAll:(.*)>$/.exec(e)[1])) assert.ok(logs.some((l) => l.formattedMessage === linha.replace('1.7.2-c7512f9a', '1.7.2-c7512f9a')), linha); }
      else if (k === 'throws') assert.ok(erro, 'devia lançar');
      else if (k === 'elapsed') assert.ok(decorrido >= 250 && decorrido < 5000, `${decorrido} ms`);
    }
  });
}

// ─── vector executor / differential tools ───────────────────────────────────

test('executor de vetores: convenções de chave e matchers', async () => {
  const resp = { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }, texto: '' };
  resp.texto = '{"a":"1.50","n":2,"lista":[{"c":"NFE","v":true},{"c":"CTE","v":false}],"t":{"trechos":[{"x":0.55},{"x":0.45}],"tot":"1.00"},"vazio":[],"nulo":null}';
  resp.json = lerResposta(resp.texto);
  const ok = (k, e, o) => assert.equal(verificarChave(resp, k, e, o), null, `${k} ${e}`);
  const ruim = (k, e, o) => assert.ok(verificarChave(resp, k, e, o), `${k} ${e} devia falhar`);
  ok('httpStatus', '200'); ok('httpStatus', '<2xx>'); ruim('httpStatus', '<4xx>');
  ok('$.a', '1.50', { regraTexto: 'string-node' }); ruim('$.n', '2', { regraTexto: 'string-node' }); ok('$.n', '2', { regraTexto: 'string-node', tipos: { '$.n': 'number' } }); ok('$.n', '2');
  ok('$.a', '<num:1.5>'); ok('$.t.trechos[*].x', '<rawnum-scale:2>'); ok('$.t.tot', '<sum-eq:$.t.trechos[*].x>'); ok('$.t.trechos[0].x', '<rawnum:0.55>');
  ok('$.lista.length()', '<gte:2>'); ok('$.lista[*].c', '["NFE","CTE"]'); ok("$.lista[?(@.c == 'NFE')].v", '[true]'); ok('$..c', '<hasItem:CTE>');
  ok('$.lista[*].v', '<all-boolean>'); ok('$.nulo', '<absent>'); ok('$.nulo', '<null>'); ok('$.zzz', '<absent>'); ruim('$.nulo', '<present>');
  ok('$.vazio', '<array>'); ruim('$.vazio', '<not-empty>'); ok('$raw', '<not-regex:[0-9][eE][-+]?[0-9]>'); ok('header:Cache-Control', '<contains:max-age=3600>');
  ok('header:Content-Type', '<compatible:application/json>'); ok('$.a#2', ['<present>', '<contains:1.5>']);
  ok('$', { a: '1.50', lista: [{ c: 'CTE' }, { c: 'NFE' }] });
  ruim('$', { a: '1.5' });
  assert.ok(typeof verificarChave(resp, 'calls', 'x') === 'object', 'mock-only key');
  assert.deepEqual(verificarInvariantesArredondamento(lerResposta('{"objetos":[{"tribCalc":{"IBSCBS":{"gIBSCBS":{"vBC":"200.00","gCBS":{"pCBS":"0.90","vCBS":"1.80"},"gIBSUF":{"pIBSUF":"0.10","vIBSUF":"0.20"},"gIBSMun":{"pIBSMun":"0.00","vIBSMun":"0.00"},"vIBS":"0.20"}}}}],"total":{"tribCalc":{"IBSCBSTot":{"vBCIBSCBS":"200.00","gIBS":{"gIBSUF":{"vDif":"0.00","vDevTrib":"0.00","vIBSUF":"0.20"},"gIBSMun":{"vDif":"0.00","vDevTrib":"0.00","vIBSMun":"0.00"},"vIBS":"0.20"},"gCBS":{"vDif":"0.00","vDevTrib":"0.00","vCBS":"1.80"}}}}}')), []);
  // a synthetic HTTP vector through the real server
  const item = { arquivo: 'dados-unit', vetor: { id: 'sintetico', endpoint: 'x', method: 'GET', path: '/versao/status', expected: { httpStatus: '200', '$.versaoAplicacaoLocal': '1.7.2', '$.dbAtualizada': 'false', 'header:Content-Type': 'application/json' } } };
  assert.deepEqual(requisicaoDoVetor(item.vetor).path, '/api/versao/status');
  const r = await executarVetor(s, item);
  assert.deepEqual(r.falhas, []);
  assert.ok(vetoresHttp({ endpoints: ['dados-abertos'] }).length > 100);
  assert.equal(vetoresHttp({ arquivos: ['calculo'], filtro: (v) => Boolean(v.corpus) }).length, 1);
});

test('diferencial: normalização (timestamp, host, multiconjuntos) e diff legível', () => {
  const a = '{"detail":"Um ou mais campos são inválidos - [b: x] [a: y] ","instance":"/i","status":400,"title":"Campos inválidos.","type":"http://h:1/errors/e","timestamp":"2026-01-01T00:00:00.1Z"}';
  const b = '{"detail":"Um ou mais campos são inválidos - [a: y] [b: x] ","instance":"/i","status":400,"title":"Campos inválidos.","type":"http://outro/errors/e","timestamp":"2026-01-02T00:00:00Z"}';
  assert.equal(normalizarCorpo(a, 'application/problem+json'), normalizarCorpo(b, 'application/problem+json'));
  assert.notEqual(normalizarCorpo('{"a":"\\u001f"}', 'application/json'), normalizarCorpo('{"a":"\\u001F"}', 'application/json'), 'escapes continuam comparados byte a byte');
  assert.match(diffTexto('abcdef', 'abcXef'), /posição 3/);
});

// ─── live differential (only when the oracle answers) ───────────────────────

// opt-in: `npm test` must not depend on whatever happens to listen on :8080
const ORACULO = process.env.ORACULO_URL;
const oraculoVivo = ORACULO ? await enviarCru(ORACULO, { metodo: 'GET', caminho: '/api/versao/status', headers: { host: 'localhost:5181' } }).then((r) => r.status === 200, () => false) : false;
const SEM_ORACULO_MOTIVO = ORACULO ? `oráculo indisponível em ${ORACULO}` : 'diferencial ao vivo desligado (defina ORACULO_URL)';

test('diferencial ao vivo contra o oráculo: rotas da fundação + fallback (0 divergências)', { skip: !oraculoVivo && SEM_ORACULO_MOTIVO }, async () => {
  const { gerar } = await import('./diferencial/geradores/fundacao.mjs');
  const app = await subirApp();
  try {
    const reqs = gerar({ seed: Number(process.env.SEED ?? 20261124), n: 400 }).map((r) => ({ ...r, headers: { host: app.host, ...(r.headers ?? {}) } }));
    const res = await compararTodos(reqs, { oraculo: ORACULO, app: app.base });
    const div = res.filter((x) => !x.igual).map((x) => `${x.req.metodo} ${x.req.caminho}: ${x.divergencias.join(' | ')}`);
    assert.deepEqual(div, []);
  } finally { await app.fechar(); }
});

test('Dec ainda serve ao Simples: of/toString/div inalterados', () => {
  assert.equal(Dec.of(' 12.340 ').toString(), '12.340');
  assert.equal(Dec.of('1').div('3', 4).toString(), '0.3333');
  assert.throws(() => Dec.of('1e2'), TypeError);
  assert.equal(ErroJson.name, 'ErroJson');
  void comoLista; void lerCorpoRequisicao; void javaEqualsIgnoreCase;
});
