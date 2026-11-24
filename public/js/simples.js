// Simples Nacional panel: invoices → DAS of the month (LC 123) + CBS/IBS per invoice with the
// official calculator (Reforma, from 2027). All math runs on the server (/api/simples/calcular).
import { $, el, brl, pctBR, mesValido, mesLongo, capital, mesCurto, somarMeses, codigoServico, nbsFmt, parseValor, api, criarUploader, rolarPara } from './comum.js';

const TRIBUTOS = { IRPJ: 'IRPJ', CSLL: 'CSLL', COFINS: 'Cofins', PIS: 'PIS/Pasep', CPP: 'INSS patronal (CPP)', ICMS: 'ICMS', IPI: 'IPI', ISS: 'ISS', CBS: 'CBS', IBS: 'IBS' };

// canceladas: access keys from cancellation events read so far (kept for notes sent later)
const state = { atividades: [], notas: [], empresa: {}, manualSeq: 0, canceladas: new Set() };
const MOTIVO_CANCELADA = 'cancelada (evento de cancelamento enviado)';

/**
 * Uploader callback (pure, tested in Node): adds the new notes, remembers the cancellation events and
 * marks every loaded note with a cancelled key, also notes sent after their event.
 */
export function receberLeitura(estado, notas, eventos = []) {
  let lidas = 0, repetidas = 0, canceladas = 0;
  for (const ev of eventos) if (ev?.tipo === 'cancelamento' && ev.chave) estado.canceladas.add(ev.chave);
  for (const n of notas) {
    if (estado.notas.some((x) => x.id === n.id)) { repetidas++; continue; }
    estado.notas.push(n);
    lidas++;
  }
  for (const n of estado.notas) {
    if (n.chave && estado.canceladas.has(n.chave) && n.ignorar !== MOTIVO_CANCELADA) { n.ignorar = MOTIVO_CANCELADA; canceladas++; }
  }
  return { lidas, repetidas, canceladas };
}

function preencherSelect(select, valor) {
  select.replaceChildren(el('option', { value: '' }, 'Escolha…'));
  const grupos = {};
  for (const a of state.atividades) (grupos[a.grupo] ??= []).push(a);
  for (const [g, lista] of Object.entries(grupos)) {
    select.append(el('optgroup', { label: g }, lista.map((a) => el('option', { value: a.id, selected: a.id === valor, title: `Exemplos: ${a.exemplos}` }, a.nome))));
  }
}


export function iniciarSimples(infoSimples) {
  state.atividades = infoSimples.atividades;
  preencherSelect($('#form-manual select[name=atividade]'), null);
  criarUploader({
    zona: $('#soltar'), input: $('#arquivos'), status: $('#status-upload'),
    aoLer: (notas, eventos) => {
      const r = receberLeitura(state, notas, eventos);
      render();
      return r;
    },
  });
  ligarEventos();
}

function ligarEventos() {
// ── Manual entry ────────────────────────────────────────────────────────────
$('#form-manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (!mesValido(f.competencia.value)) { f.competencia.setCustomValidity('Use o formato AAAA-MM, por exemplo 2026-11'); f.competencia.reportValidity(); return; }
  f.competencia.setCustomValidity('');
  const valor = parseValor(f.valor.value);
  if (!valor) { f.valor.setCustomValidity('Digite um valor como 10.000,00'); f.valor.reportValidity(); return; }
  f.valor.setCustomValidity('');
  const at = state.atividades.find((a) => a.id === f.atividade.value);
  state.notas.push({
    id: `manual-${++state.manualSeq}`, tipo: 'manual', origem: 'Digitado', competencia: f.competencia.value, valor,
    atividade: f.atividade.value, issRetido: f.issRetido.checked, descricao: at?.nome,
  });
  f.valor.value = '';
  render();
});
$('#form-manual input[name=valor]').addEventListener('input', (e) => e.target.setCustomValidity(''));
$('#form-manual input[name=competencia]').addEventListener('input', (e) => e.target.setCustomValidity(''));

// ── Calculate ───────────────────────────────────────────────────────────────
$('#calcular').addEventListener('click', async () => {
  const btn = $('#calcular');
  btn.disabled = true;
  btn.textContent = 'Calculando…';
  try {
    const r = await api('/api/simples/calcular', { method: 'POST', body: { notas: state.notas, empresa: state.empresa, simularReforma: $('#simular').checked } });
    const body = r.body;
    if (!r.ok) throw new Error(body?.erro ?? 'Falha no cálculo');
    renderResultado(body);
  } catch (e) {
    $('#passo-resultado').hidden = false;
    $('#resultado').replaceChildren(el('div', { class: 'pendencias' }, el('p', {}, e.message)));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Calcular o imposto';
  }
});

}

// ── Render: notes table + company form ──────────────────────────────────────
function render() {
  const corpo = $('#corpo-notas');
  corpo.replaceChildren();
  $('#lista-notas').hidden = state.notas.length === 0;
  for (const n of [...state.notas].sort((a, b) => (a.competencia ?? '').localeCompare(b.competencia ?? '') || String(a.numero ?? '').localeCompare(String(b.numero ?? ''), 'pt-BR', { numeric: true }))) {
    const select = el('select', { 'aria-label': `Tipo de atividade da nota ${n.numero ?? ''}`, onchange: (e) => { n.atividade = e.target.value; renderEmpresa(); } });
    preencherSelect(select, n.atividade);
    const titulo = n.tipo === 'manual' ? 'Valor digitado' : `${n.tipo} nº ${n.numero ?? '?'}`;
    const servico = n.tipo === 'NFS-e'
      ? [codigoServico(n.cTribNac), n.itemLc116 ? ` — ${n.itemLc116}` : '', el('span', { class: 'sub' }, [n.nbs ? `NBS ${nbsFmt(n.nbs)}` : null, issTexto(n)].filter(Boolean).join(' · '))]
      : n.tipo === 'manual' ? [n.descricao ?? '', n.issRetido ? el('span', { class: 'sub' }, 'ISS retido pelo cliente') : null]
        : [`${n.itens?.length ?? 0} item(ns)`, el('span', { class: 'sub' }, (n.itens ?? []).slice(0, 2).map((i) => `${i.descricao} (CFOP ${i.cfop})`).join('; '))];
    const celulaValor = n.valor != null ? brl(n.valor) : el('input', { type: 'text', inputmode: 'decimal', placeholder: 'valor', 'aria-label': `Valor da nota ${n.numero ?? ''}`, class: 'valor-faltando',
      onchange: (e) => { const v = parseValor(e.target.value); e.target.setCustomValidity(v ? '' : 'Digite um valor como 1.500,00'); e.target.reportValidity(); if (v) { n.valor = v; render(); } } });
    corpo.append(el('tr', { class: n.ignorar ? 'ignorada' : null },
      el('td', {}, titulo,
        n.prestador?.nome ? el('span', { class: 'sub' }, `Emitida por ${n.prestador.nome}`) : null,
        el('span', { class: 'sub' }, n.tomador?.nome ? `Para ${n.tomador.nome}` : (n.arquivo ?? '')),
        n.ignorar ? el('span', { class: 'aviso' }, `Fora do cálculo: ${n.ignorar}`) : null),
      el('td', {}, n.competencia ? mesCurto(n.competencia) : el('span', { class: 'aviso' }, 'sem mês')),
      el('td', {}, ...servico, ...[...(n.avisos ?? []), ...(n.avisosSimples ?? [])].map((a) => el('span', { class: 'aviso' }, a))),
      el('td', { class: 'valor' }, celulaValor),
      el('td', {}, select, n.sugestao ? el('span', { class: 'sugestao', title: n.sugestao.motivo }, `Sugestão pelo ${n.sugestao.curto ?? n.sugestao.motivo}`) : null,
        !n.atividade ? el('span', { class: 'aviso' }, 'Escolha o tipo de atividade') : null),
      el('td', {}, el('button', { class: 'remover', type: 'button', 'aria-label': 'Remover esta nota', onclick: () => { state.notas = state.notas.filter((x) => x !== n); render(); } }, '×')),
    ));
  }
  renderEmpresa();
}
function issTexto(n) {
  if (n.tribISSQN === '2') return 'ISS: imunidade';
  if (n.tribISSQN === '3') return 'ISS: exportação';
  if (n.tribISSQN === '4') return 'ISS: não incidência';
  if (n.tpRetISSQN === '2' || n.tpRetISSQN === '3') return 'ISS retido';
  if (n.regApTribSN === '2' || n.regApTribSN === '3') return 'ISS fora do Simples';
  return n.tpRetISSQN === '1' ? 'ISS não retido' : null;
}

function renderEmpresa() {
  const meses = [...new Set(state.notas.map((n) => n.competencia).filter(Boolean))].sort();
  $('#passo-empresa').hidden = meses.length === 0;
  const box = $('#meses-empresa');
  box.replaceChildren();
  for (const m of meses) {
    const d = (state.empresa[m] ??= { rbt12: '', folha12: '' });
    const precisaFolha = state.notas.some((n) => n.competencia === m && n.atividade === 'servicos-fator-r');
    const reforma = m >= '2027-01';
    const ini = somarMeses(m, reforma ? -13 : -12), fim = somarMeses(m, reforma ? -2 : -1);
    const campo = (nome, rotulo, dica) => {
      const input = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', value: d[nome] ? Number(d[nome]).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '' });
      input.addEventListener('change', () => {
        const v = parseValor(input.value);
        input.setCustomValidity(input.value && !v ? 'Digite um valor como 250.000,00' : '');
        input.reportValidity();
        d[nome] = v ?? '';
        if (nome === 'folha12' || nome === 'rbt12') atualizarFatorR();
        if (nome === 'rbt12') sublimite.hidden = !(Number(d.rbt12) > 3600000);
      });
      return el('label', {}, rotulo, input, el('span', { class: 'dica' }, dica));
    };
    const fr = el('span', { class: 'dica', 'data-fator': m });
    const atualizarFatorR = () => {
      if (!precisaFolha) return;
      if (d.folha12 === '' || d.rbt12 === '') { fr.textContent = 'Fator "r" = folha ÷ faturamento. Com 28% ou mais, os serviços do Fator "r" vão para o Anexo III (mais barato); abaixo disso, Anexo V.'; return; }
      const folha = Number(d.folha12), rbt = Number(d.rbt12);
      // Res. CGSN 140 art. 26 §§6-7: sem faturamento, r = 28% com folha e 1% sem folha
      const r = rbt === 0 ? (folha > 0 ? 28 : 1) : folha === 0 ? 1 : (folha / rbt) * 100;
      const anexoIII = rbt === 0 ? folha > 0 : folha > 0 && folha * 100 >= rbt * 28;
      fr.textContent = `Fator "r" = ${pctBR(r.toFixed(4), 4)} → ${anexoIII ? 'Anexo III' : 'Anexo V'}`;
    };
    const sublimite = el('fieldset', { class: 'sublimite', hidden: !(Number(d.rbt12) > 3600000) },
      el('legend', {}, 'A receita deste ano já passou de R$ 3,6 milhões (sublimite)?'),
      ...[['sim', true, 'Sim: ICMS, ISS e IBS ficam fora do DAS'], ['nao', false, 'Não: continuam no DAS pela fórmula da 5ª faixa']].map(([v, b, txt]) =>
        el('label', { class: 'check' }, el('input', { type: 'radio', name: `sub-${m}`, value: v, checked: d.sublimiteExcedido === b, onchange: () => { d.sublimiteExcedido = b; } }), txt)));
    box.append(el('div', { class: 'mes-empresa' },
      el('h3', {}, `Notas de ${mesLongo(m)}`),
      campo('rbt12', `Faturamento de ${mesCurto(ini)} a ${mesCurto(fim)} (RBT12)`, reforma ? 'A partir de 2027 o RBT12 são os 12 meses antes do mês anterior.' : 'Soma da receita bruta dos 12 meses antes deste mês.'),
      precisaFolha ? el('div', {}, campo('folha12', `Folha de salários de ${mesCurto(ini)} a ${mesCurto(fim)}`, 'Salários, pró-labore, INSS patronal e FGTS do período.'), fr) : el('div'),
      sublimite,
    ));
    atualizarFatorR();
  }
}

function renderResultado({ meses, erros }) {
  const box = $('#resultado');
  box.replaceChildren();
  $('#passo-resultado').hidden = false;
  for (const e of erros ?? []) box.append(el('div', { class: 'pendencias' }, el('p', {}, e.erro)));
  for (const m of meses) box.append(renderMes(m));
  rolarPara($('#passo-resultado'));
}

function fita(porTributo, total, rotuloTotal) {
  const linhas = Object.entries(porTributo).filter(([, v]) => Number(v) > 0).sort((a, b) => Number(b[1]) - Number(a[1]));
  const max = Math.max(...linhas.map(([, v]) => Number(v)), 1);
  return el('table', {},
    el('caption', { class: 'sr' }, 'Divisão do imposto entre os tributos'),
    el('tbody', {}, linhas.map(([t, v]) => el('tr', {},
      el('td', {}, TRIBUTOS[t] ?? t, el('span', { class: `barra ${t.toLowerCase()}`, style: `width:${(Number(v) / max) * 100}%`, 'aria-hidden': 'true' })),
      el('td', { class: 'valor' }, brl(v))))),
    el('tfoot', {}, el('tr', {}, el('td', {}, rotuloTotal), el('td', { class: 'valor' }, brl(total)))));
}

function renderMes(m) {
  const sec = el('article', { class: 'mes-resultado' }, el('h3', { class: 'mes-titulo' }, capital(mesLongo(m.competencia))));
  if (m.pendencias?.length) sec.append(el('div', { class: 'pendencias' }, m.pendencias.map((p) => el('p', {}, p))));
  if (!m.das) return sec;
  const venc = somarMeses(m.competencia, 1);
  sec.append(el('div', { class: 'guia', role: 'group', 'aria-label': `DAS de ${mesLongo(m.competencia)}` },
    el('div', { class: 'guia-topo' }, el('span', {}, `DAS — Simples Nacional · competência ${m.competencia.slice(5)}/${m.competencia.slice(0, 4)}`), el('span', {}, `Vence em 20/${venc.slice(5)}/${venc.slice(0, 4)}`)),
    el('div', { class: 'guia-corpo' },
      el('div', { class: 'guia-total' },
        el('div', { class: 'rotulo' }, 'Valor estimado a pagar'),
        el('div', { class: 'valor-grande' }, brl(m.das.total)),
        el('p', {}, `Faturamento do mês: ${brl(m.das.receita)}`),
        Number(m.das.naoTributavel) > 0 ? el('p', {}, `Fora da receita (não tributável): ${brl(m.das.naoTributavel)}`) : null,
        el('p', {}, `Alíquota efetiva média: ${pctBR(m.das.aliquotaMedia, 2)}`)),
      el('div', { class: 'fita' }, fita(m.das.porTributo, m.das.total, 'Total do DAS')))));

  const conta = el('div', { class: 'conta' });
  for (const l of m.das.linhas) conta.append(explicarLinha(l, m));
  sec.append(el('details', { class: 'explica' }, el('summary', {}, 'Como chegamos nesse valor'), conta));
  if (m.reforma) sec.append(renderReforma(m));
  return sec;
}

function explicarLinha(l, m) {
  const rbt = state.empresa[m.competencia]?.rbt12;
  const partes = [
    el('h3', {}, `${l.atividadeNome}: ${brl(l.receita)}`),
  ];
  if (!l.anexo) { partes.push(el('p', {}, 'Não entra no DAS.')); return el('div', {}, partes); }
  if (l.fatorR != null) partes.push(el('p', {}, `Fator "r" = ${pctBR(l.fatorR, 2)}: ${l.anexo === 'III' ? 'igual ou acima de 28%, então a receita vai para o Anexo III' : 'abaixo de 28%, então a receita vai para o Anexo V'}.`));
  partes.push(
    el('p', {}, `Anexo ${l.anexo}, ${l.faixa}ª faixa: alíquota nominal ${pctBR(l.aliquotaNominal, 2)} e parcela a deduzir ${brl(l.parcelaDeduzir)}.`),
    el('p', { class: 'formula' }, `Alíquota efetiva = (${brl(rbt)} × ${pctBR(l.aliquotaNominal, 2)} − ${brl(l.parcelaDeduzir)}) ÷ ${brl(rbt)} = ${pctBR(l.aliquotaEfetiva, 6)}`),
  );
  if (l.tributos.ISS) partes.push(el('p', {}, `Dessa alíquota, ${pctBR(l.tributos.ISS.percentual, 4)} é ISS — é o percentual de ISS que aparece na sua nota fiscal.`));
  if (l.tetoIssAplicado) partes.push(el('p', {}, 'O ISS passaria de 5%: fica limitado a 5% e o excedente vai para os outros tributos (nota da 5ª faixa).'));
  for (const x of l.excluidos ?? []) partes.push(el('p', {}, `Sem ${TRIBUTOS[x.tributo] ?? x.tributo} no DAS: ${x.motivo}.`));
  partes.push(el('p', { class: 'formula' }, `Imposto = ${brl(l.receita)} × ${pctBR(l.aliquotaAplicada, 6)} = ${brl(l.total)}`));
  for (const a of l.avisos ?? []) partes.push(el('p', { class: 'aviso' }, a));
  return el('div', { class: 'grupo-conta' }, partes);
}

function renderReforma(m) {
  const r = m.reforma;
  const sec = el('section', { class: 'reforma' }, el('h3', {}, 'Com a Reforma Tributária', r.simulacao ? el('span', { class: 'selo' }, `simulação com as regras de ${r.competenciaCalculo.slice(0, 4)}`) : null));
  if (r.erro) { sec.append(el('div', { class: 'pendencias' }, el('p', {}, r.erro))); return sec; }
  const dasR = r.das ?? m.das;
  if (r.simulacao) {
    sec.append(el('p', {}, `A partir de 2027 o PIS e a Cofins do DAS viram CBS, e entra uma pequena parcela de IBS. Com o mesmo faturamento, este mês ficaria assim:`));
  }
  sec.append(el('div', { class: 'comparacao' },
    el('div', {}, el('span', {}, r.simulacao ? 'DAS com as regras de 2027' : 'DAS do mês'), el('strong', {}, brl(dasR.total))),
    el('div', {}, el('span', {}, 'CBS dentro do DAS'), el('strong', {}, brl(dasR.porTributo.CBS ?? '0'))),
    el('div', {}, el('span', {}, 'IBS dentro do DAS'), el('strong', {}, brl(dasR.porTributo.IBS ?? '0')))));
  if (r.simulacao) sec.append(el('details', { class: 'explica' }, el('summary', {}, 'Ver a divisão completa do DAS de 2027'), el('div', { class: 'conta fita' }, fita(dasR.porTributo, dasR.total, 'Total do DAS'))));

  const of = r.oficial;
  sec.append(el('p', {}, 'CBS e IBS de cada nota, pelo mesmo cálculo da calculadora oficial da Receita Federal. É o valor que vai destacado no documento fiscal e que o seu cliente pode usar como crédito. Na NFS-e a alíquota é arredondada para 2 casas antes da conta, por isso pode diferir alguns centavos da parcela do DAS.'));
  const notasPorId = Object.fromEntries(state.notas.map((n) => [n.id, n]));
  const ordem = (x) => String(notasPorId[x.nota]?.numero ?? '');
  const linhas = [...of.resultados].sort((a, b) => ordem(a).localeCompare(ordem(b), 'pt-BR', { numeric: true })).map((x) => {
    const n = notasPorId[x.nota];
    const nome = n?.tipo === 'manual' ? `Digitado (${n.descricao ?? ''})` : `${n?.tipo ?? ''} nº ${n?.numero ?? '?'}`;
    if (x.status !== 200) return el('tr', {}, el('td', {}, nome), el('td', { colspan: '5', class: 'aviso' }, (x.resposta.errors ?? []).map((e) => `${e.code}: ${e.detail}`).join(' ')));
    const objs = x.resposta.objetos ?? [];
    const t = objs.length === 1 ? objs[0].tribCalc : null;
    const estado = objs.map((o) => o.estadoItem === 'CALCULADO' ? null : (o.motivoEstado?.descricao ?? (o.erros ?? []).map((e) => `${e.code}: ${e.detail}`).join(' '))).filter(Boolean).join(' ');
    return el('tr', {},
      el('td', {}, nome, estado ? el('span', { class: 'aviso' }, estado) : null),
      el('td', { class: 'valor' }, brl(x.resposta.total?.vRBSNtot)),
      el('td', { class: 'valor' }, t?.pCBSSN ? pctBR(t.pCBSSN) : objs.length > 1 ? 'por item' : '—'),
      el('td', { class: 'valor' }, brl(x.resposta.total?.vCBSSNtot)),
      el('td', { class: 'valor' }, t?.pIBSSN ? pctBR(t.pIBSSN) : objs.length > 1 ? 'por item' : '—'),
      el('td', { class: 'valor' }, brl(x.resposta.total?.vIBSSNtot)));
  });
  sec.append(el('div', { class: 'tabela-rolagem' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Nota', 'Receita (base)', 'Alíq. CBS', 'CBS', 'Alíq. IBS', 'IBS'].map((h, i) => el('th', { scope: 'col', class: i ? 'num-col' : null }, h)))),
    el('tbody', {}, linhas),
    el('tfoot', {}, el('tr', {}, el('td', {}, 'Total das notas'), el('td', { class: 'valor' }, brl(of.total.vRBSN)), el('td'), el('td', { class: 'valor' }, brl(of.total.vCBSSN)), el('td'), el('td', { class: 'valor' }, brl(of.total.vIBSSN)))))));
  sec.append(el('details', { class: 'explica' }, el('summary', {}, 'Ver a requisição e a resposta da calculadora oficial'),
    el('div', { class: 'conta' },
      el('p', {}, 'Linha de alíquotas efetivas do contribuinte (o que o PGDAS-D informa à calculadora):'),
      el('pre', { class: 'json' }, JSON.stringify(of.linhaAliquotas, null, 2)),
      ...of.resultados.map((x) => el('div', {}, el('p', {}, `Nota ${notasPorId[x.nota]?.numero ?? x.nota} — POST /calculadora/observabilidade/simples-nacional/nao-assistido (HTTP ${x.status})`),
        el('pre', { class: 'json' }, JSON.stringify({ requisicao: x.requisicao, resposta: x.resposta }, null, 2)))))));
  return sec;
}
