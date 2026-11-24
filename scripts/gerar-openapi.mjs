// Builds docs/openapi.json: the two OFFICIAL contracts (exported by the Receita Federal Java
// APIs with springdoc, saved in docs/oficial-*.openapi.json) plus this app's own routes.
//   node scripts/gerar-openapi.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { EXEMPLOS } from '../public/js/api-doc.js';

const raiz = new URL('../', import.meta.url);
const ler = (p) => JSON.parse(readFileSync(new URL(p, raiz), 'utf8'));
const regular = ler('docs/oficial-regime-regular.openapi.json');
const simples = ler('docs/oficial-simples.openapi.json');
const pacote = ler('package.json');

// Schema names that exist in both contracts with different shapes get a "Simples" prefix.
const renomear = {};
for (const [nome, sch] of Object.entries(simples.components?.schemas ?? {})) {
  const outro = regular.components?.schemas?.[nome];
  if (outro && JSON.stringify(outro) !== JSON.stringify(sch)) renomear[nome] = `Simples${nome}`;
}
const trocarRefs = (obj) => JSON.parse(JSON.stringify(obj).replace(/"#\/components\/schemas\/([^"]+)"/g, (m, n) => (renomear[n] ? `"#/components/schemas/${renomear[n]}"` : m)));
const schemasSimples = Object.fromEntries(Object.entries(trocarRefs(simples.components?.schemas ?? {})).map(([n, s]) => [renomear[n] ?? n, s]));
const pathsSimples = trocarRefs(simples.paths);
delete pathsSimples['/versao/status']; // same path in both APIs: the regime-regular one is served

const json = (schema, exemplo) => ({ content: { 'application/json': { schema, ...(exemplo ? { example: exemplo } : {}) } } });
const obj = { type: 'object' };
const TAG = 'Aplicação (rotas próprias desta calculadora)';
const app = {
  '/saude': { get: { tags: [TAG], summary: 'Saúde do servidor (pública, sem token)', responses: { 200: { description: 'OK', ...json(obj, { status: 'ok' }) } } } },
  '/info': { get: { tags: [TAG], summary: 'Versão da base oficial, módulos e se o servidor exige token', responses: { 200: { description: 'OK', ...json(obj) } } } },
  '/openapi.json': { get: { tags: [TAG], summary: 'Este documento (público)', responses: { 200: { description: 'OpenAPI 3.1', ...json(obj) } } } },
  '/api-docs': { get: { tags: [TAG], summary: 'Este documento, no caminho do springdoc das APIs oficiais (público)', responses: { 200: { description: 'OpenAPI 3.1', ...json(obj) } } } },
  '/notas': {
    post: {
      tags: [TAG], summary: 'Lê uma nota fiscal (PDF do DANFSe, XML de NFS-e nacional ou XML de NF-e/NFC-e)',
      description: [
        'Corpo = bytes do arquivo (até 2 MB). Nada é gravado. Devolve `{nota}`: a nota normalizada usada pelas rotas /simples/calcular e /regime-regular/preparar',
        '(`nota.ignorar` diz por que ela fica fora do cálculo, p.ex. "nota cancelada"; `nota.avisos` vale para os dois regimes, `nota.avisosSimples` só para o Simples).',
        'Um XML de evento de cancelamento (NF-e/NFC-e 110111/110112 registrado, NFS-e e101101/e105102/e105104/e305101) devolve `{evento}`:',
        'tire do cálculo a nota com a mesma `chave`. PDF: lido um por vez numa thread separada (até 32 MB descompactado, 10 s; 8 PDFs ao mesmo tempo, 2 por cliente, senão 429);',
        'PDF cifrado ou com LZW/RunLength/Brotli é recusado (422): envie o XML.',
      ].join(' '),
      parameters: [{ name: 'x-filename', in: 'header', required: false, schema: { type: 'string' }, description: 'Nome do arquivo (URL-encoded)' }],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: {
        200: { description: 'Nota lida (`{nota}`) ou evento de cancelamento (`{evento}`)', content: { 'application/json': { schema: obj, examples: {
          nota: { value: { nota: { id: '…', tipo: 'NFS-e', numero: '228', chave: '…', dataEmissao: '2026-04-29', valor: '950.00', prestador: { doc: '11111111000111', nome: '…' }, ignorar: null, avisos: [], avisosSimples: [] } } },
          evento: { value: { evento: { tipo: 'cancelamento', chave: '41137002211111111000111000000000022826054848833960', descricao: 'Cancelamento de NFS-e' } } },
        } } } },
        413: { description: 'Arquivo maior que 2 MB', ...json(obj) },
        422: { description: 'Arquivo não lido (formato, PDF pesado/cifrado, evento que não é de cancelamento ou não registrado pela SEFAZ)', ...json(obj, { erro: 'Formato não reconhecido. Envie o PDF (DANFSe) ou o XML da nota.', arquivo: 'x.txt' }) },
        429: { description: 'Muitas requisições (RATE_LIMIT) ou fila de PDFs cheia: repita após `Retry-After` segundos', ...json(obj, { erro: 'Muitos PDFs sendo lidos agora: tente de novo em alguns segundos, ou envie o XML da nota.', arquivo: 'nota.pdf' }) },
      },
    },
  },
  '/simples/info': { get: { tags: [TAG], summary: 'Atividades do Simples (para escolher na nota) e períodos das tabelas', responses: { 200: { description: 'OK', ...json(obj) } } } },
  '/simples/calcular': {
    post: {
      tags: [TAG], summary: 'DAS do mês (LC 123) + CBS/IBS de cada nota pela calculadora oficial',
      description: 'Até 2.000 notas e 10.000 itens de NF-e por requisição; `notas` é uma lista.',
      requestBody: { required: true, ...json(obj, { notas: [{ id: 'manual-1', tipo: 'manual', competencia: '2026-10', valor: '22000.00', atividade: 'servicos-iii' }], empresa: { '2026-10': { rbt12: '240000.00', folha12: '' } }, simularReforma: true }) },
      responses: { 200: { description: 'Resultado por mês', ...json(obj) }, 400: { description: 'Corpo inválido ou acima dos limites', ...json(obj, { erro: '…' }) } },
    },
  },
  '/regime-regular/preparar': {
    post: {
      tags: [TAG], summary: 'Transforma notas lidas em operações editáveis do regime regular (data, local do IBS, itens, classificação)',
      description: 'Até 500 notas, 5.000 itens no total e 990 por nota, 2 MB de JSON. Itens com IS trazem `aliquotasIS` {adValorem, adRem} da nota (usadas a partir de 2027). Notas repetidas, substituídas, canceladas ou de outro CNPJ NÃO são retiradas aqui: a tela faz isso; quem usa a API decide quais operações calcular.',
      requestBody: { required: true, ...json(obj, { notas: ['<campo nota da resposta de POST /notas>'] }) },
      responses: { 200: { description: 'Operações', ...json(obj) }, 400: { description: 'Corpo inválido ou acima dos limites', ...json(obj, { erro: '…' }) } },
    },
  },
  '/regime-regular/calcular': {
    post: {
      tags: [TAG], summary: 'CBS, IBS e Imposto Seletivo de cada operação (calculadora oficial) e soma por mês',
      description: [
        'Cada operação vira uma requisição a POST /calculadora/observabilidade/regime-geral. A partir de 2027 informe `aliquotas` (cbs, ibsEstadual, ibsMunicipal em %;',
        'impostoSeletivo {adValorem, adRem} opcional, senão vale `item.aliquotasIS`). Até 500 operações, 5.000 itens no total e 990 por operação, 2 MB de JSON:',
        'para mais, envie em lotes e some os resumos (a tela faz isso). `resumo[]` traz por mês notas, vBC, vCBS, vIBSUF, vIBSMun, vIBS, vIS, total,',
        '`notasNaoCalculadas` e `itensNaoCalculados` (o que ficou fora do total); `naoCalculadasSemMes` conta as operações sem data válida.',
      ].join(' '),
      requestBody: { required: true, ...json(obj, { operacoes: [{ notaId: 'op-1', tipo: 'Digitado', tpDoc: 91, data: '2027-03-10', municipio: 4314902, itens: [{ numero: 1, nbs: '122011200', cst: '200', cClassTrib: '200028', baseCalculo: '1200.00' }] }], aliquotas: { cbs: '8.8', ibsEstadual: '0.05', ibsMunicipal: '0.05' } }) },
      responses: { 200: { description: 'Resultados e resumo mensal', ...json(obj) }, 400: { description: 'Corpo inválido ou acima dos limites', ...json(obj, { erro: '…' }) } },
    },
  },
};

// Request examples that work (the official springdoc export has none): same ones as the API page.
for (const [chave, ex] of Object.entries(EXEMPLOS)) {
  const [metodo, caminho] = chave.split(' ');
  const op = { ...app, ...regular.paths, ...pathsSimples }[caminho]?.[metodo.toLowerCase()];
  if (!op) continue;
  const conteudo = op.requestBody?.content?.['application/json'];
  if (ex.corpo && conteudo) conteudo.example = JSON.parse(ex.corpo);
  for (const p of op.parameters ?? []) if (ex.parametros?.[p.name] != null) p.example = ex.parametros[p.name];
}

const doc = {
  openapi: '3.1.0',
  info: {
    title: 'Calculadora de tributos — API',
    version: pacote.version,
    description: [
      'API desta calculadora local. Dois grupos de rotas:',
      '',
      '* **Contrato oficial** (`/calculadora/...`, `/versao/...`): as mesmas requisições e respostas das APIs Java da Receita Federal',
      '  [calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular) 1.7.2 e',
      '  [calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional) 1.0.2, portadas para JavaScript.',
      '  Um cliente feito para a API oficial funciona trocando só a URL base.',
      '* **Aplicação** (`/notas`, `/simples/*`, `/regime-regular/*`): leitura de notas fiscais e o fluxo usado pela tela.',
      '',
      'Quando o servidor é publicado com `API_TOKEN`, envie `Authorization: Bearer <token>` (ou `X-API-Key`). `GET /saude`, `GET /info`, `GET /openapi.json` e `GET /api-docs` são públicas.',
      '',
      'Diferenças conhecidas em relação às APIs Java: as rotas de cálculo oficiais (`/calculadora/regime-geral`, `/calculadora/observabilidade/regime-geral`,',
      '`/calculadora/observabilidade/simples-nacional` e `.../nao-assistido`) aceitam até 10.000 itens por operação (acima: 413 `{erro}`);',
      'em `/calculadora/xml/validate`, um texto acima de 64 KB num campo com tamanho máximo é recusado por tamanho (cvc-maxLength-valid) e não por padrão.',
    ].join('\n'),
  },
  servers: [{ url: '/api', description: 'Este servidor' }],
  tags: [{ name: TAG }, ...(regular.tags ?? []), ...(simples.tags ?? [])],
  security: [{}, { token: [] }],
  paths: { ...app, ...regular.paths, ...pathsSimples },
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'Exigido só quando o servidor foi iniciado com API_TOKEN.' } },
    schemas: { ...(regular.components?.schemas ?? {}), ...schemasSimples },
  },
};
writeFileSync(new URL('docs/openapi.json', raiz), `${JSON.stringify(doc, null, 1)}\n`);
console.log(`docs/openapi.json: ${Object.keys(doc.paths).length} caminhos, ${Object.keys(doc.components.schemas).length} schemas, ${Object.keys(renomear).length} renomeados (${Object.keys(renomear).join(', ')})`);
