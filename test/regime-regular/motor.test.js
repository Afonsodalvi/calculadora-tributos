// Calculation engine of the regime-regular port (src/regime-regular/calculo/motor): official unit
// vectors that target the engine (AvaliadorExpressaoAritmetica, CalculoCbsIbsService,
// MemoriaCalculoService, AliquotaResultadoDTO, TributacaoCompraGovernamentalDomain, monofasia,
// IBSCBS/Tributos domains, serializers), the worked examples of calc-core.md §14 (expected JSON
// captured from the official API), expressions checked against the official JEXL evaluator, the
// pipeline vectors of CalculadoraService whose tribCalc keys depend only on the engine, and — when
// ORACULO_URL is set (opt-in, e.g. http://127.0.0.1:8080) and answers — a live cross-check: hundreds of
// generated items computed by the engine and by POST /api/calculadora/observabilidade/regime-geral.
// The engine input (OperacaoModel) is always built by the real orchestration (calculo/processamento.js,
// ProcessamentoItemService P1..P10), so these checks cover the orchestration → engine interface too.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '../../src/core/decimal.js';
import { abrirBanco } from '../../src/core/db.js';
import { problemTypePorClasse, ErroSerializacao } from '../../src/regime-regular/comum/problema.js';
import { criarMotor, dominios as D, avaliar, variaveis, serializarTributos } from '../../src/regime-regular/calculo/motor/index.js';
import { formatarMoeda, formatarPercentual, substituirPlaceholders } from '../../src/regime-regular/calculo/motor/memoria-calculo.js';
import { tdec1104OpRTC, tdec1302, serializar } from '../../src/regime-regular/calculo/motor/serializacao.js';
import * as E from '../../src/regime-regular/calculo/motor/excecoes.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { criarProcessamento } from '../../src/regime-regular/calculo/processamento.js';
import { vincularOperacao, fatoGeradorAplicavel, CAMPOS_COMPONENTES } from '../../src/regime-regular/calculo/entrada.js';
import { lerJsonTexto } from '../../src/regime-regular/comum/json.js';

// vectors read directly (test/lib/vetores.js pulls the whole HTTP app, which this engine-level test does not need)
const raiz = fileURLToPath(new URL('../../', import.meta.url));
const ARQUIVOS = { calculo: 'vectors-calculo.json', validacao: 'vectors-validacao.json', 'dados-unit': 'vectors-dados-unit.json' };
const cacheVetores = new Map();
function carregar(nome) {
  if (!cacheVetores.has(nome)) cacheVetores.set(nome, JSON.parse(readFileSync(new URL(`../fixtures/regime-regular/${ARQUIVOS[nome]}`, import.meta.url), 'utf8')));
  return cacheVetores.get(nome);
}
const vetoresUnitarios = (arquivo, prefixo) => carregar(arquivo).vectors.filter((v) => String(v.endpoint).startsWith(`unit:${prefixo}`));

const base = abrirBanco(`${raiz}data/calculadora-pro.db`);
after(() => base.close());
const motor = criarMotor(base);
const ZERO = Dec.ZERO;
const dec = (v) => (v == null ? null : Dec.parse(String(v)));
/** compareTo equality of a Dec with the text of a vector. */
const mesmoValor = (d, texto, msg) => assert.ok(d != null && d.compareTo(Dec.parse(texto)) === 0, `${msg}: esperado ${texto}, obtido ${d?.toJavaString()}`);
/** BigDecimal.equals (value AND scale). */
const mesmoBigDecimal = (d, texto, msg) => assert.equal(d?.toJavaString(), Dec.parse(texto).toJavaString(), msg);
/** Runs `f` and returns { erro } or { valor }. */
const tentar = (f) => { try { return { valor: f() }; } catch (erro) { return { erro }; } };

// ─── official unit vectors (vectors-dados-unit.json) ────────────────────────────────────────

describe('vetores unitários oficiais do motor', () => {
  for (const v of vetoresUnitarios('dados-unit', 'AvaliadorExpressaoAritmetica.evaluate')) {
    test(v.id, () => {
      const vars = new Map(Object.entries(v.input.variables).map(([k, x]) => [k, Dec.parse(x)]));
      const r = avaliar(v.input.expression, vars);
      for (const [k, e] of Object.entries(v.expected)) {
        if (k === 'result.precision()') assert.equal(String(r.precision()), e);
        else if (/BigDecimal\.equals/.test(v.notes)) mesmoBigDecimal(r, e, k);
        else mesmoValor(r, e, k);
      }
    });
  }

  for (const v of [...vetoresUnitarios('dados-unit', 'MemoriaCalculoService.formatarMoeda'), ...vetoresUnitarios('dados-unit', 'MemoriaCalculoService.formatarPercentual')]) {
    test(v.id, () => {
      const f = v.endpoint.endsWith('formatarMoeda') ? formatarMoeda : formatarPercentual;
      assert.equal(f(dec(v.input.args[0])), v.expected.result);
    });
  }

  for (const v of vetoresUnitarios('dados-unit', 'CalculoCbsIbsService.buscarAliquotaPadrao')) {
    test(v.id, () => {
      const m = v.input.mocks['aliquotaPadraoService.buscarAliquota'];
      const chamadas = [];
      const aliquotaPadraoService = {
        buscarAliquota: (...args) => { chamadas.push(args); return D.criarAliquotaResultadoDTO(dec(m.valorReferencia), dec(m.valorPadrao), m.formaAplicacao); },
      };
      const { calculoCbsIbs } = criarMotor(null, { servicos: { aliquotaPadraoService } });
      const r = calculoCbsIbs.buscarAliquotaPadrao(v.input.idTributo, v.input.codigoUf, v.input.codigoMunicipio, v.input.data);
      if (v.expected.result !== undefined) {
        if (/BigDecimal\.equals/.test(v.notes)) mesmoBigDecimal(r, v.expected.result, 'result');
        else mesmoValor(r, v.expected.result, 'result');
      }
      assert.deepEqual(chamadas, [[v.input.idTributo, v.input.codigoUf, v.input.codigoMunicipio, v.input.data]], 'verify(times(1)) com os mesmos argumentos');
    });
  }

  for (const v of vetoresUnitarios('dados-unit', 'CalculoCbsIbsService.calcularCbsIbs')) {
    test(v.id, () => {
      const fracao = v.input.fracaoDiferimento;
      const servicos = {
        tratamentoService: {
          buscar: () => ({
            descricao: null, expressaoAliquota: 'aliquota', expressaoBaseCalculo: 'baseCalculoInformada-impostoSeletivoInformado+impostoSeletivoCalculado',
            expressaoAliquotaEfetiva: 'aliquota*(1-percentualReducao)*(1-pRedutorCompraGov/100)', expressaoTributoCalculado: 'baseCalculo*aliquotaEfetiva',
            expressaoTributoDevido: 'tributoCalculado', expressaoPercentualDiferimento: fracao, expressaoValorDiferimento: `tributoCalculado*${fracao}`,
            inPossuiAjuste: false, inPossuiPercentualReducao: false, inPossuiMonofasia: false, // Mockito-built entity: primitive booleans false
          }),
        },
        classificacaoTributariaService: {
          buscarClassificacaoTributariaCalculo: () => ({
            id: 1, codigo: '510001', tipoAliquota: 'Padrão', inGrupoMonofasiaPadrao: false, inGrupoMonofasiaReten: false,
            inGrupoMonofasiaRet: false, inGrupoMonofasiaDiferimento: false, inGrupoReducao: false,
          }),
        },
        situacaoTributariaService: { consultarSituacaoTributariaPorCodigo: () => ({ inGrupoIbsCbs: true }) },
      };
      const { calculoCbsIbs } = criarMotor(null, { servicos });
      const item = { numero: 1, cst: '510', cClassTrib: '510001', baseCalculo: dec(v.input.baseCalculo), aliquotasNominais: { cbs: dec(v.input.aliquotaCbs) } };
      const r = calculoCbsIbs.calcularCbsIbs(D.TributoEnum.CBS, null, null, item,
        { idTratamentoTributario: 20, idClassificacaoTributaria: 1, inIncompativelComSuspensao: false, inExigeGrupoDesoneracao: false },
        ZERO, false, '2027-03-15', null, ZERO);
      const ler = { baseCalculo: r.baseCalculo, aliquota: r.aliquota, tributoDevido: r.tributoDevido, 'grupoDiferimento.pDif': r.grupoDiferimento.pDif,
        'grupoDiferimento.vDif': r.grupoDiferimento.vDif, 'tributoDevido + vDif': r.tributoDevido.add(r.grupoDiferimento.vDif) };
      for (const [k, e] of Object.entries(v.expected)) {
        if (k === 'tributoDevido.scale()') assert.equal(String(r.tributoDevido.scale()), e);
        else if (k === 'grupoDiferimento.vDif.scale()') assert.equal(String(r.grupoDiferimento.vDif.scale()), e);
        else mesmoValor(ler[k], e, k);
      }
    });
  }

  const dto = (x) => D.criarAliquotaResultadoDTO(dec(x.valorReferencia ?? x[0]), dec(x.valorPadrao ?? x[1]), (x.formaAplicacao ?? x[2]) || null);
  for (const v of vetoresUnitarios('dados-unit', 'AliquotaResultadoDTO')) {
    test(v.id, () => {
      if (v.input.dto1) {
        const d1 = dto(v.input.dto1), d2 = dto(v.input.dto2), d3 = v.input.dto3 ? dto(v.input.dto3) : null;
        for (const [k, e] of Object.entries(v.expected)) {
          if (k === 'dto1.equals(dto2)' || k === 'dto1.hashCode() == dto2.hashCode()') {
            // record equality: component-wise BigDecimal.equals
            const igual = ['valorReferencia', 'valorPadrao'].every((c) => (d1[c] == null ? d2[c] == null : d2[c] != null && d1[c].equalsJava(d2[c]))) && d1.formaAplicacao === d2.formaAplicacao;
            assert.equal(String(igual), e, k);
          } else {
            const [quem, campo] = k.split('.');
            mesmoBigDecimal({ dto1: d1, dto2: d2, dto3: d3 }[quem][campo], e, k);
          }
        }
        return;
      }
      const { valor: r, erro } = tentar(() => dto(v.input));
      for (const [k, e] of Object.entries(v.expected)) {
        if (k === 'throws') { assert.equal(erro?.classeJava, e); continue; }
        assert.equal(erro, undefined, erro?.message);
        if (k === 'result') assert.ok(r != null);
        else if (k === 'toString()') {
          // record toString: AliquotaResultadoDTO[valorReferencia=50.00, valorPadrao=null, formaAplicacao=null]
          const s = `AliquotaResultadoDTO[valorReferencia=${r.valorReferencia?.toJavaString() ?? null}, valorPadrao=${r.valorPadrao?.toJavaString() ?? null}, formaAplicacao=${r.formaAplicacao}]`;
          assert.ok(s.includes(e.replace(/^<contains:|>$/g, '')), s);
        } else {
          const x = k === 'valorAplicavel()' ? r.valorAplicavel() : r[k];
          if (e === '<null>') assert.equal(x, null, k);
          else mesmoBigDecimal(x, e, k);
        }
      }
    });
  }

  for (const v of vetoresUnitarios('dados-unit', 'TributacaoCompraGovernamentalDomain.getValoresEfetivos')) {
    test(v.id, () => {
      const detalhe = D.TributacaoCompraGovernamentalDomain.builder(Object.fromEntries(Object.entries(v.input.detalhe).map(([k, x]) => [k, dec(x)])));
      const { valor: r, erro } = tentar(() => D.TributacaoCompraGovernamentalDomain.getValoresEfetivos(detalhe, v.input.tpEnteGov,
        dec(v.input.pTransferenciaCBS), v.input.dataFatoGerador, dec(v.input.vBC)));
      const soma = (o, campos) => campos.reduce((s, c) => s.add(o[c] ?? ZERO), ZERO);
      const P = ['pAliqCBS', 'pAliqIBSUF', 'pAliqIBSMun'], V = ['vTribCBS', 'vTribIBSUF', 'vTribIBSMun'];
      for (const [k, e] of Object.entries(v.expected)) {
        if (k === 'throws') { assert.equal(erro?.classeJava, e); continue; }
        if (k === 'message') { assert.equal(erro?.mensagem, e); continue; }
        assert.equal(erro, undefined, erro?.message);
        if (k === 'result') {
          if (e === '<null>') assert.equal(r, null);
          else if (e === '<same:detalhe>') assert.equal(r, detalhe);
          else assert.fail(`matcher ${e}`);
        } else if (k === 'vTribCBS.scale()') assert.equal(String(r.vTribCBS.scale()), e);
        else if (k === 'sum(pAliq)') mesmoValor(soma(r, P), e.startsWith('<eqOf:') ? soma(detalhe, P).toPlainString() : e, k);
        else if (k === 'sum(vTrib)') mesmoValor(soma(r, V), e, k);
        else mesmoValor(r[k], e, k);
      }
    });
  }

  // getters of the domains: hand-built objects for each vector (input = description of the Java builder)
  const cbsVazio = () => D.CBSDomain.novo();
  const grupoCompleto = () => D.GrupoIBSCBSDomain.builder({ gCBS: cbsVazio(), gIBSUF: D.IBSUFDomain.novo(), gIBSMun: D.IBSMunDomain.novo(), gTribRegular: D.TributacaoRegularDomain.builder() });
  const credPres = (c) => ({ vBCCredPres: null, cCredPres: null, gIBSCredPres: null, gCBSCredPres: null, ...c });
  const credIbs = (c) => ({ pCredPres: null, vCredPres: null, vCredPresCondSus: null, ...c });
  const IBSCBS = {
    'ibscbsd-01-vazio': () => D.IBSCBSDomain.builder(),
    'ibscbsd-02-grupo-delegates': () => D.IBSCBSDomain.builder({ gIBSCBS: grupoCompleto() }),
    'ibscbsd-03-monofasia-true': () => D.IBSCBSDomain.builder({ gIBSCBSMono: D.MonofasiaDomain.builder() }),
    'ibscbsd-04-monofasia-false': () => D.IBSCBSDomain.builder(),
    'ibscbsd-05-estorno-true': () => D.IBSCBSDomain.builder({ gEstornoCred: {} }),
    'ibscbsd-06-estorno-false': () => D.IBSCBSDomain.builder(),
    'ibscbsd-07-sem-credpres': () => D.IBSCBSDomain.builder(),
    'ibscbsd-08-credpres-cbs': () => D.IBSCBSDomain.builder({ gCredPresOper: credPres({ gCBSCredPres: credIbs() }) }),
    'ibscbsd-09-credpres-ibs-valor': () => D.IBSCBSDomain.builder({ gCredPresOper: credPres({ gIBSCredPres: credIbs({ vCredPres: Dec.parse('25.00') }) }) }),
  };
  const TRIB = {
    'tribd-01-sem-is': () => D.TributosDomain.builder(),
    'tribd-02-com-is': () => D.TributosDomain.builder({ IS: D.ImpostoSeletivoDomain.builder({ vIS: Dec.parse('100') }) }),
    'tribd-03-sem-ibscbs': () => D.TributosDomain.builder(),
    'tribd-04-com-grupo': () => D.TributosDomain.builder({ IBSCBS: D.IBSCBSDomain.builder({ gIBSCBS: grupoCompleto() }) }),
    'tribd-05-monofasia': () => D.TributosDomain.builder({ IBSCBS: D.IBSCBSDomain.builder({ gIBSCBSMono: D.MonofasiaDomain.builder() }) }),
    'tribd-06-estorno': () => D.TributosDomain.builder({ IBSCBS: D.IBSCBSDomain.builder({ gEstornoCred: {} }) }),
  };
  const conferirGetters = (classe, objeto, esperado) => {
    for (const [k, e] of Object.entries(esperado)) {
      const metodo = k.replace(/\(\)$/, '');
      const x = classe[metodo](objeto);
      if (e === 'true' || e === 'false') assert.equal(String(x), e, k);
      else if (e === '<null>') assert.equal(x, null, k);
      else if (e === '<present>') assert.ok(x != null, k);
      else mesmoValor(x, e, k);
    }
  };
  for (const v of vetoresUnitarios('dados-unit', 'IBSCBSDomain')) test(v.id, () => conferirGetters(D.IBSCBSDomain, IBSCBS[v.id](), v.expected));
  for (const v of vetoresUnitarios('dados-unit', 'TributosDomain')) test(v.id, () => conferirGetters(D.TributosDomain, TRIB[v.id](), v.expected));
  for (const v of vetoresUnitarios('dados-unit', 'CreditoPresumidoOperacaoDomain')) {
    test(v.id, () => {
      const g = v.input.gIBSCredPres && credIbs(Object.fromEntries(Object.entries(v.input.gIBSCredPres).map(([k, x]) => [k, dec(x)])));
      const c = credPres({ gIBSCredPres: g ?? null, gCBSCredPres: v.input.gCBSCredPres ? credIbs() : null });
      conferirGetters(D.CreditoPresumidoOperacaoDomain, c, v.expected);
    });
  }

  // monofasia: CbsIbsOutput with grupoMonofasia.<etapa> built from the vector input
  const ETAPA = { tributoMonofasico: D.GrupoEtapaMonofasiaOutput, tributoSujeitoRetencao: D.GrupoEtapaMonofasiaOutput, tributoRetido: D.GrupoEtapaMonofasiaOutput, tributoDiferido: D.GrupoDiferimentoMonofasiaOutput };
  const saidaMono = (x) => {
    if (x == null) return null;
    const g = {};
    for (const [etapa, campos] of Object.entries(x)) g[etapa] = ETAPA[etapa].builder(Object.fromEntries(Object.entries(campos).map(([k, y]) => [k, dec(y)])));
    return D.CbsIbsOutput.builder({ grupoMonofasia: D.GrupoMonofasiaOutput.builder(g) });
  };
  const FABRICA = { MonofasiaPadraoDomain: D.MonofasiaPadraoDomain, MonofasiaRetencaoDomain: D.MonofasiaRetencaoDomain, MonofasiaRetidoAnteriormenteDomain: D.MonofasiaRetidoAnteriormenteDomain, MonofasiaDiferimentoDomain: D.MonofasiaDiferimentoDomain };
  const PREFIXO = { padrao: 'MonofasiaPadraoDomain', retencao: 'MonofasiaRetencaoDomain', retido: 'MonofasiaRetidoAnteriormenteDomain', diferimento: 'MonofasiaDiferimentoDomain' };
  for (const v of carregar('dados-unit').vectors.filter((x) => /^unit:Monofasia.*Domain\.(create|builder)$/.test(x.endpoint))) {
    test(v.id, () => {
      if (v.endpoint === 'unit:Monofasia*Domain.builder') {
        for (const [k, e] of Object.entries(v.expected)) {
          const [grupo, campo] = k.split('.');
          mesmoValor(FABRICA[PREFIXO[grupo]].builder()[campo], e, k);
        }
        return;
      }
      const args = [saidaMono(v.input.cbs), saidaMono(v.input.ibsEstadual), saidaMono(v.input.ibsMunicipal)];
      if (v.endpoint === 'unit:Monofasia*Domain.create') {
        for (const [k, e] of Object.entries(v.expected)) assert.equal(FABRICA[k.replace('.create', '')].create(...args), null, `${k} ${e}`);
        return;
      }
      const r = FABRICA[v.endpoint.replace(/^unit:|\.create$/g, '')].create(...args);
      for (const [k, e] of Object.entries(v.expected)) mesmoValor(r[k], e, k);
    });
  }
  for (const v of [...vetoresUnitarios('dados-unit', 'GrupoEtapaMonofasiaOutput.merge'), ...vetoresUnitarios('dados-unit', 'GrupoDiferimentoMonofasiaOutput.merge')]) {
    test(v.id, () => {
      const classe = v.endpoint.includes('GrupoEtapa') ? D.GrupoEtapaMonofasiaOutput : D.GrupoDiferimentoMonofasiaOutput;
      const g = (x) => classe.builder(Object.fromEntries(Object.entries(x).map(([k, y]) => [k, dec(y)])));
      if (v.input.grupo) {
        const grupo = g(v.input.grupo);
        assert.equal(classe.merge(null, grupo), grupo);
        assert.equal(classe.merge(grupo, null), grupo);
        return;
      }
      const r = classe.merge(g(v.input.grupo1), g(v.input.grupo2));
      for (const [k, e] of Object.entries(v.expected)) mesmoValor(r[k], e, k);
    });
  }
  for (const v of vetoresUnitarios('dados-unit', 'MonofasiaDomain')) {
    test(v.id, () => {
      const grupo = (classe, x) => (x == null ? null : FABRICA[classe].builder(Object.fromEntries(Object.entries(x).map(([k, y]) => [k, dec(y)]))));
      const c = {};
      if (v.input.gMonoPadrao) c.gMonoPadrao = grupo('MonofasiaPadraoDomain', v.input.gMonoPadrao);
      if (v.input.gMonoReten) c.gMonoReten = grupo('MonofasiaRetencaoDomain', v.input.gMonoReten);
      if (v.input.gMonoDif) c.gMonoDif = grupo('MonofasiaDiferimentoDomain', v.input.gMonoDif);
      if (v.input.vTotIBSMonoItem) c.vTotIBSMonoItem = dec(v.input.vTotIBSMonoItem);
      if (v.input.vTotCBSMonoItem) c.vTotCBSMonoItem = dec(v.input.vTotCBSMonoItem);
      const m = D.MonofasiaDomain.builder(c);
      for (const [k, e] of Object.entries(v.expected)) mesmoValor(D.MonofasiaDomain[`get${k[0].toUpperCase()}${k.slice(1)}`](m), e, k);
    });
  }

  for (const v of vetoresUnitarios('dados-unit', 'BigDecimalTDec1104OpRTCSerializer.serialize')) {
    test(v.id, () => assert.equal(JSON.stringify({ value: tdec1104OpRTC(Dec.parse(v.input.value)) }), v.expected.json));
  }

  // exception messages of the engine (derivedMessage = String.format of the Java constructor)
  const EXCECOES = {
    ClassificacaoTributariaNaoEncontradaException: (a) => E.classificacaoTributariaNaoEncontrada(...a),
    TipoAliquotaDesconhecidoException: (a) => E.tipoAliquotaDesconhecido(...a),
    PercentualReducaoNaoEncontradoException: (a) => E.percentualReducaoNaoEncontrado(...a),
    AliquotaReferenciaNaoEncontradaException: (a) => E.aliquotaReferenciaNaoEncontrada(...a),
    FundamentacaoClassificacaoNaoEncontradaException: (a) => E.fundamentacaoNaoEncontrada(...a),
    ErroAvaliadorExpressaoAritmeticaException: (a) => E.erroAvaliadorExpressao(...a),
    FormaAplicacaoNaoDefinidaException: () => E.formaAplicacaoNaoDefinida(),
  };
  for (const v of carregar('dados-unit').vectors.filter((x) => /<init>$/.test(x.endpoint) && EXCECOES[x.endpoint.slice(5, -7)])) {
    test(v.id, () => {
      const classe = v.endpoint.slice(5, -7);
      const hoje = '2026-11-23';
      const e = EXCECOES[classe](v.input.args.map((x) => (x === '<today>' ? hoje : x)));
      assert.equal(e.classeJava, v.expected.throws);
      assert.equal(e.mensagem, v.expected.derivedMessage.replaceAll('<today>', hoje));
    });
  }
});

// ─── expressions checked against the official evaluator (JEXL 3.5 on JDK 25) ──────────────────

test('avaliador: resultados e erros idênticos ao AvaliadorExpressaoAritmetica oficial', () => {
  const ORIGEM = 'br.gov.serpro.rtc.domain.service.calculotributo.AvaliadorExpressaoAritmetica.evaluate:111';
  // [expression, variables, toString|class, scale|message] — captured from the official class
  const casos = [
    ['1.00', {}, '1.0', 1], ['0.4285714', {}, '0.4285714', 7], ['010', {}, '8', 0], ['007', {}, '7', 0], ['0X1F', {}, '31', 0],
    ['1e3', {}, '1000.0', 1], ['1.5e3', {}, '1500.0', 1], ['1E-3', {}, '0.001', 3], ['1e-7', {}, '1.0E-7', 8], ['1.5E10', {}, '1.5E+10', -9],
    ['1.25e-10', {}, '1.25E-10', 12], ['0e0', {}, '0.0', 1], ['12e-1', {}, '1.2', 1], ['00.5', {}, '0.5', 1],
    ['(1-100/100)', {}, '0', 0], ['0.1+0.2', {}, '0.3', 1], ['-5', {}, '-5', 0], ['-0.0', {}, '0.0', 1], ['- -3', {}, '3', 0], ['+-3', {}, '-3', 0],
    ['2147483648', {}, '2147483648', 0], ['9999999999999999999', {}, '9999999999999999999', 0], ['9007199254740993', {}, '9007199254740993', 0],
    ['0.1234567890123456789', {}, '0.12345678901234568', 17], ['0.30000000000000004', {}, '0.30000000000000004', 17], ['3.0000000000000000001', {}, '3.0', 1],
    ['4.9e-325', {}, '0.0', 1], ['123456789.123', {}, '123456789.123', 3], ['1/3', {}, '0.3333333333333333333333333333333333', 34],
    ['x', { x: '1.50' }, '1.50', 2], [' x ', { x: '1.50' }, '1.50', 2], ['-x', { x: '2.50' }, '-2.50', 2], ['3*-x', { x: '2' }, '-6', 0],
    ['a*(3/4)', { a: '100' }, '75.00', 2], ['1+ 2* 3', {}, '7', 0], ['((1))', {}, '1', 0], ['$a', { $a: '1' }, '1', 0], ['çá', { çá: '2' }, '2', 0],
    ['baseCalculoInformada*0.5', { baseCalculoInformada: '100.05' }, '50.025', 3],
    ['tributoCalculado*1.00', { tributoCalculado: '11.11113000' }, '11.111130000', 9],
    ['quantidade*aliquotaAdRemPrincipal', { quantidade: '2', aliquotaAdRemPrincipal: '0.7925' }, '1.5850', 4],
    ['aliquota*(1-percentualReducao)*(1-pRedutorCompraGov/100)', { aliquota: '0.088123', percentualReducao: '0.60', pRedutorCompraGov: '0' }, '0.03524920', 8],
    ['', {}, 'NumberFormatException', 'Erro ao avaliar expressão: null'],
    ['1.7976931348623157e309', {}, 'NumberFormatException', 'Character I is neither a decimal digit number, decimal point, nor "e" notation exponential mark.'],
    ['y', { x: '1' }, 'JexlException$Variable', `${ORIGEM}@1:1 variable 'y' is undefined`],
    ['1+z', {}, 'JexlException$Variable', `${ORIGEM}@1:3 variable 'z' is undefined`],
    ['(z)', {}, 'JexlException$Variable', `${ORIGEM}@1:2 variable 'z' is undefined`],
    [' z', {}, 'JexlException$Variable', `${ORIGEM}@1:1 variable 'z' is undefined`],
    ['1\n+z', {}, 'JexlException$Variable', `${ORIGEM}@2:2 variable 'z' is undefined`],
    ['1\t\t/z', {}, 'JexlException$Variable', `${ORIGEM}@1:5 variable 'z' is undefined`],
    ['1/0', {}, 'JexlException', `${ORIGEM}@1:3 JEXL error : / error`], ['0/0', {}, 'JexlException', `${ORIGEM}@1:3 JEXL error : / error`],
    ['10/0', {}, 'JexlException', `${ORIGEM}@1:4 JEXL error : / error`], ['1/(2-2)', {}, 'JexlException', `${ORIGEM}@1:3 JEXL error : / error`],
    ['(1)/0', {}, 'JexlException', `${ORIGEM}@1:5 JEXL error : / error`], ['1+2+3/0', {}, 'JexlException', `${ORIGEM}@1:7 JEXL error : / error`],
    ['a / b', { a: '1', b: '0.00' }, 'JexlException', `${ORIGEM}@1:5 JEXL error : / error`], ['1/-0', {}, 'JexlException', `${ORIGEM}@1:3 JEXL error : / error`],
    ['1\n/0', {}, 'JexlException', `${ORIGEM}@2:2 JEXL error : / error`], ['\n1/0', {}, 'JexlException', `${ORIGEM}@2:3 JEXL error : / error`],
    ['1\t/0', {}, 'JexlException', `${ORIGEM}@1:4 JEXL error : / error`], ['  1/0', {}, 'JexlException', `${ORIGEM}@1:3 JEXL error : / error`],
    ['08', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in '8'`], ['1.', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in '.'`],
    ['.5', {}, 'JexlException$Parsing', `${ORIGEM}@1:1 parsing error in '.'`], ['1+', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in '+'`],
    ['1 +', {}, 'JexlException$Parsing', `${ORIGEM}@1:3 parsing error in '+'`], ['(1', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in '1'`],
    ['1)', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in ')'`], ['()', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in ')'`],
    ['2*(', {}, 'JexlException$Parsing', `${ORIGEM}@1:3 parsing error in '('`], ['1 1', {}, 'JexlException$Parsing', `${ORIGEM}@1:3 parsing error in '1'`],
    ['a b', { a: '1', b: '2' }, 'JexlException$Parsing', `${ORIGEM}@1:3 parsing error in 'b'`], ['1.5e', {}, 'JexlException$Parsing', `${ORIGEM}@1:4 parsing error in 'e'`],
    ['1e', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in 'e'`], ['1e+', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in 'e'`],
    ['0x', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in 'x'`], ['1_000', {}, 'JexlException$Parsing', `${ORIGEM}@1:2 parsing error in '_000'`],
    ['div', {}, 'JexlException$Parsing', `${ORIGEM}@1:1 parsing error in 'div'`], ['size', {}, 'JexlException$Parsing', `${ORIGEM}@1:1 parsing error in 'size'`],
    ['empty', {}, 'JexlException$Parsing', `${ORIGEM}@1:1 parsing error in 'empty'`],
  ];
  const falhas = [];
  for (const [expr, vars, a, b] of casos) {
    const m = new Map(Object.entries(vars).map(([k, x]) => [k, Dec.parse(x)]));
    let obtido;
    try { const r = avaliar(expr, m); obtido = [r.toJavaString(), r.scale()]; } catch (e) { obtido = [e.classeJava, e.mensagem ?? e.mensagemJava]; }
    if (obtido[0] !== a || obtido[1] !== b) falhas.push(`${JSON.stringify(expr)}: java ${a} ${b} | porte ${obtido.join(' ')}`);
  }
  assert.deepEqual(falhas, []);
  // Case 1 returns the very same bound value (same scale), and nulls become ZERO in the phase maps
  const x = Dec.parse('1.50');
  assert.equal(avaliar('aliquota', variaveis([['aliquota', x]])), x);
  assert.equal(avaliar('aliquota', variaveis([['aliquota', null]])).toJavaString(), '0');
  // fail closed: JEXL features outside the whitelist are refused (the Java would evaluate them)
  for (const e of ['x.abs()', '5%2', '1 == 1', '"a"', 'new("java.io.File","/")', 'a=1', 'x ? 1 : 2', '--x']) {
    assert.throws(() => avaliar(e, new Map([['x', x], ['a', x]])), (err) => err.classeJava === 'JexlException$Parsing', e);
  }
});

test('avaliador: 2500 expressões aleatórias idênticas ao JEXL oficial (resultado, escala e erro)', () => {
  // Deterministic generator (mulberry32, seed 2024) over the formula grammar: the 21 variables
  // (some missing → undefined variable), integer/octal/hex/real/exponent literals, unary signs,
  // parentheses, tabs/spaces, divisions (by zero too). The official AvaliadorExpressaoAritmetica
  // output for the same 2500 cases ("OK\t<toString>\t<scale>" or "ERR\t<class>\t<message>") is pinned
  // by its SHA-256 (1956 values, 411 JexlException$Variable, 133 JexlException "/ error").
  let seed = 2024;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const NOMES = ['baseCalculo', 'impostoSeletivoCalculado', 'baseCalculoInformada', 'impostoSeletivoInformado', 'aliquotaEfetiva', 'redutor', 'ajuste', 'aliquotaAdRem', 'aliquotaAdValorem', 'aliquotaReferencia', 'aliquotaPadraoOuReferencia', 'percentualReducao', 'pRedutorCompraGov', 'aliquota', 'quantidade', 'tributoCalculado', 'percentualDiferimento', 'aliquotaAdRemPrincipal', 'aliquotaAdRemSecundaria', 'variacaoPontoPercentual', 'pBio'];
  const num = () => pick([
    () => String(Math.floor(rnd() * 1000)), () => '0', () => '100', () => '1.00', () => '0.5', () => (rnd() * 100).toFixed(Math.floor(rnd() * 8) + 1),
    () => '0.4285714', () => '1e3', () => '2.5E-3', () => '010', () => '0x1F', () => '12345678901234567890', () => '0.1234567890123456789',
  ])();
  const ws = () => pick(['', '', '', ' ', '\t']);
  const expr = (d) => {
    if (d <= 0 || rnd() < 0.3) return rnd() < 0.5 ? num() : (rnd() < 0.95 ? pick(NOMES) : 'zz');
    const r = rnd();
    if (r < 0.1) return pick(['-', '+', '- ']) + '(' + expr(d - 1) + ')';
    if (r < 0.25) return '(' + expr(d - 1) + ')';
    const op = pick(['+', '-', '*', '/', '/']);
    return expr(d - 1) + ws() + op + ' ' + ws() + expr(d - 1);
  };
  const valor = () => pick(['0', '0.00', '1', '100', '0.9', '0.009000', '1000.00', '-3.5', '0.60', '12345.6789', '0.1922', '5', '0.30', '1.000000', '7720']);
  const linhas = [];
  for (let i = 0; i < 2500; i++) {
    const e = ' '.repeat(rnd() < 0.1 ? 1 : 0) + expr(1 + Math.floor(rnd() * 4));
    const vars = new Map();
    for (const n of NOMES) if (rnd() < 0.9) vars.set(n, Dec.parse(valor()));
    try { const r = avaliar(e, vars); linhas.push(`OK\t${r.toJavaString()}\t${r.scale()}`); } catch (x) { linhas.push(`ERR\t${x.classeJava}\t${x.mensagem ?? x.mensagemJava}`); }
  }
  assert.equal(createHash('sha256').update(linhas.join('\n')).digest('hex'), 'ab8b2e5cf8769944c57520e3b22d47ffe1cdb93f6f4ab8d640abfc3c6277e03e');
});

// ─── worked examples of calc-core.md §14 (expected tribCalc captured from the official API) ─────

const proc = criarProcessamento(base, { motor });
/** JSON fields written as number lexemes (the tests keep decimals as strings to preserve the scale). */
const NUMERICOS = new Set(['numero', 'municipio', 'tpDoc', 'tpEnteGov', 'tpOperGov', 'baseCalculo', 'quantidade', 'impostoInformado',
  'cbs', 'ibsEstadual', 'ibsMunicipal', 'adValorem', 'adRem', ...CAMPOS_COMPONENTES]);
/** JSON body with the decimal strings written as number lexemes (the BigDecimal keeps the scale). */
const corpoJson = (op) => JSON.stringify(op, (k, v) => (NUMERICOS.has(k) && typeof v === 'string' ? `@@${v}@@` : v)).replace(/"@@([^@]*)@@"/g, '$1');

/**
 * OperacaoModel of an item built by the real orchestration: the request is bound by the Jackson port
 * (entrada.js), the operation-level steps of CalculadoraService run (UF from the município, tpDoc) and
 * ProcessamentoItemService P1..P10 build the model (processamento.montarOperacaoModel). Returns null
 * when the orchestration rejects the item before the engine. `op` / `it` = request JSON with decimal
 * values as strings.
 */
function montarOperacaoModel(op, it) {
  return montarOuRejeitar(op, it).modelo ?? null;
}
/** { modelo } or { erro } (the ErroJava with which the orchestration rejects the item). */
function montarOuRejeitar(op, it) {
  const operacao = vincularOperacao(lerJsonTexto(corpoJson({ ...op, itens: [it] })));
  try {
    if (operacao.uf == null) operacao.uf = proc.servicos.municipioService.buscarUfPorMunicipio(operacao.municipio);
    proc.servicos.ufService.validarUf(operacao.uf);
    proc.servicos.municipioService.validarMunicipio(operacao.municipio, operacao.uf);
    const data = fatoGeradorAplicavel(operacao);
    const tipoDfe = proc.servicos.tipoDfeService.buscarPorTipo(operacao.tpDoc, data);
    return { modelo: proc.montarOperacaoModel(operacao, operacao.itens[0], data, tipoDfe) };
  } catch (e) {
    if (e?.classeJava) return { erro: e };
    throw e;
  }
}
const calcularItem = (op, it) => motor.serializarTributos(motor.calcular(montarOperacaoModel(op, it)));
const operacao = (data, extra = {}) => ({ id: 'x', versao: '1', dhFatoGerador: `${data}T10:00:00-03:00`, municipio: 3550308, uf: 'SP', ...extra });

describe('exemplos trabalhados (calc-core.md §14), conferidos com o oráculo', () => {
  const mem = (norma, trat, bc, resto) => `Operação de consumo com enquadramento legal em ${norma}, tributada conforme ${trat}. A base de cálculo utilizada é de R$ ${bc}${resto}`;
  const integral = (bc, aliq) => mem('LC 214/2025', 'Tributação integral', bc, `, com alíquota de ${aliq}%.`);

  test('A — 2026, CST 000/000001, alíquotas de referência do banco, empates HALF_EVEN', () => {
    const op = operacao('2026-06-15');
    assert.deepEqual(calcularItem(op, { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: '1000.00' }), {
      IBSCBS: { CST: '000', cClassTrib: '000001',
        gIBSCBS: { vBC: '1000.00', gIBSUF: { pIBSUF: '0.10', vIBSUF: '1.00' }, gIBSMun: { pIBSMun: '0.00', vIBSMun: '0.00' }, vIBS: '1.00', gCBS: { pCBS: '0.90', vCBS: '9.00' } },
        memoriaCalculo: { cbs: integral('1.000,00', '0,90'), ibsUF: integral('1.000,00', '0,10'), ibsMun: integral('1.000,00', '0,00') } },
    });
    const g5 = calcularItem(op, { numero: 2, cst: '000', cClassTrib: '000001', baseCalculo: '5.00' }).IBSCBS.gIBSCBS;
    assert.deepEqual([g5.gIBSUF.vIBSUF, g5.gCBS.vCBS, g5.vIBS], ['0.00', '0.04', '0.00']); // 0.005 → 0.00
    const g15 = calcularItem(op, { numero: 3, cst: '000', cClassTrib: '000001', baseCalculo: '15.00' }).IBSCBS.gIBSCBS;
    assert.deepEqual([g15.gIBSUF.vIBSUF, g15.gCBS.vCBS, g15.vIBS], ['0.02', '0.14', '0.02']); // 0.015 → 0.02
  });

  test('B — 2027, CST 200/200028 (redução de 60%), alíquotas nominais', () => {
    const red = (bc, aliq) => mem('Art. 129', 'Alíquota reduzida em 60%', bc, `, com alíquota de ${aliq}%, sendo que esse regime define uma redução de 60,00% na alíquota.`);
    assert.deepEqual(calcularItem(operacao('2027-06-15'), { numero: 1, cst: '200', cClassTrib: '200028', nbs: '122011100', baseCalculo: '1000.00', aliquotasNominais: { cbs: '8.8123', ibsEstadual: '0.1', ibsMunicipal: '0.05' } }), {
      IBSCBS: { CST: '200', cClassTrib: '200028',
        gIBSCBS: { vBC: '1000.00', gIBSUF: { pIBSUF: '0.10', gRed: { pRedAliq: '60.00', pAliqEfet: '0.04' }, vIBSUF: '0.40' },
          gIBSMun: { pIBSMun: '0.05', gRed: { pRedAliq: '60.00', pAliqEfet: '0.02' }, vIBSMun: '0.20' }, vIBS: '0.60',
          gCBS: { pCBS: '8.8123', gRed: { pRedAliq: '60.00', pAliqEfet: '3.5249' }, vCBS: '35.25' } },
        memoriaCalculo: { cbs: red('1.000,00', '8,8123'), ibsUF: red('1.000,00', '0,10'), ibsMun: red('1.000,00', '0,05') } },
    });
  });

  test('C — 2026, CST 510/510001 (diferimento de 100%)', () => {
    const t = mem('Art. 28, § 1º', 'Diferimento', '1.234,57', ', sendo que esta operação não possui alíquota.');
    assert.deepEqual(calcularItem(operacao('2026-06-15'), { numero: 1, cst: '510', cClassTrib: '510001', baseCalculo: '1234.57' }), {
      IBSCBS: { CST: '510', cClassTrib: '510001',
        gIBSCBS: { vBC: '1234.57', gIBSUF: { pIBSUF: '0.10', gDif: { pDif: '100.00', vDif: '1.23' }, vIBSUF: '0.00' },
          gIBSMun: { pIBSMun: '0.00', gDif: { pDif: '100.00', vDif: '0.00' }, vIBSMun: '0.00' }, vIBS: '0.00',
          gCBS: { pCBS: '0.90', gDif: { pDif: '100.00', vDif: '11.11' }, vCBS: '0.00' } },
        memoriaCalculo: { cbs: t, ibsUF: t, ibsMun: t } },
    });
  });

  test('D — 2029, compra governamental de Município (transferência de 10% da CBS) e cenario_02_estado (2027)', () => {
    assert.deepEqual(calcularItem(operacao('2029-06-15', { gCompraGov: { tpEnteGov: 4, tpOperGov: 1 } }),
      { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: '1000.00', aliquotasNominais: { cbs: '8.8', ibsEstadual: '0.1', ibsMunicipal: '0.05' } }), {
      IBSCBS: { CST: '000', cClassTrib: '000001',
        gIBSCBS: { vBC: '1000.00', gIBSUF: { pIBSUF: '0.10', gRed: { pRedAliq: '0.00', pAliqEfet: '0.00' }, vIBSUF: '0.00' },
          gIBSMun: { pIBSMun: '0.05', gRed: { pRedAliq: '0.00', pAliqEfet: '1.03' }, vIBSMun: '10.30' }, vIBS: '10.30',
          gCBS: { pCBS: '8.80', gRed: { pRedAliq: '0.00', pAliqEfet: '7.92' }, vCBS: '79.20' },
          gTribCompraGov: { pAliqIBSUF: '0.10', vTribIBSUF: '1.00', pAliqIBSMun: '0.05', vTribIBSMun: '0.50', pAliqCBS: '8.80', vTribCBS: '88.00' } },
        memoriaCalculo: { cbs: integral('1.000,00', '8,80'), ibsUF: integral('1.000,00', '0,10'), ibsMun: integral('1.000,00', '0,05') } },
    });
    assert.deepEqual(calcularItem(operacao('2027-06-15', { gCompraGov: { tpEnteGov: 2, tpOperGov: 1 } }),
      { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: '200', aliquotasNominais: { cbs: '8.4', ibsEstadual: '0.05', ibsMunicipal: '0.05' } }).IBSCBS.gIBSCBS, {
      vBC: '200.00', gIBSUF: { pIBSUF: '0.05', gRed: { pRedAliq: '0.00', pAliqEfet: '0.10' }, vIBSUF: '0.20' },
      gIBSMun: { pIBSMun: '0.05', gRed: { pRedAliq: '0.00', pAliqEfet: '0.00' }, vIBSMun: '0.00' }, vIBS: '0.20',
      gCBS: { pCBS: '8.40', gRed: { pRedAliq: '0.00', pAliqEfet: '8.40' }, vCBS: '16.80' },
      gTribCompraGov: { pAliqIBSUF: '0.05', vTribIBSUF: '0.10', pAliqIBSMun: '0.05', vTribIBSMun: '0.10', pAliqCBS: '8.40', vTribCBS: '16.80' },
    });
  });

  test('E — 2026, suspensão 550/550001 com tributação regular 000/000001', () => {
    const t = mem('Art. 82', 'Suspensão', '500,00', ', sendo que esta operação não possui alíquota.');
    assert.deepEqual(calcularItem(operacao('2026-06-15'), { numero: 1, cst: '550', cClassTrib: '550001', baseCalculo: '500.00', tributacaoRegular: { cst: '000', cClassTrib: '000001' } }), {
      IBSCBS: { CST: '550', cClassTrib: '550001',
        gIBSCBS: { vBC: '500.00', gIBSUF: { pIBSUF: '0.00', vIBSUF: '0.00' }, gIBSMun: { pIBSMun: '0.00', vIBSMun: '0.00' }, vIBS: '0.00', gCBS: { pCBS: '0.00', vCBS: '0.00' },
          gTribRegular: { CSTReg: '000', cClassTribReg: '000001', pAliqEfetRegIBSUF: '0.10', vTribRegIBSUF: '0.50', pAliqEfetRegIBSMun: '0.00', vTribRegIBSMun: '0.00', pAliqEfetRegCBS: '0.90', vTribRegCBS: '4.50' } },
        memoriaCalculo: { cbs: t, ibsUF: t, ibsMun: t } },
    });
  });

  test('F — 2027, Imposto Seletivo (ad valorem 13 + ad rem 21,3) compondo a base da CBS/IBS', () => {
    const r = calcularItem(operacao('2027-06-15'), { numero: 1, cst: '000', cClassTrib: '000001',
      impostoSeletivo: { cst: '000', cClassTrib: '000001', baseCalculo: '200.00', quantidade: '1', unidade: 'VN' },
      aliquotasNominais: { cbs: '8.8', ibsEstadual: '0.1', ibsMunicipal: '0.05', impostoSeletivo: { adValorem: '13', adRem: '21.3' } } });
    assert.deepEqual(r.IS, {
      CSTIS: '000', cClassTribIS: '000001', vBCIS: '200.00', pIS: '13.00', pISEspec: '21.30', adRemIS: '21.30', uTrib: 'VN', qTrib: '1', vIS: '47.30',
      memoriaCalculo: 'Operação de consumo sujeita à tributação pelo Imposto Seletivo, com enquadramento legal em Art. 412, I, tributada conforme Tributação pelo Imposto Seletivo - Com Cálculo. A base de cálculo utilizada é de R$ 200,00, com alíquota ad valorem de 13,00%. A alíquota ad rem é de 21,30.',
    });
    assert.deepEqual(r.IBSCBS.gIBSCBS, { vBC: '247.30', gIBSUF: { pIBSUF: '0.10', vIBSUF: '0.25' }, gIBSMun: { pIBSMun: '0.05', vIBSMun: '0.12' }, vIBS: '0.37', gCBS: { pCBS: '8.80', vCBS: '21.76' } });
    assert.equal(r.IBSCBS.memoriaCalculo.cbs, integral('247,30', '8,80'));
  });
});

// ─── errors, serialization, memory and the builder-chain quirk ─────────────────────────────

describe('erros, serialização e regras finas do motor', () => {
  test('ordem de erros: ajuste (CAL-007) antes de percentual/alíquota; alíquota ausente em 2027 sem nominais (CAL-001)', () => {
    const r1 = tentar(() => motor.calcular(montarOperacaoModel(operacao('2026-06-15'), { numero: 1, cst: '620', cClassTrib: '620001', baseCalculo: '10.00' })));
    assert.equal(r1.erro.classeJava, 'ErroFaltaImplementacaoException');
    assert.equal(r1.erro.problemType.code, 'CAL-007');
    assert.match(r1.erro.mensagem, /^A classificação tributária 620001 ainda não possui tratamento tributário implementado/);
    // CST without the IBS/CBS group: the CBS is still calculated (and fails) before being discarded
    const modelo = montarOperacaoModel(operacao('2027-06-15'), { numero: 1, cst: '410', cClassTrib: '000001', baseCalculo: '10.00' });
    const r2 = tentar(() => motor.calcular(modelo));
    assert.equal(r2.erro.classeJava, 'AliquotaNaoEncontradaException');
    assert.equal(r2.erro.mensagem, 'Alíquota de referencia ou padrão não encontrada para o tributo com id 2, UF null, município null e data 2027-06-15');
    assert.equal(problemTypePorClasse(r2.erro.classeJava).code, 'CAL-001');
  });

  test('CST sem grupo IBS/CBS: sem gIBSCBS, memória com a base informada e alíquota zero, sem consultar a transferência', () => {
    const consultas = [];
    const servicos = { ...motor.servicos, transferenciaService: { getPercentualTransferencia: (d) => { consultas.push(d); throw new Error('não deveria consultar'); } } };
    const m = criarMotor(base, { servicos });
    const r = m.serializarTributos(m.calcular(montarOperacaoModel(operacao('2026-06-15'), { numero: 1, cst: '410', cClassTrib: '410001', baseCalculo: '77.70' })));
    assert.equal(r.IBSCBS.gIBSCBS, undefined);
    assert.deepEqual(consultas, []);
    assert.match(r.IBSCBS.memoriaCalculo.cbs, /R\$ 77,70/);
  });

  test('serializers: negativos, CST/cClassTrib/uTrib fora do padrão → ErroSerializacao (500 "Failed to write request")', () => {
    assert.throws(() => tdec1302(Dec.parse('-0.01')), (e) => e instanceof ErroSerializacao && e.mensagem === 'Números negativos não são permitidos para TDec1302');
    assert.throws(() => tdec1104OpRTC(Dec.parse('-1')), (e) => e instanceof ErroSerializacao && e.mensagem === 'Números negativos não são permitidos para TDec_1104OpRTC');
    const t = motor.calcular(montarOperacaoModel(operacao('2026-06-15'), { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: '10.00' }));
    t.IBSCBS.gIBSCBS.gCBS.pCBS = Dec.parse('-1');
    assert.throws(() => serializarTributos(t), (e) => e instanceof ErroSerializacao && e.mensagem === 'Números negativos não são permitidos para TDec_0302_04');
    assert.throws(() => serializar('IBSCBSDomain', D.IBSCBSDomain.builder({ CST: '0001' })), (e) => e.classeJava === 'DatabindException' && e.mensagem === 'TCST deve ser uma string de exatamente 3 dígitos numéricos');
    assert.throws(() => serializar('IBSCBSDomain', D.IBSCBSDomain.builder({ CST: '000', cClassTrib: '00000a' })), (e) => e.mensagem === 'TcClassTrib deve ser uma string de exatamente 6 dígitos numéricos');
    assert.throws(() => serializar('ImpostoSeletivoDomain', D.ImpostoSeletivoDomain.builder({ uTrib: '' })), (e) => e.mensagem === 'uTrib deve ter entre 1 e 6 caracteres');
    assert.throws(() => serializar('ImpostoSeletivoDomain', D.ImpostoSeletivoDomain.builder({ uTrib: 'ABCDEFG' })), (e) => e.mensagem === 'uTrib deve ter entre 1 e 6 caracteres');
    // NON_NULL and @JsonPropertyOrder; empty memory object serializes as {}
    assert.deepEqual(JSON.stringify(serializar('IBSCBSDomain', D.IBSCBSDomain.builder({ memoriaCalculo: D.MemoriaCalculoDomain.criar(), cClassTrib: '000001', CST: '000' }))), '{"CST":"000","cClassTrib":"000001","memoriaCalculo":{}}');
  });

  test('getTributacaoRegular descarta o builder quando um tributo não tem tributação regular (bug do Java reproduzido)', () => {
    // CBS and IBS UF with regular taxation, IBS Mun without: the Java returns null (the chain loses the builder)
    const comTR = (aliq, valor) => D.CbsIbsOutput.builder({ baseCalculo: Dec.parse('10.00'), aliquota: ZERO, tributoDevido: ZERO,
      tributacaoRegular: D.TributacaoRegularOutput.builder({ cst: '000', cClassTrib: '000001', aliquotaEfetiva: Dec.parse(aliq), tributoDevido: Dec.parse(valor) }) });
    const semTR = () => D.CbsIbsOutput.builder({ baseCalculo: Dec.parse('10.00'), aliquota: ZERO, tributoDevido: ZERO });
    const servicos = { ...motor.servicos, transferenciaService: { getPercentualTransferencia: () => ZERO } };
    let fila = [comTR('0.9', '0.09'), semTR(), comTR('0.0', '0.00')];
    const motorStub = criarMotorComCbsIbs({ calcularCbsIbs: () => fila.shift() }, servicos);
    const r1 = motorStub.calcular(modeloSimples());
    // IBS UF without TR: CBS data lost; IBS Mun starts a new builder
    assert.deepEqual(serializar('TributacaoRegularDomain', r1.IBSCBS.gIBSCBS.gTribRegular), {
      CSTReg: '000', cClassTribReg: '000001', pAliqEfetRegIBSUF: '0.00', vTribRegIBSUF: '0.00', pAliqEfetRegIBSMun: '0.00', vTribRegIBSMun: '0.00', pAliqEfetRegCBS: '0.00', vTribRegCBS: '0.00',
    });
    fila = [comTR('0.9', '0.09'), comTR('0.1', '0.01'), semTR()];
    const r2 = motorStub.calcular(modeloSimples());
    assert.equal(r2.IBSCBS.gIBSCBS.gTribRegular, null, 'IBS Mun sem tributação regular: grupo descartado');
    fila = [comTR('0.9', '0.09'), comTR('0.1', '0.01'), comTR('0.05', '0.01')];
    const r3 = motorStub.calcular(modeloSimples());
    assert.deepEqual(serializar('TributacaoRegularDomain', r3.IBSCBS.gIBSCBS.gTribRegular), {
      CSTReg: '000', cClassTribReg: '000001', pAliqEfetRegIBSUF: '0.10', vTribRegIBSUF: '0.01', pAliqEfetRegIBSMun: '0.05', vTribRegIBSMun: '0.01', pAliqEfetRegCBS: '0.90', vTribRegCBS: '0.09',
    });
  });

  test('memória de cálculo: tokenização ([a [b] → chave "a [b"; sem "]" → literal), modelo vazio e [quantidade] em notação científica', () => {
    const v = new Map([['a [b', 'X'], ['quantidade', Dec.parse('1E+3').toJavaString()]]);
    assert.equal(substituirPlaceholders('ini [a [b] fim [x', v), 'ini X fim [x');
    assert.equal(substituirPlaceholders('sem colchetes', v), 'sem colchetes');
    assert.equal(substituirPlaceholders('[quantidade] [desconhecida]!', v), '1E+3 !');
    const servicos = {
      ...motor.servicos,
      fundamentacaoClassificacaoService: { buscar: () => ({ textoCurto: null, memoriaCalculo: ' \t' }) },
    };
    const m = criarMotor(base, { servicos });
    const r = m.calcular(montarOperacaoModel(operacao('2026-06-15'), { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: '1.00' }));
    assert.equal(r.IBSCBS.memoriaCalculo.cbs, 'Texto de memória de cálculo não encontrado');
    assert.equal(formatarMoeda(Dec.parse('-0.001')), '-0,00', 'DecimalFormat mantém o sinal de um negativo que arredonda para zero');
  });
});

// ─── monophasic taxation (unreachable with the current database) against the official classes ───

test('monofasia: 1024 cenários idênticos ao CalculoTributoService oficial com serviços simulados', () => {
  // Scenarios run on the JDK through the official CalculoTributoService / CalculoCbsIbsService /
  // MemoriaCalculoService with stub services (treatments 23–26 with possuiAjuste=false so the
  // monophasic branch runs; 32 combinations of the 4 monophasic flags + inGrupoReducao; quantities
  // 1, 1000.5, 1E+3, 0.0001; with and without government purchase). The Java output (Jackson JSON,
  // or "ERR <exception simple name>", or "ERR SERIALIZACAO" when a serializer rejects a value) is
  // pinned by its SHA-256; three lines are kept literally for readability.
  const TT = [
    ['23', 'aliquotaAdRemPrincipal', '', 'quantidade', 'quantidade*aliquotaAdRemPrincipal', ''],
    ['24', 'aliquotaAdRemPrincipal', 'aliquotaAdRemSecundaria', 'quantidade', 'quantidade*aliquotaAdRemPrincipal', '(pBio/(1-pBio))*quantidade*aliquotaAdRemSecundaria'],
    ['25', 'aliquotaAdRemPrincipal', '', 'quantidade', 'quantidade*aliquotaAdRemPrincipal', 'quantidade*aliquotaAdRemPrincipal*(1-percentualDiferimento)'],
    ['26', '(1-pBio)*aliquotaAdRemPrincipal+pBio*aliquotaAdRemSecundaria', 'aliquotaAdRemSecundaria', 'quantidade', '(variacaoPontoPercentual/100)*quantidade*(pBio/(1-pBio))*aliquotaAdRemSecundaria', 'quantidade*aliquota'],
  ];
  const linhas = [];
  for (const t of TT) for (let flags = 0; flags < 32; flags++) for (const qtd of ['1', '1000.5', '1E+3', '0.0001']) for (const ente of [0, 4]) {
    const servicos = {
      tratamentoService: { buscar: () => ({ id: Number(t[0]), descricao: `Monofasia ${t[0]}`, expressaoAliquota: t[1], expressaoAliquotaEfetiva: t[2], expressaoBaseCalculo: t[3], expressaoTributoCalculado: t[4], expressaoTributoDevido: t[5], expressaoPercentualDiferimento: null, expressaoValorDiferimento: null, inPossuiPercentualReducao: true, inPossuiAjuste: false, inPossuiMonofasia: true }) },
      classificacaoTributariaService: { buscarClassificacaoTributariaCalculo: (id) => ({ id, codigo: '620001', tipoAliquota: 'Uniforme setorial', inGrupoMonofasiaPadrao: !!(flags & 1), inGrupoMonofasiaReten: !!(flags & 2), inGrupoMonofasiaRet: !!(flags & 4), inGrupoMonofasiaDiferimento: !!(flags & 8), inGrupoReducao: !!(flags & 16) }) },
      situacaoTributariaService: { consultarSituacaoTributariaPorCodigo: () => ({ inGrupoIbsCbs: true }) },
      percentualReducaoService: { buscar: () => Dec.parse('0.0') },
      fundamentacaoClassificacaoService: { buscar: () => ({ textoCurto: 'Art. 172', memoriaCalculo: 'Operação de consumo com enquadramento legal em [norma], tributada conforme [tratamento]. A base de cálculo utilizada é de [quantidade] [unidade], com alíquota ad rem de R$ [aliquota_ad_rem].' }) },
      transferenciaService: { getPercentualTransferencia: () => Dec.parse('0.0') },
    };
    const m = criarMotor(null, { servicos });
    const op = { data: '2026-06-15', codigoMunicipio: 3550308, codigoUf: 35, tpEnteGov: ente === 0 ? null : ente, pRedutor: ZERO,
      item: { numero: 1, cst: '620', cClassTrib: '620001', baseCalculo: Dec.parse('100.00'), quantidade: Dec.parse(qtd), unidade: 'LT' },
      tratamentoClassificacao: { tratamentoClassificacaoCbsIbs: { idTratamentoTributario: Number(t[0]), idClassificacaoTributaria: 160, inIncompativelComSuspensao: false, inExigeGrupoDesoneracao: false }, temDesoneracao: false } };
    let r;
    try {
      const trib = m.calcular(op);
      try { r = JSON.stringify(m.serializarTributos(trib)); } catch (e) { if (e instanceof ErroSerializacao) r = 'ERR SERIALIZACAO'; else throw e; }
    } catch (e) { r = `ERR ${e.classeJava ?? `${e.name}: ${e.message}`}`; }
    linhas.push(`${t[0]}|${flags}|${qtd}|${ente}\t${r}`);
  }
  const porId = (k) => linhas.find((l) => l.startsWith(`${k}\t`));
  assert.equal(porId('24|15|1000.5|4'), '24|15|1000.5|4\t{"IBSCBS":{"CST":"620","cClassTrib":"620001","gIBSCBSMono":{"gMonoPadrao":{"qBCMono":"50.0250","adRemIBS":"0.1922","adRemCBS":"0.1922","vIBSMono":"792.90","vCBSMono":"792.90"},"gMonoReten":{"qBCMonoReten":"428.7857","adRemIBSReten":"0.1922","vIBSMonoReten":"82.41","adRemCBSReten":"0.1922","vCBSMonoReten":"82.41"},"gMonoRet":{"qBCMonoRet":"1000.5000","adRemIBSRet":"0.7925","vIBSMonoRet":"82.41","adRemCBSRet":"0.7925","vCBSMonoRet":"82.41"},"gMonoDif":{"pDifIBS":"89.6065","vIBSMonoDif":"710.49","pDifCBS":"89.6065","vCBSMonoDif":"710.49"},"vTotIBSMonoItem":"164.82","vTotCBSMonoItem":"164.82"},"memoriaCalculo":{"cbs":"Operação de consumo com enquadramento legal em Art. 172, tributada conforme Monofasia 24. A base de cálculo utilizada é de 1000.5 LT, com alíquota ad rem de R$ 0,1922.","ibsUF":"Operação de consumo com enquadramento legal em Art. 172, tributada conforme Monofasia 24. A base de cálculo utilizada é de 1000.5 LT, com alíquota ad rem de R$ 0,1922.","ibsMun":"Operação de consumo com enquadramento legal em Art. 172, tributada conforme Monofasia 24. A base de cálculo utilizada é de 1000.5 LT, com alíquota ad rem de R$ 0,1922."}}}');
  assert.equal(porId('26|31|0.0001|0'), '26|31|0.0001|0\tERR ArithmeticException');
  assert.equal(porId('25|12|1|0'), '25|12|1|0\tERR SERIALIZACAO');
  assert.equal(createHash('sha256').update(linhas.join('\n')).digest('hex'), '913cc86debb39b615d1bf2f00e621528b840be6a6f346f2aec1e7f173ac51c55');
});

// helpers for the builder-chain test: an engine whose CBS/IBS calculation is a stub
function criarMotorComCbsIbs(stub, servicos) {
  const m = criarMotor(base, { servicos });
  // the engine wires calcularCbsIbs through the object returned by criarCalculoCbsIbs; replacing the
  // method on that object changes what calcular() calls
  m.calculoCbsIbs.calcularCbsIbs = (...args) => stub.calcularCbsIbs(...args);
  return m;
}
function modeloSimples() {
  return montarOperacaoModel(operacao('2026-06-15'), { numero: 1, cst: '000', cClassTrib: '000001', baseCalculo: '10.00' });
}

// ─── pipeline vectors (CalculadoraService.calcularTributos): tribCalc keys through the engine ────

test('vetores do pipeline oficial (CalculadoraService): chaves de tribCalc recalculadas pelo motor', (t) => {
  let conferidos = 0;
  let chaves = 0;
  const falhas = [];
  for (const arquivo of ['calculo', 'validacao']) {
    for (const v of vetoresUnitarios(arquivo, 'CalculadoraService.calcularTributos')) {
      if (v.expected.throws !== undefined || v.endpoint.includes('+')) continue;
      const op = JSON.parse(JSON.stringify(v.input.operacao ?? v.input), (k, x) => (typeof x === 'number' ? String(x) : x));
      op.municipio = Number(op.municipio);
      if (op.gCompraGov?.tpEnteGov != null) op.gCompraGov.tpEnteGov = Number(op.gCompraGov.tpEnteGov);
      const objetos = [];
      let ok = true;
      for (const it of op.itens ?? []) {
        const modelo = montarOperacaoModel(op, it);
        if (!modelo) { ok = false; break; }
        const r = tentar(() => motor.serializarTributos(motor.calcular(modelo)));
        if (r.erro) { ok = false; break; }
        objetos.push({ tribCalc: r.valor });
      }
      if (!ok) continue;
      conferidos++;
      for (const [k, e] of Object.entries(v.expected)) {
        const m = /^\$\.objetos\[(\d+)\]\.tribCalc\.(.+)$/.exec(k.replace(/#\d+$/, ''));
        if (!m) continue;
        chaves++;
        let x = objetos[Number(m[1])]?.tribCalc;
        for (const p of m[2].split('.')) x = x?.[p];
        const s = String(e);
        let bom;
        if (s === '<present>') bom = x != null;
        else if (s === '<absent>') bom = x == null;
        else if (s.startsWith('<num:')) bom = x != null && Dec.parse(String(x)).compareTo(Dec.parse(s.slice(5, -1))) === 0;
        else if (s.startsWith('<gt:')) bom = x != null && Dec.parse(String(x)).compareTo(Dec.parse(s.slice(4, -1))) > 0;
        else bom = x === s;
        if (!bom) falhas.push(`${v.id} ${k}: esperado ${s}, obtido ${JSON.stringify(x)}`);
      }
    }
  }
  t.diagnostic(`vetores conferidos: ${conferidos}, chaves: ${chaves}`);
  assert.deepEqual(falhas, []);
  assert.ok(conferidos >= 40, `vetores conferidos: ${conferidos}`);
});

// ─── rounding corpus (lote-arredondamento.jsonl): serialization never changes a number ────────

/** Request body of the corpus with every JSON number turned into its exact lexeme (string). */
const lerNota = (corpo) => {
  const op = JSON.parse(corpo.replace(/([:[,])\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/g, '$1"$2"'));
  op.municipio = Number(op.municipio);
  if (op.gCompraGov?.tpEnteGov != null) op.gCompraGov.tpEnteGov = Number(op.gCompraGov.tpEnteGov);
  return op;
};
const notasCorpus = () => readFileSync(new URL('../fixtures/regime-regular/lote-arredondamento.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).slice(0, 300).map((l) => JSON.parse(l));

test('arred-serializacao-nao-altera-numero: todo BigDecimal guardado pelo motor é o número publicado (300 notas do lote)', (t) => {
  let numerosComparados = 0;
  const diferencas = [];
  let itens = 0;
  // walks the domain object and its serialization side by side (fields present in both)
  const comparar = (dominio, json, caminho) => {
    for (const [k, v] of Object.entries(dominio)) {
      const j = json?.[k];
      if (v == null || j == null) continue;
      if (v instanceof Dec) {
        numerosComparados++;
        if (Dec.parse(String(j)).compareTo(v) !== 0) diferencas.push(`${caminho}.${k}: guardado ${v.toJavaString()}, publicado ${j}`);
      } else if (typeof v === 'object') comparar(v, j, `${caminho}.${k}`);
    }
  };
  for (const nota of notasCorpus()) {
    const op = lerNota(nota.corpo);
    for (const it of op.itens) {
      const modelo = montarOperacaoModel(op, it);
      if (!modelo) continue;
      const r = tentar(() => motor.calcular(modelo));
      if (r.erro) continue;
      const s = tentar(() => motor.serializarTributos(r.valor));
      if (s.erro) continue;
      itens++;
      comparar(r.valor, s.valor, `nota ${nota.indice} item ${it.numero}`);
    }
  }
  t.diagnostic(`itens ${itens}, números comparados ${numerosComparados}`);
  assert.deepEqual(diferencas, []);
  assert.ok(numerosComparados > 3000, String(numerosComparados));
});

// ─── live cross-check against the official API ─────────────────────────────────────────────

// opt-in: `npm test` must not depend on whatever happens to listen on :8080
const ORACULO = process.env.ORACULO_URL;
const SEM_ORACULO_MOTIVO = ORACULO ? `oráculo indisponível em ${ORACULO}` : 'diferencial ao vivo desligado (defina ORACULO_URL)';

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SQL_LISTA = `SELECT ct.CLTR_ID id, ct.CLTR_CD cod, st.SITR_CD cst, tt.TRTR_IN_EXIGE_GRUPO_DESONERACAO exd, tt.TRTR_IN_INCOMPATIVEL_COM_SUSPENSAO inc
 FROM CLASSIFICACAO_TRIBUTARIA ct JOIN SITUACAO_TRIBUTARIA st ON ct.CLTR_SITR_ID = st.SITR_ID JOIN TRIBUTO_SITUACAO_TRIBUTARIA tst ON tst.TRST_SITR_ID = st.SITR_ID
 JOIN TRATAMENTO_CLASSIFICACAO tc ON tc.TRCL_CLTR_ID = ct.CLTR_ID AND :d BETWEEN tc.TRCL_INICIO_VIGENCIA AND COALESCE(tc.TRCL_FIM_VIGENCIA, :d)
 JOIN TRATAMENTO_TRIBUTARIO tt ON tt.TRTR_ID = tc.TRCL_TRTR_ID
 WHERE tst.TRST_TBTO_ID = :t AND :d BETWEEN ct.CLTR_INICIO_VIGENCIA AND COALESCE(ct.CLTR_FIM_VIGENCIA, :d)
 AND :d BETWEEN st.SITR_INICIO_VIGENCIA AND COALESCE(st.SITR_FIM_VIGENCIA, :d) AND :d BETWEEN tst.TRST_INICIO_VIGENCIA AND COALESCE(tst.TRST_FIM_VIGENCIA, :d)
 ORDER BY ct.CLTR_CD`;
const SQL_NCM = `SELECT n.NCM_CD c FROM NCM_APLICAVEL a JOIN NCM n ON n.NCM_CD LIKE a.NCMA_NCM_CD || '%'
 WHERE a.NCMA_CLTR_ID = :id AND LENGTH(n.NCM_CD) = 8 AND :d BETWEEN a.NCMA_INICIO_VIGENCIA AND COALESCE(a.NCMA_FIM_VIGENCIA, :d)
 AND :d BETWEEN n.NCM_INICIO_VIGENCIA AND COALESCE(n.NCM_FIM_VIGENCIA, :d) ORDER BY n.NCM_CD LIMIT 20`;
const SQL_NBS = `SELECT n.NBS_CD c FROM NBS_APLICAVEL a JOIN NBS n ON n.NBS_CD LIKE a.NBSA_NBS_CD || '%'
 WHERE a.NBSA_CLTR_ID = :id AND LENGTH(n.NBS_CD) = 9 AND :d BETWEEN a.NBSA_INICIO_VIGENCIA AND COALESCE(a.NBSA_FIM_VIGENCIA, :d)
 AND :d BETWEEN n.NBS_INICIO_VIGENCIA AND COALESCE(n.NBS_FIM_VIGENCIA, :d) ORDER BY n.NBS_CD LIMIT 20`;

/**
 * Requests of valid-looking items: every CBS/IBS classification of the date (2026 with the database
 * rates; 2027–2034 with nominal rates, incl. Imposto Seletivo ad valorem / ad rem), HALF_EVEN ties,
 * huge bases, suspension with regular taxation (550xxx, 200022, 200024), deferral (510001, 515001),
 * government purchase tpEnteGov 1–6, NCM/NBS of the annexes, and some CST × cClassTrib mismatches.
 */
function gerarRequisicoes(seed, nReq, itensPorReq) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const valor = (max, casas) => (r() * max).toFixed(Math.floor(r() * (casas + 1)));
  const DATAS = ['2026-01-01', '2026-03-15', '2026-12-31', '2027-01-01', '2027-06-15', '2028-02-29', '2029-05-10', '2030-07-01', '2031-09-09', '2032-12-31', '2033-01-01', '2034-06-30'];
  const LOCAIS = [[3550308, 'SP'], [3304557, 'RJ'], [1200013, 'AC'], [5300108, 'DF'], [4314902, 'RS']];
  const reqs = [];
  for (let k = 0; k < nReq; k++) {
    const data = pick(DATAS);
    const [municipio, uf] = pick(LOCAIS);
    const tpEnteGov = r() < 0.45 ? 1 + Math.floor(r() * 6) : null;
    const cbsIbs = base.all(SQL_LISTA, { d: data, t: 2n });
    const regulares = cbsIbs.filter((c) => !c.exd && !c.inc);
    const csts = [...new Set(cbsIbs.map((c) => c.cst))];
    const listaIS = data >= '2027' ? base.all(SQL_LISTA, { d: data, t: 1n }) : [];
    const itens = [];
    for (let i = 0; i < itensPorReq; i++) {
      const c = pick(cbsIbs);
      const it = { numero: i + 1, cst: r() < 0.85 ? c.cst : pick(csts), cClassTrib: c.cod };
      const ncms = base.all(SQL_NCM, { id: BigInt(c.id), d: data }).map((x) => x.c);
      const nbss = ncms.length ? [] : base.all(SQL_NBS, { id: BigInt(c.id), d: data }).map((x) => x.c);
      if (ncms.length) { it.ncm = pick(ncms); it.cst = c.cst; } else if (nbss.length) { it.nbs = pick(nbss); it.cst = c.cst; }
      it.baseCalculo = pick([() => valor(5000, 2), () => pick(['5.00', '15.00', '25.00', '0.50', '1.50', '100.05', '1234.57', '0', '0.01']), () => valor(1e9, 2)])();
      if (r() < 0.5) it.quantidade = pick(['1', '2.5', '1000', '0.0001', '3', '12.3456']);
      if (r() < 0.4) it.unidade = pick(['UN', 'KG', 'LT', 'VN']);
      if (c.exd || r() < 0.05) { const tr = pick(regulares); it.tributacaoRegular = { cst: tr.cst, cClassTrib: tr.cod }; }
      if (data >= '2027') {
        if (r() < 0.9) it.aliquotasNominais = { cbs: valor(r() < 0.8 ? 12 : 100, 4), ibsEstadual: valor(r() < 0.8 ? 20 : 100, 4), ibsMunicipal: valor(r() < 0.8 ? 6 : 100, 4) };
        if (listaIS.length && !it.ncm && !it.nbs && r() < 0.35) {
          const ci = pick(listaIS);
          const is = { cst: ci.cst, cClassTrib: ci.cod, baseCalculo: valor(3000, 2), unidade: pick(['VN', 'KG', 'LT']), quantidade: pick(['1', '2', '10.5', '0.0001']) };
          if (r() < 0.4) is.impostoInformado = valor(300, 2);
          it.impostoSeletivo = is;
          delete it.baseCalculo;
          if (r() < 0.3) it.baseCalculo = Dec.parse(is.baseCalculo).add(Dec.parse(is.impostoInformado ?? '0')).toPlainString();
          const adRem = r() < 0.5 ? valor(50, 4) : null;
          it.aliquotasNominais = { ...(it.aliquotasNominais ?? {}), impostoSeletivo: { adValorem: r() < 0.8 || adRem == null ? valor(30, 4) : null, adRem } };
        }
      }
      itens.push(it);
    }
    const op = { id: 'x', versao: '1', dhFatoGerador: `${data}T10:00:00-03:00`, municipio, uf, itens };
    if (tpEnteGov != null) op.gCompraGov = { tpEnteGov, tpOperGov: 1 };
    reqs.push(op);
  }
  return reqs;
}

/**
 * Sends each operation to the oracle (observabilidade endpoint, one result per item) and compares
 * every item: tribCalc JSON text, the engine error (code + detail), or the orchestration's rejection
 * before the engine (code + detail). `corpoDe(op)` gives the request body text.
 */
async function compararComOraculo(operacoes, corpoDe) {
  const res = { itens: 0, calculados: 0, errosMotor: 0, foraDoMotor: 0, naoModelados: 0 };
  const divergencias = [];
  for (const op of operacoes) {
    const resp = await fetch(`${ORACULO}/api/calculadora/observabilidade/regime-geral`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: corpoDe(op) });
    const json = await resp.json();
    if (!Array.isArray(json.objetos)) { divergencias.push({ op: op.id, java: `oráculo ${resp.status}: ${JSON.stringify(json).slice(0, 300)}` }); continue; }
    for (const obj of json.objetos) {
      res.itens++;
      const it = op.itens.find((x) => Number(x.numero) === obj.nObj);
      const { modelo, erro: rejeicao } = it ? montarOuRejeitar(op, it) : {};
      if (!modelo) {
        if (!rejeicao) { res.naoModelados++; continue; }
        // rejected by the orchestration before the engine: same code and detail as the oracle
        res.foraDoMotor++;
        const e0 = obj.erros?.[0];
        const b = `${problemTypePorClasse(rejeicao.classeJava).code ?? 'CAL-999'} ${rejeicao.mensagem}`;
        if (obj.tribCalc || `${e0?.code} ${e0?.detail}` !== b || obj.erros.length !== 1) divergencias.push({ data: op.dhFatoGerador, item: it, java: JSON.stringify(obj.erros ?? obj.tribCalc), porte: b });
        continue;
      }
      const { valor: meu, erro } = tentar(() => motor.serializarTributos(motor.calcular(modelo)));
      if (obj.tribCalc) {
        res.calculados++;
        const a = JSON.stringify(obj.tribCalc);
        const b = erro ? `ERRO ${erro.classeJava}: ${erro.message}` : JSON.stringify(meu);
        if (a !== b) divergencias.push({ data: op.dhFatoGerador, tpEnteGov: op.gCompraGov?.tpEnteGov, item: it, java: a, porte: b });
        continue;
      }
      const e0 = obj.erros?.[0];
      res.errosMotor++;
      const a = `${e0?.code} ${e0?.detail}`;
      const b = erro ? `${problemTypePorClasse(erro.classeJava).code ?? 'CAL-999'} ${erro.mensagem ?? erro.mensagemJava ?? erro.message}` : `tribCalc ${JSON.stringify(meu)}`;
      if (a !== b || obj.erros.length !== 1) divergencias.push({ data: op.dhFatoGerador, item: it, java: JSON.stringify(obj.erros), porte: b });
    }
  }
  return { res, divergencias };
}
const oraculoVivo = () => (ORACULO ? fetch(`${ORACULO}/api/versao/status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false) : Promise.resolve(false));

test('diferencial ao vivo: itens gerados × POST /api/calculadora/observabilidade/regime-geral (0 divergências)', { timeout: 600_000 }, async (t) => {
  if (!(await oraculoVivo())) { t.skip(SEM_ORACULO_MOTIVO); return; }
  const operacoes = [101, 202, 303].flatMap((seed) => gerarRequisicoes(seed, 10, 15));
  const { res, divergencias } = await compararComOraculo(operacoes, corpoJson);
  t.diagnostic(JSON.stringify({ ...res, divergencias: divergencias.length }));
  assert.deepEqual(divergencias.slice(0, 5), [], `${divergencias.length} divergência(s); ${JSON.stringify(res)}`);
  assert.ok(res.calculados >= 250 && res.errosMotor >= 20 && res.foraDoMotor >= 20 && res.naoModelados === 0, JSON.stringify(res));
});

test('diferencial ao vivo: 300 notas do lote de arredondamento × oráculo (0 divergências)', { timeout: 600_000 }, async (t) => {
  if (!(await oraculoVivo())) { t.skip(SEM_ORACULO_MOTIVO); return; }
  const notas = notasCorpus();
  const corpos = new Map(notas.map((n) => [n.indice, n.corpo]));
  const operacoes = notas.map((n) => Object.assign(lerNota(n.corpo), { indice: n.indice }));
  const { res, divergencias } = await compararComOraculo(operacoes, (op) => corpos.get(op.indice));
  t.diagnostic(JSON.stringify({ ...res, divergencias: divergencias.length }));
  assert.deepEqual(divergencias.slice(0, 5), [], `${divergencias.length} divergência(s); ${JSON.stringify(res)}`);
  assert.ok(res.calculados >= 1000, JSON.stringify(res));
});
