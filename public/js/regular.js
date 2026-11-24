// Regime Regular panel (Lucro Presumido / Lucro Real): invoices → editable operations →
// CBS, IBS and Imposto Seletivo computed by the official calculator port (/api/regime-regular/*,
// which calls the official routes /api/calculadora/...). Reference data comes from the official
// "dados abertos" routes.
import { $, el, brl, pctBR, mesLongo, capital, dataBR, nbsFmt, ncmFmt, parseValor, api, apiComPausa, criarUploader, rolarPara } from './comum.js';

const DA = '/api/calculadora/dados-abertos';
const TIPOS_DOC = { 55: 'NF-e', 65: 'NFC-e', 91: 'NFS-e' };
const ESTADOS = {
  CALCULADO: 'Calculado',
  CALCULO_SIMULADO: 'Calculado com as alíquotas informadas',
  INCONSISTENCIA_ENTRADA: 'Dados da nota inconsistentes',
  NAO_IMPLEMENTADO: 'Situação ainda não tratada pela calculadora oficial',
  FALHA_TECNICA: 'Falha técnica',
};
/** Today's LOCAL date (toISOString is UTC: late evening in Brazil it is already tomorrow). */
export const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MOTIVO_CANCELADA = 'cancelada (evento de cancelamento enviado)';
const LOTE_BYTES = 1.5 * 1024 * 1024; // /preparar and /calcular accept 2 MB of JSON
const LOTE_ITENS = 5000;
const LOTE_NOTAS = 500;

const state = {
  operacoes: [], seq: 0, ufs: [], municipios: new Map(), classificacoes: new Map(), aliquotas: { cbs: '', ibsEstadual: '', ibsMunicipal: '' },
  pendentes: [], // identities of notes sent to /preparar and not back yet (a second drop must not count them again)
  canceladas: new Set(), // access keys of the cancellation events uploaded so far
};

// ── Reference data (official dados abertos, cached) ─────────────────────────
async function ufs() {
  if (!state.ufs.length) state.ufs = (await api(`${DA}/ufs`)).body ?? [];
  return state.ufs;
}
async function municipiosDaUf(sigla) {
  if (!sigla) return [];
  if (!state.municipios.has(sigla)) state.municipios.set(sigla, (await api(`${DA}/ufs/municipios?siglaUf=${encodeURIComponent(sigla)}`)).body ?? []);
  return state.municipios.get(sigla);
}
async function ufDoMunicipio(codigo) {
  const cod = Math.floor(Number(codigo) / 100000);
  return (await ufs()).find((u) => u.codigo === cod) ?? null;
}
async function nomeMunicipio(codigo) {
  const uf = await ufDoMunicipio(codigo);
  if (!uf) return null;
  const m = (await municipiosDaUf(uf.sigla)).find((x) => x.codigo === Number(codigo));
  return m ? `${m.nome}/${uf.sigla}` : null;
}
async function classificacoes(data) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(data ?? '') ? data : hoje();
  if (!state.classificacoes.has(d)) {
    const r = await api(`${DA}/classificacoes-tributarias/cbs-ibs?data=${d}`);
    state.classificacoes.set(d, r.ok ? r.body : []);
  }
  return state.classificacoes.get(d);
}
async function preencherDatalist(lista, data) {
  const cls = await classificacoes(data);
  lista.replaceChildren(...cls.map((c) => el('option', { value: c.codigo }, `${c.codigo} — ${c.descricaoTratamentoTributario ?? ''}: ${(c.descricao ?? '').slice(0, 110)}`)));
}

/** UF + município pickers bound to an object field holding the IBGE code. */
async function seletorMunicipio(alvo, campo, aoMudar) {
  const selUf = el('select', { 'aria-label': 'UF' }, el('option', { value: '' }, 'UF'));
  const selMun = el('select', { 'aria-label': 'Município' }, el('option', { value: '' }, 'Município'));
  for (const u of await ufs()) selUf.append(el('option', { value: u.sigla }, u.sigla));
  const carregar = async (sigla, codigo) => {
    selMun.replaceChildren(el('option', { value: '' }, 'Município'));
    for (const m of await municipiosDaUf(sigla)) selMun.append(el('option', { value: m.codigo, selected: m.codigo === Number(codigo) }, m.nome));
  };
  if (alvo[campo]) {
    const uf = await ufDoMunicipio(alvo[campo]);
    if (uf) { selUf.value = uf.sigla; await carregar(uf.sigla, alvo[campo]); }
  }
  selUf.addEventListener('change', async () => { await carregar(selUf.value); alvo[campo] = null; aoMudar?.(); });
  selMun.addEventListener('change', () => { alvo[campo] = selMun.value ? Number(selMun.value) : null; aoMudar?.(); });
  return el('span', { class: 'seletor-municipio' }, selUf, selMun);
}

// ── Boot ────────────────────────────────────────────────────────────────────
export async function iniciarRegular() {
  criarUploader({
    zona: $('#r-soltar'), input: $('#r-arquivos'), status: $('#r-status-upload'),
    aoLer: (notas, eventos) => receberNotas(notas, eventos),
  });
  const f = $('#r-form-manual');
  f.data.value = hoje();
  f.prepend(el('div', { class: 'largo' }, el('span', { class: 'rotulo-campo' }, 'Local onde o IBS é devido (município do destino)'), await seletorMunicipio(f, 'municipioEscolhido')));
  const lista = $('#r-classificacoes');
  await preencherDatalist(lista, f.data.value);
  f.data.addEventListener('change', () => preencherDatalist(lista, f.data.value));
  f.addEventListener('submit', (e) => { e.preventDefault(); adicionarManual(f); });
  $('#r-calcular').addEventListener('click', calcular);
  for (const k of ['cbs', 'ibsEstadual', 'ibsMunicipal']) {
    const input = $(`#r-aliq-${k}`);
    input.addEventListener('change', () => {
      const v = parseValor(input.value, 4);
      input.setCustomValidity(input.value && (!v || Number(v) > 100) ? 'Digite um percentual como 8,8' : '');
      input.reportValidity();
      state.aliquotas[k] = v ?? '';
    });
  }
}

// ── Same invoice in several files, cancellations, replacements, other issuers ──
// digits, or letters too: the alphanumeric CNPJ (issued from July 2026) is part of CNPJs and access keys
const soDigitos = (v) => (v == null ? null : String(v).toUpperCase().replace(/[^0-9A-Z]/g, '') || null);
/** Keys of one invoice: id, access key, and issuer + type + number + series + issue date. */
function identidade(n) {
  const chave = soDigitos(n.chave);
  const doc = soDigitos(n.prestador?.doc);
  const emissao = doc && n.numero ? [doc, n.tipo ?? '', String(n.numero), n.serie ?? '', n.dataEmissao ?? n.competencia ?? ''].join('|') : null;
  return { id: n.id ?? chave ?? null, chave, emissao };
}
function guardar(v, idn) {
  if (idn.id) v.ids.add(idn.id);
  if (idn.chave) v.chaves.add(idn.chave);
  if (idn.emissao) { v.emissoes.add(idn.emissao); if (!idn.chave) v.emissoesSemChave.add(idn.emissao); }
}
/** Issuer + number only identifies the invoice when one of the two files has no access key. */
const repetida = (v, idn) => (idn.id && v.ids.has(idn.id)) || (idn.chave && v.chaves.has(idn.chave))
  || (idn.emissao && (idn.chave ? v.emissoesSemChave : v.emissoes).has(idn.emissao));

/** Splits a batch into new invoices and repeats (inside the batch or of an identity already known). */
export function separarRepetidas(notas, conhecidas) {
  const v = { ids: new Set(), chaves: new Set(), emissoes: new Set(), emissoesSemChave: new Set() };
  for (const idn of conhecidas) guardar(v, idn);
  const novas = [];
  let repetidas = 0;
  for (const n of notas) {
    const idn = identidade(n);
    if (repetida(v, idn)) { repetidas++; continue; }
    guardar(v, idn);
    novas.push({ nota: n, idn });
  }
  return { novas, repetidas };
}

/** Uploader callback (synchronous, so a second drop already sees this one's notes). */
function receberNotas(notas, eventos = []) {
  for (const e of eventos ?? []) if (e?.tipo === 'cancelamento' && soDigitos(e.chave)) state.canceladas.add(soDigitos(e.chave));
  const { novas, repetidas } = separarRepetidas(notas, [...state.operacoes.map((o) => o.identidade).filter(Boolean), ...state.pendentes]);
  if (eventos?.length) { marcarExclusoes(); render(); }
  if (novas.length) {
    const reservadas = new Set(novas.map((x) => x.idn));
    state.pendentes.push(...reservadas);
    prepararNotas(novas)
      .catch((e) => $('#r-status-upload').append(el('br'), el('span', { class: 'erro' }, e.message)))
      .finally(() => { state.pendentes = state.pendentes.filter((p) => !reservadas.has(p)); });
  }
  return { lidas: novas.length, repetidas };
}

/** Same rules as the Simples (src/notas/notas.js), over every loaded note, recomputed after each change. */
export function marcarExclusoes(operacoes = state.operacoes, canceladas = state.canceladas) {
  const notas = operacoes.filter((o) => o.tipo !== 'Digitado');
  for (const o of notas) o.ignorar = o.ignorarNota ?? null; // reason given when the file was read
  for (const o of notas) if (!o.ignorar && o.chave && canceladas.has(o.chave)) o.ignorar = MOTIVO_CANCELADA;
  // A company is its CNPJ root (8 digits): head office and branches are one taxpayer.
  const raiz = (d) => (d?.length === 14 ? d.slice(0, 8) : d);
  const conta = new Map();
  for (const o of notas) if (o.emitenteDoc) conta.set(raiz(o.emitenteDoc), (conta.get(raiz(o.emitenteDoc)) ?? 0) + 1);
  const empresa = [...conta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const o of notas) {
    if (empresa && o.emitenteDoc && raiz(o.emitenteDoc) !== empresa && !o.ignorar && !o.incluirMesmoAssim) o.ignorar = `emitida por outro CNPJ/CPF (${o.emitenteDoc}), não é receita da empresa`;
  }
  const substituidas = new Set(notas.map((o) => o.substitui).filter(Boolean));
  for (const o of notas) if (o.chave && substituidas.has(o.chave) && !o.ignorar) o.ignorar = 'substituída por outra nota enviada';
}

/** Chunks under the server's JSON, note and item limits (/preparar and /calcular). */
export function lotes(lista, corpo = (x) => x.nota) {
  const out = [];
  let atual = [], bytes = 0, itens = 0;
  for (const x of lista) {
    const c = corpo(x);
    const b = new TextEncoder().encode(JSON.stringify(c)).length;
    const i = Array.isArray(c.itens) ? c.itens.length : 1;
    if (atual.length && (atual.length >= LOTE_NOTAS || bytes + b > LOTE_BYTES || itens + i > LOTE_ITENS)) { out.push(atual); atual = []; bytes = 0; itens = 0; }
    atual.push(x); bytes += b; itens += i;
  }
  if (atual.length) out.push(atual);
  return out;
}

async function prepararNotas(novas) {
  const status = $('#r-status-upload');
  for (const lote of lotes(novas)) {
    let r;
    let pausa = null; // keeps the upload summary already in the status line
    try {
      r = await apiComPausa('/api/regime-regular/preparar', { method: 'POST', body: { notas: lote.map((x) => x.nota) } }, (t) => {
        pausa ??= status.appendChild(el('span', { class: 'aviso' }));
        pausa.textContent = `O servidor pediu uma pausa (limite de envios por minuto); continuando em ${t} s…`;
      });
    } catch (e) {
      r = { ok: false, body: { erro: e.message } };
    }
    pausa?.remove();
    if (!r.ok) { status.append(el('br'), el('span', { class: 'erro' }, r.body?.erro ?? `Erro ${r.status} ao preparar as notas.`)); continue; }
    r.body.operacoes.forEach((op, i) => {
      const { nota: n, idn } = lote[i];
      op.identidade = idn;
      op.emitente = n.prestador?.nome ?? null;
      op.emitenteDoc = soDigitos(n.prestador?.doc);
      op.destinatario = n.tomador?.nome ?? null;
      op.arquivo = n.arquivo ?? null;
      op.chave = idn.chave;
      op.substitui = soDigitos(n.substitui);
      op.ignorarNota = n.ignorar ?? null;
      op.avisos = [...(n.avisos ?? []), ...(op.avisos ?? [])];
      state.operacoes.push(op);
    });
    marcarExclusoes();
    render();
  }
}

function adicionarManual(f) {
  const valor = parseValor(f.valor.value);
  if (!valor) { f.valor.setCustomValidity('Digite um valor como 10.000,00'); f.valor.reportValidity(); return; }
  f.valor.setCustomValidity('');
  const codigo = f.codigo.value.replace(/\D/g, '');
  const servico = f.natureza.value === 'servico';
  if (codigo && codigo.length !== (servico ? 9 : 8)) { f.codigo.setCustomValidity(servico ? 'A NBS tem 9 dígitos' : 'A NCM tem 8 dígitos'); f.codigo.reportValidity(); return; }
  f.codigo.setCustomValidity('');
  const cClassTrib = f.cClassTrib.value.trim() || '000001';
  if (!/^\d{6}$/.test(cClassTrib)) { f.cClassTrib.setCustomValidity('Escolha uma classificação de 6 dígitos'); f.cClassTrib.reportValidity(); return; }
  f.cClassTrib.setCustomValidity('');
  if (!f.municipioEscolhido) { alert('Escolha a UF e o município onde o IBS é devido.'); return; }
  state.operacoes.push({
    notaId: `manual-${++state.seq}`, tipo: 'Digitado', numero: null, tpDoc: Number(f.tpDoc.value) || null,
    data: f.data.value, municipio: f.municipioEscolhido, origem: { data: 'digitada', municipio: 'escolhido' }, avisos: [],
    itens: [{ numero: 1, descricao: f.descricao.value || null, [servico ? 'nbs' : 'ncm']: codigo || null, cst: cClassTrib.slice(0, 3), cClassTrib, baseCalculo: valor, quantidade: '1', unidade: 'UN' }],
  });
  f.valor.value = '';
  f.descricao.value = '';
  render();
}

// ── Review table ────────────────────────────────────────────────────────────
async function render() {
  const corpo = $('#r-corpo');
  $('#r-lista').hidden = state.operacoes.length === 0;
  $('#r-passo-revisao').hidden = state.operacoes.length === 0;
  const linhas = [];
  for (const op of [...state.operacoes].sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
    const datalist = el('datalist', { id: `cls-${op.notaId}` });
    preencherDatalist(datalist, op.data);
    const titulo = op.tipo === 'Digitado' ? 'Operação digitada' : `${op.tipo} nº ${op.numero ?? '?'}`;
    const itens = op.itens.map((it) => {
      const cls = el('input', { value: it.cClassTrib, list: datalist.id, inputmode: 'numeric', maxlength: '6', size: '7', 'aria-label': `Classificação tributária do item ${it.numero}`,
        onchange: (e) => {
          const v = e.target.value.trim();
          e.target.setCustomValidity(/^\d{6}$/.test(v) ? '' : 'Use os 6 dígitos da classificação');
          e.target.reportValidity();
          if (/^\d{6}$/.test(v)) { it.cClassTrib = v; it.cst = v.slice(0, 3); }
        } });
      const produto = it.ncm ? `NCM ${ncmFmt(it.ncm)}` : it.nbs ? `NBS ${nbsFmt(it.nbs)}` : 'sem NCM/NBS';
      const baseTxt = it.baseCalculo != null ? brl(it.baseCalculo) : it.impostoSeletivo ? 'base do IS + IS da nota' : it.gComponentesBC ? 'pelos valores da nota' : '—';
      return el('div', { class: 'item-op' },
        el('span', {}, `Item ${it.numero}: ${produto}`, it.descricao ? el('span', { class: 'sub' }, it.descricao) : null),
        el('label', { class: 'mini' }, 'cClassTrib ', cls),
        el('span', { class: 'sub' }, `Base: ${baseTxt}`, it.impostoSeletivo ? ' · com Imposto Seletivo' : ''),
        it.impostoSeletivo && desde2027(op) ? camposAliquotaIS(it) : null);
    });
    const municipioNome = el('span', { class: 'sub' }, op.municipio ? `IBGE ${op.municipio}` : 'não identificado');
    if (op.municipio) nomeMunicipio(op.municipio).then((n) => { if (n) municipioNome.textContent = n; });
    const alterarLocal = el('details', { class: 'mini-detalhe' }, el('summary', {}, 'alterar'));
    alterarLocal.addEventListener('toggle', async () => {
      if (alterarLocal.open && alterarLocal.children.length === 1) alterarLocal.append(await seletorMunicipio(op, 'municipio', () => { municipioNome.textContent = op.municipio ? `IBGE ${op.municipio}` : 'não identificado'; if (op.municipio) nomeMunicipio(op.municipio).then((n) => { if (n) municipioNome.textContent = n; }); }));
    });
    const outroEmitente = op.ignorar?.startsWith('emitida por outro CNPJ/CPF');
    const alternarInclusao = (v) => () => { op.incluirMesmoAssim = v; marcarExclusoes(); render(); };
    linhas.push(el('tr', { class: op.ignorar ? 'ignorada' : null },
      el('td', {}, titulo, op.emitente ? el('span', { class: 'sub' }, `Emitida por ${op.emitente}`) : null,
        op.destinatario ? el('span', { class: 'sub' }, `Para ${op.destinatario}`) : null,
        op.ignorar ? el('span', { class: 'aviso' }, `Fora do cálculo: ${op.ignorar}`) : null,
        outroEmitente ? el('button', { type: 'button', class: 'botao-link', onclick: alternarInclusao(true) }, 'Incluir mesmo assim') : null,
        op.incluirMesmoAssim && !op.ignorar ? el('span', { class: 'sub' }, 'Incluída mesmo sendo de outro CNPJ/CPF. ', el('button', { type: 'button', class: 'botao-link', onclick: alternarInclusao(false) }, 'Tirar do cálculo')) : null),
      el('td', { 'data-rotulo': 'Data do fato gerador' }, el('input', { type: 'date', value: op.data ?? '', 'aria-label': `Data do fato gerador de ${titulo}`, onchange: (e) => { op.data = e.target.value; render(); } }),
        op.origem?.data ? el('span', { class: 'sub' }, op.origem.data) : null),
      el('td', { 'data-rotulo': 'Local do IBS' }, municipioNome, op.origem?.municipio ? el('span', { class: 'sub' }, op.origem.municipio) : null, alterarLocal),
      el('td', { 'data-rotulo': 'Itens e classificação' }, datalist, ...itens, ...(op.avisos ?? []).map((a) => el('span', { class: 'aviso' }, a))),
      el('td', {}, el('button', { class: 'remover', type: 'button', 'aria-label': `Remover ${titulo}`, onclick: () => { state.operacoes = state.operacoes.filter((x) => x !== op); marcarExclusoes(); render(); } }, '×'))));
  }
  corpo.replaceChildren(...linhas);
  const precisaAliquotas = state.operacoes.some((o) => !o.ignorar && desde2027(o));
  $('#r-aliquotas').hidden = !precisaAliquotas;
  $('#r-aviso-2026').hidden = !state.operacoes.some((o) => String(o.data).startsWith('2026'));
}

/** Imposto Seletivo rate of one item (from 2027 the official table has none): prefilled from the invoice. */
function camposAliquotaIS(it) {
  const campo = (k, rotulo, dica) => el('label', { class: 'mini' }, `${rotulo} `,
    el('input', { type: 'text', inputmode: 'decimal', size: '7', value: it.aliquotasIS?.[k] ?? '', placeholder: dica, 'aria-label': `${rotulo} do item ${it.numero}`,
      onchange: (e) => {
        const v = parseValor(e.target.value, 4);
        e.target.setCustomValidity(e.target.value && !v ? 'Digite um número como 10 ou 2,50' : '');
        e.target.reportValidity();
        const a = { ...(it.aliquotasIS ?? {}) };
        if (v) a[k] = v; else delete a[k];
        it.aliquotasIS = a;
      } }));
  const aviso = el('span', { class: 'aviso', hidden: temAliquotaIS(it) }, 'Informe a alíquota do Imposto Seletivo deste item.');
  const box = el('span', { class: 'aliquota-is' }, campo('adValorem', 'Alíquota do IS (%)', 'ex.: 10'), campo('adRem', 'IS por unidade (R$)', 'opcional'), aviso);
  box.addEventListener('change', () => { aviso.hidden = temAliquotaIS(it); });
  return box;
}
const temAliquotaIS = (it) => Boolean(it.aliquotasIS?.adValorem || it.aliquotasIS?.adRem);
/** Operation dated 2027 or later (when the official table has no rates and they must be informed). */
const desde2027 = (o) => /^\d{4}-/.test(o.data ?? '') && o.data >= '2027';

// Only what /calcular reads (display fields stay here; the request stays small).
const CAMPOS_OP = ['notaId', 'numero', 'tipo', 'data', 'municipio', 'uf', 'tpDoc', 'gCompraGov'];
const CAMPOS_ITEM = ['numero', 'ncm', 'nbs', 'cst', 'cClassTrib', 'baseCalculo', 'quantidade', 'unidade', 'impostoSeletivo', 'tributacaoRegular', 'gComponentesBC', 'aliquotasIS'];
const escolher = (o, campos) => Object.fromEntries(campos.filter((k) => o[k] != null).map((k) => [k, o[k]]));

// ── Calculate ───────────────────────────────────────────────────────────────
async function calcular() {
  const btn = $('#r-calcular');
  const ativas = state.operacoes.filter((o) => !o.ignorar);
  const box = $('#r-resultado');
  $('#r-passo-resultado').hidden = false;
  if (!ativas.length) { box.replaceChildren(el('div', { class: 'pendencias' }, el('p', {}, 'Nenhuma nota para calcular.'))); return; }
  if (ativas.some((o) => !o.municipio)) { box.replaceChildren(el('div', { class: 'pendencias' }, el('p', {}, 'Escolha o município do IBS de todas as notas (coluna "Local do IBS").'))); return; }
  const a = state.aliquotas;
  if (ativas.some(desde2027) && !(a.cbs && a.ibsEstadual && a.ibsMunicipal)) {
    box.replaceChildren(el('div', { class: 'pendencias' }, el('p', {}, 'A partir de 2027 informe as alíquotas de CBS, IBS estadual e IBS municipal (passo 2).')));
    rolarPara($('#r-aliquotas'));
    return;
  }
  if (ativas.some((o) => desde2027(o) && o.itens.some((it) => it.impostoSeletivo && !temAliquotaIS(it)))) {
    box.replaceChildren(el('div', { class: 'pendencias' }, el('p', {}, 'A partir de 2027 informe a alíquota do Imposto Seletivo de cada item com IS (coluna "Itens e classificação").')));
    rolarPara($('#r-passo-revisao'));
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Calculando…';
  try {
    const operacoes = ativas.map((op) => ({ ...escolher(op, CAMPOS_OP), itens: op.itens.map((it) => escolher(it, CAMPOS_ITEM)) }));
    const partes = [];
    for (const lote of lotes(operacoes, (x) => x)) {
      const r = await apiComPausa('/api/regime-regular/calcular', { method: 'POST', body: { operacoes: lote, aliquotas: a.cbs ? a : null } }, (t) => {
        btn.textContent = `Calculando… (pausa pedida pelo servidor: ${t} s)`;
      });
      if (!r.ok) throw new Error(r.body?.erro ?? `Erro ${r.status} no cálculo`);
      partes.push(r.body);
    }
    renderResultado(juntarCalculos(partes));
  } catch (e) {
    box.replaceChildren(el('div', { class: 'pendencias' }, el('p', {}, e.message)));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Calcular CBS, IBS e Imposto Seletivo';
  }
}

/** Exact sum of two decimal strings ("12.30" + "0.005"), like BigDecimal.add (scale = max scale). */
export function somarDecimais(a, b) {
  const ler = (t) => {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(t));
    if (!m) throw new Error(`Valor decimal inválido: ${t}`);
    let [, sinal, int, frac = '', exp = '0'] = m;
    let escala = frac.length - Number(exp);
    let n = BigInt((sinal === '-' ? '-' : '') + ((int + frac) || '0'));
    if (escala < 0) { n *= 10n ** BigInt(-escala); escala = 0; }
    return { n, escala };
  };
  const x = ler(a), y = ler(b);
  const escala = Math.max(x.escala, y.escala);
  const n = x.n * 10n ** BigInt(escala - x.escala) + y.n * 10n ** BigInt(escala - y.escala);
  const abs = (n < 0n ? -n : n).toString().padStart(escala + 1, '0');
  return (n < 0n ? '-' : '') + (escala ? `${abs.slice(0, -escala)}.${abs.slice(-escala)}` : abs);
}

const CAMPOS_VALOR = ['vBC', 'vCBS', 'vIBSUF', 'vIBSMun', 'vIBS', 'vIS', 'total'];
const CAMPOS_CONTAGEM = ['notas', 'notasNaoCalculadas', 'itensNaoCalculados'];
/** Joins the answers of /calcular sent in chunks: results in order, month summaries added up exactly. */
export function juntarCalculos(partes) {
  const meses = new Map();
  for (const p of partes) {
    for (const m of p.resumo) {
      const t = meses.get(m.mes);
      if (!t) { meses.set(m.mes, { ...m }); continue; }
      for (const k of CAMPOS_VALOR) t[k] = somarDecimais(t[k], m[k]);
      for (const k of CAMPOS_CONTAGEM) t[k] += m[k];
    }
  }
  return {
    resultados: partes.flatMap((p) => p.resultados),
    resumo: [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes)),
    naoCalculadasSemMes: partes.reduce((s, p) => s + (p.naoCalculadasSemMes ?? 0), 0),
  };
}

function renderResultado({ resultados, resumo, naoCalculadasSemMes }) {
  const box = $('#r-resultado');
  box.replaceChildren();
  const mesesSimulados = new Set(resultados.filter((x) => x.simulado).map((x) => x.data?.slice(0, 7)));
  if (naoCalculadasSemMes) box.append(el('div', { class: 'pendencias' }, el('p', {}, `${naoCalculadasSemMes} nota(s) sem data válida não foram calculadas — veja nota por nota.`)));
  for (const m of resumo) {
    const faltas = [
      m.notasNaoCalculadas ? `${m.notasNaoCalculadas} nota(s) não calculada(s)` : null,
      m.itensNaoCalculados ? `${m.itensNaoCalculados} item(ns) não calculado(s)` : null,
    ].filter(Boolean);
    const max = Math.max(Number(m.vCBS), Number(m.vIBSUF), Number(m.vIBSMun), Number(m.vIS), 0.01);
    const barras = (v) => `width:${(Number(v) / max) * 100}%`;
    const fita = el('table', {},
      el('caption', { class: 'sr' }, 'Divisão entre os tributos'),
      el('tbody', {},
        el('tr', {}, el('td', {}, 'CBS (federal)', el('span', { class: 'barra cbs', style: barras(m.vCBS), 'aria-hidden': 'true' })), el('td', { class: 'valor' }, brl(m.vCBS))),
        el('tr', {}, el('td', {}, 'IBS estadual', el('span', { class: 'barra ibs', style: barras(m.vIBSUF), 'aria-hidden': 'true' })), el('td', { class: 'valor' }, brl(m.vIBSUF))),
        el('tr', {}, el('td', {}, 'IBS municipal', el('span', { class: 'barra iss', style: barras(m.vIBSMun), 'aria-hidden': 'true' })), el('td', { class: 'valor' }, brl(m.vIBSMun))),
        Number(m.vIS) > 0 ? el('tr', {}, el('td', {}, 'Imposto Seletivo', el('span', { class: 'barra ipi', style: barras(m.vIS), 'aria-hidden': 'true' })), el('td', { class: 'valor' }, brl(m.vIS))) : null),
      el('tfoot', {}, el('tr', {}, el('td', {}, 'Total destacado nas notas'), el('td', { class: 'valor' }, brl(m.total)))));
    const ano = m.mes.slice(0, 4);
    box.append(el('article', { class: 'mes-resultado' },
      el('h3', { class: 'mes-titulo' }, capital(mesLongo(m.mes))),
      el('div', { class: 'guia regular', role: 'group', 'aria-label': `Tributos de ${mesLongo(m.mes)}` },
        el('div', { class: 'guia-topo' }, el('span', {}, `CBS · IBS · IS — ${m.notas} nota(s)`), el('span', {}, ano === '2026' ? 'Ano de teste (2026)' : `Regras de ${ano}`)),
        el('div', { class: 'guia-corpo' },
          el('div', { class: 'guia-total' },
            el('div', { class: 'rotulo' }, 'Tributos sobre o consumo do mês'),
            el('div', { class: 'valor-grande' }, brl(m.total)),
            faltas.length ? el('p', { class: 'incompleto', role: 'note' }, `Total incompleto: ${faltas.join(' e ')} — veja nota por nota.`) : null,
            el('p', {}, `Base de cálculo somada: ${brl(m.vBC)}`),
            ano === '2026' ? el('p', { class: 'nota-2026' }, 'Em 2026 a CBS (0,9%) e o IBS (0,1%) são de teste: vão destacados na nota, mas são compensados com PIS/Cofins. Quem cumpre as obrigações acessórias não paga esse valor a mais.') : null,
            mesesSimulados.has(m.mes) ? el('p', { class: 'nota-2026' }, 'Simulação: as alíquotas deste ano ainda não estão na tabela oficial, então o cálculo usou as alíquotas que você informou. As reduções e regras da classificação são as oficiais.') : null),
          el('div', { class: 'fita' }, fita)))));
  }

  const linhas = resultados.map((x) => {
    const titulo = x.tipo === 'Digitado' ? 'Operação digitada' : `${x.tipo ?? ''} nº ${x.numero ?? '?'}`;
    if (x.status !== 200) {
      const erros = (x.resposta?.errors ?? []).map((e) => `${e.code}: ${e.detail}`).join(' ') || x.resposta?.detail || `HTTP ${x.status}`;
      const antes = x.data && x.data < '2026-01-01' ? 'A CBS e o IBS só existem a partir de 2026; esta nota é anterior e não tem esses tributos. ' : '';
      return el('tr', {}, el('td', {}, titulo, el('span', { class: 'sub' }, dataBR(x.data))), el('td', { colspan: '4', class: 'aviso' }, antes, el('span', { class: 'sub' }, erros)), el('td', {}, detalhes(x)));
    }
    const tot = x.resposta?.total?.tribCalc ?? {};
    const objs = x.resposta?.objetos ?? [];
    const problemas = objs.filter((o) => o.erros?.length || !['CALCULADO', 'CALCULO_SIMULADO'].includes(o.estadoItem))
      .map((o) => `Item ${o.nObj}: ${ESTADOS[o.estadoItem] ?? o.estadoItem}${o.erros?.length ? ` — ${o.erros.map((e) => `${e.code}: ${e.detail}`).join(' ')}` : ''}`);
    return el('tr', {},
      el('td', {}, titulo, el('span', { class: 'sub' }, dataBR(x.data)), ...problemas.map((p) => el('span', { class: 'aviso' }, p)), conferencia(x)),
      el('td', { class: 'valor', 'data-rotulo': 'Base' }, brl(tot.IBSCBSTot?.vBCIBSCBS)),
      el('td', { class: 'valor', 'data-rotulo': 'CBS' }, brl(tot.IBSCBSTot?.gCBS?.vCBS)),
      el('td', { class: 'valor', 'data-rotulo': 'IBS' }, brl(tot.IBSCBSTot?.gIBS?.vIBS)),
      el('td', { class: 'valor', 'data-rotulo': 'Imposto Seletivo' }, tot.ISTot ? brl(tot.ISTot.vIS) : '—'),
      el('td', {}, detalhes(x)));
  });
  box.append(el('h3', { class: 'subtitulo' }, 'Nota por nota'),
    el('div', { class: 'tabela-rolagem' }, el('table', { class: 'notas cartoes' },
      el('thead', {}, el('tr', {}, ['Nota', 'Base', 'CBS', 'IBS', 'IS', ''].map((h, i) => el('th', { scope: 'col', class: i && i < 5 ? 'num-col' : null }, h)))),
      el('tbody', {}, linhas))));
  rolarPara($('#r-passo-resultado'));
}

/** Compares the official result with the values already printed on the invoice (when present). */
function conferencia(x) {
  const op = state.operacoes.find((o) => o.notaId === x.notaId);
  const objs = x.resposta?.objetos ?? [];
  const difs = [];
  let conferidos = 0;
  for (const it of op?.itens ?? []) {
    const d = it.declarado;
    const o = objs.find((ob) => ob.nObj === it.numero)?.tribCalc?.IBSCBS?.gIBSCBS;
    if (!d || !o) continue;
    for (const [nome, decl, calc] of [['CBS', d.vCBS, o.gCBS?.vCBS], ['IBS estadual', d.vIBSUF, o.gIBSUF?.vIBSUF], ['IBS municipal', d.vIBSMun, o.gIBSMun?.vIBSMun]]) {
      if (decl == null || calc == null) continue;
      conferidos++;
      if (Number(decl) !== Number(calc)) difs.push(`${nome} na nota ${brl(decl)}, oficial ${brl(calc)}`);
    }
  }
  if (!conferidos) return null;
  return difs.length
    ? el('span', { class: 'aviso' }, `Diferente do destacado na nota: ${difs.join('; ')}.`)
    : el('span', { class: 'confere' }, 'Confere com os valores destacados na nota.');
}

function detalhes(x) {
  const box = el('div', { class: 'conta' });
  const det = el('details', { class: 'explica' }, el('summary', {}, 'Detalhes'), box);
  det.addEventListener('toggle', () => {
    if (!det.open || box.childElementCount) return;
    for (const o of x.resposta?.objetos ?? []) {
      const ib = o.tribCalc?.IBSCBS;
      const g = ib?.gIBSCBS;
      const partes = [el('h3', {}, `Item ${o.nObj} — ${ESTADOS[o.estadoItem] ?? o.estadoItem}`)];
      if (ib) partes.push(el('p', {}, `CST ${ib.CST}, classificação ${ib.cClassTrib}.`));
      if (g) {
        partes.push(el('p', { class: 'formula' }, `CBS: ${brl(g.vBC)} × ${pctBR(g.gCBS?.gRed?.pAliqEfet ?? g.gCBS?.pCBS)} = ${brl(g.gCBS?.vCBS)}`));
        partes.push(el('p', { class: 'formula' }, `IBS estadual: ${brl(g.vBC)} × ${pctBR(g.gIBSUF?.gRed?.pAliqEfet ?? g.gIBSUF?.pIBSUF)} = ${brl(g.gIBSUF?.vIBSUF)}`));
        partes.push(el('p', { class: 'formula' }, `IBS municipal: ${brl(g.vBC)} × ${pctBR(g.gIBSMun?.gRed?.pAliqEfet ?? g.gIBSMun?.pIBSMun)} = ${brl(g.gIBSMun?.vIBSMun)}`));
        if (g.gCBS?.gRed) partes.push(el('p', {}, `Redução de ${pctBR(g.gCBS.gRed.pRedAliq)} na alíquota (pela classificação tributária).`));
      }
      const is = o.tribCalc?.IS;
      if (is) partes.push(el('p', { class: 'formula' }, `Imposto Seletivo: ${brl(is.vIS)}`));
      for (const [k, t] of Object.entries(ib?.memoriaCalculo ?? {})) partes.push(el('p', { class: 'memoria' }, `${{ cbs: 'CBS', ibsUF: 'IBS estadual', ibsMun: 'IBS municipal' }[k] ?? k}: ${t}`));
      for (const e of o.erros ?? []) partes.push(el('p', { class: 'aviso' }, `${e.code}: ${e.detail}`));
      box.append(el('div', { class: 'grupo-conta' }, partes));
    }
    const tipoXml = { 55: 'nfe', 65: 'nfce' }[x.entrada?.tpDoc];
    if (x.status === 200 && tipoXml) {
      const saida = el('div');
      box.append(el('button', { type: 'button', class: 'secundario', onclick: async () => {
        const r = await api(`/api/calculadora/xml/generate?tipo=${tipoXml}`, { method: 'POST', body: x.resposta, bruto: true });
        const texto = await r.text();
        if (!r.ok) { saida.replaceChildren(el('p', { class: 'aviso' }, `Não foi possível gerar o XML (HTTP ${r.status}).`)); return; }
        const url = URL.createObjectURL(new Blob([texto], { type: 'application/xml' }));
        saida.replaceChildren(el('a', { href: url, download: `ibscbs-${x.numero ?? x.notaId}.xml` }, 'Baixar XML'), el('pre', { class: 'json' }, texto));
      } }, `Gerar o XML do grupo IBS/CBS (${TIPOS_DOC[x.entrada.tpDoc]})`), saida);
    }
    box.append(el('p', {}, 'Requisição enviada à calculadora oficial (POST /api/calculadora/observabilidade/regime-geral) e resposta:'),
      el('pre', { class: 'json' }, JSON.stringify({ requisicao: x.entrada, resposta: x.resposta }, null, 2)));
  });
  return det;
}
