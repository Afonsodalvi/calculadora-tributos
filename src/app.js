// Composition: shared official database + modules + HTTP guards + static UI.
// Each module registers its routes in the router (see src/*/modulo.js).
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { abrirBanco } from './core/db.js';
import { criarRoteador, criarContexto, ErroHttp } from './http/roteador.js';
import { criarSeguranca, registrarErro, chaveLimite, CABECALHOS_SEGURANCA, CSP_PAGINA } from './http/seguranca.js';
import { moduloNotas } from './notas/modulo.js';
import { moduloSimples } from './simples/modulo.js';
import { moduloRegimeRegular } from './regime-regular/modulo.js';
import { moduloAplicacaoRegimeRegular } from './regime-regular/aplicacao.js';
import { estiloOficial, tratarOficial } from './regime-regular/comum/spring.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
};

/** readFile errors that only mean "no such static file" for a client-chosen path (404, nothing logged). */
const ARQUIVO_INEXISTENTE = new Set(['ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG', 'ERR_INVALID_ARG_VALUE']);

export function criarApp(cfg, { raiz }) {
  const base = abrirBanco(join(raiz, 'data', 'calculadora-pro.db'));
  const versaoBase = base.versao();
  const modulos = [moduloNotas(), moduloSimples({ base, raiz }), moduloRegimeRegular({ base, raiz }), moduloAplicacaoRegimeRegular({ base })];
  const r = criarRoteador();
  for (const m of modulos) m.registrar(r);

  r.get('/api/saude', () => ({ status: 200, body: { status: 'ok' } }), { publica: true });
  r.get('/api/info', () => ({
    status: 200,
    body: {
      versaoBase,
      modulos: modulos.filter((m) => m.nome).map((m) => ({ id: m.id, nome: m.nome })),
      autenticacao: Boolean(cfg.token),
    },
  }), { publica: true });
  const openapi = async () => ({ status: 200, body: JSON.parse(await readFile(join(raiz, 'docs', 'openapi.json'), 'utf8')) });
  r.get('/api/openapi.json', openapi, { publica: true });
  r.get('/api/api-docs', openapi, { publica: true }); // springdoc path of the official Java APIs

  const seg = criarSeguranca(cfg);
  const pasta = join(raiz, 'public');

  function enviar(res, status, body, headers = {}, tipo) {
    const texto = typeof body === 'string' || Buffer.isBuffer(body);
    const vazio = body == null || (texto && body.length === 0);
    res.writeHead(status, {
      ...CABECALHOS_SEGURANCA,
      // no body → no Content-Type (as Spring does)
      ...(vazio && !tipo ? {} : { 'content-type': tipo ?? (texto ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8') }),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(body == null ? undefined : texto ? body : JSON.stringify(body));
  }

  async function tratar(req, res) {
    if (!seg.hostPermitido(req)) return enviar(res, 403, { erro: 'Host não permitido. Configure ALLOWED_HOSTS.' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return enviar(res, 400, { erro: 'Requisição inválida.' }); }

    // Official API paths (/api/calculadora/**, /api/versao/**): same answers as the Java APIs
    // (Spring mapping, 404/405/415/406, firewall), after the app's own guards.
    const estilo = estiloOficial(req.url);
    if (estilo) {
      const cors = seg.cabecalhosCors(req);
      if (!seg.origemPermitida(req)) return enviar(res, 403, { erro: 'Origem não permitida. Configure CORS_ORIGINS.' });
      if (req.method === 'OPTIONS' && cors['access-control-allow-origin']) return enviar(res, 204, null, cors);
      const espera = seg.limite(req);
      if (espera) return enviar(res, 429, { erro: 'Muitas requisições. Tente de novo em instantes.' }, { ...cors, 'retry-after': String(espera) });
      if (!seg.tokenValido(req)) return enviar(res, 401, { erro: 'Token ausente ou inválido. Envie Authorization: Bearer <API_TOKEN>.' }, { ...cors, 'www-authenticate': 'Bearer' });
      return tratarOficial(req, res, { rotas: r.rotas.filter((x) => x.oficial), estilo, cors, criarContexto, enviarApp: enviar });
    }

    if (url.pathname.startsWith('/api/')) {
      const cors = seg.cabecalhosCors(req);
      if (!seg.origemPermitida(req)) return enviar(res, 403, { erro: 'Origem não permitida. Configure CORS_ORIGINS.' });
      if (req.method === 'OPTIONS') return enviar(res, 204, null, cors);
      const espera = seg.limite(req);
      if (espera) return enviar(res, 429, { erro: 'Muitas requisições. Tente de novo em instantes.' }, { ...cors, 'retry-after': String(espera) });
      const { rota, params, outroMetodo } = r.achar(req.method, url.pathname);
      if (!rota?.publica && !seg.tokenValido(req)) {
        return enviar(res, 401, { erro: 'Token ausente ou inválido. Envie Authorization: Bearer <API_TOKEN>.' }, { ...cors, 'www-authenticate': 'Bearer' });
      }
      if (!rota) {
        return outroMetodo
          ? enviar(res, 405, { erro: 'Método não permitido.' }, { ...cors, allow: outroMetodo.join(', ') })
          : enviar(res, 404, { erro: 'Rota não encontrada.' }, cors);
      }
      // cliente = the rate-limit key (client IP, IPv6 /64), for per-client caps inside handlers
      const saida = await rota.handler({ ...criarContexto(req, url, params), cliente: chaveLimite(seg.ipCliente(req)) });
      return enviar(res, saida.status, saida.body, { ...cors, ...saida.headers }, saida.tipo);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return enviar(res, 405, { erro: 'Método não permitido.' }, { allow: 'GET' });
    let rel;
    try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); } catch { return enviar(res, 400, { erro: 'Caminho inválido.' }); }
    if (rel.includes('\0')) return enviar(res, 404, { erro: 'Não encontrado.' });
    const arquivo = normalize(join(pasta, rel));
    if (!arquivo.startsWith(pasta + sep)) return enviar(res, 403, { erro: 'Proibido.' });
    let conteudo;
    try { conteudo = await readFile(arquivo); } catch (e) {
      if (ARQUIVO_INEXISTENTE.has(e.code)) return enviar(res, 404, { erro: 'Não encontrado.' });
      throw e;
    }
    const tipo = MIME[extname(arquivo)] ?? 'application/octet-stream';
    return enviar(res, 200, conteudo, tipo.startsWith('text/html') ? { 'content-security-policy': CSP_PAGINA } : {}, tipo);
  }

  async function handler(req, res) {
    try {
      await tratar(req, res);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e?.code === 'ENOENT' || e?.code === 'EISDIR') return enviar(res, 404, { erro: 'Não encontrado.' });
      if (e instanceof SyntaxError) return enviar(res, 400, { erro: 'JSON inválido.' });
      if (e instanceof URIError) return enviar(res, 400, { erro: 'Requisição inválida (codificação %XX malformada).' });
      if (e instanceof ErroHttp) return enviar(res, e.status, { erro: e.message });
      registrarErro(e);
      return enviar(res, 500, { erro: 'Erro interno.' });
    }
  }

  return { handler, versaoBase, modulos, rotas: r.rotas, fechar: () => base.close() };
}
