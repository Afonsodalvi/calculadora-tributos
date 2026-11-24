// "Consultar tabelas oficiais": thin views over the official dados-abertos routes.
import { $, el, pctBR, api, ncmFmt, nbsFmt } from './comum.js';

const DA = '/api/calculadora/dados-abertos';
/** Today's LOCAL date (toISOString is UTC: late evening in Brazil it is already tomorrow). */
export const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const erroDe = (r) => r.body?.detail ?? r.body?.erro ?? `HTTP ${r.status}`;
const normal = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function iniciarConsultas() {
  for (const i of document.querySelectorAll('#painel-consultas input[type=date]')) i.value = hoje();

  // Classificações tributárias (cClassTrib)
  const fc = $('#c-form-class');
  fc.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saida = $('#c-saida-class');
    saida.replaceChildren(el('p', {}, 'Consultando…'));
    const r = await api(`${DA}/classificacoes-tributarias/cbs-ibs?data=${fc.data.value}`);
    if (!r.ok) { saida.replaceChildren(el('p', { class: 'aviso' }, erroDe(r))); return; }
    const termos = normal(fc.busca.value).split(/\s+/).filter(Boolean);
    const achadas = r.body.filter((c) => termos.every((t) => normal(`${c.codigo} ${c.descricao} ${c.descricaoTratamentoTributario}`).includes(t)));
    saida.replaceChildren(
      el('p', {}, `${achadas.length} classificação(ões) vigente(s) em ${fc.data.value.split('-').reverse().join('/')}${achadas.length > 60 ? ' — mostrando as 60 primeiras; refine a busca' : ''}.`),
      el('div', { class: 'tabela-rolagem' }, el('table', { class: 'notas' },
        el('thead', {}, el('tr', {}, ['cClassTrib', 'Descrição', 'Tratamento', 'Redução CBS / IBS', 'Nomenclatura'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, achadas.slice(0, 60).map((c) => el('tr', {},
          el('td', {}, c.codigo),
          el('td', {}, c.descricao),
          el('td', {}, c.descricaoTratamentoTributario ?? '—'),
          el('td', {}, c.possuiPercentualReducao ? `${pctBR(c.percentualReducaoCbs ?? 0, 2, 0)} / ${pctBR(c.percentualReducaoIbsUf ?? 0, 2, 0)}` : 'sem redução'),
          el('td', {}, c.nomenclatura ?? '—')))))));
  });

  // Alíquotas de referência
  const fa = $('#c-form-aliq');
  fa.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saida = $('#c-saida-aliq');
    const d = fa.data.value;
    const mun = fa.municipio.value.replace(/\D/g, '');
    const uf = mun ? mun.slice(0, 2) : '';
    const [u, e2, m] = await Promise.all([
      api(`${DA}/aliquota-uniao?data=${d}`),
      uf ? api(`${DA}/aliquota-uf?codigoUf=${uf}&data=${d}`) : null,
      mun ? api(`${DA}/aliquota-municipio?codigoMunicipio=${mun}&data=${d}`) : null,
    ]);
    const linha = (rotulo, r) => el('tr', {}, el('td', {}, rotulo), el('td', { class: r?.ok ? 'valor' : null }, r == null ? 'informe o município' : r.ok ? pctBR(r.body.aliquotaReferencia, 4) : erroDe(r)));
    saida.replaceChildren(el('table', {}, el('tbody', {}, linha('União (CBS)', u), linha('Estado (IBS)', e2), linha('Município (IBS)', m))),
      el('p', { class: 'dica' }, 'A tabela oficial traz alíquotas de referência só para 2026. A partir de 2027 as alíquotas são fixadas por resolução do Senado e por lei de cada ente; informe-as no cálculo.'));
  });

  // NCM / NBS
  const fn = $('#c-form-nomenclatura');
  fn.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saida = $('#c-saida-nomenclatura');
    const codigo = fn.codigo.value.replace(/\D/g, '');
    const tipo = codigo.length === 9 ? 'nbs' : 'ncm';
    const r = await api(`${DA}/${tipo}?${tipo}=${codigo}&data=${fn.data.value}`);
    saida.replaceChildren(r.ok
      ? el('div', {}, el('p', {}, el('strong', {}, `${tipo.toUpperCase()} ${tipo === 'nbs' ? nbsFmt(codigo) : ncmFmt(codigo)}`)),
        el('dl', { class: 'hierarquia' }, ...['capitulo', 'posicao', 'subposicao', 'item', 'subitem'].filter((k) => r.body[k]).flatMap((k) => [el('dt', {}, { capitulo: 'Capítulo', posicao: 'Posição', subposicao: 'Subposição', item: 'Item', subitem: 'Subitem' }[k]), el('dd', {}, r.body[k])])),
        el('p', {}, r.body.tributadoPeloImpostoSeletivo ? 'Sujeito ao Imposto Seletivo.' : 'Não sujeito ao Imposto Seletivo.'))
      : el('p', { class: 'aviso' }, erroDe(r)));
  });
}
