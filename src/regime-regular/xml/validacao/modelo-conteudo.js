// Content models of complex types as the JDK Xerces builds and runs them (impl.xs.models):
// CMBuilder (compact syntax tree with XSCMRepeatingLeaf when every nested group is 1..1, otherwise
// the expanded syntax tree with the "constant space" a{n,m} counters), XSDFACM (DFA over leaf
// positions, element map in particle order, counting states, whatCanGoHere, occurenceInfo,
// checkMinMaxBounds) and XSEmptyCM. The order of the expected-element lists in the messages and
// the choice between cvc-complex-type.2.4.a/b/d/e/f/g/h/i/j depend on these details.
import { ILIMITADO } from './esquema.js';

export const PRIMEIRO_ERRO = -1;
export const ERRO_SEGUINTE = -2;

// ─── Syntax tree (CMNode) ──────────────────────────────────────────────────────────────────────
class Folha {
  constructor(tipoParticula, termo, idParticula, posicao, min = null, max = null) {
    this.tipo = 'folha';
    this.tipoParticula = tipoParticula; // 'elemento' | 'curinga'
    this.termo = termo;
    this.idParticula = idParticula;
    this.posicao = posicao;
    this.repeticao = min != null ? { min, max } : null; // XSCMRepeatingLeaf
    this.limites = null; // user data of the constant space algorithm
  }
}
class Uni {
  constructor(op, filho) { this.tipo = 'uni'; this.op = op; this.filho = filho; } // '?', '*', '+'
  definirLimites(l) { this.limites = l; this.filho.definirLimites?.(l); if (this.filho.tipo === 'folha') this.filho.limites = l; }
}
class Bin {
  constructor(op, esq, dir) { this.tipo = 'bin'; this.op = op; this.esq = esq; this.dir = dir; } // 'sequence' | 'choice'
}

const tipoTermo = (termo) => (termo.compositor ? 'grupo' : termo.permite ? 'curinga' : 'elemento');

class Construtor {
  constructor() { this.folhas = 0; this.particulas = 0; }

  novaFolha(p, min, max) {
    return new Folha(tipoTermo(p.termo), p.termo, this.particulas++, this.folhas++, min, max);
  }

  /** CMBuilder.useRepeatingLeafNodes. */
  usarFolhasRepetidas(p) {
    if (tipoTermo(p.termo) !== 'grupo') return true;
    const g = p.termo;
    if (p.min !== 1 || p.max !== 1) {
      if (g.particulas.length === 1) {
        const p2 = g.particulas[0];
        return tipoTermo(p2.termo) !== 'grupo' && p2.min === 1 && p2.max === 1;
      }
      return g.particulas.length === 0;
    }
    return g.particulas.every((x) => this.usarFolhasRepetidas(x));
  }

  /** buildCompactSyntaxTree. */
  arvoreCompacta(p) {
    if (tipoTermo(p.termo) !== 'grupo') return this.arvoreCompacta2(p, p.min, p.max);
    const g = p.termo;
    if (g.particulas.length === 1 && (p.min !== 1 || p.max !== 1)) return this.arvoreCompacta2(g.particulas[0], p.min, p.max);
    let r = null;
    let n = 0;
    for (const filho of g.particulas) {
      const t = this.arvoreCompacta(filho);
      if (t) { n++; r = r ? new Bin(g.compositor, r, t) : t; }
    }
    if (r && g.compositor === 'choice' && n < g.particulas.length) r = new Uni('?', r);
    return r;
  }

  /** buildCompactSyntaxTree2. */
  arvoreCompacta2(p, min, max) {
    if (min === 1 && max === 1) return this.novaFolha(p);
    if (min === 0 && max === 1) return new Uni('?', this.novaFolha(p));
    if (min === 0 && max === ILIMITADO) return new Uni('*', this.novaFolha(p));
    if (min === 1 && max === ILIMITADO) return new Uni('+', this.novaFolha(p));
    const folha = this.novaFolha(p, min, max);
    return new Uni(min === 0 ? '*' : '+', folha);
  }

  /** buildSyntaxTree (expanded). */
  arvore(p, otimizar) {
    if (tipoTermo(p.termo) !== 'grupo') {
      const folha = this.novaFolha(p);
      return this.expandir(folha, p.min, p.max, otimizar);
    }
    const g = p.termo;
    let r = null;
    let n = 0;
    for (const filho of g.particulas) {
      const t = this.arvore(filho, otimizar && p.min === 1 && p.max === 1 && (g.compositor === 'sequence' || g.particulas.length === 1));
      if (t) { n++; r = r ? new Bin(g.compositor, r, t) : t; }
    }
    if (r) {
      if (g.compositor === 'choice' && n < g.particulas.length) r = new Uni('?', r);
      r = this.expandir(r, p.min, p.max, false);
    }
    return r;
  }

  /** expandContentModel. */
  expandir(no, min, max, otimizar) {
    if (min === 1 && max === 1) return no;
    if (min === 0 && max === 1) return new Uni('?', no);
    if (min === 0 && max === ILIMITADO) return new Uni('*', no);
    if (min === 1 && max === ILIMITADO) return new Uni('+', no);
    // (optimize && element) || wildcard — the operator precedence of the original
    if ((otimizar && no.tipo === 'folha' && no.tipoParticula === 'elemento') || (no.tipo === 'folha' && no.tipoParticula === 'curinga')) {
      const u = new Uni(min === 0 ? '*' : '+', no);
      u.definirLimites({ min, max });
      return u;
    }
    if (max === ILIMITADO) {
      // e{n,unbounded} => e{n-1} e+
      const r = this.multiplos(no, min - 1, true);
      return new Bin('sequence', r, new Uni('+', this.copiar(no)));
    }
    let r = null;
    if (min > 0) r = this.multiplos(no, min, false);
    if (max > min) {
      const opcional = new Uni('?', no);
      r = r == null ? this.multiplos(opcional, max - min, false) : new Bin('sequence', r, this.multiplos(opcional, max - min, true));
    }
    return r;
  }

  multiplos(no, num, copiarPrimeiro) {
    if (num === 0) return null;
    if (num === 1) return copiarPrimeiro ? this.copiar(no) : no;
    const n1 = Math.floor(num / 2);
    return new Bin('sequence', this.multiplos(no, n1, copiarPrimeiro), this.multiplos(no, num - n1, true));
  }

  copiar(no) {
    if (no.tipo === 'bin') return new Bin(no.op, this.copiar(no.esq), this.copiar(no.dir));
    if (no.tipo === 'uni') return new Uni(no.op, this.copiar(no.filho));
    const f = new Folha(no.tipoParticula, no.termo, no.idParticula, this.folhas++);
    return f;
  }
}

// ─── DFA (XSDFACM) ─────────────────────────────────────────────────────────────────────────────
class ConjuntoBits {
  constructor() { this.s = new Set(); }
  static de(it) { const c = new ConjuntoBits(); for (const x of it) c.s.add(x); return c; }
  chave() { return [...this.s].sort((a, b) => a - b).join(','); }
}

function anotar(no) {
  if (no.tipo === 'folha') {
    no.primeiros = no.posicao === -1 ? new Set() : new Set([no.posicao]);
    no.ultimos = no.primeiros;
    no.anulavel = no.posicao === -1;
    return;
  }
  if (no.tipo === 'uni') {
    anotar(no.filho);
    no.primeiros = no.filho.primeiros;
    no.ultimos = no.filho.ultimos;
    no.anulavel = no.op === '+' ? no.filho.anulavel : true;
    return;
  }
  anotar(no.esq);
  anotar(no.dir);
  if (no.op === 'choice') {
    no.primeiros = new Set([...no.esq.primeiros, ...no.dir.primeiros]);
    no.ultimos = new Set([...no.esq.ultimos, ...no.dir.ultimos]);
    no.anulavel = no.esq.anulavel || no.dir.anulavel;
  } else {
    no.primeiros = no.esq.anulavel ? new Set([...no.esq.primeiros, ...no.dir.primeiros]) : no.esq.primeiros;
    no.ultimos = no.dir.anulavel ? new Set([...no.esq.ultimos, ...no.dir.ultimos]) : no.dir.ultimos;
    no.anulavel = no.esq.anulavel && no.dir.anulavel;
  }
}

function seguintes(no, lista) {
  if (no.tipo === 'bin') {
    seguintes(no.esq, lista);
    seguintes(no.dir, lista);
    if (no.op === 'sequence') for (const i of no.esq.ultimos) for (const j of no.dir.primeiros) lista[i].add(j);
  } else if (no.tipo === 'uni') {
    seguintes(no.filho, lista);
    if (no.op === '*' || no.op === '+') for (const i of no.ultimos) for (const j of no.primeiros) lista[i].add(j);
  }
}

function coletarFolhas(no, lista) {
  if (no.tipo === 'folha') lista[no.posicao] = no;
  else if (no.tipo === 'uni') coletarFolhas(no.filho, lista);
  else { coletarFolhas(no.esq, lista); coletarFolhas(no.dir, lista); }
}

/** Element declaration matching (SubstitutionGroupHandler.getMatchingElemDecl without groups). */
const casa = (qn, decl) => decl.nome === qn.local && (decl.ns ?? null) === (qn.uri ?? null);

export class ModeloDFA {
  constructor(arvore, totalFolhas) {
    const posEoc = totalFolhas;
    const eoc = new Folha('elemento', null, -1, posEoc);
    const cabeca = new Bin('sequence', arvore, eoc);
    const n = totalFolhas + 1;
    anotar(cabeca);
    const folhas = new Array(n);
    coletarFolhas(cabeca, folhas);
    const seg = Array.from({ length: n }, () => new Set());
    seguintes(cabeca, seg);

    // element map: one entry per particle, in leaf position order; the EOC entry is dropped
    this.mapa = [];
    const ocorrencias = [];
    const idsVistos = new Map();
    for (let pos = 0; pos < n; pos++) {
      const f = folhas[pos];
      if (idsVistos.has(f.idParticula)) continue;
      idsVistos.set(f.idParticula, this.mapa.length);
      ocorrencias.push(f.repeticao ? { ...f.repeticao, indice: this.mapa.length } : null);
      this.mapa.push({ termo: f.termo, tipo: f.tipoParticula, id: f.idParticula, limites: f.limites });
    }
    this.mapa.pop();
    ocorrencias.pop();
    const posicoesPorElemento = this.mapa.map((m) => folhas.map((f, i) => (f.idParticula === m.id ? i : -1)).filter((i) => i >= 0));

    // subset construction
    this.transicoes = [];
    this.finais = [];
    const estados = [];
    const indice = new Map();
    const inicial = cabeca.primeiros;
    estados.push(inicial);
    indice.set(ConjuntoBits.de(inicial).chave(), 0);
    this.transicoes.push(new Array(this.mapa.length).fill(-1));
    for (let atual = 0; atual < estados.length; atual++) {
      const conj = estados[atual];
      this.finais[atual] = conj.has(posEoc);
      for (let e = 0; e < this.mapa.length; e++) {
        const novo = new Set();
        for (const pos of posicoesPorElemento[e]) if (conj.has(pos)) for (const x of seg[pos]) novo.add(x);
        if (novo.size === 0) continue;
        const k = ConjuntoBits.de(novo).chave();
        let destino = indice.get(k);
        if (destino === undefined) {
          destino = estados.length;
          estados.push(novo);
          indice.set(k, destino);
          this.transicoes.push(new Array(this.mapa.length).fill(-1));
        }
        this.transicoes[atual][e] = destino;
      }
    }
    // counting states: a state that loops on a repeating leaf
    this.contagem = null;
    if (ocorrencias.some(Boolean)) {
      this.contagem = this.transicoes.map((linha, i) => {
        const j = linha.findIndex((d) => d === i);
        return j >= 0 ? ocorrencias[j] : null;
      });
    }
    this.contadores = this.mapa.map((m) => (m.limites ? 0 : -1));
  }

  /** startContentModel: resets the a{n,m} counters (shared by every element of the type). */
  iniciar() {
    for (let i = 0; i < this.contadores.length; i++) if (this.contadores[i] !== -1) this.contadores[i] = 0;
    return [0, 0, 0];
  }

  /** oneTransition: the matching declaration/wildcard or null (state[0] = PRIMEIRO_ERRO). */
  transicao(qn, estado) {
    const atual = estado[0];
    if (atual < 0) { if (atual === PRIMEIRO_ERRO) estado[0] = ERRO_SEGUINTE; return null; }
    let e = 0;
    let proximo = -1;
    let achado = null;
    for (; e < this.mapa.length; e++) {
      proximo = this.transicoes[atual][e];
      if (proximo === -1) continue;
      const m = this.mapa[e];
      if (m.tipo === 'elemento' ? casa(qn, m.termo) : m.termo.permite(qn.uri)) {
        achado = m.termo;
        if (this.contadores[e] >= 0) this.contadores[e]++;
        break;
      }
    }
    if (e === this.mapa.length) { estado[1] = estado[0]; estado[0] = PRIMEIRO_ERRO; return null; }
    if (this.contagem) {
      let o = this.contagem[atual];
      if (o) {
        if (atual === proximo) {
          if (++estado[2] > o.max && o.max !== ILIMITADO) return this.procurarDepois(qn, estado, e);
        } else if (estado[2] < o.min) {
          estado[1] = estado[0]; estado[0] = PRIMEIRO_ERRO; return null;
        } else {
          o = this.contagem[proximo];
          if (o) estado[2] = e === o.indice ? 1 : 0;
        }
      } else {
        o = this.contagem[proximo];
        if (o) estado[2] = e === o.indice ? 1 : 0;
      }
    }
    estado[0] = proximo;
    return achado;
  }

  /** findMatchingDecl(curElem, state, handler, elemIndex): another transition after the counter overflowed. */
  procurarDepois(qn, estado, e) {
    const atual = estado[0];
    let proximo = -1;
    let achado = null;
    while (++e < this.mapa.length) {
      proximo = this.transicoes[atual][e];
      if (proximo === -1) continue;
      const m = this.mapa[e];
      if (m.tipo === 'elemento' ? casa(qn, m.termo) : m.termo.permite(qn.uri)) { achado = m.termo; break; }
    }
    if (e === this.mapa.length) { estado[1] = estado[0]; estado[0] = PRIMEIRO_ERRO; return null; }
    estado[0] = proximo;
    const o = this.contagem[proximo];
    if (o) estado[2] = e === o.indice ? 1 : 0;
    return achado;
  }

  /** endContentModel. */
  fim(estado) {
    const atual = estado[0];
    if (!this.finais[atual]) return false;
    const o = this.contagem?.[atual];
    return !(o && estado[2] < o.min);
  }

  /** whatCanGoHere: terms in element-map order. */
  oQuePodeVir(estado) {
    let atual = estado[0];
    if (atual < 0) atual = estado[1];
    const o = this.contagem?.[atual] ?? null;
    const r = [];
    for (let e = 0; e < this.mapa.length; e++) {
      const prox = this.transicoes[atual][e];
      if (prox === -1) continue;
      if (o) {
        if (atual === prox) { if (estado[2] >= o.max && o.max !== ILIMITADO) continue; }
        else if (estado[2] < o.min) continue;
      }
      r.push(this.mapa[e].termo);
    }
    return r;
  }

  /** occurenceInfo: [min, max, count, elemIndex] of the counting state, or null. */
  infoOcorrencia(estado) {
    if (!this.contagem) return null;
    let atual = estado[0];
    if (atual < 0) atual = estado[1];
    const o = this.contagem[atual];
    return o ? [o.min, o.max, estado[2], o.indice] : null;
  }

  nomeTermo(i) { return String(this.mapa[i].termo); }

  /** checkMinMaxBounds: pairs [key, "{term}"] for the a{n,m} counters out of bounds. */
  verificarLimites() {
    const r = [];
    for (let e = 0; e < this.mapa.length; e++) {
      const c = this.contadores[e];
      if (c === -1) continue;
      const { min, max } = this.mapa[e].limites;
      if (c < min) r.push(['cvc-complex-type.2.4.b', `{${this.mapa[e].termo}}`]);
      if (max !== ILIMITADO && c > max) r.push(['cvc-complex-type.2.4.d.1', `{${this.mapa[e].termo}}`]);
    }
    return r;
  }
}

/** XSEmptyCM: no child element is allowed. */
export class ModeloVazio {
  iniciar() { return [0, 0, 0]; }
  transicao(qn, estado) {
    if (estado[0] < 0) { estado[0] = ERRO_SEGUINTE; return null; }
    estado[0] = PRIMEIRO_ERRO;
    return null;
  }
  fim() { return true; }
  oQuePodeVir() { return []; }
  infoOcorrencia() { return null; }
  verificarLimites() { return []; }
}

const MODELO_VAZIO = new ModeloVazio();

/** CMBuilder.getContentModel(typeDecl): null for empty/simple content (cached on the type). */
export function modeloDoTipo(tipo) {
  if (tipo.modelo !== undefined) return tipo.modelo;
  let m = null;
  if (tipo.conteudo === 'elemento' || tipo.conteudo === 'misto') {
    if (!tipo.particula) m = MODELO_VAZIO;
    else {
      const c = new Construtor();
      const arvore = c.usarFolhasRepetidas(tipo.particula) ? c.arvoreCompacta(tipo.particula) : c.arvore(tipo.particula, true);
      m = arvore ? new ModeloDFA(arvore, c.folhas) : MODELO_VAZIO;
    }
  }
  tipo.modelo = m;
  return m;
}
