// Shared UI helpers: DOM builder, pt-BR formatting, exact money parsing, API calls (with the
// optional server token) and the invoice uploader used by both regimes.
export const $ = (s, el = document) => el.querySelector(s);
export const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v; // CSSOM: allowed by the page CSP
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
  return e;
};

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const brl = (v) => (v == null || v === '' ? '—' : BRL.format(Number(v)));
export const pctBR = (v, max = 4, min = 2) => (v == null || v === '' ? '—' : `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max })}%`);
export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const mesValido = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(c ?? '');
export const mesLongo = (c) => (mesValido(c) ? `${MESES[Number(c.slice(5)) - 1]} de ${c.slice(0, 4)}` : String(c));
export const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const mesCurto = (c) => (mesValido(c) ? `${MESES[Number(c.slice(5)) - 1].slice(0, 3)}/${c.slice(0, 4)}` : String(c));
export const dataBR = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d ?? '—');
export const somarMeses = (c, n) => { const d = new Date(Number(c.slice(0, 4)), Number(c.slice(5)) - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const codigoServico = (c) => (c && c.length === 6 ? `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4)}` : c);
export const nbsFmt = (n) => (n && n.length === 9 ? `${n[0]}.${n.slice(1, 5)}.${n.slice(5, 7)}.${n.slice(7)}` : n);
export const ncmFmt = (n) => (n && n.length === 8 ? `${n.slice(0, 4)}.${n.slice(4, 6)}.${n.slice(6)}` : n);

/** "10.000,50" or "10000.50" → "10000.50" (exact text, no float math). */
export function parseValor(t, casas = 2) {
  const s = String(t ?? '').trim().replace(/[R$%\s]/g, '');
  if (!s) return null;
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!new RegExp(`^\\d+(\\.\\d{1,${casas}})?$`).test(norm)) return null;
  const [i, f = ''] = norm.split('.');
  return casas === 2 ? `${BigInt(i)}.${f.padEnd(2, '0')}` : `${BigInt(i)}${f ? `.${f}` : ''}`;
}

// ── API (local server; token only when the server was published with API_TOKEN) ──
const CHAVE_TOKEN = 'calculadora-api-token';
export async function api(path, { method = 'GET', body, headers = {}, bruto = false } = {}) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const token = sessionStorage.getItem(CHAVE_TOKEN);
    const h = { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    if (body !== undefined && !(body instanceof Blob) && !h['content-type']) h['content-type'] = 'application/json';
    const r = await fetch(path, { method, headers: h, body: body === undefined || body instanceof Blob ? body : JSON.stringify(body) });
    if (r.status === 401 && tentativa === 0) {
      const t = prompt('Este servidor exige um token de acesso. Digite o token informado por quem publicou a calculadora:');
      if (!t) throw new Error('Acesso sem token recusado pelo servidor.');
      sessionStorage.setItem(CHAVE_TOKEN, t.trim());
      continue;
    }
    if (bruto) return r;
    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
    return { ok: r.ok, status: r.status, body: json, texto, headers: r.headers };
  }
  throw new Error('Token inválido.');
}

const ESPERA_MAX_S = 30; // longest pause honoured from a 429 Retry-After
const MAX_PAUSAS = 6; // per request
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * api() that waits and resends when the server answers 429 (per-minute limit, busy PDF queue),
 * honouring Retry-After (1–30 s) up to MAX_PAUSAS times. aoEsperar(segundosRestantes) shows the pause.
 */
export async function apiComPausa(path, opcoes, aoEsperar = () => {}) {
  for (let pausa = 0; ; pausa++) {
    const r = await api(path, opcoes);
    if (r.status !== 429 || pausa >= MAX_PAUSAS) return r;
    const s = Math.min(ESPERA_MAX_S, Math.max(1, Number.parseInt(r.headers?.get?.('retry-after') ?? '', 10) || 5));
    for (let t = s; t > 0; t--) { aoEsperar(t); await esperar(1000); }
  }
}

/**
 * Drop zone + file picker that sends the files to /api/notas one at a time (pausing when the server's
 * per-minute limit answers 429) and hands back aoLer(notas, eventos), where eventos are the
 * cancellation events read: [{ tipo: 'cancelamento', chave, descricao }].
 */
export function criarUploader({ zona, input, status, aoLer }) {
  // files dropped while a batch is still uploading wait for it (one request at a time)
  let fila = Promise.resolve();
  const enfileirar = (arquivos) => { fila = fila.then(() => enviar(arquivos)).catch(() => {}); };

  zona.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  for (const ev of ['dragenter', 'dragover']) zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('ativo'); });
  for (const ev of ['dragleave', 'drop']) zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('ativo'); });
  zona.addEventListener('drop', (e) => enfileirar([...e.dataTransfer.files]));
  input.addEventListener('change', () => { enfileirar([...input.files]); input.value = ''; });

  function enviarArquivo(f, i, total) {
    status.textContent = `Lendo ${i + 1} de ${total}: ${f.name}…`;
    return apiComPausa('/api/notas', { method: 'POST', headers: { 'x-filename': encodeURIComponent(f.name) }, body: f }, (t) => {
      status.textContent = `O servidor pediu uma pausa (limite de envios por minuto). ${i} de ${total} arquivo(s) enviados; continuando em ${t} s…`;
    });
  }

  async function enviar(arquivos) {
    if (!arquivos.length) return;
    const msgs = [];
    const notas = [];
    const eventos = [];
    for (const [i, f] of arquivos.entries()) {
      try {
        const r = await enviarArquivo(f, i, arquivos.length);
        if (!r.ok) { msgs.push(el('span', { class: 'erro' }, `${f.name}: ${r.body?.erro ?? `erro ${r.status}`}`)); continue; }
        if (r.body?.evento) eventos.push(r.body.evento);
        else notas.push(r.body.nota);
      } catch (e) {
        msgs.push(el('span', { class: 'erro' }, `${f.name}: ${e.message}`));
      }
    }
    const { lidas, repetidas, canceladas } = aoLer(notas, eventos) ?? {};
    const partes = [];
    if (lidas) partes.push(`${lidas} nota(s) lida(s).`);
    if (repetidas) partes.push(`${repetidas} arquivo(s) eram a mesma nota de outro arquivo e foram contados uma vez só.`);
    if (eventos.length) partes.push(`${eventos.length} evento(s) de cancelamento lido(s).`);
    if (canceladas) partes.push(`${canceladas} nota(s) carregada(s) marcada(s) como cancelada(s).`);
    status.replaceChildren(partes.join(' '), ...msgs.flatMap((m) => [el('br'), m]));
  }
}

export const rolarPara = (alvo) => alvo.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
