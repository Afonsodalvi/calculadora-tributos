// Expected-value conventions of the regime-regular vector files (test/fixtures/regime-regular/vectors-*.json,
// see each file's meta.expectedConventions): JSONPath subset (Jayway: [*], .., filters, length()),
// matchers (<num:X>, <rawnum:X>, <sum-eq:P>, <all-…>, <hasItem:X>…), whole-body LENIENT comparison,
// and the rounding invariants I1–I7 of VerificadorInvariantesArredondamento (corpus vector).
// Responses are read with the port's Jackson-like reader so number lexemes survive (JsonNum).
import { Dec } from '../../src/core/decimal.js';
import { lerJsonTexto, JsonNum, JsonObj, JsonArr } from '../../src/regime-regular/comum/json.js';
import { lerMediaType, compativel } from '../../src/regime-regular/comum/spring.js';

export const AUSENTE = Symbol('ausente');

/** Response text → plain tree (objects, arrays, strings, booleans, null, JsonNum). undefined when not JSON. */
export function lerResposta(texto) {
  if (texto == null || texto === '') return undefined;
  let raiz;
  try { raiz = lerJsonTexto(texto); } catch { return undefined; }
  const conv = (n) => {
    if (n instanceof JsonObj) { const o = {}; for (const [k, v] of n.entradas) o[k] = conv(v); return o; }
    if (n instanceof JsonArr) return n.itens.map(conv);
    return n;
  };
  return conv(raiz);
}

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNum);

function tokens(caminho) {
  const t = [];
  let s = caminho.replace(/^\$/, '');
  while (s.length) {
    let m;
    if ((m = /^\.length\(\)/.exec(s))) { t.push({ tipo: 'length' }); s = s.slice(m[0].length); continue; }
    if ((m = /^\.\.([A-Za-z0-9_$]+)/.exec(s))) { t.push({ tipo: 'profundo', nome: m[1] }); s = s.slice(m[0].length); continue; }
    if ((m = /^\.([^.[\]]+)/.exec(s))) { t.push({ tipo: 'campo', nome: m[1] }); s = s.slice(m[0].length); continue; }
    if ((m = /^\[(\d+)\]/.exec(s))) { t.push({ tipo: 'indice', i: Number(m[1]) }); s = s.slice(m[0].length); continue; }
    if ((m = /^\[\*\]/.exec(s))) { t.push({ tipo: 'todos' }); s = s.slice(m[0].length); continue; }
    if ((m = /^\['([^']*)'\]/.exec(s))) { t.push({ tipo: 'campo', nome: m[1] }); s = s.slice(m[0].length); continue; }
    if ((m = /^\[\?\(@\.([A-Za-z0-9_]+)\s*==\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false))\)\]/.exec(s))) {
      t.push({ tipo: 'filtro', campo: m[1], valor: m[2] ?? m[3] ?? m[4] }); s = s.slice(m[0].length); continue;
    }
    throw new Error(`JSONPath não suportado: ${caminho} (resto '${s}')`);
  }
  return t;
}

const textoNo = (v) => (v === AUSENTE ? '<absent>' : v === null ? 'null' : v instanceof JsonNum ? v.src : typeof v === 'object' ? JSON.stringify(plano(v)) : String(v));

/** Plain JS value for JSON comparisons (JsonNum → Number). */
export function plano(v) {
  if (v instanceof JsonNum) return Number(v.src);
  if (Array.isArray(v)) return v.map(plano);
  if (ehObjeto(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plano(x)]));
  return v;
}

/**
 * Evaluates a path. Returns { valores, multi, comprimento }: `multi` = indefinite path (list result);
 * definite paths give one value (AUSENTE when missing).
 */
export function avaliar(raiz, caminho) {
  let atuais = [raiz];
  let multi = false;
  let comprimento = false;
  for (const tk of tokens(caminho)) {
    switch (tk.tipo) {
      case 'campo': atuais = atuais.map((c) => (ehObjeto(c) && Object.hasOwn(c, tk.nome) ? c[tk.nome] : AUSENTE)); if (multi) atuais = atuais.filter((x) => x !== AUSENTE); break;
      case 'indice': atuais = atuais.map((c) => (Array.isArray(c) && tk.i < c.length ? c[tk.i] : AUSENTE)); if (multi) atuais = atuais.filter((x) => x !== AUSENTE); break;
      case 'todos': multi = true; atuais = atuais.flatMap((c) => (Array.isArray(c) ? c : ehObjeto(c) ? Object.values(c) : [])); break;
      case 'profundo': {
        multi = true;
        const r = [];
        const visitar = (n) => {
          if (Array.isArray(n)) n.forEach(visitar);
          else if (ehObjeto(n)) for (const [k, v] of Object.entries(n)) { if (k === tk.nome) r.push(v); visitar(v); }
        };
        atuais.forEach(visitar);
        atuais = r;
        break;
      }
      case 'filtro': {
        multi = true;
        atuais = atuais.flatMap((c) => (Array.isArray(c) ? c : [])).filter((e) => ehObjeto(e) && Object.hasOwn(e, tk.campo) && textoNo(e[tk.campo]) === String(tk.valor));
        break;
      }
      case 'length': comprimento = true; atuais = atuais.map((c) => (Array.isArray(c) ? c.length : ehObjeto(c) ? Object.keys(c).length : typeof c === 'string' ? c.length : AUSENTE)); break;
      default:
    }
  }
  return { valores: atuais, multi, comprimento };
}

const numero = (v) => {
  if (v instanceof JsonNum) return Dec.parse(v.src);
  if (typeof v === 'number') return Dec.parse(String(v));
  if (typeof v === 'string') { try { return Dec.parse(v.trim()); } catch { return null; } }
  return null;
};

function somaDe(raiz, caminho) {
  const { valores } = avaliar(raiz, caminho);
  let total = Dec.ZERO;
  for (const v of valores) { const n = numero(v); if (n) total = total.add(n); }
  return total;
}

const javaRegex = (r) => new RegExp(r.replace(/\\p\{Alpha\}/g, '[A-Za-z]'), 'u');

/**
 * Checks one expected key against a response. resp = { status, headers, texto, json }.
 * opcoes: { regraTexto: 'string-node'|'texto', tipos: expectedTypes, comprimentoDe(id), invariantes(json) }.
 * Returns null (ok), a failure string, or { naoAplicavel: motivo }.
 */
export function verificarChave(resp, chaveOriginal, esperado, opcoes = {}) {
  const chave = chaveOriginal.replace(/#\d+$/, '');
  if (Array.isArray(esperado)) {
    for (const e of esperado) { const r = verificarChave(resp, chave, e, opcoes); if (r) return r; }
    return null;
  }
  if (chave === 'captured' || chave.startsWith('captured:') || chave === 'calls') return { naoAplicavel: `${chave}: interação com @MockitoBean (sem equivalente via HTTP real)` };
  const m = typeof esperado === 'string' ? /^<([A-Za-z0-9-]+)(?::([\s\S]*))?>$/.exec(esperado) : null;
  const op = m?.[1];
  const arg = m?.[2];

  if (chave === 'httpStatus') {
    if (op === '2xx') return resp.status >= 200 && resp.status < 300 ? null : `status ${resp.status} não é 2xx`;
    if (op === '4xx') return resp.status >= 400 && resp.status < 500 ? null : `status ${resp.status} não é 4xx`;
    return String(resp.status) === String(esperado) ? null : `status ${resp.status} != ${esperado}`;
  }
  if (chave === 'body') return resp.texto === esperado ? null : `corpo '${resp.texto.slice(0, 200)}' != '${esperado}'`;
  if (chave.startsWith('header:')) {
    const nome = chave.slice(7).toLowerCase();
    const valor = resp.headers[nome];
    if (op === 'compatible') {
      const a = lerMediaType(valor), b = lerMediaType(arg);
      return a && b && compativel(b, a) && a.tipo === b.tipo && (a.subtipo === b.subtipo || b.subtipo === '*') ? null : `header ${nome} '${valor}' não compatível com ${arg}`;
    }
    if (op === 'contains') return valor != null && String(valor).includes(arg) ? null : `header ${nome} '${valor}' não contém '${arg}'`;
    if (op === 'absent') return valor == null ? null : `header ${nome} presente: ${valor}`;
    return String(valor) === esperado ? null : `header ${nome} '${valor}' != '${esperado}'`;
  }
  if (chave === '$raw') {
    if (op === 'not-regex') return javaRegex(arg).test(resp.texto) ? `corpo casa /${arg}/` : null;
    if (op === 'contains') return resp.texto.includes(arg) ? null : `corpo não contém '${arg}'`;
    return resp.texto === esperado ? null : 'corpo cru diferente';
  }
  if (chave === 'invariantes[*]') {
    if (op !== 'none-violated') return `matcher desconhecido ${esperado}`;
    const lista = arg.split(',');
    const v = verificarInvariantesArredondamento(resp.json).filter((x) => lista.includes(x.invariante));
    return v.length ? `violações: ${v.slice(0, 5).map((x) => `${x.invariante} ${x.caminho}: ${x.detalhe}`).join('; ')}` : null;
  }
  if (!chave.startsWith('$')) return { naoAplicavel: `chave '${chave}' só existe em vetores unitários` };
  if (resp.json === undefined) return `${chave}: resposta não é JSON (${resp.texto.slice(0, 120)})`;

  // whole-body object (JSONAssert LENIENT, Spring content().json())
  if (chave === '$' && esperado !== null && typeof esperado === 'object') {
    const d = compararLeniente(esperado, resp.json, '$');
    return d ? `corpo (LENIENT): ${d}` : null;
  }

  const { valores, multi, comprimento } = avaliar(resp.json, chave);
  const atual = multi ? valores : valores[0];
  const presente = (v) => v !== AUSENTE && v !== null;
  const lista = multi ? valores : Array.isArray(atual) ? atual : null;
  switch (op) {
    case undefined: break;
    case 'absent': return (multi ? valores.length === 0 : atual === AUSENTE || atual === null) ? null : `${chave} presente: ${textoNo(atual)}`;
    case 'null': return atual === null ? null : `${chave} = ${textoNo(atual)}, esperado null`;
    case 'present': return (multi ? valores.length > 0 && valores.every(presente) : presente(atual)) ? null : `${chave} ausente`;
    case 'all-present': return valores.every(presente) ? null : `${chave}: algum elemento ausente`;
    case 'not-empty': return presente(atual) && !(atual === '' || (Array.isArray(atual) && !atual.length) || (ehObjeto(atual) && !Object.keys(atual).length)) ? null : `${chave} vazio`;
    case 'nonempty': return (multi ? valores.length > 0 : Array.isArray(atual) && atual.length > 0) ? null : `${chave} vazio`;
    case 'all-nonempty': return valores.length > 0 && valores.every((x) => Array.isArray(x) && x.length > 0) ? null : `${chave}: lista vazia`;
    case 'array': case 'is-array': return (multi ? valores.every(Array.isArray) && valores.length > 0 : Array.isArray(atual)) ? null : `${chave} não é array`;
    case 'nonblank': return typeof atual === 'string' && atual.trim() ? null : `${chave} em branco`;
    case 'all-boolean': return valores.length > 0 && valores.every((x) => typeof x === 'boolean') ? null : `${chave}: nem todos booleanos`;
    case 'all-matches': { const re = new RegExp(`^(?:${arg})$`, 'u'); return valores.every((x) => typeof x === 'string' && re.test(x)) ? null : `${chave}: elemento fora de /${arg}/`; }
    case 'all-gte': return valores.every((x) => { const n = numero(x); return n && n.compareTo(Dec.parse(arg)) >= 0; }) ? null : `${chave}: elemento < ${arg}`;
    case 'contains': return (multi ? valores.some((x) => textoNo(x).includes(arg)) : typeof atual === 'string' ? atual.includes(arg) : textoNo(atual).includes(arg)) ? null : `${chave} = ${textoNo(atual).slice(0, 300)} não contém '${arg}'`;
    case 'not-contains': return !textoNo(atual).includes(arg) ? null : `${chave} contém '${arg}'`;
    case 'hasItem': return (lista ?? []).some((x) => textoNo(x) === arg) ? null : `${chave} sem o item ${arg}`;
    case 'not-hasItem': return (lista ?? []).some((x) => textoNo(x) === arg) ? `${chave} contém o item ${arg}` : null;
    case 'containsExactlyInAnyOrder': {
      const exp = JSON.parse(arg).map((x) => JSON.stringify(x)).sort();
      const act = (lista ?? []).map((x) => JSON.stringify(plano(x))).sort();
      return JSON.stringify(exp) === JSON.stringify(act) ? null : `${chave} = ${JSON.stringify(act)} != (qualquer ordem) ${arg}`;
    }
    case 'containsAll': {
      const act = new Set((lista ?? []).map((x) => JSON.stringify(plano(x))));
      const faltam = JSON.parse(arg).filter((x) => !act.has(JSON.stringify(x)));
      return faltam.length ? `${chave} sem ${JSON.stringify(faltam)}` : null;
    }
    case 'num': {
      const n = numero(atual);
      if (!presente(atual) || !n) return `${chave} = ${textoNo(atual)} não numérico`;
      return n.compareTo(Dec.parse(arg)) === 0 ? null : `${chave} = ${textoNo(atual)} != ${arg} (compareTo)`;
    }
    case 'rawnum': return atual instanceof JsonNum && atual.src === arg ? null : `${chave} = ${textoNo(atual)}${atual instanceof JsonNum ? '' : ' (não é número JSON)'} != número cru ${arg}`;
    case 'rawnum-scale': {
      const alvo = multi ? valores : [atual];
      const ruim = alvo.find((x) => !(x instanceof JsonNum) || Dec.parse(x.src).scale() !== Number(arg));
      return ruim === undefined ? null : `${chave}: ${textoNo(ruim)} sem escala ${arg}`;
    }
    case 'sum-eq': {
      const n = numero(atual);
      const s = somaDe(resp.json, arg);
      return n && n.compareTo(s) === 0 ? null : `${chave} = ${textoNo(atual)} != soma ${s.toPlainString()} de ${arg}`;
    }
    case 'gt': case 'gte': {
      const n = comprimento || typeof atual === 'number' ? (typeof atual === 'number' ? Dec.valueOf(atual) : null) : numero(atual);
      if (!n) return `${chave} = ${textoNo(atual)} não numérico`;
      const c = n.compareTo(Dec.parse(arg));
      return (op === 'gt' ? c > 0 : c >= 0) ? null : `${chave} = ${textoNo(atual)} não ${op === 'gt' ? '>' : '>='} ${arg}`;
    }
    case 'eqLengthOf': case 'lteLengthOf': {
      if (!opcoes.comprimentoDe) return { naoAplicavel: `${op} exige a resposta do vetor ${arg}` };
      const ref = opcoes.comprimentoDe(arg);
      if (ref == null) return `${chave}: vetor de referência ${arg} sem comprimento`;
      return (op === 'eqLengthOf' ? atual === ref : atual <= ref) ? null : `${chave} = ${textoNo(atual)} ${op === 'eqLengthOf' ? '!=' : '>'} ${ref} (${arg})`;
    }
    default: return { naoAplicavel: `matcher ${op} não se aplica via HTTP` };
  }
  // plain value
  if (multi || (typeof esperado === 'string' && esperado.startsWith('[') && Array.isArray(atual))) {
    let exp;
    try { exp = JSON.parse(esperado); } catch { exp = esperado; }
    return JSON.stringify(plano(atual)) === JSON.stringify(exp) ? null : `${chave} = ${JSON.stringify(plano(atual))} != ${esperado}`;
  }
  if (opcoes.regraTexto === 'string-node') {
    const tipo = opcoes.tipos?.[chave];
    if (tipo === 'number') {
      return atual instanceof JsonNum && Dec.parse(atual.src).compareTo(Dec.parse(esperado)) === 0 ? null : `${chave} = ${textoNo(atual)} != número ${esperado}`;
    }
    if (typeof atual !== 'string') return `${chave} = ${textoNo(atual)} (${atual instanceof JsonNum ? 'número' : typeof atual}) != texto '${esperado}'`;
    return atual === esperado ? null : `${chave} = '${atual}' != '${esperado}'`;
  }
  return textoNo(atual) === String(esperado) ? null : `${chave} = ${textoNo(atual)} != ${esperado}`;
}

/** JSONAssert LENIENT: expected keys must exist with equal values; arrays same size, any order. */
export function compararLeniente(esp, act, caminho) {
  if (esp === null) return act === null ? null : `${caminho}: esperado null, veio ${textoNo(act)}`;
  if (Array.isArray(esp)) {
    if (!Array.isArray(act)) return `${caminho}: esperado array`;
    if (esp.length !== act.length) return `${caminho}: tamanho ${act.length} != ${esp.length}`;
    const usados = new Set();
    for (let i = 0; i < esp.length; i++) {
      const j = act.findIndex((a, k) => !usados.has(k) && compararLeniente(esp[i], a, caminho) === null);
      if (j < 0) return `${caminho}[${i}]: sem elemento correspondente (${JSON.stringify(esp[i]).slice(0, 200)})`;
      usados.add(j);
    }
    return null;
  }
  if (typeof esp === 'object') {
    if (!ehObjeto(act)) return `${caminho}: esperado objeto, veio ${textoNo(act)}`;
    for (const [k, v] of Object.entries(esp)) {
      if (!Object.hasOwn(act, k)) return `${caminho}.${k}: ausente`;
      const d = compararLeniente(v, act[k], `${caminho}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (typeof esp === 'number') return act instanceof JsonNum && Number(act.src) === esp ? null : `${caminho}: ${textoNo(act)} != ${esp}`;
  if (typeof esp === 'boolean') return act === esp ? null : `${caminho}: ${textoNo(act)} != ${esp}`;
  return act === esp ? null : `${caminho}: ${textoNo(act)} != '${esp}'`;
}

// ─── VerificadorInvariantesArredondamento (test helper of the official suite) ──────

const MONETARIO = /^\d{1,13}\.\d{2}$/;
const ALIQUOTA = /^\d{1,3}\.\d{2,4}$/;
const QUANTIDADE = /^\d{1,11}(\.\d{4})?$/;
const EXPOENTE = /[0-9][eE][-+]?[0-9]/;
const TOLERANCIA = Dec.parse('0.04');
const TRIBUTOS = [
  ['gIBSUF', 'pIBSUF', 'vIBSUF', 'pAliqIBSUF', 'vTribIBSUF', 'pAliqEfetRegIBSUF', 'vTribRegIBSUF'],
  ['gIBSMun', 'pIBSMun', 'vIBSMun', 'pAliqIBSMun', 'vTribIBSMun', 'pAliqEfetRegIBSMun', 'vTribRegIBSMun'],
  ['gCBS', 'pCBS', 'vCBS', 'pAliqCBS', 'vTribCBS', 'pAliqEfetRegCBS', 'vTribRegCBS'],
];
const MONO_TOTAL = { vIBSMono: 'gMonoPadrao', vCBSMono: 'gMonoPadrao', vIBSMonoReten: 'gMonoReten', vCBSMonoReten: 'gMonoReten', vIBSMonoRet: 'gMonoRet', vCBSMonoRet: 'gMonoRet' };

const path = (n, ...ks) => { let c = n; for (const k of ks) c = ehObjeto(c) && Object.hasOwn(c, k) ? c[k] : AUSENTE; return c; };
const dec = (n) => (n === AUSENTE || n === null || n === undefined ? Dec.ZERO : n instanceof JsonNum ? Dec.parse(n.src) : Dec.parse(String(n)));
const arred2 = (v) => v.setScale(2, 'HALF_EVEN');
const arred4 = (v) => v.setScale(4, 'HALF_EVEN');
const UM = Dec.ONE;

/** Port of VerificadorInvariantesArredondamento.verificar(json): list of { invariante, caminho, detalhe }. */
export function verificarInvariantesArredondamento(resposta) {
  const v = [];
  const add = (invariante, caminho, detalhe) => v.push({ invariante, caminho, detalhe });
  const pRedutor = dec(path(resposta, 'oper', 'gCompraGov', 'pRedutor'));
  const somas = new Map();
  const somar = (c, x) => somas.set(c, (somas.get(c) ?? Dec.ZERO).add(x));
  const de = (c) => somas.get(c) ?? Dec.ZERO;
  const objetos = path(resposta, 'objetos');
  (Array.isArray(objetos) ? objetos : []).forEach((obj, i) => {
    const tribCalc = path(obj, 'tribCalc');
    const caminho = `$.objetos[${i}].tribCalc`;
    const is = path(tribCalc, 'IS');
    if (ehObjeto(is)) {
      const vIS = dec(path(is, 'vIS'));
      somar('vIS', vIS);
      const esperado = arred2(dec(path(is, 'vBCIS')).mul(dec(path(is, 'pIS'))).movePointLeft(2).add(dec(path(is, 'qTrib')).mul(dec(path(is, 'adRemIS')))));
      if (vIS.compareTo(esperado) !== 0) add('I2', `${caminho}.IS.vIS`, `publicado ${vIS.toJavaString()}, esperado ${esperado.toJavaString()}`);
    }
    const mono = path(tribCalc, 'IBSCBS', 'gIBSCBSMono');
    if (ehObjeto(mono)) for (const [campo, grupo] of Object.entries(MONO_TOTAL)) somar(campo, dec(path(mono, grupo, campo)));
    const g = path(tribCalc, 'IBSCBS', 'gIBSCBS');
    if (!ehObjeto(g)) return;
    const cg = `${caminho}.IBSCBS.gIBSCBS`;
    const vBC = dec(path(g, 'vBC'));
    somar('vBCIBSCBS', vBC);
    const detalhe = path(g, 'gTribCompraGov');
    const regular = path(g, 'gTribRegular');
    const compraGov = ehObjeto(detalhe);
    let somaValores = Dec.ZERO, somaAliqPrincipal = Dec.ZERO, somaAliqDetalhe = Dec.ZERO, somaValoresDetalhe = Dec.ZERO;
    for (const t of TRIBUTOS) {
      const grupo = path(g, t[0]);
      if (!ehObjeto(grupo)) continue;
      const ct = `${cg}.${t[0]}`;
      const aliquota = dec(path(grupo, t[1]));
      const valor = dec(path(grupo, t[2]));
      const gRed = path(grupo, 'gRed');
      const pRedAliq = dec(path(gRed, 'pRedAliq'));
      const vDevTrib = dec(path(grupo, 'gDevTrib', 'vDevTrib'));
      const gDif = path(grupo, 'gDif');
      const temEfet = ehObjeto(gRed) && Object.hasOwn(gRed, 'pAliqEfet');
      const publicada = temEfet ? dec(path(gRed, 'pAliqEfet')) : aliquota;
      if (compraGov && !ehObjeto(regular)) {
        const esperada = arred4(aliquota.mul(UM.sub(pRedAliq.movePointLeft(2))).mul(UM.sub(pRedutor.movePointLeft(2))));
        const pub = dec(path(detalhe, t[3]));
        if (pub.compareTo(esperada) !== 0) add('I3', `${cg}.gTribCompraGov.${t[3]}`, `publicada ${pub.toJavaString()}, esperada ${esperada.toJavaString()}`);
      } else if (!compraGov && temEfet) {
        const esperada = arred4(aliquota.mul(UM.sub(pRedAliq.movePointLeft(2))));
        if (publicada.compareTo(esperada) !== 0) add('I3', `${ct}.gRed.pAliqEfet`, `publicada ${publicada.toJavaString()}, esperada ${esperada.toJavaString()}`);
      }
      const bruto = arred2(vBC.mul(publicada).movePointLeft(2));
      let vDif = Dec.ZERO;
      if (ehObjeto(gDif)) {
        vDif = dec(path(gDif, 'vDif'));
        const esp = arred2(vBC.mul(publicada).movePointLeft(2).mul(dec(path(gDif, 'pDif'))).movePointLeft(2));
        if (vDif.compareTo(esp) !== 0) add('I2', `${ct}.gDif.vDif`, `publicado ${vDif.toJavaString()}, esperado ${esp.toJavaString()}`);
      }
      const esperado = bruto.sub(vDif).sub(vDevTrib);
      if (valor.compareTo(esperado) !== 0) add('I2', `${ct}.${t[2]}`, `publicado ${valor.toJavaString()}, esperado ${esperado.toJavaString()}`);
      if (ehObjeto(regular) && Object.hasOwn(regular, t[6])) {
        const aliqReg = dec(path(regular, t[5]));
        const valReg = dec(path(regular, t[6]));
        const espReg = arred2(vBC.mul(aliqReg).movePointLeft(2));
        if (valReg.compareTo(espReg) !== 0) add('I2', `${cg}.gTribRegular.${t[6]}`, `publicado ${valReg.toJavaString()}, esperado ${espReg.toJavaString()}`);
      }
      if (compraGov) {
        const aliqDet = dec(path(detalhe, t[3]));
        const valDet = dec(path(detalhe, t[4]));
        let espDet = arred2(vBC.mul(aliqDet).movePointLeft(2));
        if (ehObjeto(gDif)) espDet = espDet.sub(arred2(vBC.mul(aliqDet).movePointLeft(2).mul(dec(path(gDif, 'pDif'))).movePointLeft(2)));
        if (valDet.compareTo(espDet) !== 0) add('I2', `${cg}.gTribCompraGov.${t[4]}`, `publicado ${valDet.toJavaString()}, esperado ${espDet.toJavaString()}`);
        somaAliqDetalhe = somaAliqDetalhe.add(aliqDet);
        somaValoresDetalhe = somaValoresDetalhe.add(valDet);
        somaAliqPrincipal = somaAliqPrincipal.add(publicada);
      }
      somaValores = somaValores.add(valor);
      somar(t[2], valor);
      somar(`${t[2]}.vDif`, vDif);
      somar(`${t[2]}.vDevTrib`, vDevTrib);
    }
    const vIBS = dec(path(g, 'vIBS'));
    const somaIBS = dec(path(g, 'gIBSUF', 'vIBSUF')).add(dec(path(g, 'gIBSMun', 'vIBSMun')));
    if (vIBS.compareTo(somaIBS) !== 0) add('I1', `${cg}.vIBS`, `publicado ${vIBS.toJavaString()}, soma das partes ${somaIBS.toJavaString()}`);
    somar('vIBS', vIBS);
    if (compraGov && !ehObjeto(regular)) {
      if (somaAliqPrincipal.compareTo(somaAliqDetalhe) !== 0) add('I5', cg, `soma principal ${somaAliqPrincipal.toJavaString()}, detalhe ${somaAliqDetalhe.toJavaString()}`);
      if (somaValoresDetalhe.sub(somaValores).abs().compareTo(TOLERANCIA) > 0) add('I6', cg, `soma do detalhe ${somaValoresDetalhe.toJavaString()}, principal ${somaValores.toJavaString()}`);
    }
  });
  const total = path(resposta, 'total', 'tribCalc');
  const c = '$.total.tribCalc';
  const conferir = (caminho, no, soma) => {
    if (no === AUSENTE || no === null) { if (soma.signum() !== 0) add('I4', caminho, `total ausente, soma dos itens ${soma.toJavaString()}`); return; }
    const t = dec(no);
    if (t.compareTo(soma) !== 0) add('I4', caminho, `total ${t.toJavaString()}, soma dos itens ${soma.toJavaString()}`);
  };
  const tot = path(total, 'IBSCBSTot');
  if (ehObjeto(tot)) {
    conferir(`${c}.IBSCBSTot.vBCIBSCBS`, path(tot, 'vBCIBSCBS'), de('vBCIBSCBS'));
    const gIBS = path(tot, 'gIBS');
    for (const [grupo, campo] of [['gIBSUF', 'vIBSUF'], ['gIBSMun', 'vIBSMun']]) {
      conferir(`${c}.IBSCBSTot.gIBS.${grupo}.${campo}`, path(gIBS, grupo, campo), de(campo));
      conferir(`${c}.IBSCBSTot.gIBS.${grupo}.vDif`, path(gIBS, grupo, 'vDif'), de(`${campo}.vDif`));
      conferir(`${c}.IBSCBSTot.gIBS.${grupo}.vDevTrib`, path(gIBS, grupo, 'vDevTrib'), de(`${campo}.vDevTrib`));
    }
    conferir(`${c}.IBSCBSTot.gIBS.vIBS`, path(gIBS, 'vIBS'), de('vIBS'));
    const gCBS = path(tot, 'gCBS');
    conferir(`${c}.IBSCBSTot.gCBS.vCBS`, path(gCBS, 'vCBS'), de('vCBS'));
    conferir(`${c}.IBSCBSTot.gCBS.vDif`, path(gCBS, 'vDif'), de('vCBS.vDif'));
    conferir(`${c}.IBSCBSTot.gCBS.vDevTrib`, path(gCBS, 'vDevTrib'), de('vCBS.vDevTrib'));
    const gMono = path(tot, 'gMono');
    for (const campo of Object.keys(MONO_TOTAL)) conferir(`${c}.IBSCBSTot.gMono.${campo}`, path(gMono, campo), de(campo));
    const vIBS = dec(path(gIBS, 'vIBS'));
    const partes = dec(path(gIBS, 'gIBSUF', 'vIBSUF')).add(dec(path(gIBS, 'gIBSMun', 'vIBSMun')));
    if (vIBS.compareTo(partes) !== 0) add('I1', `${c}.IBSCBSTot.gIBS.vIBS`, `publicado ${vIBS.toJavaString()}, soma das partes ${partes.toJavaString()}`);
  }
  const isTot = path(total, 'ISTot');
  if (ehObjeto(isTot)) conferir(`${c}.ISTot.vIS`, path(isTot, 'vIS'), de('vIS'));
  const formatos = (no, caminho) => {
    if (Array.isArray(no)) { no.forEach((x, i) => formatos(x, `${caminho}[${i}]`)); return; }
    if (!ehObjeto(no)) return;
    for (const [nome, valor] of Object.entries(no)) {
      const cc = `${caminho}.${nome}`;
      const monetario = nome.length > 1 && nome[0] === 'v' && /\p{Lu}/u.test(nome[1]);
      const aliq = (nome.length > 1 && nome[0] === 'p' && /\p{Lu}/u.test(nome[1])) || nome === 'adRemIS';
      if (Array.isArray(valor) || ehObjeto(valor)) formatos(valor, cc);
      else if (typeof valor === 'string') {
        if (monetario && !MONETARIO.test(valor)) add('I7', cc, `valor monetário fora do formato de 2 casas: ${valor}`);
        else if (aliq && !ALIQUOTA.test(valor)) add('I7', cc, `alíquota fora do formato de 2 a 4 casas: ${valor}`);
        else if (nome === 'qTrib' && !QUANTIDADE.test(valor)) add('I7', cc, `quantidade fora do formato: ${valor}`);
      } else if (valor instanceof JsonNum) {
        if (monetario || aliq) add('I7', cc, `número publicado fora do tipo texto: ${valor.src}`);
        if (EXPOENTE.test(valor.src)) add('I7', cc, `número com expoente: ${valor.src}`);
      }
    }
  };
  formatos(resposta, '$');
  return v;
}
