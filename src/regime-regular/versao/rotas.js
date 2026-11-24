// Version / offline / download routes of calculadora-rtc-regime-regular (profile offline):
//   GET /api/versao/status               — VersaoOfflineController + VersaoOfflineService
//   GET /api/calculadora/download/url    — DownloadController + DownloadService
// The remote version check (versao.url) is OFF unless VERSAO_OFFLINE_URL is set: the port never
// calls the Receita's servers on its own, which gives the same answer as the Java API whose
// remote is unreachable (remote fields absent, every "atualizada" flag false).
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { VERSAO_APLICACAO, ultimaVersaoBase, ErroJava, erroParametroAusente } from '../comum/problema.js';
import { escreverJson, lerDocumentoJson, comoObjeto, comoString, ErroJson } from '../comum/json.js';
import { negociar, lerMediaType, compativel } from '../comum/spring.js';
import { javaIsBlank, javaTrim } from '../comum/java.js';

const OFICIAL = { oficial: 'regime-regular' };
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/;
const extrairSemver = (v) => (v == null ? null : (SEMVER.exec(v)?.[0] ?? null));

/** new VersaoOfflineOutput(VersaoOutput local, VersaoOutput remota). */
export function versaoOfflineOutput(local, remota) {
  const versaoAplicacaoLocal = local.versaoApp ?? null;
  const versaoDbLocal = local.versaoDb ?? null;
  const dataDbLocal = local.dataVersaoDb ?? null;
  const versaoAplicacaoRemota = remota ? remota.versaoApp ?? null : null;
  const versaoDbRemota = remota ? remota.versaoDb ?? null : null;
  const dataDbRemota = remota ? remota.dataVersaoDb ?? null : null;
  const semverLocal = extrairSemver(versaoAplicacaoLocal);
  return {
    aplicacaoAtualizada: semverLocal != null && semverLocal === extrairSemver(versaoAplicacaoRemota),
    dbAtualizada: versaoDbLocal != null && versaoDbLocal === versaoDbRemota,
    dataDbAtualizada: dataDbLocal != null && dataDbLocal === dataDbRemota,
    versaoAplicacaoLocal, versaoAplicacaoRemota, versaoDbLocal, versaoDbRemota, dataDbLocal, dataDbRemota,
  };
}

/** JSON of VersaoOfflineOutput (no @JsonPropertyOrder → alphabetical; nulls omitted). */
export function versaoOfflineJson(o) {
  return escreverJson({
    aplicacaoAtualizada: o.aplicacaoAtualizada, dataDbAtualizada: o.dataDbAtualizada, dataDbLocal: o.dataDbLocal, dataDbRemota: o.dataDbRemota,
    dbAtualizada: o.dbAtualizada, versaoAplicacaoLocal: o.versaoAplicacaoLocal, versaoAplicacaoRemota: o.versaoAplicacaoRemota,
    versaoDbLocal: o.versaoDbLocal, versaoDbRemota: o.versaoDbRemota,
  });
}

/** YAML of VersaoOfflineOutput (Jackson YAML converter: declaration order, explicit nulls, quoted strings). */
export function versaoOfflineYaml(o) {
  const v = (x) => (x === null ? 'null' : typeof x === 'boolean' ? String(x) : escreverJson(String(x)));
  const campos = ['aplicacaoAtualizada', 'dbAtualizada', 'dataDbAtualizada', 'versaoAplicacaoLocal', 'versaoAplicacaoRemota', 'versaoDbLocal', 'versaoDbRemota', 'dataDbLocal', 'dataDbRemota'];
  return `---\n${campos.map((c) => `${c}: ${v(o[c])}\n`).join('')}`;
}

const segundos = (v, padrao) => {
  if (v == null || v === '') return padrao;
  const t = String(v).trim();
  let m;
  if ((m = /^(\d+)\s*ms$/i.exec(t))) return Number(m[1]);
  if ((m = /^(\d+(?:\.\d+)?)\s*s$/i.exec(t))) return Number(m[1]) * 1000;
  if ((m = /^PT(\d+(?:\.\d+)?)S$/i.exec(t))) return Number(m[1]) * 1000;
  if (/^\d+$/.test(t)) return Number(t);
  return padrao;
};

class ErroRestClient extends Error {}

/** RestTemplate.getForObject(url, VersaoOutput.class) with SimpleClientHttpRequestFactory timeouts. */
function obterVersaoRemota(url, { connectTimeout, readTimeout }, redirecionamentos = 0) {
  return new Promise((resolve, reject) => {
    let alvo;
    try { alvo = new URL(url); } catch (e) { reject(new ErroJava('IllegalArgumentException', e.message)); return; }
    const req = (alvo.protocol === 'https:' ? requestHttps : alvo.protocol === 'http:' ? requestHttp : null);
    if (!req) { reject(new ErroJava('IllegalArgumentException', `URI is not absolute or has an unsupported scheme: ${url}`)); return; }
    const pedido = req(alvo, { method: 'GET', headers: { Accept: 'application/json, application/*+json', 'User-Agent': 'Java/25.0.5' } });
    const conexao = setTimeout(() => pedido.destroy(new ErroRestClient('Connect timed out')), connectTimeout);
    pedido.on('socket', (s) => {
      if (!s.connecting) clearTimeout(conexao);
      s.once('connect', () => { clearTimeout(conexao); s.setTimeout(readTimeout, () => pedido.destroy(new ErroRestClient('Read timed out'))); });
    });
    pedido.on('error', (e) => { clearTimeout(conexao); reject(e instanceof ErroRestClient ? e : new ErroRestClient(e.message)); });
    pedido.on('response', (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('error', (e) => reject(new ErroRestClient(e.message)));
      res.on('end', () => {
        clearTimeout(conexao);
        const corpo = Buffer.concat(partes);
        const st = res.statusCode;
        if (st >= 300 && st < 400 && res.headers.location && redirecionamentos < 20) {
          const prox = new URL(res.headers.location, alvo);
          if (prox.protocol === alvo.protocol) { obterVersaoRemota(prox.href, { connectTimeout, readTimeout }, redirecionamentos + 1).then(resolve, reject); return; }
        }
        if (st >= 400) { reject(new ErroRestClient(`${st} : [no body]`)); return; }
        if (st === 204 || corpo.length === 0) { resolve(null); return; }
        const ct = lerMediaType(res.headers['content-type']);
        if (!ct || ![lerMediaType('application/json'), lerMediaType('application/*+json')].some((m) => compativel(m, ct))) {
          reject(new ErroRestClient(`Could not extract response: no suitable HttpMessageConverter found for response type [class br.gov.serpro.rtc.api.model.output.dadosabertos.VersaoOutput] and content type [${res.headers['content-type'] ?? ''}]`));
          return;
        }
        try {
          const doc = lerDocumentoJson(corpo);
          if (doc.vazio) { resolve(null); return; }
          const s = (no) => comoString(no);
          const v = comoObjeto(doc.raiz, 'br.gov.serpro.rtc.api.model.output.dadosabertos.VersaoOutput', {
            ambiente: s, dataVersaoDb: s, descricaoVersaoApp: s, descricaoVersaoDb: s, versaoApp: s, versaoDb: s,
          });
          doc.verificarFim('br.gov.serpro.rtc.api.model.output.dadosabertos.VersaoOutput');
          resolve(v);
        } catch (e) {
          reject(e instanceof ErroJson ? new ErroRestClient(`JSON parse error: ${e.message}`) : e);
        }
      });
    });
    pedido.end();
  });
}

/**
 * VersaoOfflineService. opcoes: { base, url (null = no remote check), connectTimeout, readTimeout (ms),
 * versaoAplicacao, log: { warn, info } }.
 */
export function criarServicoVersao({ base, url = null, connectTimeout = 5000, readTimeout = 10000, versaoAplicacao = VERSAO_APLICACAO, log = console } = {}) {
  const versaoLocal = () => {
    const v = ultimaVersaoBase(base);
    return { versaoApp: versaoAplicacao, descricaoVersaoApp: versaoAplicacao, versaoDb: v.numeroVersao, dataVersaoDb: v.data };
  };
  const consultarVersaoRemota = () => (url ? obterVersaoRemota(url, { connectTimeout, readTimeout }) : Promise.reject(new ErroRestClient('versao.url não configurada (modo offline)')));

  async function verificarVersao() {
    let remota;
    try {
      remota = await consultarVersaoRemota();
    } catch (e) {
      if (!(e instanceof ErroRestClient)) throw e;
      if (url) log.warn(`Consulta da versão remota indisponível em [${url}]: ${e.message}`);
      remota = null;
    }
    return versaoOfflineOutput(versaoLocal(), remota);
  }

  /** Startup check (one attempt; the Java @Retryable repeats it up to 3 times). Throws on failure. */
  async function verificarVersaoNaInicializacao() {
    const status = versaoOfflineOutput(versaoLocal(), await consultarVersaoRemota());
    const atualizados = [], desatualizados = [];
    const par = (ok, rotulo, local, remota) => (ok ? atualizados : desatualizados).push(`${rotulo} (LOCAL):  ${local}`, `${rotulo} (ONLINE): ${remota}`);
    par(status.aplicacaoAtualizada, 'Aplicação', status.versaoAplicacaoLocal, status.versaoAplicacaoRemota);
    par(status.dbAtualizada, 'Banco de Dados', status.versaoDbLocal, status.versaoDbRemota);
    par(status.dataDbAtualizada, 'Data do Banco', status.dataDbLocal, status.dataDbRemota);
    if (atualizados.length) { log.info(`= VERSÃO ATUALIZADA ${'='.repeat(30)}`); for (const l of atualizados) log.info(l); }
    if (desatualizados.length) { log.info(`= VERSÃO DESATUALIZADA ${'='.repeat(27)}`); for (const l of desatualizados) log.info(l); }
    return status;
  }

  return { verificarVersao, verificarVersaoNaInicializacao };
}

/** application.download.platforms from the environment (APPLICATION_DOWNLOAD_PLATFORMS_<KEY>=url, relaxed binding). */
export function plataformasDownload(env = process.env) {
  const m = new Map();
  for (const [k, v] of Object.entries(env)) {
    const x = /^APPLICATION_DOWNLOAD_PLATFORMS_(.+)$/.exec(k);
    if (x) m.set(x[1].toLowerCase(), v);
  }
  return m;
}

/** DownloadService.resolveDownloadUrl → { platform, downloadUrl } or ErroJava PlataformaDownloadNaoEncontradaException. */
export function resolverDownload(plataformas, platform) {
  const naoEncontrada = () => new ErroJava('PlataformaDownloadNaoEncontradaException', `Plataforma de download '${platform}' não encontrada. Plataformas disponíveis: [${[...plataformas.keys()].join(', ')}]`);
  if (platform == null || javaIsBlank(platform)) throw naoEncontrada();
  const normalizado = javaTrim(platform).toLowerCase();
  for (const [k, v] of plataformas) if (k.toLowerCase() === normalizado.toLowerCase()) return { platform: k, downloadUrl: v };
  throw naoEncontrada();
}

export function registrar(r, deps) {
  const servico = criarServicoVersao({
    base: deps.base,
    url: process.env.VERSAO_OFFLINE_URL || null,
    connectTimeout: segundos(process.env.VERSAO_CONNECT_TIMEOUT, 5000),
    readTimeout: segundos(process.env.VERSAO_READ_TIMEOUT, 10000),
  });
  const plataformas = plataformasDownload();

  // VersaoOfflineController: @GetMapping("/versao/status") without `produces` → content negotiation
  // among the converters able to write the bean (JSON, application/*+json, YAML).
  r.get('/api/versao/status', async (ctx) => {
    const saida = await servico.verificarVersao();
    if (ctx.aceito === null) return { status: 406, body: null };
    const tipo = negociar(ctx.aceito, ['application/json', 'application/*+json', 'application/yaml']);
    if (tipo === 'application/yaml') return { status: 200, tipo, body: versaoOfflineYaml(saida) };
    return { status: 200, tipo, body: versaoOfflineJson(saida) };
  }, OFICIAL);

  // DownloadController: produces application/json, @RequestParam("platform") String platform.
  r.get('/api/calculadora/download/url', (ctx) => {
    const platform = ctx.parametros.texto('platform');
    if (platform === null) throw erroParametroAusente('platform');
    const res = resolverDownload(plataformas, platform);
    if (res.downloadUrl == null || javaIsBlank(res.downloadUrl)) return { status: 204, body: null };
    return { status: 200, tipo: 'application/json', body: escreverJson({ downloadUrl: res.downloadUrl }) };
  }, { ...OFICIAL, produz: ['application/json'] });
}
