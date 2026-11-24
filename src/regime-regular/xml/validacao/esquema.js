// XmlUtil.getSchema(tipo, subtipo): compiles xsd/<mnemonico>/<grupo|nota>.xsd and its
// include/import closure (only files inside the document type's folder — the official
// ClasspathResourceResolver confines references to that root; nothing is ever read from the
// network) into the component model of the Xerces XSD traversers: global/local element
// declarations, complex types (content type, particle, attribute uses, wildcards), simple types
// (restriction chains with facets) and identity constraints. Anonymous types are named like
// XSDHandler.genAnonTypeName ("#AnonType_" + names of the ancestors).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, sep, isAbsolute } from 'node:path';
import { LeitorXml } from './leitor-xml.js';
import { TIPOS_EMBUTIDOS, XSD_NS, restringir } from './tipos-simples.js';

const RAIZ_XSD = fileURLToPath(new URL('../xsd/', import.meta.url));
const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
export const ILIMITADO = -1;

// ─── Minimal DOM of the XSD documents ──────────────────────────────────────────────────────────
function lerDom(texto) {
  const raiz = { filhos: [] };
  const pilha = [raiz];
  const nsPilha = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])];
  const abrir = (qn, atributos) => {
    const ns = new Map(nsPilha[nsPilha.length - 1]);
    const attrs = new Map();
    for (const a of atributos) {
      if (a.uri === XMLNS_URI) ns.set(a.local === 'xmlns' && (a.prefixo === 'xmlns' && a.bruto === 'xmlns') ? '' : a.local, a.valor);
      else if (a.uri == null) attrs.set(a.local, a.valor);
    }
    const no = { ns: qn.uri, local: qn.local, atributos: attrs, filhos: [], pai: pilha[pilha.length - 1], nsMap: ns };
    pilha[pilha.length - 1].filhos.push(no);
    pilha.push(no);
    nsPilha.push(ns);
  };
  const fechar = () => { pilha.pop(); nsPilha.pop(); };
  new LeitorXml(texto.replace(/^﻿/, ''), {
    inicioElemento: abrir,
    elementoVazio: (qn, a) => { abrir(qn, a); fechar(); },
    fimElemento: fechar,
    caracteres: () => {},
  }).analisar();
  return raiz.filhos[0];
}

const filhosXs = (no) => no.filhos.filter((f) => f.ns === XSD_NS && f.local !== 'annotation');
const attr = (no, nome) => no.atributos.get(nome) ?? null;

/** "#AnonType_" + the name attributes of the ancestors up to (excluding) the schema element. */
function nomeAnonimo(no) {
  let s = '#AnonType_';
  for (let p = no.pai; p && p.pai && p.local !== 'schema'; p = p.pai) s += p.atributos.get('name') ?? '';
  return s;
}

// ─── Components ────────────────────────────────────────────────────────────────────────────────
/** XSElementDecl: toString = "uri":name (or name without namespace). */
export class DeclElemento {
  constructor(nome, ns) {
    this.nome = nome;
    this.ns = ns;
    this.tipo = null;
    this.nillable = false;
    this.restricoes = [];
    this.fixo = null;
    this.padrao = null;
  }
  toString() { return this.ns != null ? `"${this.ns}":${this.nome}` : this.nome; }
}

/** XSWildcardDecl. */
export class Curinga {
  constructor(restricao, lista, processo) { this.restricao = restricao; this.lista = lista; this.processo = processo; }
  permite(uri) {
    if (this.restricao === 'any') return true;
    if (this.restricao === 'not') return uri != null && !this.lista.includes(uri);
    return this.lista.includes(uri ?? null);
  }
  toString() {
    if (this.restricao === 'any') return 'WC[##any]';
    if (this.restricao === 'not') return `WC[##other:"${this.lista[0] ?? ''}"]`;
    return `WC[${this.lista.map((n) => `"${n ?? ''}"`).join(',')}]`;
  }
}

/** XSComplexTypeDecl. conteudo: 'vazio' | 'simples' | 'elemento' | 'misto'. */
export class TipoComplexo {
  constructor(nome, ns) {
    this.categoria = 'complexo';
    this.nome = nome;
    this.ns = ns;
    this.conteudo = 'vazio';
    this.particula = null;
    this.usos = [];
    this.curingaAtributo = null;
    this.tipoSimples = null;
    this.base = null;
    this.modelo = undefined;
  }
  toString() { return this.nome; }
}

/** anyType (SchemaGrammar.fAnyType): mixed, sequence of a lax ##any wildcard, lax attribute wildcard. */
export const ANY_TYPE = (() => {
  const t = new TipoComplexo('anyType', XSD_NS);
  t.conteudo = 'misto';
  t.particula = { min: 1, max: 1, termo: { compositor: 'sequence', particulas: [{ min: 0, max: ILIMITADO, termo: new Curinga('any', [], 'lax') }] } };
  t.curingaAtributo = new Curinga('any', [], 'lax');
  return t;
})();

const ocorrencia = (v, padrao) => (v == null ? padrao : v === 'unbounded' ? ILIMITADO : Number(v));

// ─── Schema compilation ────────────────────────────────────────────────────────────────────────
class Compilador {
  constructor(raizTipo) {
    this.raizTipo = raizTipo;
    this.documentos = new Map(); // path → { dom, tns }
    this.globais = { elemento: new Map(), tipo: new Map(), atributo: new Map(), grupo: new Map(), grupoAtributos: new Map() };
    this.construidos = new Map();
  }

  /** ClasspathResourceResolver: relative references resolved under the type's folder only. */
  caminho(base, local) {
    const p = normalize(join(dirname(base), local));
    const rel = relative(this.raizTipo, p);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Referencia de schema fora do escopo permitido: ${local}`);
    return p;
  }

  carregar(arquivo, tnsHerdado) {
    const chave = `${arquivo}|${tnsHerdado ?? ''}`;
    if (this.documentos.has(chave)) return;
    const dom = lerDom(readFileSync(arquivo, 'utf8'));
    const tnsProprio = attr(dom, 'targetNamespace');
    const doc = {
      dom,
      tns: tnsProprio ?? tnsHerdado ?? null,
      formElemento: attr(dom, 'elementFormDefault') ?? 'unqualified',
      formAtributo: attr(dom, 'attributeFormDefault') ?? 'unqualified',
    };
    this.documentos.set(chave, doc);
    // chameleon include: unqualified QNames of a schema without targetNamespace take the includer's
    if (tnsProprio == null && doc.tns != null) {
      const marcar = (no) => { if (!no.nsMap.has('')) no.nsMap.set('', doc.tns); no.filhos.forEach(marcar); };
      marcar(dom);
    }
    for (const f of filhosXs(dom)) {
      if (f.local === 'include' || f.local === 'redefine') this.carregar(this.caminho(arquivo, attr(f, 'schemaLocation')), doc.tns);
      else if (f.local === 'import' && attr(f, 'schemaLocation')) this.carregar(this.caminho(arquivo, attr(f, 'schemaLocation')), null);
    }
    for (const f of filhosXs(dom)) {
      const nome = attr(f, 'name');
      const mapa = { element: 'elemento', complexType: 'tipo', simpleType: 'tipo', attribute: 'atributo', group: 'grupo', attributeGroup: 'grupoAtributos' }[f.local];
      if (!mapa || nome == null) continue;
      const k = chaveQ(doc.tns, nome);
      if (!this.globais[mapa].has(k)) this.globais[mapa].set(k, { no: f, doc });
    }
  }

  /** QName attribute value → { ns, local } in the scope of `no`. */
  resolverQName(no, valor) {
    const i = valor.indexOf(':');
    const prefixo = i < 0 ? '' : valor.slice(0, i);
    const local = i < 0 ? valor : valor.slice(i + 1);
    const ns = no.nsMap.get(prefixo) ?? (prefixo === '' ? null : undefined);
    if (ns === undefined) throw new Error(`prefixo não declarado: ${valor}`);
    return { ns: ns === '' ? null : ns, local };
  }

  global(espaco, ns, local, construir) {
    const k = `${espaco}|${chaveQ(ns, local)}`;
    if (this.construidos.has(k)) return this.construidos.get(k);
    const def = this.globais[espaco].get(chaveQ(ns, local));
    if (!def) return null;
    return construir(def, k);
  }

  tipoPorNome(no, valor) {
    const { ns, local } = this.resolverQName(no, valor);
    if (ns === XSD_NS) {
      if (local === 'anyType') return ANY_TYPE;
      const t = TIPOS_EMBUTIDOS.get(local);
      if (!t) throw new Error(`tipo embutido não suportado: ${local}`);
      return t;
    }
    const t = this.global('tipo', ns, local, (def, k) => (def.no.local === 'complexType' ? this.tipoComplexo(def.no, def.doc, k) : this.tipoSimples(def.no, def.doc, k)));
    if (!t) throw new Error(`tipo não encontrado: ${valor}`);
    return t;
  }

  tipoSimples(no, doc, chave) {
    const anonimo = attr(no, 'name') == null;
    const nome = anonimo ? nomeAnonimo(no) : attr(no, 'name');
    const filho = filhosXs(no)[0];
    if (filho.local !== 'restriction') throw new Error(`simpleType ${filho.local} não suportado`);
    let base;
    const filhos = filhosXs(filho);
    if (attr(filho, 'base')) base = this.tipoPorNome(filho, attr(filho, 'base'));
    else base = this.tipoSimples(filhos.find((f) => f.local === 'simpleType'), doc);
    const facetas = filhos.filter((f) => f.local !== 'simpleType').map((f) => ({ tipo: f.local, valor: attr(f, 'value') }));
    const t = restringir(base, { nome, ns: doc.tns, anonimo, facetas });
    if (chave) this.construidos.set(chave, t);
    return t;
  }

  tipoComplexo(no, doc, chave) {
    const anonimo = attr(no, 'name') == null;
    const t = new TipoComplexo(anonimo ? nomeAnonimo(no) : attr(no, 'name'), doc.tns);
    if (chave) this.construidos.set(chave, t);
    const misto = attr(no, 'mixed') === 'true';
    const filhos = filhosXs(no);
    const conteudo = filhos[0];
    if (conteudo?.local === 'simpleContent') {
      const ext = filhosXs(conteudo)[0];
      const base = this.tipoPorNome(ext, attr(ext, 'base'));
      t.base = base;
      t.conteudo = 'simples';
      if (base.categoria === 'simples') t.tipoSimples = base;
      else { t.tipoSimples = base.tipoSimples; t.usos.push(...base.usos); t.curingaAtributo = base.curingaAtributo; }
      if (ext.local === 'restriction') throw new Error('simpleContent/restriction não suportado');
      this.atributos(filhosXs(ext), doc, t);
      return t;
    }
    if (conteudo?.local === 'complexContent') {
      const ext = filhosXs(conteudo)[0];
      if (ext.local !== 'extension') throw new Error('complexContent/restriction não suportado');
      const base = this.tipoPorNome(ext, attr(ext, 'base'));
      t.base = base;
      const mistoCc = attr(conteudo, 'mixed') != null ? attr(conteudo, 'mixed') === 'true' : misto;
      const propria = this.conteudoComplexo(filhosXs(ext), doc, t, mistoCc);
      t.usos.unshift(...base.usos);
      if (!t.curingaAtributo) t.curingaAtributo = base.curingaAtributo;
      if (base.conteudo === 'vazio' || base.conteudo === 'simples' || !base.particula) {
        t.particula = propria.particula;
        t.conteudo = propria.conteudo;
      } else if (!propria.particula) {
        t.particula = base.particula;
        t.conteudo = base.conteudo;
      } else {
        t.particula = { min: 1, max: 1, termo: { compositor: 'sequence', particulas: [base.particula, propria.particula] } };
        t.conteudo = propria.conteudo;
      }
      return t;
    }
    const r = this.conteudoComplexo(filhos, doc, t, misto);
    t.particula = r.particula;
    t.conteudo = r.conteudo;
    return t;
  }

  /** processComplexContent: particle (group/sequence/choice/all) + attributes; content type. */
  conteudoComplexo(filhos, doc, t, misto) {
    let particula = null;
    let resto = filhos;
    const primeiro = filhos[0];
    if (primeiro && ['sequence', 'choice', 'all', 'group'].includes(primeiro.local)) {
      particula = this.particulaGrupo(primeiro, doc);
      resto = filhos.slice(1);
      if (particula && particula.termo.particulas?.length === 0 && filhosXs(primeiro).length === 0
        && (primeiro.local === 'sequence' || (primeiro.local === 'choice' && particula.min === 0))) particula = null;
    }
    if (!particula && misto) particula = { min: 1, max: 1, termo: { compositor: 'sequence', particulas: [] } };
    this.atributos(resto, doc, t);
    return { particula, conteudo: particula == null ? 'vazio' : misto ? 'misto' : 'elemento' };
  }

  particulaGrupo(no, doc) {
    const min = ocorrencia(attr(no, 'minOccurs'), 1);
    const max = ocorrencia(attr(no, 'maxOccurs'), 1);
    if (max === 0) return null;
    if (no.local === 'group') {
      const { ns, local } = this.resolverQName(no, attr(no, 'ref'));
      const def = this.globais.grupo.get(chaveQ(ns, local));
      const g = this.particulaGrupo(filhosXs(def.no)[0], def.doc);
      return { min, max, termo: g.termo };
    }
    const particulas = [];
    for (const f of filhosXs(no)) {
      let p = null;
      if (f.local === 'element') p = this.particulaElemento(f, doc);
      else if (f.local === 'any') p = this.particulaCuringa(f, doc);
      else if (['sequence', 'choice', 'all', 'group'].includes(f.local)) p = this.particulaGrupo(f, doc);
      if (p) particulas.push(p);
    }
    return { min, max, termo: { compositor: no.local, particulas } };
  }

  particulaCuringa(no, doc) {
    const min = ocorrencia(attr(no, 'minOccurs'), 1);
    const max = ocorrencia(attr(no, 'maxOccurs'), 1);
    if (max === 0) return null;
    return { min, max, termo: this.curinga(no, doc) };
  }

  curinga(no, doc) {
    const ns = (attr(no, 'namespace') ?? '##any').trim();
    const processo = attr(no, 'processContents') ?? 'strict';
    if (ns === '##any') return new Curinga('any', [], processo);
    if (ns === '##other') return new Curinga('not', [doc.tns, null], processo);
    const lista = ns.split(/\s+/).filter(Boolean).map((x) => (x === '##targetNamespace' ? doc.tns : x === '##local' ? null : x));
    return new Curinga('lista', lista, processo);
  }

  particulaElemento(no, doc) {
    const min = ocorrencia(attr(no, 'minOccurs'), 1);
    const max = ocorrencia(attr(no, 'maxOccurs'), 1);
    if (max === 0) return null;
    let decl;
    if (attr(no, 'ref')) {
      const { ns, local } = this.resolverQName(no, attr(no, 'ref'));
      decl = this.elementoGlobal(ns, local);
      if (!decl) throw new Error(`elemento não encontrado: ${attr(no, 'ref')}`);
    } else {
      const form = attr(no, 'form') ?? doc.formElemento;
      decl = this.declaracaoElemento(no, doc, form === 'qualified' ? doc.tns : null);
    }
    return { min, max, termo: decl };
  }

  elementoGlobal(ns, local) {
    return this.global('elemento', ns, local, (def, k) => this.declaracaoElemento(def.no, def.doc, def.doc.tns, k));
  }

  declaracaoElemento(no, doc, ns, chave) {
    const d = new DeclElemento(attr(no, 'name'), ns);
    if (chave) this.construidos.set(chave, d);
    d.nillable = attr(no, 'nillable') === 'true';
    d.fixo = attr(no, 'fixed');
    d.padrao = attr(no, 'default');
    const filhos = filhosXs(no);
    if (attr(no, 'type')) d.tipo = this.tipoPorNome(no, attr(no, 'type'));
    else {
      const anon = filhos.find((f) => f.local === 'complexType' || f.local === 'simpleType');
      if (anon) d.tipo = anon.local === 'complexType' ? this.tipoComplexo(anon, doc) : this.tipoSimples(anon, doc);
      else if (attr(no, 'substitutionGroup')) {
        const { ns: sns, local } = this.resolverQName(no, attr(no, 'substitutionGroup'));
        d.tipo = this.elementoGlobal(sns, local).tipo;
      } else d.tipo = ANY_TYPE;
    }
    for (const f of filhos) {
      if (f.local !== 'unique' && f.local !== 'key' && f.local !== 'keyref') continue;
      const seletor = filhosXs(f).find((x) => x.local === 'selector');
      const campos = filhosXs(f).filter((x) => x.local === 'field');
      d.restricoes.push({
        categoria: f.local,
        nome: attr(f, 'name'),
        elemento: d.nome,
        seletor: compilarXPath(attr(seletor, 'xpath'), seletor),
        campos: campos.map((c) => compilarXPath(attr(c, 'xpath'), c)),
      });
    }
    return d;
  }

  atributos(nos, doc, t) {
    for (const no of nos) {
      if (no.local === 'attribute') {
        let decl;
        if (attr(no, 'ref')) {
          const { ns, local } = this.resolverQName(no, attr(no, 'ref'));
          decl = this.global('atributo', ns, local, (def) => this.declaracaoAtributo(def.no, def.doc, def.doc.tns));
        } else {
          const form = attr(no, 'form') ?? doc.formAtributo;
          decl = this.declaracaoAtributo(no, doc, form === 'qualified' ? doc.tns : null);
        }
        const uso = attr(no, 'use') ?? 'optional';
        if (uso === 'prohibited') { t.usos = t.usos.filter((u) => !(u.decl.nome === decl.nome && u.decl.ns === decl.ns)); continue; }
        const existente = t.usos.findIndex((u) => u.decl.nome === decl.nome && u.decl.ns === decl.ns);
        const u = { decl, obrigatorio: uso === 'required', fixo: attr(no, 'ref') ? null : attr(no, 'fixed'), padrao: attr(no, 'ref') ? null : attr(no, 'default') };
        if (existente >= 0) t.usos[existente] = u; else t.usos.push(u);
      } else if (no.local === 'attributeGroup') {
        const { ns, local } = this.resolverQName(no, attr(no, 'ref'));
        const def = this.globais.grupoAtributos.get(chaveQ(ns, local));
        this.atributos(filhosXs(def.no), def.doc, t);
      } else if (no.local === 'anyAttribute') {
        t.curingaAtributo = this.curinga(no, doc);
      }
    }
  }

  declaracaoAtributo(no, doc, ns) {
    const anon = filhosXs(no).find((f) => f.local === 'simpleType');
    const tipo = attr(no, 'type') ? this.tipoPorNome(no, attr(no, 'type')) : anon ? this.tipoSimples(anon, doc) : TIPOS_EMBUTIDOS.get('anySimpleType');
    const global = no.pai?.local === 'schema';
    return { nome: attr(no, 'name'), ns, tipo, fixo: global ? attr(no, 'fixed') : null, padrao: global ? attr(no, 'default') : null };
  }
}

const chaveQ = (ns, local) => `{${ns ?? ''}}${local}`;

/**
 * Identity-constraint XPath subset (selector: steps of '.', '*', QNames, alternatives with '|';
 * field: '@name', '.', or child steps ending in '@name').
 */
function compilarXPath(expr, no) {
  return expr.split('|').map((caminho) => {
    const passos = caminho.trim().replace(/^\.\//, '').split('/').filter((p) => p && p !== '.');
    return passos.map((p) => {
      const atributo = p.startsWith('@');
      const nome = (atributo ? p.slice(1) : p).replace(/^child::|^attribute::/, '');
      if (nome === '*') return { atributo, curinga: true };
      const i = nome.indexOf(':');
      const ns = i < 0 ? null : no.nsMap.get(nome.slice(0, i));
      return { atributo, curinga: false, ns: ns ?? null, local: i < 0 ? nome : nome.slice(i + 1) };
    });
  });
}

/** Compiled schema: root lookup of global element declarations (any namespace of the closure). */
export class Esquema {
  constructor(compilador) { this.c = compilador; }
  elementoGlobal(ns, local) { return this.c.elementoGlobal(ns, local); }
  tipoGlobal(ns, local) {
    if (ns === XSD_NS) return local === 'anyType' ? ANY_TYPE : TIPOS_EMBUTIDOS.get(local) ?? null;
    return this.c.global('tipo', ns, local, (def, k) => (def.no.local === 'complexType' ? this.c.tipoComplexo(def.no, def.doc, k) : this.c.tipoSimples(def.no, def.doc, k)));
  }
  atributoGlobal(ns, local) { return this.c.global('atributo', ns, local, (def) => this.c.declaracaoAtributo(def.no, def.doc, def.doc.tns)); }
}

const cache = new Map();

/**
 * XmlUtil.getSchema: the schema of xsd/<mnemonico>/<arquivo> (cached like the @Cacheable).
 * Every global declaration is compiled eagerly so that a broken schema fails here, once.
 */
export function obterEsquema(mnemonico, arquivo) {
  const chave = `${mnemonico}/${arquivo}`;
  if (cache.has(chave)) return cache.get(chave);
  const raizTipo = join(RAIZ_XSD, mnemonico);
  if (raizTipo.split(sep).includes('..')) throw new Error('mnemônico inválido');
  const c = new Compilador(raizTipo);
  c.carregar(join(raizTipo, arquivo), null);
  const e = new Esquema(c);
  for (const [k, def] of c.globais.elemento) {
    const local = k.slice(k.indexOf('}') + 1);
    e.elementoGlobal(def.doc.tns, local);
  }
  cache.set(chave, e);
  return e;
}
