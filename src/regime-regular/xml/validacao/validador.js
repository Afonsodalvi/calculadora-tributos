// XMLSchemaValidator of the JDK Xerces reduced to what the official XSDs need, as an event handler
// of LeitorXml: content-model transitions at each start tag (cvc-complex-type.2.4.a/d/e/f/g/h),
// declarations (global root lookup → cvc-elt.1.a, lax/skip wildcards, lax assessment with
// anyType), attributes in document order (cvc-type.3.1.1, cvc-complex-type.3.2.2, value errors,
// fixed values) then the missing required ones (cvc-complex-type.4), identity constraints
// (xs:unique → DuplicateUnique), and at each end tag the content checks (cvc-complex-type.2.1/
// 2.2/2.3/2.4.b/i/j, constant-space bounds, cvc-type.3.1.2, simple values with the facet errors).
// The DraconianErrorHandler stops at the first error: every check throws ErroXml at the position
// the scanner is at when Xerces reports it.
import { ErroXml, mensagemEsquema } from './mensagens.js';
import { ErroTipo, normalizarEspacos } from './tipos-simples.js';
import { ehNCName } from './leitor-xml.js';
import { ANY_TYPE, ILIMITADO } from './esquema.js';
import { modeloDoTipo, PRIMEIRO_ERRO } from './modelo-conteudo.js';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
const ehEspacoXml = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

/** "{"uri":local}" (or the local name without namespace) used by cvc-complex-type.2.4.a. */
const nomeExpandido = (qn) => (qn.uri != null ? `{"${qn.uri}":${qn.local}}` : qn.local);
const esperados = (lista) => `{${lista.map(String).join(', ')}}`;

export class Validador {
  constructor(esquema) {
    this.esquema = esquema;
    this.leitor = null;
    this.pilha = [];
    this.atual = null;
    this.pularProfundidade = -1;
    this.profundidade = -1;
    this.contexto = { ids: new Set() };
    this.casadores = []; // active selectors: { restricao, profundidadeInicial, valores: Set }
  }

  erro(chave, args) {
    const { linha, coluna } = this.leitor.local();
    return new ErroXml(linha, coluna, mensagemEsquema(chave, args));
  }

  erroTipo(e) {
    if (e instanceof ErroTipo) return this.erro(e.chave, e.args);
    throw e;
  }

  inicioDocumento() {}
  fimDocumento() {}

  elementoVazio(qn, atributos) {
    this.inicioElemento(qn, atributos);
    this.fimElemento(qn);
  }

  caracteres(texto) {
    if (this.pularProfundidade >= 0 || !this.atual) return;
    const a = this.atual;
    if (texto.length > 0) a.viuTexto = true;
    if (a.acumular) a.texto += texto;
    if (a.tipo.categoria === 'complexo' && a.tipo.conteudo === 'elemento') {
      for (const c of texto) if (!ehEspacoXml(c)) { a.viuCaracteres = true; break; }
    }
  }

  // ─── Start tag (handleStartElement) ──────────────────────────────────────────────────────
  inicioElemento(qn, atributos) {
    if (this.pularProfundidade >= 0) { this.profundidade++; return; }
    const pai = this.atual;
    let decl = null;
    let curinga = null;
    if (pai && pai.modelo) {
      const termo = pai.modelo.transicao(qn, pai.estado);
      if (pai.estado[0] === PRIMEIRO_ERRO) this.erroConteudo(qn, pai);
      if (termo) { if (termo.permite) curinga = termo; else decl = termo; }
    }
    if (pai) pai.subElemento = true;
    this.profundidade++;
    if (curinga && curinga.processo === 'skip') {
      this.pularProfundidade = this.profundidade;
      return;
    }
    if (decl == null) decl = this.esquema.elementoGlobal(qn.uri ?? null, qn.local);
    let tipo = decl ? decl.tipo : null;
    const xsiType = valorAtributo(atributos, XSI, 'type');
    if (tipo == null && xsiType == null) {
      if (this.profundidade === 0) throw this.erro('cvc-elt.1.a', [qn.bruto]);
      if (curinga && curinga.processo === 'strict') throw this.erro('cvc-complex-type.2.4.c', [qn.bruto]);
      tipo = ANY_TYPE;
    }
    if (xsiType != null) tipo = this.tipoXsi(qn, xsiType, decl, tipo);
    const elemento = {
      qn, decl, tipo, nil: false,
      modelo: tipo.categoria === 'complexo' ? modeloDoTipo(tipo) : null,
      estado: null, texto: '', viuTexto: false, viuCaracteres: false, subElemento: false,
      acumular: tipo.categoria === 'simples' || tipo.conteudo === 'simples',
      profundidade: this.profundidade, restricoes: [],
    };
    if (elemento.modelo) elemento.estado = elemento.modelo.iniciar();
    if (pai) this.pilha.push(pai);
    this.atual = elemento;
    const xsiNil = valorAtributo(atributos, XSI, 'nil');
    if (xsiNil != null && decl) elemento.nil = this.xsiNil(qn, decl, xsiNil);
    this.processarAtributos(elemento, atributos);
    // identity constraints: matchers see the element, then its own selectors start
    for (const s of this.casadores) this.selecionar(s, elemento, atributos);
    if (decl) {
      for (const r of decl.restricoes) {
        const s = { restricao: r, profundidadeInicial: this.profundidade, valores: new Map() };
        this.casadores.push(s);
        elemento.restricoes.push(s);
      }
    }
  }

  /** The content-model transition failed: the message Xerces chooses. */
  erroConteudo(qn, pai) {
    const m = pai.modelo;
    const proximos = pai.tipo.particula ? m.oQuePodeVir(pai.estado) : [];
    const info = m.infoOcorrencia(pai.estado);
    if (proximos.length > 0) {
      const lista = esperados(proximos);
      if (info) {
        const [min, max, n, termo] = info;
        if (n < min) {
          const falta = min - n;
          if (falta > 1) throw this.erro('cvc-complex-type.2.4.h', [qn.bruto, m.nomeTermo(termo), String(min), String(falta)]);
          throw this.erro('cvc-complex-type.2.4.g', [qn.bruto, m.nomeTermo(termo), String(min)]);
        }
        if (n >= max && max !== ILIMITADO) throw this.erro('cvc-complex-type.2.4.e', [qn.bruto, lista, String(max)]);
      }
      throw this.erro('cvc-complex-type.2.4.a', [nomeExpandido(qn), lista]);
    }
    if (info) {
      const [, max, n, termo] = info;
      if (n >= max && max !== ILIMITADO) throw this.erro('cvc-complex-type.2.4.f', [m.nomeTermo(termo), String(max)]);
    }
    throw this.erro('cvc-complex-type.2.4.d', [qn.bruto]);
  }

  /** getAndCheckXsiType: QName value (QNameDV), type lookup, derivation from the declared type. */
  tipoXsi(qn, valor, decl, tipoDeclarado) {
    const v = valor.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
    const dp = v.indexOf(':');
    const prefixo = dp > 0 ? v.slice(0, dp) : '';
    const local = dp > 0 ? v.slice(dp + 1) : v;
    if ((prefixo && !ehNCName(prefixo)) || !ehNCName(local)) throw this.erro('cvc-datatype-valid.1.2.1', [v, 'QName']);
    const uri = this.leitor.resolverPrefixo(prefixo);
    if (prefixo && uri == null) throw this.erro('UndeclaredPrefix', [v, prefixo]);
    const t = this.esquema.tipoGlobal(uri ?? null, local);
    if (!t) throw this.erro('cvc-elt.4.2', [qn.bruto, valor]);
    if (tipoDeclarado && !derivaDe(t, tipoDeclarado)) throw this.erro('cvc-elt.4.3', [qn.bruto, valor, String(tipoDeclarado)]);
    return t;
  }

  xsiNil(qn, decl, valor) {
    if (!decl.nillable) throw this.erro('cvc-elt.3.1', [qn.bruto, `${XSI},nil`]);
    const v = normalizarEspacos(valor, 'collapse');
    if (v !== 'true' && v !== 'false' && v !== '1' && v !== '0') {
      throw this.erro('cvc-datatype-valid.1.2.1', [v, 'boolean']);
    }
    return v === 'true' || v === '1';
  }

  /** processAttributes + addDefaultAttributes. */
  processarAtributos(el, atributos) {
    const tipo = el.tipo;
    const simples = tipo.categoria === 'simples';
    const usos = simples ? [] : tipo.usos;
    const curinga = simples ? null : tipo.curingaAtributo;
    for (const a of atributos) {
      if (a.uri === XSI && ['type', 'nil', 'schemaLocation', 'noNamespaceSchemaLocation'].includes(a.local)) continue;
      if (a.uri === XMLNS_URI) continue;
      if (simples) throw this.erro('cvc-type.3.1.1', [el.qn.bruto, a.bruto]);
      const uso = usos.find((u) => u.decl.nome === a.local && (u.decl.ns ?? null) === (a.uri ?? null));
      if (!uso) {
        if (!curinga || !curinga.permite(a.uri ?? null)) throw this.erro('cvc-complex-type.3.2.2', [el.qn.bruto, a.bruto]);
        if (curinga.processo === 'skip') continue;
        const global = this.esquema.atributoGlobal(a.uri ?? null, a.local);
        if (!global) {
          if (curinga.processo === 'strict') throw this.erro('cvc-complex-type.3.2.2', [el.qn.bruto, a.bruto]);
          continue;
        }
        this.validarAtributo(el, a, global, null);
        continue;
      }
      this.validarAtributo(el, a, uso.decl, uso);
    }
    for (const u of usos) {
      if (!u.obrigatorio) continue;
      if (!atributos.some((a) => a.local === u.decl.nome && (a.uri ?? null) === (u.decl.ns ?? null))) {
        throw this.erro('cvc-complex-type.4', [el.qn.bruto, u.decl.nome]);
      }
    }
  }

  /** processOneAttribute: value, then fixed constraints of the declaration and of the use. */
  validarAtributo(el, a, decl, uso) {
    let r;
    try {
      r = decl.tipo.validar(a.valor, this.contexto);
    } catch (e) {
      throw this.erroTipo(e);
    }
    a.valorReal = r.valor;
    a.normalizado = r.normalizado;
    if (decl.fixo != null && normalizarEspacos(decl.fixo, decl.tipo.espacos) !== r.normalizado) {
      throw this.erro('cvc-attribute.4', [el.qn.bruto, a.bruto, a.valor, normalizarEspacos(decl.fixo, decl.tipo.espacos)]);
    }
    if (uso?.fixo != null && normalizarEspacos(uso.fixo, decl.tipo.espacos) !== r.normalizado) {
      throw this.erro('cvc-complex-type.3.1', [el.qn.bruto, a.bruto, a.valor, normalizarEspacos(uso.fixo, decl.tipo.espacos)]);
    }
  }

  /** Selector "./*"-like steps relative to the constrained element; fields "@attr". */
  selecionar(s, el, atributos) {
    const nivel = el.profundidade - s.profundidadeInicial;
    const casaPasso = (p, qn) => p.curinga || (p.local === qn.local && (p.ns ?? null) === (qn.uri ?? null));
    const selecionado = s.restricao.seletor.some((caminho) => caminho.length === nivel && caminho.every((p, i) => (i === caminho.length - 1 ? casaPasso(p, el.qn) : true)));
    if (!selecionado) return;
    const valores = [];
    for (const campo of s.restricao.campos) {
      const caminho = campo[0];
      const passo = caminho?.[caminho.length - 1];
      if (!passo || !passo.atributo || caminho.length !== 1) return;
      const a = atributos.find((x) => x.local === passo.local && (x.uri ?? null) === (passo.ns ?? null));
      if (!a) return;
      valores.push(a.valorReal !== undefined ? a.valorReal : a.valor);
    }
    const chave = valores.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('\u0000');
    if (s.valores.has(chave)) {
      const codigo = s.restricao.categoria === 'key' ? 'DuplicateKey' : 'DuplicateUnique';
      throw this.erro(codigo, [valores.map((v) => (typeof v === 'object' ? v.texto ?? String(v) : String(v))).join(','), s.restricao.elemento, s.restricao.nome]);
    }
    s.valores.set(chave, true);
  }

  // ─── End tag (handleEndElement) ───────────────────────────────────────────────────────────
  fimElemento() {
    if (this.pularProfundidade >= 0) {
      if (this.pularProfundidade === this.profundidade) this.pularProfundidade = -1;
      this.profundidade--;
      return;
    }
    const el = this.atual;
    this.conteudoElemento(el);
    for (const s of el.restricoes) this.casadores.splice(this.casadores.indexOf(s), 1);
    this.profundidade--;
    this.atual = this.pilha.pop() ?? null;
  }

  /** processElementContent → elementLocallyValidType / elementLocallyValidComplexType. */
  conteudoElemento(el) {
    const { qn, decl, tipo } = el;
    if (el.nil) {
      if (el.subElemento || el.viuTexto) throw this.erro('cvc-elt.3.2.1', [qn.bruto, `${XSI},nil`]);
      return;
    }
    let texto = el.texto;
    const valorPadrao = decl && (decl.fixo ?? decl.padrao);
    if (valorPadrao != null && !el.subElemento && !el.viuTexto) texto = valorPadrao;
    if (tipo.categoria === 'simples') {
      if (el.subElemento) throw this.erro('cvc-type.3.1.2', [qn.bruto]);
      let r;
      try { r = tipo.validar(texto, this.contexto); } catch (e) { throw this.erroTipo(e); }
      this.verificarFixo(el, r.normalizado);
      return;
    }
    if (tipo.conteudo === 'vazio') {
      if (el.subElemento || el.viuTexto) throw this.erro('cvc-complex-type.2.1', [qn.bruto]);
    } else if (tipo.conteudo === 'simples') {
      if (el.subElemento) throw this.erro('cvc-complex-type.2.2', [qn.bruto]);
      let r;
      try { r = tipo.tipoSimples.validar(texto, this.contexto); } catch (e) { throw this.erroTipo(e); }
      this.verificarFixo(el, r.normalizado);
    } else if (tipo.conteudo === 'elemento') {
      if (el.viuCaracteres) throw this.erro('cvc-complex-type.2.3', [qn.bruto]);
    }
    if ((tipo.conteudo === 'elemento' || tipo.conteudo === 'misto') && el.modelo) {
      const m = el.modelo;
      if (el.estado[0] >= 0 && !m.fim(el.estado)) {
        const lista = esperados(m.oQuePodeVir(el.estado));
        const info = m.infoOcorrencia(el.estado);
        if (info) {
          const [min, , n, termo] = info;
          if (n < min) {
            const falta = min - n;
            if (falta > 1) throw this.erro('cvc-complex-type.2.4.j', [qn.bruto, m.nomeTermo(termo), String(min), String(falta)]);
            throw this.erro('cvc-complex-type.2.4.i', [qn.bruto, m.nomeTermo(termo), String(min)]);
          }
        }
        throw this.erro('cvc-complex-type.2.4.b', [qn.bruto, lista]);
      }
      const limites = m.verificarLimites();
      if (limites.length) throw this.erro(limites[0][0], [qn.bruto, limites[0][1]]);
    }
  }

  /** cvc-elt.5.2.2.2.x: the value must match the fixed value constraint. */
  verificarFixo(el, normalizado) {
    const fixo = el.decl?.fixo;
    if (fixo == null) return;
    if (normalizado !== fixo) {
      const chave = el.tipo.categoria === 'complexo' && el.tipo.conteudo === 'misto' ? 'cvc-elt.5.2.2.2.1' : 'cvc-elt.5.2.2.2.2';
      throw this.erro(chave, [el.qn.bruto, normalizado, fixo]);
    }
  }
}

function valorAtributo(atributos, uri, local) {
  return atributos.find((a) => a.uri === uri && a.local === local)?.valor ?? null;
}

/** XSConstraints.checkTypeDerivationOk without block/final (none in these schemas). */
function derivaDe(t, base) {
  if (base === ANY_TYPE) return true;
  if (t.categoria !== base.categoria && !(t.categoria === 'simples' && base.nome === 'anySimpleType')) return false;
  for (let x = t; x; x = x.base) if (x === base) return true;
  return false;
}
