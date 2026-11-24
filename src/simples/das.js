// DAS (Documento de Arrecadação do Simples Nacional) — LC 123/2006 art. 18 and Res. CGSN 140/2018:
//   alíquota efetiva AE = (RBT12 × Aliq − PD) / RBT12 (art. 18 §1-A; RBT12 = 0 counts as R$ 1,00),
//   repartida entre os tributos pelos percentuais da faixa (§1-B). ISS limited to the cap of the
//   5th-faixa note of Anexos III/IV (5% until 2028), the excess going to the other taxes by the
//   note's coefficients. Above the 5th faixa (RBT12 > R$ 3,6 mi), federal taxes use the 6th faixa
//   and, while the sublimite is not exceeded in the year, ICMS/ISS/IBS use the 5th-faixa formula
//   (Res. CGSN 140 art. 21 III "b" / IV). Amounts rounded to cents, half up (Res. CGSN 190 art. 45-A).
// The official RFB calculator (src/rtc) does NOT do this part: it receives the effective-rate
// line ready (PGDAS-D). This module produces that line from the law's tables (data/anexos.json).
import { Dec } from '../core/decimal.js';

const CASAS = 30; // internal precision of effective percentages (PGDAS-D carries 26 in percent points)
const HUNDRED = Dec.of('100');
const SUBNACIONAIS = ['ICMS', 'ISS', 'IBS'];

export function criarDas(tabelas) {
  const limites = tabelas.limites.map((v) => Dec.of(String(v)));
  const sublimite = Dec.of(String(tabelas.sublimite));
  const limite = Dec.of(String(tabelas.limite));

  function periodo(competencia) {
    const p = tabelas.periodos.find((x) => competencia >= x.inicio && (x.fim == null || competencia <= x.fim));
    if (!p) throw new Error(`As tabelas do Simples Nacional para ${competencia} não estão incluídas nesta calculadora.`);
    return p;
  }

  /** Faixa (0..5) for RBT12; "até 180.000,00" is inclusive. */
  const faixaIndex = (rbt12) => { const i = limites.findIndex((l) => rbt12.cmp(l) <= 0); return i === -1 ? 5 : i; };

  /** AE in percent points: (RBT12 × Aliq − PD) / RBT12, RBT12 = 0 → R$ 1,00. */
  function ae(rbt12, aliquota, deduzir) {
    const base = rbt12.isZero() ? Dec.ONE : rbt12;
    return base.mul(Dec.of(aliquota)).sub(Dec.of(deduzir).mul(HUNDRED)).div(base, CASAS);
  }

  function aliquotaEfetiva(per, anexo, rbt12) {
    const fi = faixaIndex(rbt12);
    const f = per.anexos[anexo].faixas[fi];
    return { faixa: fi + 1, nominal: Dec.of(f.aliquota), deduzir: Dec.of(f.deduzir), ae: ae(rbt12, f.aliquota, f.deduzir), def: f };
  }

  /**
   * Effective percentage of each tax (percent of revenue).
   * comRedistribuicao: the ISS is inside the DAS for this revenue, so the ISS cap of the 5th
   * faixa applies; otherwise the plain repartition ("par sem redistribuição do ISS").
   * sublimiteExcedido: RBT12 above R$ 3,6 mi AND sublimite exceeded in the year → no ICMS/ISS/IBS.
   */
  function partilha(per, anexo, rbt12, { comRedistribuicao = true, sublimiteExcedido = true } = {}) {
    const a = aliquotaEfetiva(per, anexo, rbt12);
    const out = {};
    let tetoIssAplicado = false;
    const pctOf = (base, p) => base.mul(Dec.of(p)).div(HUNDRED, CASAS);
    const teto = a.def.tetoIss;
    const issNormal = a.def.reparticao.ISS ? pctOf(a.ae, a.def.reparticao.ISS) : null;
    if (comRedistribuicao && teto && issNormal && issNormal.cmp(Dec.of(teto.iss)) > 0) {
      tetoIssAplicado = true;
      const excesso = a.ae.sub(Dec.of(teto.iss));
      for (const [t, p] of Object.entries(teto.excedente)) out[t] = pctOf(excesso, p);
      out.ISS = Dec.of(teto.iss).setScale(CASAS);
    } else {
      for (const [t, p] of Object.entries(a.def.reparticao)) out[t] = pctOf(a.ae, p);
    }
    // art. 18 §1-B, II: a diferença centesimal entre o total dos percentuais e a alíquota efetiva
    // vai para o tributo com maior percentual de repartição (some LC 227 tables sum to 99,99/100,01%)
    const pesos = tetoIssAplicado ? teto.excedente : a.def.reparticao;
    const maior = Object.entries(pesos).filter(([t]) => t in out).sort((x, y) => Dec.of(y[1]).cmp(x[1]))[0]?.[0];
    const diferenca = a.ae.sub(Object.values(out).reduce((s, v) => s.add(v), Dec.ZERO));
    if (maior && !diferenca.isZero()) out[maior] = out[maior].add(diferenca);
    const sub = a.def.subnacionaisPela5aFaixa;
    if (sub && !sublimiteExcedido) {
      const ae5 = ae(rbt12, sub.aliquota, sub.deduzir);
      for (const [t, p] of Object.entries(sub.percentuais)) out[t] = pctOf(ae5, p);
      // ISS still capped (art. 18 §1-B, I); the excess goes to the federal taxes by the
      // redistribution table (Res. CGSN 140 notes: for III/IV the 5th-faixa note coefficients)
      const f5 = per.anexos[anexo].faixas[4];
      const tetoPer = Dec.of(f5.tetoIss?.iss ?? '5');
      if (out.ISS && out.ISS.cmp(tetoPer) > 0) {
        const excesso = out.ISS.sub(tetoPer);
        out.ISS = tetoPer.setScale(CASAS);
        const coef = a.def.redistribuicaoIss ?? f5.tetoIss?.excedente;
        if (coef) {
          tetoIssAplicado = true;
          for (const [t, p] of Object.entries(coef)) if (t !== 'ISS') out[t] = (out[t] ?? Dec.ZERO).add(pctOf(excesso, p));
        }
      }
    }
    return { ...a, anexo, percentuais: out, tetoIssAplicado };
  }

  /** r = FS12 / RBT12; Res. CGSN 140 art. 26 §§6-7: no revenue → 0,28 with payroll, 0,01 without. */
  function fatorR(folha12, rbt12) {
    if (folha12 == null) return null;
    if (rbt12.isZero()) return Dec.of(folha12.isZero() ? '0.01' : '0.28');
    if (folha12.isZero()) return Dec.of('0.01');
    return folha12.div(rbt12, 10);
  }

  /**
   * DAS of one revenue group (receitas do mês de um mesmo tipo, já somadas — art. 18 §4º).
   * p: competencia 'YYYY-MM', rbt12 Dec, folha12 Dec|null, valor Dec,
   *    das: { anexo, anexoAte2026?, anexoFatorR?, semIss?, semIcms?, maisIcmsDoI? } (null = não tributável),
   *    issRetido, issForaDoSimples (regApTribSN 2/3), issNaoIncide (tribISSQN 2/3/4), issIsento (tpBM 1),
   *    exportacao, icmsSt,
   *    sublimiteExcedido (only matters for RBT12 > R$ 3,6 mi; default true)
   */
  function calcularReceita(p) {
    const per = periodo(p.competencia);
    const aj = p.das;
    const avisos = [];
    if (aj == null) {
      return { anexo: null, valor: p.valor, tributos: {}, excluidos: [], total: Dec.ZERO.setScale(2), aliquotaAplicada: Dec.ZERO, avisos: ['Operação não tributável: não entra no DAS.'], periodo: per.id };
    }
    let anexo = aj.anexoAte2026 && p.competencia <= '2026-12' ? aj.anexoAte2026 : aj.anexo;
    let r = null;
    if (aj.anexoFatorR) {
      r = fatorR(p.folha12, p.rbt12);
      if (r == null) throw new Error('Informe a folha de salários dos últimos 12 meses: esta atividade depende do Fator "r".');
      anexo = r.cmp('0.28') >= 0 ? aj.anexoFatorR : aj.anexo;
    }
    const acimaSublimite = p.rbt12.cmp(sublimite) > 0;
    const sublimiteExcedido = acimaSublimite && p.sublimiteExcedido !== false;
    const temIssNoAnexo = 'ISS' in per.anexos[anexo].faixas[0].reparticao;
    const issNoDas = temIssNoAnexo && !aj.semIss && !p.issRetido && !p.issForaDoSimples && !p.issNaoIncide && !p.issIsento && !p.exportacao && !sublimiteExcedido;
    const part = partilha(per, anexo, p.rbt12, { comRedistribuicao: issNoDas, sublimiteExcedido });
    const perc = { ...part.percentuais };
    const excluidos = [];
    const excluir = (t, motivo) => { if (t in perc) { delete perc[t]; excluidos.push({ tributo: t, motivo }); } };

    if (temIssNoAnexo && !issNoDas) {
      excluir('ISS', aj.semIss ? 'atividade sem ISS no Simples' : p.issRetido ? 'ISS retido pelo tomador do serviço'
        : p.issForaDoSimples ? 'ISS recolhido fora do Simples (regApTribSN)' : p.issNaoIncide ? 'ISS não incide (imunidade, exportação ou não incidência)'
          : p.issIsento ? 'isenção municipal do ISS'
          : p.exportacao ? 'exportação' : 'sublimite excedido');
    }
    if (aj.maisIcmsDoI) {
      const pI = partilha(per, 'I', p.rbt12, { comRedistribuicao: false, sublimiteExcedido });
      if (pI.percentuais.ICMS) perc.ICMS = pI.percentuais.ICMS;
    }
    if (aj.semIcms) excluir('ICMS', 'atividade sem incidência de ICMS');
    if (p.icmsSt) excluir('ICMS', 'ICMS já recolhido por substituição tributária');
    if (p.exportacao) for (const t of ['COFINS', 'PIS', 'ICMS', 'IPI', 'ISS', 'CBS', 'IBS']) excluir(t, 'receita de exportação (LC 123, art. 18 §14)');
    if (sublimiteExcedido) {
      for (const t of SUBNACIONAIS) excluir(t, 'sublimite de R$ 3,6 milhões excedido: recolhido fora do DAS');
      avisos.push('Receita acima do sublimite de R$ 3,6 milhões: ICMS, ISS e IBS são pagos fora do DAS.');
    } else if (acimaSublimite) {
      avisos.push('RBT12 acima de R$ 3,6 milhões: tributos federais pela 6ª faixa; ICMS/ISS/IBS pela fórmula da 5ª faixa enquanto o sublimite não for excedido no ano.');
    }
    if (p.rbt12.cmp(limite) > 0) avisos.push('RBT12 acima de R$ 4,8 milhões: a empresa fica sujeita à exclusão do Simples Nacional.');

    const tributos = {};
    for (const [t, v] of Object.entries(perc)) tributos[t] = { percentual: v, valor: p.valor.mul(v).movePointLeft(2).setScale(2, 'HALF_UP') };
    const total = Object.values(tributos).reduce((s, x) => s.add(x.valor), Dec.ZERO.setScale(2));
    const aliquotaAplicada = Object.values(perc).reduce((s, v) => s.add(v), Dec.ZERO);
    return {
      anexo, faixa: part.faixa, aliquotaNominal: part.nominal, parcelaDeduzir: part.deduzir, aliquotaEfetiva: part.ae,
      aliquotaAplicada, fatorR: r, tetoIssAplicado: part.tetoIssAplicado, issNoDas, valor: p.valor, tributos, excluidos,
      total, avisos, periodo: per.id,
    };
  }

  /**
   * The contributor's effective-rate line in the format of the official engine (aliquotasEfetivas):
   * per Anexo the pair "com redistribuição do ISS" and, for III–V, the pair "sem redistribuição",
   * in percent points. null for periods without CBS/IBS (until 2026).
   */
  function linhaAliquotasEfetivas(competencia, rbt12, folha12, { sublimiteExcedido = true } = {}) {
    const per = periodo(competencia);
    if (!per.tributos.includes('CBS')) return null;
    const r = fatorR(folha12, rbt12);
    const impedimento = rbt12.cmp(sublimite) > 0 && sublimiteExcedido;
    const par = (pt) => ({ pCBSSN: (pt.CBS ?? Dec.ZERO).toString(), pIBSSN: impedimento || pt.IBS == null ? null : pt.IBS.toString() });
    const linha = { fatorR: r == null ? null : r.cmp('0.28') >= 0, impedimentoSublimite: impedimento };
    for (const a of ['I', 'II', 'III', 'IV', 'V']) {
      const entrada = par(partilha(per, a, rbt12, { comRedistribuicao: true, sublimiteExcedido }).percentuais);
      if (['III', 'IV', 'V'].includes(a)) entrada.semRedistribuicaoISS = par(partilha(per, a, rbt12, { comRedistribuicao: false, sublimiteExcedido }).percentuais);
      linha['anexo' + a] = entrada;
    }
    return linha;
  }

  return { periodo, aliquotaEfetiva, partilha, calcularReceita, linhaAliquotasEfetivas, fatorR, faixaIndex };
}
