// Request guards: Host/Origin (DNS rebinding and cross-site calls), bearer token, CORS,
// per-IP rate limit and security headers.
import { timingSafeEqual, createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

const loopbacks = (port) => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];

/**
 * Most client keys counted per one-minute window (bounded memory under address floods). Past it, new
 * clients are counted together by a coarse prefix (IPv4 /16, IPv6 /32; up to MAX_PREFIXOS_POR_JANELA of
 * them, each with 16× the limit) and then all in one shared bucket (64× the limit): a flood can neither
 * lock out every new client nor switch the limit off.
 */
export const MAX_IPS_POR_JANELA = 50_000;
export const MAX_PREFIXOS_POR_JANELA = 10_000;

/** IPv4 /16 or IPv6 /bits prefix (bits a multiple of 16) of an IP, as a key: "10.1.0.0/16", "2001:db8::/32". */
export function prefixoIp(ip, bits) {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 2).join('.')}.0.0/16`;
  const [antes, depois] = ip.includes('::') ? ip.split('::') : [ip, null];
  const a = antes ? antes.split(':') : [];
  const d = depois ? depois.split(':') : [];
  const conta = (g) => g.reduce((s, x) => s + (x.includes('.') ? 2 : 1), 0); // a dotted IPv4 tail is 2 groups
  const grupos = depois == null ? a : [...a, ...Array(Math.max(0, 8 - conta(a) - conta(d))).fill('0'), ...d];
  return `${grupos.slice(0, bits / 16).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/${bits}`;
}

/** Rate-limit key: the IP, or for IPv6 its /64 (one subscriber usually holds a whole /64). */
export const chaveLimite = (ip) => (isIP(ip) === 6 ? prefixoIp(ip, 64) : ip);

/**
 * Counters one request adds to, as [key, limit multiplier]. IPv6 also counts its /48 at 8× the limit:
 * ISPs hand one customer a /56 or a /48, so per-/64 counting alone would multiply the limit by 256+.
 */
export function contasLimite(ip) {
  return isIP(ip) === 6 ? [[prefixoIp(ip, 48), 8], [prefixoIp(ip, 64), 1]] : [[ip, 1]];
}

/** Plain IP text of an address ("[v6]:port", "v4:port" and "::ffff:v4" reduced), or null when it is not an IP. */
export function ipDe(texto) {
  let s = String(texto ?? '').trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (v6) s = v6[1];
  else if (/^[\d.]+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (/^::ffff:[\d.]+$/i.test(s)) s = s.slice(7);
  return isIP(s) ? s : null;
}

export function criarSeguranca(cfg) {
  const hostsLocais = new Set(loopbacks(cfg.port));
  const hostsExtras = new Set(cfg.hostsPermitidos.flatMap((h) => [h, `${h}:${cfg.port}`]));
  const corsTodos = cfg.corsOrigens.includes('*');
  const cors = new Set(cfg.corsOrigens);
  const hashToken = cfg.token && createHash('sha256').update(cfg.token).digest();

  /** Host header must be this machine (local mode) or one of ALLOWED_HOSTS (when set). */
  function hostPermitido(req) {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (hostsLocais.has(host) || hostsExtras.has(host)) return true;
    return !cfg.local && hostsExtras.size === 0;
  }

  /** Browser calls: same origin as the page, or a site listed in CORS_ORIGINS. */
  function origemPermitida(req) {
    const origin = req.headers.origin;
    if (origin == null) return true;
    const semEsquema = String(origin).replace(/^https?:\/\//, '').toLowerCase();
    if (semEsquema === String(req.headers.host ?? '').toLowerCase()) return true;
    return corsTodos || cors.has(origin);
  }

  function cabecalhosCors(req) {
    const origin = req.headers.origin;
    if (origin == null || !(corsTodos || cors.has(origin))) return {};
    return {
      'access-control-allow-origin': corsTodos && !cfg.token ? '*' : origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-api-key, x-filename',
      'access-control-expose-headers': 'x-warning-dados-simulados, x-calc-app-version, x-calc-db-version, retry-after',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  function tokenValido(req) {
    if (!hashToken) return true;
    const auth = String(req.headers.authorization ?? '');
    const dado = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] ?? '');
    return timingSafeEqual(createHash('sha256').update(dado).digest(), hashToken);
  }

  const proxies = new BlockList();
  for (const f of cfg.proxiesConfiaveis ?? []) proxies.addSubnet(f.endereco, f.prefixo, f.tipo);

  /**
   * Client IP for the rate limit: the TCP peer, or, with TRUST_PROXY and a peer in TRUSTED_PROXIES,
   * the RIGHTMOST X-Forwarded-For entry (the one our proxy appended; entries to its left are client-supplied).
   */
  function ipCliente(req) {
    const par = ipDe(req.socket.remoteAddress) ?? String(req.socket.remoteAddress);
    const v = isIP(par);
    if (!cfg.confiarProxy || !v || !proxies.check(par, v === 4 ? 'ipv4' : 'ipv6')) return par;
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return ipDe(xff.at(-1)) ?? par;
  }

  // ponytail: fixed one-minute window per IP in this process; put a proxy limiter in front for several instances.
  const janelas = new Map();
  let inicioJanela = Date.now();
  function limite(req) {
    if (!cfg.limitePorMinuto) return null;
    const agora = Date.now();
    if (agora - inicioJanela >= 60_000) { janelas.clear(); inicioJanela = agora; }
    const espera = Math.ceil((inicioJanela + 60_000 - agora) / 1000);
    const ip = ipCliente(req);
    const contadas = new Set(); // both IPv6 counters may fall back to the same coarse bucket: count once
    for (const [conta, fator] of contasLimite(ip)) {
      const [chave, mult] = vaga(conta, fator, ip);
      if (contadas.has(chave)) continue;
      contadas.add(chave);
      const n = (janelas.get(chave) ?? 0) + 1;
      janelas.set(chave, n);
      if (n > cfg.limitePorMinuto * mult) return espera; // a /48 over its limit does not add its /64
    }
    return null;
  }
  /** Key that has room in the table: the client's own, else its coarse prefix, else the shared bucket. */
  function vaga(chave, fator, ip) {
    if (janelas.has(chave) || janelas.size < MAX_IPS_POR_JANELA) return [chave, fator];
    const grossa = prefixoIp(ip, 32);
    if (janelas.has(grossa) || janelas.size < MAX_IPS_POR_JANELA + MAX_PREFIXOS_POR_JANELA) return [grossa, 16];
    return ['*', 64];
  }

  return { hostPermitido, origemPermitida, cabecalhosCors, tokenValido, limite, ipCliente };
}

/**
 * Logs an unexpected error as one compact, escaped line: messages may carry request data (paths,
 * header values), so no raw newlines, no full stack and a bounded size. The first stack frame
 * (taken after the message) tells where it failed.
 */
export function registrarErro(e, rotulo = 'Erro interno') {
  const pilha = String(e?.stack ?? '');
  const msg = String(e?.message ?? e);
  const frames = e?.message && pilha.includes(msg) ? pilha.slice(pilha.indexOf(msg) + msg.length) : pilha;
  const onde = /\n\s+at (.+)/.exec(frames)?.[1] ?? '';
  console.error(`${rotulo}: ${JSON.stringify({ tipo: e?.name, codigo: e?.code, mensagem: msg.slice(0, 200), onde: onde.slice(0, 200) })}`);
}

export const CABECALHOS_SEGURANCA = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

export const CSP_PAGINA = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
