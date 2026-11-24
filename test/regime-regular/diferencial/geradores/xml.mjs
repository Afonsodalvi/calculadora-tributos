// Differential cases of the XML slice (/api/calculadora/xml/**):
//  - GET generate / validate (lists) with Accept variants;
//  - POST generate?tipo=: ROC documents answered by the oracle's own calculation
//    (POST /api/calculadora/regime-geral with the official test inputs) for every tipo, plus edge
//    ROCs (missing groups, null objects, huge/small/exponent decimals, string numbers, escapes,
//    unknown/duplicate keys, Jackson coercion and syntax errors), tipo parameter variants,
//    Content-Type/Accept variants;
//  - POST validate?tipo&subtipo: the official valid examples (XmlUtilTest/XmlControllerValidacaoTest),
//    the official invalid ones (XmlUtilTest mutations), the XML the oracle generates, random
//    mutations (removed/duplicated/swapped/renamed elements, text and attribute values, inserted
//    text/elements, namespace changes, truncation, well-formedness breakers, prolog/DOCTYPE
//    variants, wrong tipo/subtipo), SYSTEMATIC perturbations (every leaf value and every attribute
//    value of every example through a catalogue that hits each facet — pattern, enumeration,
//    length/minLength/maxLength, minInclusive, primitive types — plus every element removed,
//    duplicated, given an attribute or a child), DOCTYPE/entity/JDK-limit cases (internal subset
//    syntax, parameter entities, entity positions and balance, recursion, expansion/size/depth/
//    attribute/name limits, external DTD/entity refusals) and XML 1.1 line ends, parameter variants.
// `gerar` is async: it asks the oracle (ORACULO_URL, default http://127.0.0.1:8080) for ROC
// documents; when the oracle is unreachable the ROCs come from the official vectors only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/regime-regular/', import.meta.url));
const ORACULO = process.env.ORACULO_URL ?? 'http://127.0.0.1:8080';
const TIPOS_GERACAO = ['nfe', 'nfce', 'cte', 'cte-simplificado', 'bpe', 'bpe-tm', 'nf3e'];
const TIPOS = ['nfe', 'nfce', 'nfse', 'cte', 'cte-simplificado', 'bpe', 'bpe-tm', 'nf3e'];

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const vetores = (arquivo) => JSON.parse(readFileSync(FIXTURES + arquivo, 'utf8')).vectors;

const tipoDoEnum = (t) => t.toLowerCase().replace('_simplificado', '-simplificado').replace('_tm', '-tm');

/** Official invalid examples (XmlUtilTest: one mutation of each valid example): { tipo, subtipo, xml }. */
export function exemplosInvalidos() {
  return vetores('vectors-dados-unit.json').filter((v) => v.endpoint === 'unit:XmlUtil.getSchema+validate' && v.id.startsWith('xml-02-'))
    .map((v) => ({ tipo: tipoDoEnum(v.input.tipoDocumento), subtipo: v.input.tipoXml.toLowerCase(), xml: v.input.xml, origem: v.id }));
}

/** Official valid examples: { tipo, subtipo, xml }. */
export function exemplosValidos() {
  const r = [];
  for (const v of vetores('vectors-dados-unit.json')) {
    if (v.endpoint !== 'unit:XmlUtil.getSchema+validate' || !v.id.startsWith('xml-01-')) continue;
    r.push({ tipo: v.input.tipoDocumento.toLowerCase().replace('_simplificado', '-simplificado').replace('_tm', '-tm'), subtipo: v.input.tipoXml.toLowerCase(), xml: v.input.xml, origem: v.id });
  }
  for (const v of vetores('vectors-validacao.json')) {
    if (v.endpoint !== 'xml-validate') continue;
    r.push({ tipo: v.query.tipo, subtipo: v.query.subtipo, xml: v.input, origem: v.id });
  }
  return r;
}

/** ROC documents the oracle computes for the official calculation inputs. */
async function rocsDoOraculo(limite) {
  const corpos = [];
  for (const v of vetores('vectors-calculo.json')) {
    if (v.endpoint === 'regime-geral' && v.input) corpos.push(v.inputRaw ?? JSON.stringify(v.input));
    else if (v.endpoint === 'unit:CalculadoraService.calcularTributos' && v.input && typeof v.input === 'object') corpos.push(JSON.stringify(v.input));
  }
  const rocs = [];
  for (const c of corpos) {
    if (rocs.length >= limite) break;
    try {
      const r = await fetch(`${ORACULO}/api/calculadora/regime-geral`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: c, signal: AbortSignal.timeout(20_000) });
      if (r.status === 200) rocs.push(await r.text());
    } catch { break; }
  }
  // the official generation input (entradas/xml/entrada.json) is always part of the set
  rocs.unshift(vetores('vectors-validacao.json').find((v) => v.endpoint === 'xml-generate').input);
  return [...new Set(rocs)];
}

// ─── XML element tree of a well-formed document (spans in the text) ────────────────────────────
export function arvoreXml(xml) {
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  const raiz = { filhos: [] };
  const pilha = [raiz];
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue;
    const topo = pilha[pilha.length - 1];
    if (m[1]) {
      topo.inicioFim = m.index;
      topo.fim = m.index + m[0].length;
      pilha.pop();
      continue;
    }
    const no = { nome: m[2], atributos: m[3], inicio: m.index, fimInicio: m.index + m[0].length, filhos: [], pai: topo };
    topo.filhos.push(no);
    if (m[4]) { no.vazio = true; no.inicioFim = no.fimInicio; no.fim = no.fimInicio; } else pilha.push(no);
  }
  const todos = [];
  const visitar = (n) => { for (const f of n.filhos) { todos.push(f); visitar(f); } };
  visitar(raiz);
  return { raiz: raiz.filhos[0], todos };
}

const VALORES_TEXTO = ['', ' ', 'x', 'ÿ', '0', '00', '1', '9', '99', '999', '1000', '-1', '1.0', '0.00', '1.5', '10.123', '1E2', '2025-01', '2024-12', '2025-13', '2025-01-32',
  'ABC', 'abc def', ' 1', '1 ', '\t1', '1\n', 'a&amp;b', '&lt;x&gt;', '&#65;', '&#x1F600;', '😀', 'ção', '000001', '000', '550', '410999', '123456789012345678901234567890',
  'x'.repeat(61), 'x'.repeat(256), '<![CDATA[1]]>', '<!-- c -->1', '1<!-- c -->', '<?pi x?>2', ' ', 'SEM CBENEF', 'http://x', '0.0001', '100.00', '12345678901234.00', '-0.01', '.5', '5.'];
const VALORES_ATRIBUTO = ['', ' ', 'x', '0', '1', '01', '999', 'a b', 'NFe123', 'ID1', '1ID', '&amp;', '&lt;', "'", '"', '\t', '&#10;', 'ç', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315', '#x', '%zz', 'a:b', '  1  '];
const QUEBRAS = ['<', '&', '&x', '&#0;', '&#xFFFE;', ']]>', '\u0001', '</x>', '<!-- -- -->', '<![CDATA[', '<?xml v?>', '<a>', '>', '"', "'", '\u000b', '<!DOCTYPE x>', '&lt', '&#', '<!', '<?', '</', '\r\n', '﻿'];

/** Systematic mutations of one valid document. */
function mutacoes(doc, rnd, quantidade) {
  const { xml } = doc;
  const { raiz, todos } = arvoreXml(xml);
  if (!raiz) return [];
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const casos = [];
  const add = (corpo, rotulo, extra = {}) => casos.push({ tipo: doc.tipo, subtipo: doc.subtipo, xml: corpo, rotulo: `${doc.origem} ${rotulo}`, ...extra });
  const folhas = todos.filter((n) => !n.vazio && n.filhos.length === 0);
  const complexos = todos.filter((n) => n.filhos.length > 0);
  const comAtributo = todos.filter((n) => /\S/.test(n.atributos));
  const fatia = (a, b) => xml.slice(0, a) + xml.slice(b);
  for (let k = 0; k < quantidade; k++) {
    const tipo = Math.floor(rnd() * 17);
    const n = pick(todos);
    switch (tipo) {
      case 0: if (n !== raiz) add(fatia(n.inicio, n.fim), `remove ${n.nome}`); break;
      case 1: if (n !== raiz) add(xml.slice(0, n.fim) + xml.slice(n.inicio, n.fim) + xml.slice(n.fim), `duplica ${n.nome}`); break;
      case 2: {
        const irmaos = n.pai?.filhos ?? [];
        const i = irmaos.indexOf(n);
        if (i >= 0 && i + 1 < irmaos.length) {
          const b = irmaos[i + 1];
          add(xml.slice(0, n.inicio) + xml.slice(b.inicio, b.fim) + xml.slice(n.fim, b.inicio) + xml.slice(n.inicio, n.fim) + xml.slice(b.fim), `troca ${n.nome}/${b.nome}`);
        }
        break;
      }
      case 3: case 4: case 5: {
        const f = folhas.length ? pick(folhas) : null;
        if (f) add(xml.slice(0, f.fimInicio) + pick(VALORES_TEXTO) + xml.slice(f.inicioFim), `texto ${f.nome}`);
        break;
      }
      case 6: {
        const local = n.nome.includes(':') ? n.nome.split(':')[1] : n.nome;
        const novo = pick([`${local}X`, local.toLowerCase(), `x${local}`, 'p:' + local]);
        let s = xml.slice(0, n.inicio) + `<${novo}` + xml.slice(n.inicio + 1 + n.nome.length, n.fimInicio);
        if (!n.vazio) s += xml.slice(n.fimInicio, n.inicioFim) + `</${novo}>` + xml.slice(n.fim); else s += xml.slice(n.fimInicio);
        add(s, `renomeia ${n.nome}→${novo}`);
        break;
      }
      case 7: {
        const c = complexos.length ? pick(complexos) : raiz;
        const alvo = pick(c.filhos);
        const ins = pick(['<desconhecido/>', 'texto', '<x:y xmlns:x="urn:x"/>', ' \n ', '<!-- c -->', `<${alvo.nome}/>`, '<?pi d?>', '&#65;']);
        add(xml.slice(0, alvo.inicio) + ins + xml.slice(alvo.inicio), `insere em ${c.nome}`);
        break;
      }
      case 8: {
        const c = complexos.length ? pick(complexos) : raiz;
        add(xml.slice(0, c.inicioFim) + pick(['<extra/>', 'x', `<${c.filhos[c.filhos.length - 1].nome}/>`]) + xml.slice(c.inicioFim), `anexa em ${c.nome}`);
        break;
      }
      case 9: {
        if (comAtributo.length) {
          const a = pick(comAtributo);
          const attrs = a.atributos;
          const ms = [...attrs.matchAll(/\s+([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g)];
          const at = pick(ms);
          const ini = a.inicio + 1 + a.nome.length + at.index;
          const fimA = ini + at[0].length;
          const op = Math.floor(rnd() * 4);
          if (op === 0) add(xml.slice(0, ini) + xml.slice(fimA), `remove @${at[1]}`);
          else if (op === 1) add(xml.slice(0, ini) + ` ${at[1]}="${pick(VALORES_ATRIBUTO)}"` + xml.slice(fimA), `valor @${at[1]}`);
          else if (op === 2) add(xml.slice(0, fimA) + ` ${at[1]}="1"` + xml.slice(fimA), `duplica @${at[1]}`);
          else add(xml.slice(0, fimA) + pick([' extra="1"', ' xsi:nil="true"', ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="x"', ' p:a="1"', ' xml:lang="pt"']) + xml.slice(fimA), `novo atributo em ${a.nome}`);
        } else {
          add(xml.slice(0, n.inicio + 1 + n.nome.length) + ' extra="1"' + xml.slice(n.inicio + 1 + n.nome.length), `atributo em ${n.nome}`);
        }
        break;
      }
      case 10: add(xml.slice(0, 1 + Math.floor(rnd() * (xml.length - 1))), 'trunca'); break;
      case 11: {
        const pos = Math.floor(rnd() * xml.length);
        add(xml.slice(0, pos) + pick(QUEBRAS) + xml.slice(pos), 'quebra');
        break;
      }
      case 12: {
        const f = folhas.length ? pick(folhas) : null;
        if (f) add(xml.slice(0, f.fimInicio) + xml.slice(f.fimInicio, f.inicioFim).repeat(2) + xml.slice(f.inicioFim), `texto duplicado ${f.nome}`);
        break;
      }
      case 13: {
        const pre = pick(['', '\n', ' ', '﻿', '<?xml version="1.0"?>', '<?xml version="1.1" encoding="ISO-8859-1"?>\n', '<!-- c -->\n', '<!DOCTYPE r>\n', '<!DOCTYPE r [<!ENTITY e "1">]>\n', '<?pi x?>']);
        const semDecl = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
        add(pre + semDecl + pick(['', '\n', '<!-- fim -->', ' x', '<a/>']), 'prólogo');
        break;
      }
      case 14: {
        // namespace change of the root
        const novo = pick(['', ' xmlns="http://www.portalfiscal.inf.br/outro"', ' xmlns=""']);
        const s = xml.slice(0, raiz.fimInicio).replace(/\s+xmlns="[^"]*"/, novo) + xml.slice(raiz.fimInicio);
        add(s, 'namespace raiz');
        break;
      }
      case 15: {
        const c = complexos.length ? pick(complexos) : raiz;
        const op = Math.floor(rnd() * 6);
        if (op === 0) add(xml.slice(0, c.fimInicio) + xml.slice(c.inicioFim), `esvazia ${c.nome}`);
        else if (op === 1) add(xml.slice(0, c.fimInicio - 1).replace(/\/$/, '') + '/>' + xml.slice(c.fim), `vazio ${c.nome}`);
        else if (op === 2 && folhas.length) {
          const f = pick(folhas);
          add(xml.slice(0, f.fimInicio) + `<![CDATA[${xml.slice(f.fimInicio, f.inicioFim)}]]>` + xml.slice(f.inicioFim), `cdata ${f.nome}`);
        } else if (op === 3) {
          const tipoXsi = pick(['TString', 'xs:string', 'TDec_1302', 'naoExiste', 'p:x', 'string']);
          add(xml.slice(0, c.inicio + 1 + c.nome.length) + ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:type="${tipoXsi}"` + xml.slice(c.inicio + 1 + c.nome.length), `xsi:type ${tipoXsi} em ${c.nome}`);
        } else if (op === 4 && folhas.length) {
          const f = pick(folhas);
          const v = xml.slice(f.fimInicio, f.inicioFim);
          add(xml.slice(0, f.fimInicio) + pick([` ${v}`, `${v} `, `\n${v}\n`, `${v}\t`, v.toUpperCase(), v.toLowerCase(), v + v, v.slice(0, -1), v.slice(1)]) + xml.slice(f.inicioFim), `ajusta ${f.nome}`);
        } else {
          // prefixed namespace instead of the default one (valid) or a wrong one
          const ns = /xmlns="([^"]*)"/.exec(xml.slice(raiz.inicio, raiz.fimInicio))?.[1];
          if (ns != null && c === raiz) add(`<p:${raiz.nome} xmlns:p="${pick([ns, ns + 'x'])}"` + xml.slice(raiz.inicio + 1 + raiz.nome.length, raiz.fimInicio).replace(/\s+xmlns="[^"]*"/, '') + xml.slice(raiz.fimInicio, raiz.inicioFim) + `</p:${raiz.nome}>` + xml.slice(raiz.fim), 'prefixo raiz');
          else add(xml.slice(0, c.inicioFim) + `<${c.filhos[0].nome} xmlns="urn:outro"/>` + xml.slice(c.inicioFim), `namespace filho ${c.nome}`);
        }
        break;
      }
      default: {
        const outro = pick(TIPOS);
        add(xml, 'outro tipo', { tipo: outro, subtipo: pick(['grupo', 'nota']) });
      }
    }
  }
  return casos;
}

// ─── Systematic perturbations ────────────────────────────────────────────────────────────────────
/** Leaf values: each one aims at a facet or at the primitive type of some simple type of the XSDs. */
const PERTURBA_TEXTO = [
  () => '', () => ' ', (v) => `${v}0`, (v) => v.slice(0, -1), (v) => ` ${v}`, (v) => `${v} `, (v) => `\t${v}\n`, (v) => v.replace(/\d/, 'a'),
  (v) => v.replace(/\d/, '٣'), (v) => v.replace(/\d/g, '９'), (v) => v.toUpperCase(), (v) => v.toLowerCase(), () => 'x'.repeat(2001), (v) => `-${v}`,
  (v) => `${v}.5`, (v) => v.replace('.', ','), (v) => v.replace('.', ''), (v) => v + v, (v) => v.replace(/ /g, '  '), (v) => `${v}\u00a0`, () => '0',
  () => '00', () => '-1', () => '2024-12', () => '2025-01', () => '2025-13', () => '2025-1', () => '2025-01Z', () => '0.00', () => '1E2', (v) => `${v}&amp;`,
  (v) => `<![CDATA[${v}]]>`, (v) => v.replace(/\d/g, (d) => String((Number(d) + 1) % 10)), () => '1900-01-01', () => '2025-02-30', () => 'AAAA',
  () => 'ab=', () => 'ab cd==', () => '9'.repeat(16), (v) => v.replace(/^0+/, ''), (v) => `0${v}`, () => 'ÿ', () => '\u0100',
];
/** Attribute values (always well-formed inside quotes). */
const PERTURBA_ATRIBUTO = [
  () => '', () => ' ', (v) => `${v}0`, (v) => v.slice(0, -1), (v) => ` ${v} `, (v) => v.toUpperCase(), (v) => v.replace(/\d/, 'a'), () => '0', () => '1',
  () => '990', () => '991', () => '-1', () => 'x'.repeat(300), (v) => v + v, (v) => v.replace(/\d/g, (d) => String((Number(d) + 1) % 10)),
  () => '4.00', () => '1.00', () => 'NFe', () => 'http://www.w3.org/2000/09/xmldsig#sha1', () => '&amp;', () => '&#10;1',
];

/** Every candidate change of one document (closures; sampled by the caller). */
function sistematicos(doc) {
  const { xml } = doc;
  const { raiz, todos } = arvoreXml(xml);
  if (!raiz) return [];
  const r = [];
  const add = (f, rotulo) => r.push({ tipo: doc.tipo, subtipo: doc.subtipo, montar: f, rotulo: `${doc.origem} ${rotulo}` });
  for (const n of todos) {
    const folha = !n.vazio && n.filhos.length === 0;
    if (folha) {
      const v = xml.slice(n.fimInicio, n.inicioFim);
      PERTURBA_TEXTO.forEach((p, i) => add(() => xml.slice(0, n.fimInicio) + p(v) + xml.slice(n.inicioFim), `texto#${i} ${n.nome}`));
      add(() => xml.slice(0, n.fimInicio) + '<x/>' + xml.slice(n.fimInicio), `filho em ${n.nome}`);
    } else if (!n.vazio) {
      add(() => xml.slice(0, n.fimInicio) + 'texto' + xml.slice(n.fimInicio), `texto em ${n.nome}`);
    }
    if (n !== raiz) {
      add(() => xml.slice(0, n.inicio) + xml.slice(n.fim), `remove ${n.nome}`);
      add(() => xml.slice(0, n.fim) + xml.slice(n.inicio, n.fim) + xml.slice(n.fim), `duplica ${n.nome}`);
    }
    const p = n.inicio + 1 + n.nome.length;
    add(() => xml.slice(0, p) + ' extra="1"' + xml.slice(p), `atributo em ${n.nome}`);
    for (const at of n.atributos.matchAll(/\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const ini = p + at.index;
      const fim = ini + at[0].length;
      const valor = at[3] ?? at[4];
      PERTURBA_ATRIBUTO.forEach((f, i) => add(() => `${xml.slice(0, ini)} ${at[1]}="${f(valor).replace(/"/g, '&quot;')}"${xml.slice(fim)}`, `@${at[1]}#${i} em ${n.nome}`));
    }
  }
  return r;
}

// ─── DOCTYPE, entities, JDK limits, XML 1.1 ─────────────────────────────────────────────────────
const NS_NFE = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const NFE_OK = `<infNFe ${NS_NFE}><det nItem="1"><imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></IBSCBS></imposto></det><total/></infNFe>`;

/** [tipo, subtipo, corpo, rótulo] of the DOCTYPE/entity/limit cases. */
function casosDtd() {
  const r = [];
  const add = (corpo, rotulo, tipo = 'nfe', subtipo = 'grupo') => r.push([tipo, subtipo, corpo, rotulo]);
  const d = (sub, doc = NFE_OK) => `<!DOCTYPE infNFe [${sub}]>${doc}`;
  const comCST = (sub, cst) => d(sub).replace('<CST>000</CST>', cst);
  const comItem = (sub, item) => d(sub).replace('nItem="1"', item);
  const subconjuntos = [
    '', ' ', '<!-- c -->', '<?pi x?>', '<?xml x?>', '<!-x', '<!- -->', '<!ELEMENT infNFe ANY>', '<!ELEMENT infNFe EMPTY>', '<!ELEMENT a (#PCDATA)>', '<!ELEMENT a (b,c)*>',
    '<!ELEMENT a (#PCDATA|b)*>', '<!ELEMENT a>', '<!ELEMENT a (b>', '<!ELEMENT a (#PCDATA|b)>', '<!ELEMENT a ANY', '<!ELEMENTa ANY>', '<!ELEMENT a XYZ>', '<!ELEMENT a ((b|c),d?)+>',
    '<!ELEMENT a (b|c,d)>', '<!ELEMENT a (#PCDATA|)*>', '<!ELEMENT a ( b )>', '<!ATTLIST det x CDATA #IMPLIED>', '<!ATTLIST det x CDATA #REQUIRED>', '<!ATTLIST det x CDATA #FIXED "1">',
    '<!ATTLIST det x CDATA "1">', '<!ATTLIST det nItem CDATA "1">', '<!ATTLIST det x (a|b) "a">', '<!ATTLIST det x ID #IMPLIED>', '<!ATTLIST det x NMTOKEN #IMPLIED>', '<!ATTLIST det x CDATA>',
    '<!ATTLIST det x>', '<!ATTLIST det x FOO #IMPLIED>', '<!ATTLIST det x CDATA "<">', '<!ATTLIST det x CDATA "&e;">', '<!ENTITY e "v"><!ATTLIST det x CDATA "&e;">', '<!ATTLIST det x CDATA "a',
    '<!ATTLIST det x CDATA #FIXED>', '<!ATTLIST det xmlns CDATA "urn:x">', '<!ATTLIST infNFe xmlns CDATA "urn:x">', '<!ATTLIST imposto x CDATA "1">', '<!ATTLIST det x ENTITIES #IMPLIED>',
    '<!ATTLIST det x NOTATION (n) #IMPLIED>', '<!ATTLIST det x NOTATION(n) #IMPLIED>', '<!ATTLIST det x (a|) "a">', '<!ATTLIST det>', '<!ATTLIST det x CDATA #IMPLIED y CDATA "2">',
    '<!ENTITY e "v">', "<!ENTITY e 'v'>", '<!ENTITY e "&#60;">', '<!ENTITY e "&#38;#60;">', '<!ENTITY e "a&f;b">', '<!ENTITY e "v"', '<!ENTITY e v>', '<!ENTITY e>', '<!ENTITY e "a & b">',
    '<!ENTITY e "a &x b">', '<!ENTITY e SYSTEM "x.ent">', '<!ENTITY e PUBLIC "p" "x.ent">', '<!ENTITY e SYSTEM "x.ent" NDATA n>', '<!ENTITY e SYSTEM "x.ent"NDATA n>', '<!ENTITY % p "x">',
    '<!ENTITY % p SYSTEM "x.ent">', '<!ENTITY % p "<!ENTITY e \'v\'>">%p;', '<!ENTITY % p "x"> %p;', '%p;', '<!ENTITY % p "x"><!ENTITY e "%p;">', '<!ENTITY % p "x"><!ATTLIST det %p; CDATA #IMPLIED>',
    '<![INCLUDE[ ]]>', '<!NOTATION n SYSTEM "x">', '<!NOTATION n PUBLIC "p">', '<!NOTATION n>', ']', 'x', '<a>', '<!ENTITY e "1"><!ENTITY e "2">', '<!ENTITY lt "<">', '<!ENTITY amp "&#38;">',
    '<!ENTITY e "&#0;">', '<!ENTITY e "&#xD800;">', '<!ENTITY e "\u0001">', '<!ENTITY%p "x">', '<!ENTITY % p "<!ENTITY e \'v\'"> %p;>', '<!ENTITY % p "<!ELEMENT"> %p; a ANY>',
    '<!ENTITY % p "%q;"><!ENTITY % q "x">', '<!ENTITY % p "  "> %p; %p;', '<!ENTITY % p "<!--c-->"> %p;%p;', '<!ENTITY % p "&#37;p;"> %p;', '<!ENTITY % p "&#37;q;"><!ENTITY % q "x"> %p;',
    '<!ENTITY e PUBLIC "a\tb" "x">', '<!ENTITY e PUBLIC "" "x">', '<!ENTITY e SYSTEM>', '<!ENTITY e SYSTEM x>',
  ];
  for (const sub of subconjuntos) add(d(sub), `dtd ${sub.slice(0, 40)}`);
  for (const pre of ['<!DOCTYPE infNFe>', '<!DOCTYPE>', '<!DOCTYPE infNFe [', '<!DOCTYPE infNFe [] ', '<!DOCTYPE infNFe []x>', '<!DOCTYPE infNFe SYSTEM "x.dtd">', '<!DOCTYPE infNFe SYSTEM "a/b/c.dtd">',
    '<!DOCTYPE infNFe SYSTEM "http://h">', '<!DOCTYPE infNFe SYSTEM "http://h/">', '<!DOCTYPE infNFe SYSTEM "urn:x">', '<!DOCTYPE infNFe SYSTEM "../x.dtd">', '<!DOCTYPE infNFe SYSTEM "">',
    '<!DOCTYPE infNFe PUBLIC "-//x//EN" "x.dtd">', '<!DOCTYPE infNFe PUBLIC "-//x//EN">', '<!DOCTYPE infNFe SYSTEM "jar:file:/x.jar!/a.dtd">', '<!DOCTYPE infNFe SYSTEM "C:\\x\\y.dtd">',
    '<!DOCTYPE infNFe SYSTEM "x.dtd" [<!ENTITY e "1">]>', '<!DOCTYPE a [<!ENTITY e "1">]><!DOCTYPE b>', '<!DOCTYPE infNFe PUBLIC "" "x.dtd">', '<!DOCTYPE infNFe PUBLIC " a  b " "x.dtd">',
    '<!DOCTYPE infNFe SYSTEM "mailto:a@b">', '<!DOCTYPE infNFe SYSTEM "a b:c">', '<!DOCTYPE infNFe SYSTEM "ftp://h/a/b.dtd">', '<!DOCTYPE infNFe SYSTEM "jar:x">', '<!DOCTYPE infNFeSYSTEM "x">',
    '<!DOCTYPE infNFe SYSTEM"x">', '<!DOCTYPE infNFe PUBLIC"p" "x">', '<!DOCTYPE infNFe PUBLIC "p""x">', '<!DOCTYPE infNFe SYSTEM \'x\'>', '<!DOCTYPE infNFe [] >']) {
    add(pre + NFE_OK, `doctype ${pre.slice(0, 40)}`);
  }
  add(`${NFE_OK}<!DOCTYPE x>`, 'doctype depois da raiz');
  // general entities in content and in attributes
  const cst = [['<!ENTITY e "000">', '<CST>&e;</CST>'], ['<!ENTITY e "00">', '<CST>&e;</CST>'], ['<!ENTITY e "0&f;0"><!ENTITY f "0">', '<CST>&e;</CST>'],
    ['<!ENTITY e "<CST>000</CST>">', '&e;'], ['<!ENTITY e "<CST>00</CST>">', '&e;'], ['<!ENTITY e "\n<CST>0</CST>">', '&e;'], ['<!ENTITY e "<CST>000">', '&e;</CST>'],
    ['<!ENTITY e "000</CST>">', '<CST>&e;'], ['<!ENTITY e "<CST">', '&e;>000</CST>'], ['<!ENTITY e "&e;">', '<CST>&e;</CST>'], ['<!ENTITY e "&f;"><!ENTITY f "&e;">', '<CST>&e;</CST>'],
    ['', '<CST>&e;</CST>'], ['<!ENTITY e SYSTEM "x.ent" NDATA n>', '<CST>&e;</CST>'], ['<!ENTITY e SYSTEM "x.ent">', '<CST>&e;</CST>'], ['<!ENTITY % e "000">', '<CST>%e;</CST>'],
    ['<!ENTITY e "0&#13;0">', '<CST>&e;</CST>'], ['<!ENTITY e "0&#10;0">', '<CST>&e;</CST>'], ['<!ENTITY e "0\n\n0">', '<CST>&e;</CST>'], ['<!ENTITY e "<!-- c -->000">', '<CST>&e;</CST>'],
    ['<!ENTITY e "<![CDATA[000]]>">', '<CST>&e;</CST>'], ['<!ENTITY e "<?pi x?>000">', '<CST>&e;</CST>'], ['<!ENTITY e "]]>">', '<CST>&e;</CST>'], ['<!ENTITY e "a<b">', '<CST>&e;</CST>'],
    ['<!ENTITY e "<!-- c">', '<CST>&e; --></CST>'], ['<!ENTITY e "00&amp;">', '<CST>&e;</CST>'], ['<!ENTITY e "&lt;">', '<CST>&e;</CST>'], ['<!ENTITY e "<CST/>">', '&e;'],
    ['<!ENTITY e "\t000 ">', '<CST>&e;</CST>'], ['<!ENTITY e "<x:CST/>">', '&e;'], ['<!ENTITY e "<CST xmlns=\'urn:x\'>000</CST>">', '&e;']];
  for (const [sub, x] of cst) add(comCST(sub, x), `entidade conteúdo ${sub.slice(0, 30)} ${x}`);
  const item = [['<!ENTITY e "1">', 'nItem="&e;"'], ['<!ENTITY e "x">', 'nItem="&e;"'], ['<!ENTITY e "<">', 'nItem="&e;"'], ['<!ENTITY e "a&f;"><!ENTITY f "<">', 'nItem="&e;"'],
    ['<!ENTITY e "1&#10;">', 'nItem="&e;"'], ['<!ENTITY e "\n1">', 'nItem="&e;"'], ['<!ENTITY e SYSTEM "x.ent">', 'nItem="&e;"'], ['', 'nItem="&e;"'], ['<!ENTITY e "&e;">', 'nItem="&e;"'],
    ['<!ENTITY e "&f;"><!ENTITY f "&e;">', 'nItem="&e;"'], ['<!ENTITY e "\'">', "nItem='&e;'"], ['<!ENTITY e \'"\'>', 'nItem="1&e;"'], ['<!ENTITY e "1&#9;">', 'nItem="&e;"'],
    ['<!ENTITY e "1&#13;">', 'nItem="&e;"'], ['<!ENTITY e "&amp;">', 'nItem="&e;"'], ['<!ENTITY e "1">', 'nItem="&e;&e;"'], ['<!ATTLIST det nItem NMTOKEN #IMPLIED>', 'nItem="  1  "'],
    ['<!ATTLIST det nItem ID #IMPLIED>', 'nItem=" 1 2 "'], ['<!ATTLIST det nItem CDATA #IMPLIED>', 'nItem=" 1 "'], ['<!ATTLIST det nItem (a|b) "  a  ">', ''],
    ['<!ATTLIST det xmlns:p CDATA "urn:p" p:x CDATA "1">', 'nItem="1"'], ['<!ATTLIST det nItem CDATA #FIXED "2">', 'nItem="1"'], ['<!ATTLIST det nItem CDATA "&#38;">', '']];
  for (const [sub, x] of item) add(comItem(sub, x), `entidade atributo ${sub.slice(0, 30)} ${x}`);
  // namespaces bound by the DTD validator (any DOCTYPE)
  for (const doc of [`<infNFe ${NS_NFE} xmlns:p="urn:x" p:a="1" p:a="2"><det nItem="1"/></infNFe>`, `<infNFe ${NS_NFE}><det nItem="1" nItem="2" x="3"/></infNFe>`,
    `<infNFe ${NS_NFE}><p:det xmlns:p="urn:p" nItem="1"/></infNFe>`, `<infNFe ${NS_NFE}><q:det nItem="1"/></infNFe>`, `<infNFe ${NS_NFE}><det q:nItem="1" r:x="2"/></infNFe>`,
    `<infNFe ${NS_NFE} xmlns:xmlns="urn:x"><det/></infNFe>`, `<infNFe ${NS_NFE} xmlns:a="" a:b="1"><det/></infNFe>`, `<infNFe ${NS_NFE} xmlns:a="urn:x" xmlns:b="urn:x" a:c="1" b:c="2"><det/></infNFe>`,
    '<xmlns:infNFe/>', `<infNFe ${NS_NFE} xmlns="urn:y"><det/></infNFe>`, `<infNFe ${NS_NFE} xmlns:xml="urn:x"/>`, `<infNFe ${NS_NFE} xmlns:x="http://www.w3.org/XML/1998/namespace"/>`,
    `<infNFe ${NS_NFE} xmlns:x="http://www.w3.org/2000/xmlns/"/>`, `<infNFe ${NS_NFE} xmlns:xml="http://www.w3.org/XML/1998/namespace"><det nItem="1"><imposto/></det></infNFe>`]) {
    add(doc, `sem DOCTYPE ${doc.slice(0, 60)}`);
    add(`<!DOCTYPE infNFe>${doc}`, `DOCTYPE ${doc.slice(0, 60)}`);
  }
  // JDK limits (CTe nota: the xs:any skip of infModal accepts anything)
  const cte = vetores('vectors-dados-unit.json').find((v) => v.id === 'xml-01-09-valido-CTE-NOTA').input.xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const i = cte.indexOf('<aquav>');
  const aquav = cte.slice(i, cte.indexOf('</aquav>') + 8);
  const com = (miolo, sub = '') => (sub ? `<!DOCTYPE cteProc [${sub}]>` : '') + cte.replace(aquav, miolo);
  const X = (n) => 'x'.repeat(n);
  const lim = (corpo, rotulo) => add(corpo, `limite ${rotulo}`, 'cte', 'nota');
  for (const n of [94, 95, 96, 120]) lim(com('<a>'.repeat(n) + '</a>'.repeat(n)), `profundidade ${n}`);
  for (const n of [2499, 2500, 2501, 3000]) lim(com(`<aquav>${'&e;'.repeat(n)}</aquav>`, '<!ENTITY e "">'), `expansões ${n}`);
  for (const n of [2500, 2501]) lim(com(`<aquav a="${'&e;'.repeat(n)}"/>`, '<!ENTITY e "">'), `expansões atributo ${n}`);
  lim(com('<aquav>&a9;</aquav>', Array.from({ length: 10 }, (_, k) => (k ? `<!ENTITY a${k} "${`&a${k - 1};`.repeat(10)}">` : '<!ENTITY a0 "x">')).join('')), 'bilhão de risadas');
  for (const [m, sub, r] of [['&e;&e;', `<!ENTITY e "${X(50000)}">`, '2x50000'], ['&e;', `<!ENTITY e "${X(50000)}">`, '50000'], ['&e;&e;&e;', `<!ENTITY e "${X(33333)}">`, '3x33333'],
    ['&e;&e;&e;', `<!ENTITY e "${X(33334)}">`, '3x33334'], ['&e;&e;', `<!ENTITY e "${'<b>xxxxxxxxx</b>'.repeat(3500)}">`, 'marcação'], ['&f;', `<!ENTITY e "${X(60000)}"><!ENTITY f "&e;&e;">`, 'aninhada'],
    ['&e;', `<!ENTITY e "${X(99999)}">`, '99999'], ['&e;&e;x', `<!ENTITY e "${X(50000)}">`, '2x50000 texto'], ['&e;&f;', `<!ENTITY e "${X(50000)}"><!ENTITY f "${X(49999)}">`, '99999+amp'],
    ['&e;', `<!ENTITY e "${X(100000)}">`, '100000'], ['&e;&e;', `<!ENTITY e "${X(49984)}<b/>${X(12)}">`, 'bloco'], ['&e;&e;', `<!ENTITY e "${'ab<b/>'.repeat(8334)}">`, 'ab<b/>'],
    ['&e;', `<!ENTITY e "${X(70)}<${'n'.repeat(1001)}/>">`, 'nome em entidade'], ['&e;', `<!ENTITY % p "${X(15001)}">`, 'PE 15001'], ['&e;', `<!ENTITY % p "${X(15000)}"><!ENTITY e "y">`, 'PE 15000'],
    ['&e;', `<!ENTITY e "${X(100001)}">`, 'literal 100001'], ['&e;', `<!ENTITY e "${'<b/>'.repeat(30000)}">`, 'literal marcação']]) {
    lim(com(`<aquav>${m}</aquav>`, sub), `tamanho ${r}`);
  }
  lim(com('<aquav b="&e;&e;"/>', `<!ENTITY e "${X(60000)}">`), 'tamanho atributo');
  for (const nome of [1000, 1001]) lim(com(`<${'n'.repeat(nome)}/>`), `nome elemento ${nome}`);
  lim(com(`<aquav ${'n'.repeat(1001)}="1"/>`), 'nome atributo');
  lim(com(`<aquav>&${'n'.repeat(1001)};</aquav>`), 'nome referência');
  lim(com(`<p:aquav xmlns:${'p'.repeat(1001)}="urn:x"/>`), 'prefixo xmlns');
  lim(com(`<aquav xmlns:${'p'.repeat(995)}="urn:x"/>`), 'xmlns 1001 no total');
  lim(com(`<${'p'.repeat(1001)}:aquav xmlns:${'p'.repeat(1001)}="urn:x"/>`), 'prefixo elemento');
  lim(com(`<aquav>&amp;${'&e;'.repeat(3)}</aquav>`, `<!ENTITY e "${X(33333)}">`), 'predefinida conta');
  for (const n of [199, 200, 201]) add(`<infNFe ${NS_NFE}${Array.from({ length: n }, (_, k) => ` a${k}="1"`).join('')}/>`, `limite atributos ${n}`);
  // XML 1.1 and line ends
  for (const sep of ['\u0085', '\u2028', '\r\u0085', '\r\n', '\r', '\n\u0085', '\u0085\u0085x', '\r\u2028']) {
    add(`<?xml version="1.1"?>${sep}<infNFe ${NS_NFE}>${sep}<det nItem="1"${sep}x="${sep}a">${sep}<imposto/>${sep}</det></infNFe>`, 'xml 1.1 quebras');
    add(`<?xml version="1.1"?>${sep}<infNFe ${NS_NFE}>${sep}<det nItem="1">${sep}<!--${sep}-->x${sep}<imposto/>${sep}</det></infNFe>`, 'xml 1.1 comentário');
    add(`<?xml version="1.0"?>${sep}<infNFe ${NS_NFE}>${sep}<det nItem="1">${sep}<imposto/>${sep}</det>x</infNFe>`, 'xml 1.0 quebras');
    add(`<?xml version="1.1"?><!DOCTYPE infNFe [${sep}<!ENTITY e "a${sep}b">${sep}]>${sep}<infNFe ${NS_NFE}><det nItem="&e;"/></infNFe>`, 'xml 1.1 entidade atributo');
    add(`<?xml version="1.1"?><!DOCTYPE infNFe [${sep}<!ENTITY e "0${sep}0">${sep}]>${sep}${NFE_OK.replace('<CST>000</CST>', '<CST>&e;</CST>')}`, 'xml 1.1 entidade conteúdo');
  }
  for (const x of ['\u0001', '\u0085', '\u007f', '&#x1;', '&#x85;', '&#0;']) {
    add(`<?xml version="1.1"?>${NFE_OK.replace('<CST>000</CST>', `<CST>0${x}0</CST>`)}`, 'xml 1.1 controle');
    add(NFE_OK.replace('<CST>000</CST>', `<CST>0${x}0</CST>`), 'xml 1.0 controle');
  }
  // occurrence bounds counted by the content model (NFdet 1..13 of the NF3e group, det 1..990, Transform 2..2)
  const nfdet = '<NFdet><det nItem="1"><detItem><imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></IBSCBS></imposto></detItem></det></NFdet>';
  for (const k of [0, 1, 12, 13, 14, 20]) {
    add(`<infNF3e xmlns="http://www.portalfiscal.inf.br/nf3e">${nfdet.repeat(k)}<total/></infNF3e>`, `NFdet x${k}`, 'nf3e', 'grupo');
    add(`<infNF3e xmlns="http://www.portalfiscal.inf.br/nf3e">${nfdet.repeat(k)}</infNF3e>`, `NFdet x${k} sem total`, 'nf3e', 'grupo');
    add(`<infNF3e xmlns="http://www.portalfiscal.inf.br/nf3e">${nfdet.repeat(k)}<ide/><total/></infNF3e>`, `NFdet x${k} ide depois`, 'nf3e', 'grupo');
  }
  const detNfe = '<det nItem="1"><imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></IBSCBS></imposto></det>';
  for (const k of [989, 990, 991, 995]) {
    add(`<infNFe ${NS_NFE}>${detNfe.repeat(k)}<total/></infNFe>`, `det x${k}`);
    add(`<infNFe ${NS_NFE}>${detNfe.repeat(k)}<ide/></infNFe>`, `det x${k} ide`);
  }
  // hashCSRT (xs:base64Binary with length 20 octets) inside infRespTec of the CTe/BPe nota examples
  for (const [id, tipo] of [['xml-01-09-valido-CTE-NOTA', 'cte'], ['xml-01-13-valido-BPE-NOTA', 'bpe']]) {
    const base = vetores('vectors-dados-unit.json').find((v) => v.id === id).input.xml;
    const fone = base.indexOf('</fone>', base.indexOf('<infRespTec')) + 7;
    for (const h of ['AAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAAAAAA==', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'AAAA AAAA AAAA AAAA AAAA AAA=', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAA=\n', '!!!!', '', 'QUJD', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=A', 'AAAAAAAAAAAAAAAAAAAAAAAAAAB=', ' AAAAAAAAAAAAAAAAAAAAAAAAAAA= ']) {
      add(`${base.slice(0, fone)}<idCSRT>001</idCSRT><hashCSRT>${h}</hashCSRT>${base.slice(fone)}`, `hashCSRT ${h}`, tipo, 'nota');
    }
  }
  // QNames of the namespace-aware scanner (a second colon ends the name; the local part must start an NCName)
  const NS_A = `${NS_NFE} xmlns:a="urn:a"`;
  for (const pre of ['', '<!DOCTYPE infNFe>']) {
    for (const el of ['a:1b', 'a:b:c', 'a::b', ':a', 'a:', 'a:b:', 'a:-b', 'a:.b', 'a:b1:2', 'a:\u00b7b', 'a:b:c:d', 'a1:b2', '::a', ':a:b', 'a:😀']) {
      add(`${pre}<infNFe ${NS_A}><${el}/></infNFe>`, `qname elemento ${el}`);
      add(`${pre}<infNFe ${NS_A}><${el}></${el}></infNFe>`, `qname elemento aberto ${el}`);
      add(`${pre}<infNFe ${NS_A}><det ${el}="1"/></infNFe>`, `qname atributo ${el}`);
    }
    for (const doc of [`<a:1b ${NS_A}/>`, `<infNFe ${NS_A} xmlns:1="urn:x"/>`, `<infNFe ${NS_A} xmlns:a:b="urn:x"/>`, `<infNFe ${NS_A}>&a:b;</infNFe>`, `<infNFe ${NS_A}><?a:b x?></infNFe>`]) {
      add(pre + doc, `qname ${doc.slice(0, 40)}`);
    }
  }
  add(`<!DOCTYPE a:b:c><infNFe ${NS_NFE}/>`, 'qname doctype');
  add(`<!DOCTYPE infNFe [<!ENTITY a:b "1">]><infNFe ${NS_NFE}>&a:b;</infNFe>`, 'qname entidade');
  // competApur (xs:gYearMonth with minInclusive 2025-01), only written by hand (the generation never emits it)
  const ajuste = (v) => NFE_OK.replace('<cClassTrib>000001</cClassTrib>', `<cClassTrib>000001</cClassTrib><gAjusteCompet><competApur>${v}</competApur><vIBS>1.00</vIBS><vCBS>1.00</vCBS></gAjusteCompet>`);
  const zfm = (v) => NFE_OK.replace('<cClassTrib>000001</cClassTrib>', `<cClassTrib>000001</cClassTrib><gCredPresIBSZFM><competApur>${v}</competApur><tpCredPresIBSZFM>1</tpCredPresIBSZFM><vCredPresIBSZFM>1.00</vCredPresIBSZFM></gCredPresIBSZFM>`);
  for (const v of ['2025-01', '2024-12', '2025-13', '2025-1', ' 2025-01 ', '2025-01Z', '2025-01+03:00', '-2025-01', '12025-01', '2025-00', '0000-01', '2025', '2025-01-01', '', '9999-12', '2025-02-14:00']) {
    add(ajuste(v), `competApur ${v}`);
    add(zfm(v), `competApur ZFM ${v}`);
  }
  return r;
}

// ─── Edge ROCs for generate ──────────────────────────────────────────────────────────────────────
const GRUPO_BASE = '{"vBC":"100.00","gIBSUF":{"pIBSUF":"0.10","vIBSUF":"0.10"},"gIBSMun":{"pIBSMun":"0.00","vIBSMun":"0.00"},"vIBS":"0.10","gCBS":{"pCBS":"0.90","vCBS":"0.90"}}';
function rocsDeBorda() {
  const obj = (ibscbs, extra = '') => `{"oper":{"gCompraGov":{"tpEnteGov":1,"pRedutor":10,"tpOperGov":2}},"objetos":[{"nObj":1,"tribCalc":{"IBSCBS":${ibscbs}}${extra}}],"total":{"tribCalc":{"IBSCBSTot":{"vBCIBSCBS":"100.00"}}}}`;
  const ib = (campos) => `{"CST":"000","cClassTrib":"000001",${campos}}`;
  return [
    '{}', 'null', '[]', '"x"', '1', 'true', '{"objetos":[]}', '{"objetos":null}', '{"objetos":[null]}', '{"objetos":[{}]}', '{"objetos":[{"nObj":1}]}',
    '{"objetos":[{"nObj":1,"tribCalc":{}}]}', '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{}}', '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"objetos":[{"nObj":1,"tribCalc":{"IBSCBS":{}}},{"nObj":2,"tribCalc":{"IBSCBS":{}}}],"total":{"tribCalc":{}}}',
    '{"objetos":[{"nObj":1,"tribCalc":null}],"total":{"tribCalc":{}}}', '{"objetos":[{"nObj":null,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    obj(ib(`"gIBSCBS":${GRUPO_BASE}`)),
    obj(ib('"gIBSCBS":{"vBC":1e3,"gIBSUF":{},"vIBS":0.0000001,"gCBS":{"gDif":{}}}')),
    obj(ib('"gIBSCBS":{"vBC":"1E+400","vIBS":-0.00,"gCBS":{"pCBS":"-1","vCBS":12345678901234567890.123456789}}')),
    obj(ib('"gIBSCBS":{"vBC":"  12.30 ","vIBS":"","gIBSMun":null,"gCBS":{"gRed":{"pRedAliq":1e-7,"pAliqEfet":"0E-10"}}}')),
    obj(ib('"indDoacao":1.9,"gIBSCBSMono":{"gMonoPadrao":{},"vTotIBSMonoItem":null,"vTotCBSMonoItem":"1.10"},"gTransfCred":{},"gAjusteCompet":{"competApur":"2026-01","vIBS":"1.5"},"gEstornoCred":{"vIBSEstCred":1},"gCredPresOper":{"vBCCredPres":"2","cCredPres":"3","gIBSCredPres":{"pCredPres":1},"gCBSCredPres":{}},"gCredPresIBSZFM":{"tpCredPresIBSZFM":1}')),
    obj('{"CST":"a<b&c>d\\"e\'f\\r\\ng\\th","cClassTrib":"","memoriaCalculo":{"cbs":"x"}}'),
    obj('{"CST":"\\u0001\\u0000\\ud800","cClassTrib":"ç€😀"}'),
    obj(ib('"gIBSCBS":{"gTribRegular":{"CSTReg":"000","cClassTribReg":"000001"},"gTribCompraGov":{}}')),
    obj(ib('"desconhecido":{"a":[1,2]},"CST":"200","CST":"300"')),
    obj(ib('"gIBSCBS":{"vBC":{}}')), obj(ib('"gIBSCBS":{"vBC":[1]}')), obj(ib('"gIBSCBS":{"vBC":true}')), obj(ib('"gIBSCBS":{"vBC":"abc"}')), obj(ib('"gIBSCBS":"x"')),
    obj(ib('"indDoacao":"x"')), obj(ib('"indDoacao":99999999999')), obj(ib('"indDoacao":" 7 "')), obj(ib('"CST":12')), obj(ib('"CST":1.50')), obj(ib('"CST":true')),
    obj(ib('"gIBSCBS":' + GRUPO_BASE), ',"IS":{"CSTIS":"000","cClassTribIS":"000001","vBCIS":"10","pIS":"1","uTrib":"UN","qTrib":"2","vIS":"0.10","adRemIS":"9","memoriaCalculo":"m"}'),
    obj(ib('"gIBSCBS":' + GRUPO_BASE), ',"calculoSimulado":null'), obj(ib('"gIBSCBS":' + GRUPO_BASE), ',"calculoSimulado":"sim"'), obj(ib('"gIBSCBS":' + GRUPO_BASE), ',"calculoSimulado":1'),
    '{"oper":{"gCompraGov":{"tpEnteGov":9}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"oper":{"gCompraGov":{"tpEnteGov":"3","tpOperGov":"5","pRedutor":"12.34567"}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"oper":{"gCompraGov":{"pRedutor":1e10}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"oper":{"gCompraGov":{"pRedutor":-0.00005}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"oper":{"gCompraGov":{"pRedutor":null,"tpEnteGov":null}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"oper":{"gCompraGov":{}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}', '{"oper":{},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"oper":{"gCompraGov":{"tpEnteGov":""}},"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"objetos":[{"nObj":-5,"tribCalc":{}},{"nObj":2147483647,"tribCalc":{}}],"total":{"tribCalc":{"ISTot":{},"IBSCBSTot":{"gIBS":{"gIBSUF":{},"gIBSMun":{}},"gCBS":{},"gMono":{},"gEstornoCred":{}}}}}',
    '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{"ISTot":{"vIS":null},"IBSCBSTot":{"vBCIBSCBS":"1","gIBS":{"vIBS":"2","vCredPres":"3","vCredPresCondSus":"4"},"gCBS":{"vCredPres":"5"}}}}}',
    '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}} x', '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}  ', '{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}', '{"objetos":[', '{,}', ' ', '\n',
    '{"objetos":"x"}', '{"objetos":{}}', '{"objetos":[1]}', '{"objetos":[[]]}', '{"objetos":[{"nObj":"1"}],"total":{"tribCalc":{}}}', '{"objetos":[{"nObj":1.7,"tribCalc":{}}],"total":{"tribCalc":{}}}',
    '{"total":5}', '{"total":{"tribCalc":5}}', '{"oper":"x"}', '{"oper":{"gCompraGov":[]}}',
  ];
}

/** Jackson coercion matrix: every field kind of the ROC classes with values of every JSON shape. */
const VALORES_CAMPO = {
  int: ['1', '1.9', '-1.9', '"7"', '" 7 "', '""', '"x"', 'true', 'null', '2147483648', '-2147483649', '1e2', '1E0', '"1.5"', '[]', '{}', '[1]', '0.0', '-0', '"0x1"', '"+5"', '"1e2"', '9.99e9'],
  bd: ['1', '"1.50"', '1.50', '1e3', '"1e3"', '" 1 "', '""', '"x"', 'true', 'null', '[]', '{}', '[1]', '"NaN"', '"Infinity"', '"-0"', '0E-10', '"1E+400000"', '-1.5e-3', '"0x10"', '"1_000"', '"+1"', '".5"', '"5."', '1E-400000'],
  str: ['"x"', '1', '1.50', 'true', 'null', '[]', '{}', '[1]', '""', '" "', '"a\\u0000b"', '1e3', '"\\ud800"'],
  enum: ['1', '2', '6', '7', '0', '-1', '"2"', '" 2"', '"2.0"', '2.0', '2.5', 'true', 'null', '""', '"x"', '[]', '{}', '"ENTE"', '5', '"5"'],
  bool: ['true', 'false', '"true"', '"True"', '"TRUE"', '"yes"', '1', '0', '2', 'null', '""', '1.5', '[]', '{}', '"false "'],
  obj: ['{}', 'null', '[]', '"x"', '1', 'true', '[{}]', '""'],
  lista: ['[]', 'null', '{}', '"x"', '[null]', '[1]', '[[]]', '{"nObj":1}', '""'],
};
const ROC_COMPLETO = {
  oper: { gCompraGov: { tpEnteGov: 1, pRedutor: '10.00', tpOperGov: 2 } },
  objetos: [{
    nObj: 1, calculoSimulado: false,
    tribCalc: {
      IS: { CSTIS: '000', cClassTribIS: '000001', vBCIS: '10.00', pIS: '1.00', pISEspec: '1.00', adRemIS: '1', uTrib: 'UN', qTrib: '2', vIS: '0.10', memoriaCalculo: 'm' },
      IBSCBS: {
        CST: '000', cClassTrib: '000001', indDoacao: 1,
        gIBSCBS: { vBC: '100.00', gIBSUF: { pIBSUF: '0.10', gDif: { pDif: '1', vDif: '1' }, gDevTrib: { pDevTrib: '1', vDevTrib: '1' }, gRed: { pRedAliq: '1', pAliqEfet: '1' }, vIBSUF: '0.10' }, gIBSMun: { pIBSMun: '0.00', vIBSMun: '0.00' }, vIBS: '0.10', gCBS: { pCBS: '0.90', vCBS: '0.90' }, gTribRegular: { CSTReg: '000', cClassTribReg: '000001', pAliqEfetRegIBSUF: '1' }, gTribCompraGov: { pAliqIBSUF: '1' } },
        gIBSCBSMono: { gMonoPadrao: { qBCMono: '1' }, gMonoReten: { qBCMonoReten: '1' }, gMonoRet: { qBCMonoRet: '1' }, gMonoDif: { pDifIBS: '1' }, vTotIBSMonoItem: '1', vTotCBSMonoItem: '1' },
        gTransfCred: { vIBS: '1', vCBS: '1' }, gAjusteCompet: { competApur: '2025-01', vIBS: '1', vCBS: '1' }, gEstornoCred: { vIBSEstCred: '1', vCBSEstCred: '1' },
        gCredPresOper: { vBCCredPres: '1', cCredPres: 1, gIBSCredPres: { pCredPres: '1', vCredPres: '1', vCredPresCondSus: '1' }, gCBSCredPres: { pCredPres: '1' } },
        gCredPresIBSZFM: { competApur: '2025-01', tpCredPresIBSZFM: 1, vCredPresIBSZFM: '1' }, memoriaCalculo: { cbs: 'a', ibsUF: 'b', ibsMun: 'c' },
      },
    },
  }],
  total: { tribCalc: { ISTot: { vIS: '1' }, IBSCBSTot: { vBCIBSCBS: '1', gIBS: { gIBSUF: { vDif: '1', vDevTrib: '1', vIBSUF: '1' }, gIBSMun: { vIBSMun: '1' }, vIBS: '1', vCredPres: '1', vCredPresCondSus: '1' }, gCBS: { vCBS: '1', vCredPres: '1' }, gMono: { vIBSMono: '1' }, gEstornoCred: { vIBSEstCred: '1' } } } },
};
/** [path, kind] of the fields exercised by the matrix. */
const CAMPOS_ROC = [
  ['oper', 'obj'], ['oper.gCompraGov', 'obj'], ['oper.gCompraGov.tpEnteGov', 'enum'], ['oper.gCompraGov.pRedutor', 'bd'], ['oper.gCompraGov.tpOperGov', 'enum'],
  ['objetos', 'lista'], ['objetos.0', 'obj'], ['objetos.0.nObj', 'int'], ['objetos.0.calculoSimulado', 'bool'], ['objetos.0.tribCalc', 'obj'], ['objetos.0.tribCalc.IS', 'obj'],
  ['objetos.0.tribCalc.IS.CSTIS', 'str'], ['objetos.0.tribCalc.IS.vBCIS', 'bd'], ['objetos.0.tribCalc.IS.memoriaCalculo', 'str'], ['objetos.0.tribCalc.IBSCBS', 'obj'],
  ['objetos.0.tribCalc.IBSCBS.CST', 'str'], ['objetos.0.tribCalc.IBSCBS.indDoacao', 'int'], ['objetos.0.tribCalc.IBSCBS.memoriaCalculo', 'obj'], ['objetos.0.tribCalc.IBSCBS.gIBSCBS', 'obj'],
  ['objetos.0.tribCalc.IBSCBS.gIBSCBS.vBC', 'bd'], ['objetos.0.tribCalc.IBSCBS.gIBSCBS.gIBSUF', 'obj'], ['objetos.0.tribCalc.IBSCBS.gIBSCBS.gIBSUF.pIBSUF', 'bd'],
  ['objetos.0.tribCalc.IBSCBS.gIBSCBS.gIBSUF.gDif.vDif', 'bd'], ['objetos.0.tribCalc.IBSCBS.gIBSCBS.gIBSUF.gRed', 'obj'], ['objetos.0.tribCalc.IBSCBS.gIBSCBS.gTribRegular.CSTReg', 'str'],
  ['objetos.0.tribCalc.IBSCBS.gIBSCBSMono.vTotIBSMonoItem', 'bd'], ['objetos.0.tribCalc.IBSCBS.gIBSCBSMono.gMonoPadrao', 'obj'], ['objetos.0.tribCalc.IBSCBS.gAjusteCompet.competApur', 'str'],
  ['objetos.0.tribCalc.IBSCBS.gCredPresOper.cCredPres', 'int'], ['objetos.0.tribCalc.IBSCBS.gCredPresOper.gIBSCredPres', 'obj'], ['objetos.0.tribCalc.IBSCBS.gCredPresIBSZFM.tpCredPresIBSZFM', 'int'],
  ['objetos.0.tribCalc.IBSCBS.gEstornoCred.vIBSEstCred', 'bd'], ['total', 'obj'], ['total.tribCalc', 'obj'], ['total.tribCalc.ISTot.vIS', 'bd'], ['total.tribCalc.IBSCBSTot', 'obj'],
  ['total.tribCalc.IBSCBSTot.gIBS.gIBSUF.vDif', 'bd'], ['total.tribCalc.IBSCBSTot.gCBS.vCredPres', 'bd'], ['total.tribCalc.IBSCBSTot.gMono', 'obj'],
];

/** One ROC per (field, value): the JSON text with that field replaced by the raw value. */
function rocsCampos() {
  const r = [];
  for (const [caminho, tipo] of CAMPOS_ROC) {
    for (const valor of VALORES_CAMPO[tipo]) {
      const obj = JSON.parse(JSON.stringify(ROC_COMPLETO));
      const partes = caminho.split('.');
      let o = obj;
      for (const p of partes.slice(0, -1)) o = o[p];
      o[partes[partes.length - 1]] = '@@valor@@';
      r.push([JSON.stringify(obj).replace('"@@valor@@"', valor), `${caminho}=${valor}`]);
    }
  }
  return r;
}

/** Numeric lexemes for the BigDecimal fields of a ROC (JSON numbers are written without quotes). */
const NUMEROS_ROC = ['"1E+3"', '1e3', '1.5e3', '0.0000001', '"0.0000001"', '-0.00', '"-1"', '12345678901234567890.123456789', '"1E+400"', '1e-7', '"0E-10"', '0E+3', '" 12.30 "',
  '""', '"0"', '0', '250.0', '"250"', '1E-400', '"abc"', 'null', '"12,30"', '9.99999999999999999999999999999999999999', '-1.9', '"+1.5"', '".5"', '"5."', '1.0E+10'];

/** The oracle's ROCs with numeric values, integers and groups changed. */
function rocsMutados(rocs, rnd, quantidade) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const r = [];
  for (let k = 0; k < quantidade; k++) {
    let obj;
    try { obj = JSON.parse(pick(rocs)); } catch { continue; }
    const marcas = [];
    const visitar = (o) => {
      if (Array.isArray(o)) { o.forEach(visitar); return; }
      if (!o || typeof o !== 'object') return;
      for (const [chave, v] of Object.entries(o)) {
        if (v && typeof v === 'object') {
          if (rnd() < 0.04) { delete o[chave]; continue; }
          if (rnd() < 0.02) { o[chave] = null; continue; }
          visitar(v);
        } else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && rnd() < 0.15) {
          marcas.push(pick(NUMEROS_ROC));
          o[chave] = `@@${marcas.length - 1}@@`;
        } else if ((chave === 'nObj' || chave === 'indDoacao' || chave === 'tpEnteGov') && rnd() < 0.2) {
          marcas.push(pick(['1.9', '"2"', '-5', '2147483647', '2147483648', '"x"', 'null', '0', '3']));
          o[chave] = `@@${marcas.length - 1}@@`;
        }
      }
    };
    visitar(obj);
    r.push(JSON.stringify(obj).replace(/"@@(\d+)@@"/g, (_, i) => marcas[Number(i)]));
  }
  return r;
}

export async function gerar({ seed = 1, n = 300 } = {}) {
  const rnd = prng(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const casos = [];
  const add = (metodo, caminho, headers = {}, corpo, rotulo) => {
    const h = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    casos.push({ metodo, caminho, headers: h, corpo, rotulo });
  };
  const GEN = '/api/calculadora/xml/generate';
  const VAL = '/api/calculadora/xml/validate';

  // ── lists ───────────────────────────────────────────────────────────────────────────────────
  for (const p of [GEN, VAL]) {
    for (const a of [undefined, 'application/json', '*/*', 'application/xml', 'text/plain', 'application/*', 'application/problem+json', 'foo']) add('GET', p, { accept: a }, undefined, `lista accept ${a}`);
    add('GET', `${p}?tipo=nfe`, {}, undefined, 'lista com parâmetro');
    add('HEAD', p, {}, undefined, 'lista HEAD');
  }

  // ── generate ────────────────────────────────────────────────────────────────────────────────
  const rocs = await rocsDoOraculo(Math.max(20, Math.floor(n / 6)));
  for (const roc of rocs) for (const t of TIPOS_GERACAO) add('POST', `${GEN}?tipo=${t}`, { 'content-type': 'application/json' }, roc, `generate ROC oráculo ${t}`);
  for (const roc of rocsDeBorda()) {
    for (const t of TIPOS_GERACAO) if (rnd() < 0.6) add('POST', `${GEN}?tipo=${t}`, { 'content-type': 'application/json' }, roc, `generate borda ${t}`);
  }
  for (const [roc, rotulo] of rocsCampos()) {
    add('POST', `${GEN}?tipo=${rnd() < 0.7 ? 'nfe' : pick(TIPOS_GERACAO)}`, { 'content-type': 'application/json' }, roc, `generate campo ${rotulo}`);
  }
  for (const roc of rocsMutados(rocs, rnd, Math.max(40, Math.floor(n / 2)))) {
    add('POST', `${GEN}?tipo=${pick(TIPOS_GERACAO)}`, { 'content-type': 'application/json' }, roc, 'generate ROC oráculo mutado');
  }
  const rocExemplo = rocs[0];
  for (const q of ['', 'tipo=', 'tipo=%20', 'tipo=NFE', 'tipo=Nf3E', 'tipo=nfse', 'tipo=NFSE', 'tipo=xx', 'tipo=CTE_SIMPLIFICADO', 'tipo=BPE_TM', 'tipo=bpe_tm', 'tipo=%20NFE%20',
    'tipo=nfe%20', 'tipo=%09NF3E', 'tipo=nfe&tipo=nfce', 'tipo=xx&tipo=nfe', 'tipo=&tipo=nfe', 'tipo=nf%C4%B1e', 'tipo=%C5%BFx', 'tipo=n%66e', 'outro=1', 'tipo=%ZZ', 'tipo=cte-SIMPLIFICADO']) {
    add('POST', `${GEN}${q ? `?${q}` : ''}`, { 'content-type': 'application/json' }, rocExemplo, `generate tipo ${q}`);
  }
  for (const ct of ['application/json;charset=UTF-8', 'application/json;charset=ISO-8859-1', 'application/xml', 'text/plain', undefined, 'application/json; charset=utf-16']) {
    add('POST', `${GEN}?tipo=nfe`, { 'content-type': ct }, rocExemplo, `generate content-type ${ct}`);
  }
  for (const a of ['application/xml', 'application/json', '*/*', 'text/xml', 'application/*', 'application/xml;q=0.5, application/json', 'text/plain']) {
    add('POST', `${GEN}?tipo=nfe`, { 'content-type': 'application/json', accept: a }, rocExemplo, `generate accept ${a}`);
    add('POST', `${GEN}?tipo=xx`, { 'content-type': 'application/json', accept: a }, rocExemplo, `generate erro accept ${a}`);
  }
  add('POST', `${GEN}?tipo=nfe`, { 'content-type': 'application/json' }, '', 'generate corpo vazio');
  add('POST', `${GEN}?tipo=xx`, { 'content-type': 'application/json' }, '', 'generate corpo vazio tipo inválido');
  add('POST', `${GEN}?tipo=nfe`, { 'content-type': 'application/json' }, Buffer.from([0x7b, 0x22, 0x6f, 0xff, 0x22, 0x3a, 0x31, 0x7d]), 'generate UTF-8 inválido');

  // ── validate ────────────────────────────────────────────────────────────────────────────────
  const validos = exemplosValidos();
  // XML generated by the oracle for its own ROCs (valid or not against the group schema)
  for (const roc of rocs.slice(0, 8)) {
    for (const t of TIPOS_GERACAO) {
      try {
        const r = await fetch(`${ORACULO}${GEN}?tipo=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: roc, signal: AbortSignal.timeout(20_000) });
        if (r.status === 200) validos.push({ tipo: t, subtipo: 'grupo', xml: await r.text(), origem: `gerado ${t}` });
      } catch { break; }
    }
  }
  for (const d of validos) add('POST', `${VAL}?tipo=${d.tipo}&subtipo=${d.subtipo}`, { 'content-type': 'application/xml' }, d.xml, `validate ${d.origem}`);
  const porDoc = Math.max(20, Math.ceil((n * 4) / validos.length));
  for (const d of validos) {
    for (const m of mutacoes(d, rnd, porDoc)) add('POST', `${VAL}?tipo=${m.tipo}&subtipo=${m.subtipo}`, { 'content-type': 'application/xml' }, m.xml, `validate ${m.rotulo}`);
  }
  for (const d of exemplosInvalidos()) add('POST', `${VAL}?tipo=${d.tipo}&subtipo=${d.subtipo}`, { 'content-type': 'application/xml' }, d.xml, `validate ${d.origem}`);
  // systematic perturbations of every example, sampled (every candidate when n is large enough)
  const candidatos = validos.flatMap((d) => sistematicos(d));
  const orcamento = Math.min(candidatos.length, n * 15);
  for (let k = candidatos.length - 1; k > 0; k--) {
    const j = Math.floor(rnd() * (k + 1));
    [candidatos[k], candidatos[j]] = [candidatos[j], candidatos[k]];
  }
  for (const c of candidatos.slice(0, orcamento)) {
    add('POST', `${VAL}?tipo=${c.tipo}&subtipo=${c.subtipo}`, { 'content-type': 'application/xml' }, c.montar(), `validate ${c.rotulo}`);
  }
  for (const [tipo, subtipo, corpo, rotulo] of casosDtd()) add('POST', `${VAL}?tipo=${tipo}&subtipo=${subtipo}`, { 'content-type': 'application/xml' }, corpo, `validate ${rotulo}`);
  const ex = validos[0];
  for (const q of ['', 'tipo=nfe', 'subtipo=grupo', 'tipo=nfe&subtipo=', 'tipo=nfe&subtipo=%20', 'tipo=nfe&subtipo=GRUPO', 'tipo=nfe&subtipo=Grupo%20', 'tipo=nfe&subtipo=grupo.xsd',
    'tipo=nfe&subtipo=x', 'tipo=x&subtipo=x', 'tipo=&subtipo=x', 'tipo=NFE&subtipo=NOTA', 'tipo=nfe&subtipo=grupo&subtipo=nota', 'tipo=nfe&subtipo=xx&subtipo=grupo', 'tipo=nfe&subtipo=%C4%B1', 'subtipo=grupo&tipo=nfe']) {
    add('POST', `${VAL}${q ? `?${q}` : ''}`, { 'content-type': 'application/xml' }, ex.xml, `validate parâmetros ${q}`);
  }
  for (const ct of ['application/xml;charset=UTF-8', 'application/xml;charset=ISO-8859-1', 'text/xml', 'application/json', undefined, 'application/*', 'application/xml; charset=utf-16']) {
    add('POST', `${VAL}?tipo=${ex.tipo}&subtipo=${ex.subtipo}`, { 'content-type': ct }, ex.xml, `validate content-type ${ct}`);
  }
  for (const a of ['application/json', 'application/xml', '*/*', 'text/plain', 'application/problem+json']) {
    add('POST', `${VAL}?tipo=${ex.tipo}&subtipo=${ex.subtipo}`, { 'content-type': 'application/xml', accept: a }, ex.xml, `validate accept ${a}`);
    add('POST', `${VAL}?tipo=${ex.tipo}&subtipo=${ex.subtipo}`, { 'content-type': 'application/xml', accept: a }, 'abc', `validate erro accept ${a}`);
  }
  add('POST', `${VAL}?tipo=nfe&subtipo=grupo`, { 'content-type': 'application/xml' }, '', 'validate corpo vazio');
  add('POST', `${VAL}?tipo=x&subtipo=grupo`, { 'content-type': 'application/xml' }, '', 'validate corpo vazio tipo inválido');
  add('POST', `${VAL}?tipo=nfe&subtipo=grupo`, { 'content-type': 'application/xml' }, Buffer.concat([Buffer.from('<infNFe xmlns="http://www.portalfiscal.inf.br/nfe"><det nItem="'), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('"/></infNFe>')]), 'validate UTF-8 inválido');
  add('POST', `${VAL}?tipo=nfe&subtipo=grupo`, { 'content-type': 'application/xml;charset=ISO-8859-1' }, Buffer.from('<infNFe xmlns="http://www.portalfiscal.inf.br/nfe"><det nItem="\xe7"/></infNFe>', 'latin1'), 'validate latin1');
  // body charsets (StringHttpMessageConverter: JDK decoders in REPLACE mode)
  const docCs = '<infNFe xmlns="http://www.portalfiscal.inf.br/nfe"><det nItem="ç😀"/></infNFe>';
  const u16le = Buffer.from(docCs, 'utf16le');
  const u16be = Buffer.from(u16le).swap16();
  const u32 = (b, le) => Buffer.from([...b].flatMap((_, k) => (k % 2 ? [] : le ? [b[k], b[k + 1], 0, 0] : [0, 0, b[k], b[k + 1]])));
  for (const [ct, corpo] of [
    ['UTF-16', Buffer.concat([Buffer.from([0xfe, 0xff]), u16be])], ['UTF-16', Buffer.concat([Buffer.from([0xff, 0xfe]), u16le])], ['UTF-16', u16be], ['UTF-16LE', u16le],
    ['UTF-16BE', u16be], ['UTF-16BE', Buffer.concat([u16be, Buffer.from([0x41])])], ['UTF-16BE', Buffer.concat([u16be.subarray(0, 20), Buffer.from([0xd8, 0x00, 0x00, 0x41]), u16be.subarray(20)])],
    ['UTF-16', Buffer.concat([Buffer.from([0xfe, 0xff]), u16be, Buffer.from([0xd8, 0x00])])], ['UTF-16', Buffer.concat([Buffer.from([0xfe, 0xff, 0xff, 0xfe]), u16be])],
    ['UTF-32', u32(u16be, false)], ['UTF-32LE', u32(u16le, true)], ['UTF-32', Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), u32(u16le, true)])], ['UTF-32', Buffer.from(docCs)],
    ['windows-1252', Buffer.from(docCs.replace('😀', '\x80'), 'latin1')], ['windows-1252', Buffer.concat([Buffer.from('<infNFe xmlns="http://www.portalfiscal.inf.br/nfe"><det nItem="'), Buffer.from([0x81, 0x80]), Buffer.from('"><imposto/></det></infNFe>')])],
    ['US-ASCII', Buffer.from(docCs)], ['US-ASCII', Buffer.from(docCs.replace('<det', '<d\u00e9t'))], ['"utf-8"', Buffer.from(docCs)], ['ISO-8859-15', Buffer.from(docCs, 'latin1')], ['Cp1252', Buffer.from(docCs, 'latin1')], ['foo', Buffer.from(docCs)],
  ]) {
    add('POST', `${VAL}?tipo=nfe&subtipo=grupo`, { 'content-type': `application/xml;charset=${ct}` }, corpo, `validate charset ${ct}`);
  }
  add('POST', `${GEN}?tipo=nfe`, { 'content-type': 'application/json;charset=UTF-16' }, Buffer.from('{"objetos":[{"nObj":1,"tribCalc":{}}],"total":{"tribCalc":{}}}', 'utf16le'), 'generate charset UTF-16');
  // many det (maxOccurs 990)
  const det = '<det nItem="1"><imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></IBSCBS></imposto></det>';
  for (const k of [990, 991]) add('POST', `${VAL}?tipo=nfce&subtipo=grupo`, { 'content-type': 'application/xml' }, `<infNFe xmlns="http://www.portalfiscal.inf.br/nfe">${det.repeat(k)}<total/></infNFe>`, `validate ${k} det`);
  void pick;
  return casos;
}
