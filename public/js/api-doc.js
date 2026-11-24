// Renders /api/openapi.json as a simple list: method, path, summary, parameters, example body
// and a curl line. The curl line carries only real examples (EXEMPLOS below, then the document's
// own); a value the document does not give stays a visible placeholder (<nome>, {nome}) and a body
// without a complete example goes in a file (--data-binary @corpo.json), never a schema skeleton
// with type names as values (that only returns 4xx).
import { $, el, api } from './comum.js';

/** Operation of the page's main example (the same one as in the README). */
const OPERACAO = '{"id":"1","versao":"1.0.0","dhFatoGerador":"2026-03-10T10:00:00-03:00","municipio":4314902,"uf":"RS","itens":[{"numero":1,"ncm":"10063021","cst":"000","cClassTrib":"000001","baseCalculo":100.00}]}';

/**
 * Examples for operations whose entry in docs/openapi.json has none that works (the official
 * contracts come from the Receita's springdoc export). They win over the document.
 * Key: "MÉTODO /caminho" as in the document. corpo = JSON text; parametros = path/query values;
 * arquivo = body sent from a file (with `dica` saying what goes in it); cabecalhos = extra headers.
 */
export const EXEMPLOS = {
  'POST /calculadora/regime-geral': { corpo: OPERACAO },
  'POST /calculadora/observabilidade/regime-geral': { corpo: OPERACAO },
  'POST /calculadora/pedagio': { corpo: '{"dataHoraEmissao":"2026-10-20T10:00:00-03:00","codigoMunicipioOrigem":4314902,"ufMunicipioOrigem":"RS","cst":"000","cClassTrib":"000001","baseCalculo":200.00,"trechos":[{"numero":1,"municipio":4314902,"uf":"RS","extensao":10}]}' },
  // official vector SimplesNacionalControllerTest:40 (2027, NF-e, Anexo I)
  'POST /calculadora/observabilidade/simples-nacional': { corpo: '{"id":"507f1f77bcf86cd799439011","versao":"2.0.0","data":"2027-03-15","tpDoc":"55","CRT":"1","itens":[{"numero":1,"cAtivSN":"01","cClassTrib":"000001","baseCalculo":"950.00","valorImpostoSeletivo":"50.00","pIBSSN":"1.25","pCBSSN":"2.75"}]}' },
  'GET /calculadora/observabilidade/erros': { parametros: { codigo: 'REG-001' } },
  'GET /calculadora/observabilidade/simples-nacional/erros': { parametros: { codigo: 'VSN-018' } },
  // the Simples activity tables start in 2027: the upstream example date (2026-01-01) lists nothing
  'GET /calculadora/simples-nacional/atividades': { parametros: { data: '2027-01-01' } },
  'GET /calculadora/simples-nacional/atividades/{codigo}': { parametros: { data: '2027-01-01' } },
  'POST /calculadora/xml/generate': { arquivo: 'roc.json', dica: 'roc.json = a resposta de POST /calculadora/regime-geral.' },
  'POST /calculadora/xml/validate': { arquivo: 'grupo.xml', dica: 'grupo.xml = o XML a validar (subtipo=grupo: só o grupo IBSCBS; subtipo=nota: a nota inteira).' },
  'POST /notas': { arquivo: 'nota.xml', cabecalhos: { 'x-filename': 'nota.xml' }, dica: 'nota.xml = o XML da nota (ou o PDF do DANFSe). A resposta traz o campo "nota".' },
  'POST /regime-regular/preparar': { arquivo: 'notas.json', dica: 'notas.json = {"notas":[…]} com o campo "nota" de cada resposta de POST /notas (não a resposta inteira).' },
};

/** Markdown `code` spans of a description as <code> elements (text nodes otherwise; no HTML parsing). */
const comCodigo = (texto) => String(texto).split('`').map((t, i) => (i % 2 ? el('code', {}, t) : t));

/** Shell single quotes. */
const aspas = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ARQUIVO_POR_TIPO = { 'application/json': 'corpo.json', 'application/xml': 'arquivo.xml', 'text/xml': 'arquivo.xml' };

/**
 * The call of one operation: { curl, corpo (example text or null), esquema (field skeleton, only
 * to show the shape), executavel (no placeholder and no file to fill), dica }.
 */
export function montarChamada(doc, base, path, metodo, op, { auth = '' } = {}) {
  const resolver = (ref) => (ref?.$ref ? doc.components?.schemas?.[ref.$ref.split('/').pop()] : ref);
  const extra = EXEMPLOS[`${metodo} ${path}`] ?? {};
  const SEM = undefined;

  /** Complete example built only from the document's examples (every field has one), else SEM. */
  function exemploCompleto(schema, prof = 0) {
    const s = resolver(schema);
    if (!s || prof > 10) return SEM;
    if (s.example !== undefined) return s.example;
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if (s.properties) {
      const o = {};
      for (const [k, v] of Object.entries(s.properties)) {
        const x = exemploCompleto(v, prof + 1);
        if (x === SEM) return SEM;
        o[k] = x;
      }
      return o;
    }
    if (s.type === 'array' || s.items) { const x = exemploCompleto(s.items, prof + 1); return x === SEM ? SEM : [x]; }
    return SEM;
  }
  /** Field names with their types: shown as the body's shape, never sent. */
  function esqueleto(schema, prof = 0) {
    const s = resolver(schema);
    if (!s || prof > 4) return null;
    if (s.example !== undefined) return s.example;
    if (s.type === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).slice(0, 12).map(([k, v]) => [k, esqueleto(v, prof + 1)]));
    if (s.type === 'array') return [esqueleto(s.items, prof + 1)];
    return s.type ?? null;
  }
  const valor = (p) => {
    if (extra.parametros?.[p.name] !== undefined) return extra.parametros[p.name];
    if (p.example !== undefined) return p.example;
    if (p.schema?.example !== undefined) return p.schema.example;
    const nomeado = p.examples && Object.values(p.examples)[0];
    if (nomeado?.value !== undefined) return nomeado.value;
    return p.schema?.enum?.[0];
  };

  let executavel = true;
  const parametros = op.parameters ?? [];
  const caminho = path.replace(/\{([^}]+)\}/g, (_, nome) => {
    const v = valor(parametros.find((p) => p.in === 'path' && p.name === nome) ?? { name: nome });
    if (v === undefined) { executavel = false; return `{${nome}}`; }
    return encodeURIComponent(v);
  });
  const qs = parametros.filter((p) => p.in === 'query' && p.required).map((p) => {
    const v = valor(p);
    if (v === undefined) { executavel = false; return `${p.name}=<${p.name}>`; }
    return `${p.name}=${encodeURIComponent(v)}`;
  }).join('&');

  let partes = '';
  let corpo = null;
  let esquema = null;
  const conteudo = op.requestBody?.content ?? {};
  const json = conteudo['application/json'];
  for (const [k, v] of Object.entries(extra.cabecalhos ?? {})) partes += ` -H ${aspas(`${k}: ${v}`)}`;
  if (extra.corpo !== undefined) {
    corpo = extra.corpo;
  } else if (json && !extra.arquivo) {
    const nomeado = json.examples && Object.values(json.examples)[0];
    const ex = json.example ?? nomeado?.value ?? exemploCompleto(json.schema);
    if (ex !== undefined) corpo = typeof ex === 'string' ? ex : JSON.stringify(ex);
    else esquema = esqueleto(json.schema);
  }
  if (corpo != null) {
    partes += ` -H 'Content-Type: application/json' -d ${aspas(corpo)}`;
  } else if (op.requestBody) {
    const tipo = Object.keys(conteudo)[0] ?? 'application/octet-stream';
    const arquivo = extra.arquivo ?? ARQUIVO_POR_TIPO[tipo] ?? 'arquivo';
    partes += ` -H ${aspas(`Content-Type: ${tipo}`)} --data-binary ${aspas(`@${arquivo}`)}`;
    executavel = false;
  }
  const curl = `curl -s -X ${metodo} ${aspas(`${base}${caminho}${qs ? `?${qs}` : ''}`)}${auth}${partes}`;
  return { curl, corpo, esquema, executavel, dica: extra.dica ?? null };
}

const formatar = (texto) => { try { return JSON.stringify(JSON.parse(texto), null, 2); } catch { return texto; } };

if (typeof document !== 'undefined') {
  const base = `${location.origin}/api`;
  $('#base').textContent = base;
  const info = (await api('/api/info')).body;
  $('#token-info').textContent = info?.autenticacao
    ? 'Este servidor exige token: envie o cabeçalho Authorization: Bearer <token> (ou X-API-Key: <token>). Peça o token a quem publicou a calculadora.'
    : 'Este servidor não exige token (modo local).';
  const auth = info?.autenticacao ? " -H 'Authorization: Bearer SEU_TOKEN'" : '';
  $('#exemplo-curl').textContent = `curl -s -X POST '${base}/calculadora/observabilidade/regime-geral'${auth} \\
  -H 'Content-Type: application/json' \\
  -d '{"id":"1","versao":"1.0.0","dhFatoGerador":"2026-03-10T10:00:00-03:00","municipio":4314902,"uf":"RS",
       "itens":[{"numero":1,"ncm":"10063021","cst":"000","cClassTrib":"000001","baseCalculo":100.00}]}'`;

  const doc = (await api('/api/openapi.json')).body;
  const rotas = [];
  for (const [path, metodos] of Object.entries(doc.paths)) {
    for (const [metodo, op] of Object.entries(metodos)) rotas.push({ path, metodo: metodo.toUpperCase(), op, tag: op.tags?.[0] ?? 'Outras' });
  }

  const render = (filtro = '') => {
    const f = filtro.toLowerCase();
    const grupos = new Map();
    for (const r of rotas.filter((x) => !f || `${x.path} ${x.op.summary ?? ''} ${x.tag}`.toLowerCase().includes(f))) {
      if (!grupos.has(r.tag)) grupos.set(r.tag, []);
      grupos.get(r.tag).push(r);
    }
    $('#rotas').replaceChildren(...[...grupos].map(([tag, lista]) => el('div', { class: 'grupo-api' },
      el('h3', {}, tag),
      ...lista.map(({ path, metodo, op }) => {
        const c = montarChamada(doc, base, path, metodo, op, { auth });
        const params = (op.parameters ?? []).map((p) => `${p.name}${p.required ? '*' : ''} (${p.in})`).join(', ');
        return el('details', { class: 'explica rota-api' },
          el('summary', {}, el('span', { class: `metodo m-${metodo.toLowerCase()}` }, metodo), ' ', el('code', {}, path), op.summary ? el('span', { class: 'sub' }, op.summary) : null),
          el('div', { class: 'conta' },
            op.description ? el('p', {}, ...comCodigo(op.description)) : null,
            params ? el('p', {}, el('strong', {}, 'Parâmetros: '), params) : null,
            c.corpo != null ? el('pre', { class: 'json' }, formatar(c.corpo)) : null,
            c.esquema != null ? el('p', { class: 'ajuda' }, 'Campos do corpo (tipos de cada campo, não é um exemplo pronto):') : null,
            c.esquema != null ? el('pre', { class: 'json' }, JSON.stringify(c.esquema, null, 2)) : null,
            c.dica ? el('p', { class: 'ajuda' }, c.dica) : null,
            el('pre', { class: 'json' }, c.curl),
            c.executavel ? null : el('p', { class: 'ajuda' }, 'Troque o que está entre < > ou { } e crie o arquivo indicado com @ antes de rodar.')));
      }))));
  };
  render();
  $('#filtro').addEventListener('input', (e) => render(e.target.value));
}
