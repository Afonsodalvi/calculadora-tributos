// Dados abertos (GET /api/calculadora/dados-abertos/**, DadosAbertosController of calculadora-rtc-regime-regular 1.7.2):
// - every official HTTP vector of the endpoints 'dados-abertos' and 'nomenclatura' through the real server;
// - the unit vectors DadosAbertosService.*, NcmService.*, NcmAplicavelService/NbsAplicavelService.validar* and
//   AliquotaResultadoDTO.* against the ported functions (real database, or the vectors' Mockito stubs);
// - regressions of behaviours found against the oracle (parameter conversion, locales, 5-digit years...).
// The full differential (thousands of generated requests) runs with
//   node test/regime-regular/diferencial/rodar.mjs --geradores=dados-abertos
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { subir, raiz } from '../lib/servidor.js';
import { vetoresHttp, vetoresUnitarios, executarVetor } from '../lib/vetores.js';
import { lerResposta } from '../lib/jsonpath-regreg.js';
import { abrirBanco } from '../../src/core/db.js';
import { Dec } from '../../src/core/decimal.js';
import { ErroJava } from '../../src/regime-regular/comum/problema.js';
import {
  criarServicoDadosAbertos, criarNcmAplicavelService, criarNbsAplicavelService, criarNcmService, AliquotaResultadoDTO,
  converterParaBigDecimal, normalizarSigla, siglaPorNormalizada,
} from '../../src/regime-regular/dados-abertos/servico.js';
import { DataLocal, dataSql, lerDataLocalizada, lerIsoLocalDate, lerIsoDate } from '../../src/regime-regular/dados-abertos/datas.js';
import { localeDaRequisicao, padraoDataCurta, localeLegado } from '../../src/regime-regular/dados-abertos/locale.js';
import { converterLong } from '../../src/regime-regular/dados-abertos/parametros.js';

const base = abrirBanco(`${raiz}data/calculadora-pro.db`);
after(() => base.close());
const servico = criarServicoDadosAbertos(base);
const data = (t) => { const d = lerIsoLocalDate(t); assert.ok(d, t); return d; };

/** Java value of a unit-vector expectation ("true", "<null>", "12.00"…) as text. */
function texto(v) {
  if (v === null || v === undefined) return '<null>';
  if (v instanceof Dec) return v.toJavaString();
  if (v instanceof DataLocal) return v.toString();
  return String(v);
}

/** "result", "result.x", "result[0]", "x", "getX()", "valorAplicavel()" of a unit vector. */
function valorUnitario(resultado, chave) {
  let c = chave.replace(/^result/, '');
  if (/^[a-zA-Z]/.test(c)) c = `.${c}`;
  let v = resultado;
  for (const m of c.matchAll(/\.([A-Za-z0-9_]+)(\(\))?|\[(\d+)\]/g)) {
    if (v == null) return undefined;
    if (m[3] !== undefined) v = v[Number(m[3])];
    else if (m[2]) v = v[m[1]]();
    else v = v[m[1]];
  }
  return v;
}

function verificarUnitario(resultado, chave, esperado) {
  const v = valorUnitario(resultado, chave);
  if (esperado === '<present>') return assert.ok(v !== null && v !== undefined, `${chave} presente`);
  if (esperado === '<nonempty>') return assert.ok(Array.isArray(v) && v.length > 0, `${chave} não vazio`);
  if (esperado === '<null>') return assert.ok(v === null || v === undefined, `${chave} nulo`);
  return assert.equal(texto(v), esperado, chave);
}

// ─── HTTP vectors ────────────────────────────────────────────────────────────

describe('vetores HTTP oficiais (dados-abertos, nomenclatura)', async () => {
  const s = await subir();
  after(() => s.fechar());
  const contexto = { respostas: new Map() };
  for (const item of vetoresHttp({ endpoints: ['dados-abertos', 'nomenclatura'] })) {
    const { vetor } = item;
    if (vetor.id === 'dac-32-versao') continue; // needs info.app.version overridden (own server below)
    test(vetor.id, async () => {
      const esperado = { ...vetor.expected };
      // Hamcrest jsonPath("$[*].descricao", isA(List)): the multi-path result is a list
      const multiCaminho = esperado['$[*].descricao'] === '<is-array>';
      if (multiCaminho) delete esperado['$[*].descricao'];
      const r = await executarVetor(s, { ...item, vetor: { ...vetor, expected: esperado } }, contexto);
      assert.deepEqual(r.falhas, [], r.resumo);
      if (multiCaminho) assert.ok(r.resposta.json.every((x) => typeof x.descricao === 'string'));
    });
  }
});

test('dac-32-versao: info.app.version sobrescrita (feature-calculo-SNAPSHOT-b7bb06d6)', async () => {
  const anterior = process.env.INFO_APP_VERSION;
  process.env.INFO_APP_VERSION = 'feature-calculo-SNAPSHOT-b7bb06d6';
  const s = await subir();
  try {
    const [item] = vetoresHttp({ ids: ['dac-32-versao'] });
    const r = await executarVetor(s, item);
    assert.deepEqual(r.falhas, [], r.resumo);
  } finally {
    await s.fechar();
    if (anterior === undefined) delete process.env.INFO_APP_VERSION; else process.env.INFO_APP_VERSION = anterior;
  }
});

// ─── unit vectors ───────────────────────────────────────────────────────────

const DATA_ARGS = (i) => (i.data == null ? null : data(i.data));

/** Runs DadosAbertosService.<metodo> of a 'das-*' / 'dacons-*' vector. */
function chamarServico(v) {
  const metodo = v.endpoint.slice('unit:DadosAbertosService.'.length);
  const i = v.input;
  let s = servico;
  const stub = i.mocks?.['aliquotaPadraoService.buscarAliquota'];
  const chamadas = [];
  if (stub) {
    const dec = (x) => (x == null ? null : Dec.parse(x));
    s = criarServicoDadosAbertos(base, {
      aliquotaPadraoService: {
        buscarAliquota: (...args) => { chamadas.push(args); return new AliquotaResultadoDTO(dec(stub.valorReferencia), dec(stub.valorPadrao), stub.formaAplicacao); },
      },
    });
  }
  const d = DATA_ARGS(i);
  const r = (() => {
    switch (metodo) {
      case 'consultarUfs': return s.consultarUfs();
      case 'consultarMunicipiosPorSiglaUf': return s.consultarMunicipiosPorSiglaUf(i.siglaUf);
      case 'consultarSituacoesTributarias': return s.consultarSituacoesTributarias(i.idTributo, d);
      case 'consultarClassificacoesTributariasPorIdSituacaoTributaria': return s.consultarClassificacoesTributariasPorIdSituacaoTributaria(BigInt(i.idSituacaoTributaria), d);
      case 'consultarClassificacoesTributariasPorCstETributoTipo': return s.consultarClassificacoesTributariasPorCstETributoTipo(i.cst, i.tributos, d);
      case 'consultarClassificacoesTributariasCbsIbs': return s.consultarClassificacoesTributariasCbsIbs(d);
      case 'consultarClassificacoesTributariasImpostoSeletivo': return s.consultarClassificacoesTributariasImpostoSeletivo(d);
      case 'listarClassificacaoAplicavelPorNbs': return s.listarClassificacaoAplicavelPorNbs(i.nbs, d);
      case 'consultarNcm': return s.consultarNcm(i.ncm, d);
      case 'consultarNbs': return s.consultarNbs(i.nbs, d);
      case 'listarNbs': return s.listarNbs(d);
      case 'listarNbsAplicaveisPorClassificacao': return s.listarNbsAplicaveisPorClassificacao(i.cClassTrib, d);
      case 'consultarFundamentacoesLegais': return s.consultarFundamentacoesLegais(d);
      case 'consultarAliquota': return s.consultarAliquota(i.idTributo, i.codigoUf == null ? null : BigInt(i.codigoUf), i.codigoMunicipio == null ? null : BigInt(i.codigoMunicipio), d);
      case 'consultarNomenclatura': return s.consultarNomenclatura(i.siglaDfe, i.cClassTrib, d);
      case 'consultarClassificacaoTributariaIsPorCodigo': return s.consultarClassificacaoTributariaIsPorCodigo(i.cClassTrib, d);
      case 'consultarValidadeDfeClassificacaoTributaria': return s.consultarValidadeDfeClassificacaoTributaria(i.siglaDfe, i.cClassTrib, d);
      case 'consultarCstsComClassificacoesCbsIbs': return s.consultarCstsComClassificacoesCbsIbs(i.siglaDfe, d);
      case 'consultarCstsComClassificacoesIs': return s.consultarCstsComClassificacoesIs(i.siglaDfe, d);
      case 'consultarTiposDfeAgrupados': return s.consultarTiposDfeAgrupados(d);
      case 'consultarRedutoresCompraGovernamental': return s.consultarRedutoresCompraGovernamental();
      case 'consultarTransferenciasCBS': return s.consultarTransferenciasCBS();
      case 'consultarTransferenciasIBS': return s.consultarTransferenciasIBS();
      default: throw new Error(`método sem porte no teste: ${metodo}`);
    }
  })();
  return { r, chamadas };
}

describe('DadosAbertosService (vetores unitários)', () => {
  for (const v of vetoresUnitarios('dados-unit', 'DadosAbertosService.')) {
    if (v.endpoint === 'unit:DadosAbertosService.convertToBigDecimal') continue;
    test(v.id, () => {
      if (v.expected.throws) {
        assert.throws(() => chamarServico(v), (e) => e instanceof ErroJava && e.classeJava === v.expected.throws);
        return;
      }
      const { r, chamadas } = chamarServico(v);
      for (const [chave, esperado] of Object.entries(v.expected)) {
        if (chave === 'calls') {
          // verify(aliquotaPadraoService, times(1)).buscarAliquota(idTributo, codigoUf, codigoMunicipio, data)
          const i = v.input;
          assert.equal(chamadas.length, 1);
          assert.deepEqual(chamadas[0].map((x) => (x == null ? null : String(x))), [i.idTributo, i.codigoUf, i.codigoMunicipio, i.data].map((x) => (x == null ? null : String(x))));
          continue;
        }
        if (chave.startsWith('result[*]')) continue; // checked below for das-32
        verificarUnitario(r, chave, esperado);
      }
      if (v.id === 'das-32-consultarTiposDfeAgrupados') {
        const tipos = r.flatMap((g) => g.tipos);
        assert.ok(r.every((g) => g.tipos.length > 0 && g.ordem >= 1));
        assert.ok(tipos.every((t) => typeof t.suportado === 'boolean' && typeof t.permiteNcmZero === 'boolean'));
        const so = (c) => { const x = tipos.filter((t) => t.codigo === c); assert.equal(x.length, 1, c); return x[0]; };
        assert.deepEqual([so('NFE').suportado, so('NFE').permiteNcmZero, so('CTE').suportado, so('CTE').permiteNcmZero], [true, true, true, false]);
        assert.deepEqual(tipos.filter((t) => ['NFEABI', 'DERE', 'DIR', 'DUIMP'].includes(t.codigo)).map((t) => t.suportado), [false, false, false, false]);
      }
    });
  }

  for (const v of vetoresUnitarios('dados-unit', 'DadosAbertosService.convertToBigDecimal')) {
    test(v.id, () => {
      const r = v.input.cases.map((c) => {
        if (c.type === 'null') return converterParaBigDecimal(null, 'BigDecimal');
        const valor = c.type === 'Float' || c.type === 'Double' ? Number(c.value.replace(/[fd]$/, '')) : c.value;
        return converterParaBigDecimal(valor, c.type);
      });
      for (const [chave, esperado] of Object.entries(v.expected)) verificarUnitario(r, chave, esperado); // BigDecimal.equals: toString keeps the scale
    });
  }
});

describe('NcmService / NcmAplicavelService / NbsAplicavelService (vetores unitários)', () => {
  for (const v of vetoresUnitarios('dados-unit', 'NcmService.')) {
    test(v.id, () => {
      const chamadas = [];
      const repo = {
        existeNcm: (ncm, d) => { chamadas.push(`repository.existeNcm('${ncm}', ${d})`); return v.input.mocks['repository.existeNcm']; },
        buscarTodosNcmsVigentes: (d) => { chamadas.push(`repository.buscarTodosNcmsVigentes(${d})`); return v.input.mocks['repository.buscarTodosNcmsVigentes']; },
      };
      const s = criarNcmService(repo);
      const r = v.endpoint.endsWith('existeNcm') ? s.existeNcm(v.input.ncm, data(v.input.data)) : s.consultarNcmsVigentes(data(v.input.data));
      assert.equal(typeof r === 'boolean' ? String(r) : JSON.stringify(r), v.expected.result);
      assert.deepEqual(chamadas, [v.expected.calls]);
    });
  }

  for (const [prefixo, criar, campo] of [['NcmAplicavelService.validarNcmAplicavel', criarNcmAplicavelService, 'ncm'], ['NbsAplicavelService.validarNbsAplicavel', criarNbsAplicavelService, 'nbs']]) {
    for (const v of vetoresUnitarios('dados-unit', prefixo)) {
      test(v.id, () => {
        const m = v.input.mocks;
        const nome = campo === 'ncm' ? 'Ncm' : 'Nbs';
        const repo = {
          tem: () => m.tem,
          [`tem${nome}Aplicavel`]: () => m[`tem${nome}Aplicavel`] ?? false,
          [`temExcecao${nome}Aplicavel`]: () => m[`temExcecao${nome}Aplicavel`] ?? false,
          [`tem${nome}AplicavelSemExcecao`]: () => m[`tem${nome}AplicavelSemExcecao`] ?? false,
        };
        const s = criar(repo);
        const chamar = () => s[`validar${nome}Aplicavel`](v.input[campo], v.input.idClassificacaoTributaria, v.input.codigoClassificacaoTributaria, data(v.input.data), v.input.tributos);
        if (v.expected.throws === '<none>') assert.equal(chamar(), true);
        else assert.throws(chamar, (e) => e instanceof ErroJava && e.classeJava === v.expected.throws);
      });
    }
  }

  test('ncm-aplicavel / nbs-aplicavel: NcmNaoVinculadaException vira valido=false (base real)', () => {
    const r = servico.validarNcmAplicavel('200038', '99999999', data('2026-06-01'));
    assert.deepEqual(r, { cClassTrib: '200038', dataOcorrenciaFatoGerador: '2026-06-01', ncm: '99999999', valido: false });
  });
});

describe('AliquotaResultadoDTO (vetores unitários)', () => {
  const dec = (x) => (x == null ? null : Dec.parse(x));
  const dto = (i) => new AliquotaResultadoDTO(dec(i.valorReferencia), dec(i.valorPadrao), i.formaAplicacao);
  for (const v of vetoresUnitarios('dados-unit', 'AliquotaResultadoDTO.')) {
    test(v.id, () => {
      const i = v.input;
      if (v.id === 'ardto-38-multiplas-criacoes') {
        const r = Object.fromEntries(['dto1', 'dto2', 'dto3'].map((k) => [k, dto({ valorReferencia: i[k][0], valorPadrao: i[k][1], formaAplicacao: i[k][2] })]));
        for (const [chave, esperado] of Object.entries(v.expected)) verificarUnitario(r, chave, esperado);
        return;
      }
      if (v.endpoint.endsWith('.equals')) {
        const a = dto(i.dto1), b = dto(i.dto2);
        assert.equal(a.equals(b), true);
        assert.equal(a.hashCode() === b.hashCode(), true);
        return;
      }
      if (v.endpoint.endsWith('.toString')) {
        assert.equal(dto(i).toString(), 'AliquotaResultadoDTO[valorReferencia=50.00, valorPadrao=null, formaAplicacao=null]');
        return;
      }
      if (v.expected.throws) {
        assert.throws(() => dto(i), (e) => e instanceof ErroJava && e.classeJava === v.expected.throws);
        return;
      }
      const r = dto(i);
      for (const [chave, esperado] of Object.entries(v.expected)) verificarUnitario(r, chave, esperado); // BigDecimal.equals: scale included
    });
  }
});

// ─── regressions found against the oracle ────────────────────────────────────

describe('conversão de parâmetros (conferida com o oráculo / JDK / Spring)', () => {
  test('Long: NumberUtils.parseNumber (espaços removidos, hexadecimal com - opcional, faixa de 64 bits)', () => {
    const casos = { 43: 43n, ' 4 3 ': 43n, '0x2B': 43n, '-#10': -16n, '010': 10n, '+43': 43n, '+0x2B': null, '0x': null, '9223372036854775808': null,
      '-9223372036854775808': -9223372036854775808n, '-0x8000000000000000': -9223372036854775808n, '\uff14\uff13': 43n, '0x\uff21': 10n, '4.3': null, '\u00a0': null };
    for (const [t, e] of Object.entries(casos)) assert.equal(converterLong(t), e, JSON.stringify(t));
  });

  test('LocalDate localizado: Accept-Language pelo AcceptLanguage2 do Tomcat (script vira variante) + CLDR do JDK 25', () => {
    const padrao = (al) => padraoDataCurta(localeDaRequisicao(al === undefined ? {} : { 'accept-language': al }));
    assert.equal(padrao(undefined), 'dd/MM/y');
    assert.equal(padrao('en-US'), 'M/d/yy');
    assert.equal(padrao('en-US;q=0'), 'dd/MM/y');
    assert.equal(padrao('fr;q=0.5, en-US;q=0.9'), 'M/d/yy');
    assert.equal(padrao('*'), 'y-MM-dd');
    assert.equal(padrao('i-default'), 'y-MM-dd');
    assert.equal(padrao('am-Latn'), 'dd/MM/y');
    assert.equal(padrao('zh-TW'), 'y/M/d');
    assert.deepEqual(localeLegado('zh-Hant-TW'), { L: 'zh', S: '', C: 'TW', V: 'HANT' });
    assert.equal(lerDataLocalizada('31/02/2026', 'dd/MM/y')?.toString(), '2026-02-28'); // SMART: previous valid day
    assert.equal(lerDataLocalizada('01/02/26', 'dd/MM/y')?.toString(), '0026-02-01');
    assert.equal(lerDataLocalizada('1/2/26', 'M/d/yy')?.toString(), '2026-01-02');
    assert.equal(lerDataLocalizada('01/02/0', 'dd/MM/y'), null);
    assert.equal(lerIsoDate('2026-01-01+23:59')?.toString(), '2026-01-01');
    assert.equal(lerIsoDate('2026-01-01+05'), null);
    assert.equal(lerIsoLocalDate('+12026-01-01')?.toString(), '+12026-01-01');
    assert.equal(lerIsoLocalDate('+2026-01-01'), null);
  });

  test('data ligada ao SQLite: ano da era (java.sql.Date); 5+ dígitos estouram no driver', () => {
    assert.equal(dataSql(data('-2026-01-01')), '2027-01-01');
    assert.equal(dataSql(data('0000-01-01')), '0001-01-01');
    assert.throws(() => dataSql(data('+10000-01-01')), (e) => e.classeJava === 'ArrayIndexOutOfBoundsException' && e.message === 'Index -1 out of bounds for length 4');
  });

  test('SiglasDFeEnum: normalização ASCII e mensagem com o texto cru', () => {
    assert.equal(normalizarSigla('nfs-e via'), 'NFSEVIA');
    assert.equal(normalizarSigla('NF\u00a0e'), 'NF\u00a0E');
    assert.throws(() => siglaPorNormalizada(' xyz'), (e) => e.classeJava === 'SiglaDFeNaoEncontradaException' && e.message === 'Sigla DFe inválida:  xyz');
  });
});

describe('respostas (conferidas com o oráculo)', async () => {
  const s = await subir();
  after(() => s.fechar());
  const R = '/api/calculadora/dados-abertos';

  test('percentuais Float.toString (60.0) e ordem alfabética das chaves', async () => {
    const r = await s.chamar(`${R}/classificacoes-tributarias/cbs-ibs/class-trib/200054?data=2026-06-01`);
    assert.equal(r.status, 200);
    assert.match(r.texto, /"percentualReducaoCbs":100\.0,"percentualReducaoIbsMun":100\.0,"percentualReducaoIbsUf":100\.0,"possuiPercentualReducao":true,"tipoAliquota":"Padrão","tipoReceitaBrutaSimplesNacional":9,/);
    assert.equal(r.headers['cache-control'], 'no-cache, no-store, max-age=0, must-revalidate');
  });

  test('cabeçalhos: duas grafias de Cache-Control e x-warning-dados-simulados', async () => {
    assert.equal((await s.chamar(`${R}/ufs`)).headers['cache-control'], 'max-age=3600, public');
    const ncm = await s.chamar(`${R}/classificacoes-tributarias/ncm-aplicavel?cClassTrib=200038&ncm=99999999&dataOcorrenciaFatoGerador=2026-06-01`);
    assert.equal(ncm.headers['cache-control'], 'public, max-age=3600');
    const is = await s.chamar(`${R}/ncm?ncm=24021000&data=2027-01-01`);
    assert.equal(is.headers['x-warning-dados-simulados'], '1');
    assert.equal((await s.chamar(`${R}/ncm?ncm=24021000&data=2026-12-31`)).headers['x-warning-dados-simulados'], undefined);
  });

  test('defeitos preservados: dataAtualizacao ausente no IS; NBS vinculada repetida', async () => {
    const is = lerResposta((await s.chamar(`${R}/classificacoes-tributarias/is/class-trib/000001?data=2027-01-01`)).texto);
    assert.equal(is.dataAtualizacao, undefined);
    const nbs = lerResposta((await s.chamar(`${R}/classificacoes-tributarias/nbs?nbs=114052200&data=2026-06-01`)).texto);
    assert.deepEqual(nbs.slice(0, 4), ['200038', '200038', '515001', '515001']);
  });

  test('erros: 500 da jakarta ValidationException, 400 Validation failure, 422 de sigla, ano de 5 dígitos', async () => {
    const r1 = await s.chamar(`${R}/ncm?ncm=abc&data=2026-06-01`);
    assert.equal(r1.status, 500);
    assert.equal(r1.json.detail, 'O campo NCM deve conter somente dígitos.');
    const r2 = await s.chamar(`${R}/nbs-aplicaveis?cClassTrib=abc&data=2026-06-01`);
    assert.deepEqual(r2.json, { detail: 'Validation failure', instance: `${R}/nbs-aplicaveis`, status: 400, title: 'Bad Request' });
    const r3 = await s.chamar(`${R}/nomenclatura/XX/000001?data=2026-06-01`);
    assert.equal(r3.status, 422);
    assert.equal(r3.json.detail, 'Sigla DFe inválida: XX');
    const r4 = await s.chamar(`${R}/aliquota-uniao?data=%2B10000-01-01`);
    assert.equal(r4.status, 500);
    assert.equal(r4.json.detail, 'Index -1 out of bounds for length 4');
    const r5 = await s.chamar(`${R}/ator/grupos?data=2027-01-01&papel=%E2%80%83`);
    assert.equal(r5.json.detail, 'Parâmetro inválido [papel: \u2003] '); // enum: String.trim(), not isBlank
  });
});
