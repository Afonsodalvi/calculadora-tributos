// Regime Regular module: faithful port of ReceitaFederal/calculadora-rtc-regime-regular
// (CBS, IBS and Imposto Seletivo for companies outside the Simples Nacional). Official routes
// keep the Java API contract under /api/calculadora/... ; each slice lives in its own folder.
import { registrar as calculo } from './calculo/rotas.js';
import { registrar as baseCalculo } from './base-calculo/rotas.js';
import { registrar as dadosAbertos } from './dados-abertos/rotas.js';
import { registrar as xml } from './xml/rotas.js';
import { registrar as versao } from './versao/rotas.js';

export function moduloRegimeRegular({ base, raiz }) {
  const deps = { base, raiz };
  return {
    id: 'regime-regular',
    nome: 'Regime Regular',
    deps,
    registrar(r) {
      for (const f of [calculo, baseCalculo, dadosAbertos, xml, versao]) f(r, deps);
    },
  };
}
