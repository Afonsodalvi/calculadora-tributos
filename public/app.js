// Entry point of the UI: regime switch and boot of each panel. All math happens on the local
// server; the panels live in public/js/.
import { $, api } from './js/comum.js';
import { iniciarSimples } from './js/simples.js';

const PAINEIS = { simples: '#painel-simples', regular: '#painel-regular', consultas: '#painel-consultas' };
const iniciados = new Set();
const CHAVE = 'calculadora-regime';

async function mostrar(regime) {
  for (const [k, sel] of Object.entries(PAINEIS)) $(sel).hidden = k !== regime;
  localStorage.setItem(CHAVE, regime);
  if (iniciados.has(regime)) return;
  iniciados.add(regime);
  if (regime === 'regular') (await import('./js/regular.js')).iniciarRegular();
  if (regime === 'consultas') (await import('./js/consultas.js')).iniciarConsultas();
}

const [info, infoSimples] = await Promise.all([api('/api/info'), api('/api/simples/info')]);
const v = info.body?.versaoBase;
if (v) $('#versao-base').textContent = `${v.v} (${String(v.d ?? '').slice(0, 10).split('-').reverse().join('/')})`;
iniciarSimples(infoSimples.body);
iniciados.add('simples');

const salvo = localStorage.getItem(CHAVE);
const radios = document.querySelectorAll('input[name=regime]');
for (const r of radios) {
  r.addEventListener('change', () => { if (r.checked) mostrar(r.value); });
  if (r.value === salvo) r.checked = true;
}
if (salvo && PAINEIS[salvo]) mostrar(salvo);
