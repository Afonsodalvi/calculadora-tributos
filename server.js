// Entry point. Local mode by default (127.0.0.1:5180). To publish the API for other users,
// see README "Publicar a API" (HOST, API_TOKEN, ALLOWED_HOSTS, CORS_ORIGINS, RATE_LIMIT, TRUST_PROXY).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// node:sqlite exists without a flag from Node 22.13 (and 23.4 on the 23 line). The app modules
// import it statically, so check the version before loading them: an older Node would otherwise
// stop with an obscure "No such built-in module" error.
const [maior, menor] = process.versions.node.split('.').map(Number);
if (maior < 22 || (maior === 22 && menor < 13) || (maior === 23 && menor < 4)) {
  console.error(`Node.js ${process.versions.node} não é suportado: instale o Node.js 22.13 ou mais novo (LTS em https://nodejs.org).`);
  process.exit(1);
}
const { lerConfig } = await import('./src/http/config.js');
const { criarApp } = await import('./src/app.js');

let cfg;
try {
  cfg = lerConfig();
} catch (e) {
  console.error(`Configuração inválida: ${e.message}`);
  process.exit(1);
}
const app = criarApp(cfg, { raiz: fileURLToPath(new URL('.', import.meta.url)) });
const server = createServer(app.handler);
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;

server.listen(cfg.port, cfg.host, () => {
  const endereco = cfg.local ? `http://localhost:${cfg.port}` : `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`;
  console.log(`Calculadora de tributos pronta em ${endereco}`);
  console.log(`API: ${endereco}/api  (documentação: ${endereco}/api.html)`);
  console.log(`Base de dados oficial da Receita: ${app.versaoBase?.v} (${app.versaoBase?.d})`);
  // also behind a reverse proxy (HOST=127.0.0.1 with a token): say what is enforced
  if (!cfg.local || cfg.token || cfg.limitePorMinuto) {
    console.log(`Proteções: token ${cfg.token ? 'exigido' : cfg.local ? 'desligado' : 'DESLIGADO (PUBLIC_API=1)'}, limite ${cfg.limitePorMinuto || 'sem'} req/min por IP${cfg.confiarProxy ? ' (IP do cliente pelo X-Forwarded-For)' : ''}.`);
  }
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => server.close(() => { app.fechar(); process.exit(0); }));
}
