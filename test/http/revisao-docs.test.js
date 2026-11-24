// Docs/deploy review (batch E-docs): what the README, /api.html and the build/deploy files promise
// must hold against the real app — README recipes are run as written (bash + curl + node), the
// curl lines of /api.html are executed, and the scripts are run on temporary files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { lerConfig } from '../../src/http/config.js';
import { criarApp } from '../../src/app.js';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const README = readFileSync(join(raiz, 'README.md'), 'utf8');
const NODE = process.execPath;
const PATH = `${dirname(NODE)}${delimiter}${process.env.PATH}`;
const MiB = 1024 * 1024;
const TOKEN = 'b7e3c1a95f2d4e8a0c6b9d1f3a5e7c2b';

const tem = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const temporario = () => mkdtempSync(join(tmpdir(), 'revisao-docs-'));

/** Async shell run (the app under test lives in this process: never block the event loop). */
const bash = (script, { cwd = raiz, env = {} } = {}) => new Promise((resolve) => {
  execFile('bash', ['-c', script], { cwd, env: { PATH, HOME: process.env.HOME, ...env }, maxBuffer: 64 * MiB, timeout: 120_000 },
    (erro, stdout, stderr) => resolve({ codigo: erro ? (erro.code ?? 1) : 0, stdout, stderr }));
});

/** Nth ```bash block after the first occurrence of `marcador` in the README. */
function blocoApos(marcador, n = 0) {
  let i = README.indexOf(marcador);
  assert.ok(i >= 0, `README sem "${marcador}"`);
  for (let k = 0; k <= n; k++) {
    i = README.indexOf('```bash\n', i);
    assert.ok(i >= 0, `README sem bloco bash ${n} depois de "${marcador}"`);
    i += '```bash\n'.length;
  }
  return README.slice(i, README.indexOf('\n```', i));
}

const portaLivre = () => new Promise((resolve) => {
  const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** Real app on a random port with cfg.port = that port (so Host 127.0.0.1:<porta> is accepted). */
async function subirNaPorta(env = {}) {
  let app;
  const server = createServer((req, res) => app.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  app = criarApp(lerConfig({ ...env, PORT: String(porta) }), { raiz });
  return { porta, base: `http://127.0.0.1:${porta}`, app, fechar: () => new Promise((r) => server.close(() => { app.fechar(); r(); })) };
}

const chamar = (porta, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: porta, path, method, headers }, (res) => {
    const partes = [];
    res.on('data', (c) => partes.push(c));
    res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(body);
});

/** Sends only the request head with a Content-Length: the status the server answers before any body. */
const statusSoCabecalho = (porta, path, tamanho, tipo) => new Promise((resolve, reject) => {
  const sock = connect(porta, '127.0.0.1', () => {
    sock.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${porta}\r\nContent-Type: ${tipo}\r\nContent-Length: ${tamanho}\r\n\r\n`);
  });
  let dados = '';
  sock.on('data', (c) => {
    dados += c;
    const m = /^HTTP\/1\.1 (\d{3})/.exec(dados);
    if (m) { sock.destroy(); resolve(Number(m[1])); }
  });
  sock.on('error', reject);
});

// ─── R14: the README "read an invoice and calculate" example, run as written ─────────────────

test('R14: "Ler uma nota e calcular" do README roda de ponta a ponta (notas → preparar → calcular, e o Simples)', { skip: !tem('curl') && 'sem curl' }, async () => {
  const s = await subirNaPorta();
  const dir = temporario();
  try {
    copyFileSync(join(raiz, 'test/fixtures/notas/oficiais/nfe_valido.xml'), join(dir, 'nota.xml'));
    const local = (b) => b.replaceAll('http://localhost:5180', s.base);

    const regular = await bash(local(blocoApos('Ler uma nota e calcular')), { cwd: dir });
    assert.equal(regular.codigo, 0, regular.stderr);
    const nota = JSON.parse(readFileSync(join(dir, 'nota.json'), 'utf8'));
    assert.equal(nota.nota.tipo, 'NF-e');
    const ops = JSON.parse(readFileSync(join(dir, 'operacoes.json'), 'utf8'));
    assert.ok(Array.isArray(ops.operacoes) && ops.operacoes.length === 1, JSON.stringify(ops).slice(0, 300));
    const calculo = JSON.parse(regular.stdout);
    assert.ok(Array.isArray(calculo.resultados) && calculo.resultados.length === 1, regular.stdout.slice(0, 300));
    assert.ok(calculo.resultados[0].notaId, 'resultado da nota');
    assert.ok(calculo.resumo, 'resumo mensal');

    const simples = await bash(local(blocoApos('A mesma nota no Simples Nacional')), { cwd: dir });
    assert.equal(simples.codigo, 0, simples.stderr);
    const das = JSON.parse(simples.stdout);
    assert.equal(das.meses?.[0]?.competencia, nota.nota.competencia, simples.stdout.slice(0, 300));
    assert.ok(das.meses[0].das.linhas.length >= 1, 'DAS calculado');
  } finally { await s.fechar(); }
});

// ─── R4 / SEC-5: server recipe (token shown and saved, loopback bind, rate limit on) ──────────

test('R4/SEC-5: a receita de servidor do README guarda e mostra o token; o servidor fica só no 127.0.0.1, exige o token e limita por IP', { skip: !(tem('openssl') && tem('npm')) && 'sem openssl/npm', timeout: 60_000 }, async () => {
  const home = temporario();
  const gerar = await bash(blocoApos('Gere o token uma vez'), { env: { HOME: home } });
  assert.equal(gerar.codigo, 0, gerar.stderr);
  const arquivo = join(home, 'calculadora-api-token.txt');
  const token = readFileSync(arquivo, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.ok(gerar.stdout.includes(token), 'o token aparece para o operador');
  assert.equal(statSync(arquivo).mode & 0o077, 0, 'só o dono lê o arquivo do token');

  const iniciar = blocoApos('Inicie (a cada vez');
  assert.match(iniciar, /HOST=127\.0\.0\.1\b/);
  assert.match(iniciar, /TRUST_PROXY=1/);
  assert.match(iniciar, /RATE_LIMIT=\d+/);
  const porta = await portaLivre();
  const filho = spawn('bash', ['-c', iniciar.replace('PORT=5180', `PORT=${porta}`)], { cwd: raiz, env: { PATH, HOME: home }, detached: true });
  let saida = '';
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`servidor não subiu: ${saida}`)), 30_000);
      filho.stdout.on('data', (c) => { saida += c; if (saida.includes('pronta em')) { clearTimeout(t); resolve(); } });
      filho.stderr.on('data', (c) => { saida += c; });
      filho.on('exit', (c) => { clearTimeout(t); reject(new Error(`servidor saiu (${c}): ${saida}`)); });
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.match(saida, /token exigido, limite 120 req\/min/);
    const H = { host: 'calc.suaempresa.com.br' };
    assert.equal((await chamar(porta, '/api/simples/info', { headers: H })).status, 401);
    assert.equal((await chamar(porta, '/api/simples/info', { headers: { ...H, authorization: `Bearer ${token}` } })).status, 200);
    // not reachable from another interface of this machine (only through the proxy on 127.0.0.1)
    const externo = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (externo) {
      const erro = await new Promise((resolve) => {
        const sock = connect(porta, externo.address, () => { sock.destroy(); resolve(null); });
        sock.on('error', (e) => resolve(e.code));
      });
      assert.equal(erro, 'ECONNREFUSED', `porta ${porta} aberta em ${externo.address}`);
    }
  } finally {
    try { process.kill(-filho.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
});

test('SEC-5: exemplos de publicação do README não expõem a porta HTTP nem confiam em X-Forwarded-For de qualquer um', () => {
  const docker = README.split('\n').filter((l) => l.startsWith('docker run'));
  assert.ok(docker.length >= 1);
  for (const l of docker) {
    assert.match(l, /-p 127\.0\.0\.1:5180:5180/, l);
    assert.doesNotMatch(l, /troque-por|<token/, l);
  }
  for (const l of README.split('\n').filter((x) => /TRUST_PROXY=1/.test(x) && /node server\.js|npm start/.test(x))) {
    assert.doesNotMatch(l, /HOST=0\.0\.0\.0/, l);
  }
});

// ─── R8: token exemptions and body limits ────────────────────────────────────────────────────

test('R8: rotas sem token listadas no README = rotas públicas do servidor', async () => {
  const linha = README.split('\n').find((l) => l.startsWith('| `API_TOKEN`'));
  const documentadas = [...linha.slice(linha.indexOf('exceto')).matchAll(/`(\/api\/[^`]+)`/g)].map((m) => m[1]).sort();
  const s = await subirNaPorta({ API_TOKEN: TOKEN });
  try {
    const publicas = s.app.rotas.filter((r) => r.publica).map((r) => r.path).sort();
    assert.deepEqual(documentadas, publicas);
    for (const p of documentadas) assert.equal((await chamar(s.porta, p)).status, 200, p);
    assert.equal((await chamar(s.porta, '/api/simples/info')).status, 401);
  } finally { await s.fechar(); }
});

test('R8: limites de corpo do README conferem com o servidor', async () => {
  const texto = README.replace(/\s+/g, ' '); // line wrapping is not content
  const paragrafo = texto.slice(texto.indexOf('Proteções que já vêm ligadas'), texto.indexOf('nota é gravada em disco'));
  assert.ok(paragrafo.length > 100, 'parágrafo de proteções não encontrado');
  const LIMITES = [
    [16, ['/api/calculadora/regime-geral', '/api/calculadora/observabilidade/regime-geral', '/api/calculadora/xml/generate?tipo=nfe', '/api/calculadora/xml/validate?tipo=nfe&subtipo=grupo'], '16 MB em\n`/api/calculadora/regime-geral`'],
    [2, ['/api/notas', '/api/regime-regular/preparar', '/api/regime-regular/calcular', '/api/simples/calcular', '/api/calculadora/base-calculo/cbs-ibs-mercadorias', '/api/calculadora/pedagio', '/api/calculadora/observabilidade/simples-nacional'], '2 MB nas demais rotas, inclusive `/api/notas`'],
  ];
  for (const [, , frase] of LIMITES) assert.ok(paragrafo.includes(frase.replace(/\s+/g, ' ')), `README sem "${frase}"`);
  assert.match(paragrafo, /XML de uma nota limitado a 1 MB/);
  assert.doesNotMatch(paragrafo, /\b(5|15) MB\b/, 'limite que o código não tem');
  const s = await subirNaPorta();
  try {
    for (const [mb, rotas] of LIMITES) {
      const corpo = ' '.repeat(mb * MiB - 1024);
      for (const p of rotas) {
        const tipo = p.includes('/xml/validate') ? 'application/xml' : 'application/json';
        assert.equal(await statusSoCabecalho(s.porta, p, mb * MiB + 1, tipo), 413, `${p} acima de ${mb} MB`);
        const r = await chamar(s.porta, p, { method: 'POST', headers: { 'content-type': tipo }, body: corpo });
        assert.notEqual(r.status, 413, `${p} abaixo de ${mb} MB`);
      }
    }
    const xml = `<?xml version="1.0"?><NFe><infNFe Id="x">${' '.repeat(MiB + 100)}</infNFe></NFe>`;
    const r = await chamar(s.porta, '/api/notas', { method: 'POST', headers: { 'x-filename': 'a.xml' }, body: xml });
    assert.equal(r.status, 422);
    assert.match(r.texto, /grande demais/);
  } finally { await s.fechar(); }
});

// ─── R9: the per-route curl lines of /api.html ───────────────────────────────────────────────

test('R9: as linhas curl de /api.html rodam como estão (exemplos do documento; sem exemplo, corpo em arquivo)', { skip: !tem('curl') && 'sem curl', timeout: 120_000 }, async () => {
  const { montarChamada } = await import('../../public/js/api-doc.js');
  const s = await subirNaPorta();
  try {
    const base = `${s.base}/api`;
    const doc = JSON.parse((await chamar(s.porta, '/api/openapi.json')).texto);
    const chamadas = [];
    for (const [path, metodos] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(metodos)) chamadas.push({ chave: `${m.toUpperCase()} ${path}`, ...montarChamada(doc, base, path, m.toUpperCase(), op) });
    }
    for (const c of chamadas) {
      if (/ -d '/.test(c.curl)) assert.ok(c.executavel, `${c.chave}: corpo de exemplo numa linha que não roda`);
      if (!c.executavel) assert.match(c.curl, /<[^>]+>|\{[^}]+\}|@\w/, `${c.chave}: linha não executável sem marcar o que preencher`);
    }
    const principais = [
      'POST /calculadora/regime-geral', 'POST /calculadora/observabilidade/regime-geral',
      'POST /calculadora/observabilidade/simples-nacional', 'POST /calculadora/observabilidade/simples-nacional/nao-assistido',
      'GET /calculadora/simples-nacional/atividades', 'GET /calculadora/simples-nacional/atividades/{codigo}',
      'POST /simples/calcular', 'POST /regime-regular/calcular', 'GET /calculadora/observabilidade/erros',
    ];
    for (const k of principais) assert.ok(chamadas.find((c) => c.chave === k)?.executavel, `${k} sem linha pronta`);
    const falhas = [];
    for (const c of chamadas.filter((x) => x.executavel)) {
      const r = await bash(`${c.curl} -o /dev/null -w '%{http_code}'`);
      if (!(Number(r.stdout) >= 200 && Number(r.stdout) < 400)) falhas.push(`${c.chave} → ${r.stdout || r.stderr}`);
    }
    assert.deepEqual(falhas, []);
    // Simples examples list activities (the upstream 2026-01-01 example lists none)
    const ativ = await bash(chamadas.find((c) => c.chave === 'GET /calculadora/simples-nacional/atividades').curl);
    assert.ok(JSON.parse(ativ.stdout).length > 0, ativ.stdout.slice(0, 200));
  } finally { await s.fechar(); }
});

// ─── R13: clone step and Docker healthcheck ──────────────────────────────────────────────────

test('R13: HEALTHCHECK do Dockerfile segue PORT; o passo de clone entra na pasta do app', async () => {
  const linha = readFileSync(join(raiz, 'Dockerfile'), 'utf8').split('\n').find((l) => l.startsWith('HEALTHCHECK'));
  const cmd = linha.slice(linha.indexOf(' CMD ') + 5);
  assert.match(cmd, /process\.env\.PORT/, 'porta fixa no HEALTHCHECK');
  // container-like config: token + ALLOWED_HOSTS; the healthcheck reaches it through 127.0.0.1:$PORT
  const s = await subirNaPorta({ API_TOKEN: TOKEN, ALLOWED_HOSTS: 'calc.suaempresa.com.br' });
  try {
    assert.equal((await bash(cmd, { env: { PORT: String(s.porta) } })).codigo, 0);
    assert.notEqual((await bash(cmd, { env: { PORT: String(await portaLivre()) } })).codigo, 0);
  } finally { await s.fechar(); }
  assert.match(README, /git clone \S+ (\S+) && cd \1\n/); // the app is the repository root
});

// ─── R12: Node version ───────────────────────────────────────────────────────────────────────

test('R12: Node sem node:sqlite recebe mensagem clara; engines = mínimo real (22.13 / 23.4)', async () => {
  assert.equal(JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8')).engines.node, '^22.13.0 || >=23.4.0');
  assert.match(README, /Node\.js 22\.13 ou mais novo/);
  for (const versao of ['22.12.0', '23.3.0', '20.19.0']) {
    const porta = await portaLivre();
    const falsa = `data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"${versao}"}})`;
    const filho = spawn(NODE, ['--import', falsa, '--disable-warning=ExperimentalWarning', 'server.js'], { cwd: raiz, env: { PATH, PORT: String(porta) } });
    let erro = '';
    filho.stderr.on('data', (c) => { erro += c; });
    const codigo = await new Promise((resolve) => {
      const t = setTimeout(() => { filho.kill(); resolve('não parou'); }, 10_000);
      filho.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(codigo, 1, `Node ${versao}: ${erro}`);
    assert.match(erro, new RegExp(`Node\\.js ${versao.replaceAll('.', '\\.')} não é suportado.*22\\.13`));
  }
});

// ─── R3: build-db ────────────────────────────────────────────────────────────────────────────

test('R3: build-db valida a pasta antes de tudo e só troca a base no fim', () => {
  const dir = temporario();
  const alvo = join(dir, 'alvo.db');
  writeFileSync(alvo, 'base-antiga');
  const rodar = (sqlDir) => spawnSync(NODE, ['--disable-warning=ExperimentalWarning', join(raiz, 'scripts/build-db.mjs'), sqlDir, alvo], { encoding: 'utf8' });

  let r = rodar('/caminho/que/nao/existe');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(readFileSync(alvo, 'utf8'), 'base-antiga');
  assert.equal(existsSync(`${alvo}.novo`), false);

  const sql = join(dir, 'flyway', 'sql');
  mkdirSync(join(sql, 'criacao'), { recursive: true });
  mkdirSync(join(sql, 'manutencao'));
  writeFileSync(join(sql, 'criacao', 'beforeMigrate.sql'), 'SELECT 1;');
  writeFileSync(join(sql, 'criacao', 'B0001__sistema_tributario_completo.sql'), "CREATE TABLE VERSAO_BASE_DADO (VRBD_ID INTEGER PRIMARY KEY, VRBD_VERSAO_BASE_DADO TEXT);\nINSERT INTO VERSAO_BASE_DADO VALUES (1, 'V0001');");
  writeFileSync(join(sql, 'criacao', 'afterMigrate.sql'), 'SELECT 1;');
  writeFileSync(join(sql, 'manutencao', 'V0002__quebrada.sql'), 'INSERT INTO TABELA_QUE_NAO_EXISTE VALUES (1);');
  r = rodar(sql);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(alvo, 'utf8'), 'base-antiga', 'migração falhou: base atual intacta');
  assert.equal(existsSync(`${alvo}.novo`), false);

  writeFileSync(join(sql, 'manutencao', 'V0002__quebrada.sql'), "INSERT INTO VERSAO_BASE_DADO VALUES (2, 'V0002');");
  r = rodar(sql);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(`${alvo}.novo`), false);
  const db = new DatabaseSync(alvo, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT VRBD_VERSAO_BASE_DADO v FROM VERSAO_BASE_DADO ORDER BY VRBD_ID DESC LIMIT 1').get().v, 'V0002');
  } finally { db.close(); }
});

// ─── R7: live differential is opt-in ─────────────────────────────────────────────────────────

test('R7: npm test só roda o diferencial ao vivo com ORACULO_URL', async () => {
  const arquivos = ['fundacao', 'calculo', 'motor'].map((n) => join(raiz, `test/regime-regular/${n}.test.js`));
  for (const a of arquivos) assert.doesNotMatch(readFileSync(a, 'utf8'), /ORACULO_URL\s*\?\?/, `${a}: oráculo padrão ligado sem pedir`);
  const env = { ...process.env };
  delete env.ORACULO_URL;
  delete env.NODE_TEST_CONTEXT; // inside `node --test` the child would speak the runner protocol, not TAP
  const r = await new Promise((resolve) => execFile(NODE, ['--disable-warning=ExperimentalWarning', '--test-reporter=tap', '--test-name-pattern=^diferencial ao vivo', arquivos[0]],
    { cwd: raiz, env, timeout: 60_000, maxBuffer: 16 * MiB }, (e, stdout) => resolve(stdout)));
  assert.match(r, /# SKIP diferencial ao vivo desligado \(defina ORACULO_URL\)/, r.slice(0, 500));
});

// ─── R6: validation claims the repository can reproduce ──────────────────────────────────────

test('R6: a seção Validação só cita o que o repositório reproduz', () => {
  const validacao = README.slice(README.indexOf('## Validação'), README.indexOf('## Limites conhecidos'));
  // test/fixtures/private is outside git (real invoices): cited only to say its test is skipped without it
  const foraDoGit = readFileSync(join(raiz, '.gitignore'), 'utf8').split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean);
  for (const [, p] of validacao.matchAll(/`(test\/[^`*]+?)\/?`/g)) {
    if (foraDoGit.includes(p)) continue;
    assert.ok(existsSync(join(raiz, p)), `README cita ${p}, que não existe`);
  }
  assert.doesNotMatch(validacao, /2\.070/, 'conferência célula a célula que nenhum teste faz');
  assert.match(readFileSync(join(raiz, 'test/simples/das.test.js'), 'utf8'), /244 células/);
  assert.match(validacao, /244\s+células/);
  assert.match(validacao, /test\/fixtures\/private/, 'DANFSe reais: dizer que o teste é pulado fora da máquina do autor');
  assert.match(validacao, /durante o desenvolvimento/);
});
