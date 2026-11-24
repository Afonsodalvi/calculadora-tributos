// Differential run against the official Java API (regime regular, running locally).
//
// Usage (from calculadora-tributos/):
//   node --disable-warning=ExperimentalWarning test/regime-regular/diferencial/rodar.mjs [options]
//
//   --oraculo=URL        official API base (default $ORACULO_URL or http://127.0.0.1:8080)
//   --seed=N             seed given to every generator (default 20261123)
//   --n=N                cases requested from each generator (default 300)
//   --geradores=a,b      only these generator files of geradores/ (default: all *.mjs)
//   --saida=ARQ          divergences JSON (default test/regime-regular/diferencial/divergencias.json)
//   --mostrar=N          divergences printed on screen (default 10)
//   --concorrencia=N     parallel requests (default 8)
//
// Each geradores/<nome>.mjs exports gerar({ seed, n, base }) → array of
//   { metodo, caminho ('/api/...?...' raw, sent verbatim), headers?, corpo? (string|Buffer), rotulo? }
// `base` = read-only connection to data/calculadora-pro.db (src/core/db.js API) to pick real codes.
// Our app runs in-process on a random port; both sides receive the same raw request and the same
// Host header. The process exits with code 1 when there are divergences.
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { abrirBanco } from '../../../src/core/db.js';
import { subirApp, compararTodos } from '../../lib/diferencial.js';
import { raiz } from '../../lib/servidor.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const ORACULO = args.oraculo ?? process.env.ORACULO_URL ?? 'http://127.0.0.1:8080';
const SEED = Number(args.seed ?? 20261123);
const N = Number(args.n ?? 300);
const PASTA = fileURLToPath(new URL('./geradores/', import.meta.url));
const SAIDA = args.saida ?? fileURLToPath(new URL('./divergencias.json', import.meta.url));
const MOSTRAR = Number(args.mostrar ?? 10);

const escolhidos = args.geradores ? args.geradores.split(',') : null;
const arquivos = readdirSync(PASTA).filter((f) => f.endsWith('.mjs')).filter((f) => !escolhidos || escolhidos.includes(f.replace(/\.mjs$/, '')));
if (!arquivos.length) { console.error('nenhum gerador encontrado'); process.exit(2); }

const base = abrirBanco(join(raiz, 'data', 'calculadora-pro.db'));
const app = await subirApp();
const totais = { casos: 0, divergencias: 0, porGerador: {}, statusJava: {}, statusPorte: {}, normalizados: {} };
const divergencias = [];
const inicio = Date.now();
try {
  for (const arq of arquivos) {
    const nome = arq.replace(/\.mjs$/, '');
    const { gerar } = await import(pathToFileURL(join(PASTA, arq)).href);
    const reqs = (await gerar({ seed: SEED, n: N, base })).map((r) => ({ ...r, headers: { host: app.host, ...(r.headers ?? {}) } }));
    const res = await compararTodos(reqs, { oraculo: ORACULO, app: app.base }, { concorrencia: Number(args.concorrencia ?? 8) });
    let div = 0;
    for (const r of res) {
      totais.casos++;
      for (const n of r.notas ?? []) totais.normalizados[n] = (totais.normalizados[n] ?? 0) + 1;
      const sj = r.java?.status ?? 'erro', sp = r.porte?.status ?? 'erro';
      totais.statusJava[sj] = (totais.statusJava[sj] ?? 0) + 1;
      totais.statusPorte[sp] = (totais.statusPorte[sp] ?? 0) + 1;
      if (!r.igual) {
        div++;
        const corpo = (x) => (x == null ? null : Buffer.isBuffer(x) ? x.toString('utf8').slice(0, 2000) : String(x).slice(0, 2000));
        divergencias.push({
          gerador: nome, rotulo: r.req.rotulo ?? null, metodo: r.req.metodo ?? 'GET', caminho: r.req.caminho, headers: r.req.headers, corpo: corpo(r.req.corpo),
          divergencias: r.divergencias,
          java: r.java && { status: r.java.status, corpo: corpo(r.java.corpo) }, porte: r.porte && { status: r.porte.status, corpo: corpo(r.porte.corpo) },
        });
      }
    }
    totais.divergencias += div;
    totais.porGerador[nome] = { casos: res.length, divergencias: div };
    console.log(`${nome}: ${res.length} casos, ${div} divergências`);
  }
} finally {
  await app.fechar();
  base.close();
}
writeFileSync(SAIDA, JSON.stringify({ oraculo: ORACULO, seed: SEED, n: N, totais, divergencias }, null, 2));
console.log(`\ntotal: ${totais.casos} casos, ${totais.divergencias} divergências (${((Date.now() - inicio) / 1000).toFixed(1)} s)`);
console.log('status (java):', JSON.stringify(totais.statusJava), ' status (porte):', JSON.stringify(totais.statusPorte));
console.log('normalizados (não determinismo do Java):', JSON.stringify(totais.normalizados));
for (const d of divergencias.slice(0, MOSTRAR)) {
  console.log(`\n[${d.gerador}] ${d.rotulo ?? ''} ${d.metodo} ${d.caminho}`);
  for (const x of d.divergencias) console.log(`  - ${x}`);
}
console.log(`\ndivergências gravadas em ${SAIDA}`);
process.exitCode = totais.divergencias ? 1 : 0;
