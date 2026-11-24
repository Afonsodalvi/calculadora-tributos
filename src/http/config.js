// Server settings, all from environment variables (see README "Publicar a API").
// Default: local mode, listening on 127.0.0.1 only, nothing else needed.

import { isIP } from 'node:net';

const lista = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** Default TRUSTED_PROXIES: loopback, link-local and private networks (Docker bridge, LAN). */
export const PROXIES_PADRAO = ['127.0.0.0/8', '::1/128', '169.254.0.0/16', 'fe80::/10', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/** Placeholder tokens from the docs (README/Dockerfile): never valid as a real API_TOKEN. */
const TOKENS_EXEMPLO = ['troque-por-um-token-longo', '<token com 16+ caracteres>'];

/** "ip" or "ip/prefix" → { endereco, prefixo, tipo } for net.BlockList; throws on anything else. */
function faixaIp(texto) {
  const [endereco, p, ...resto] = texto.split('/');
  const v = isIP(endereco);
  const max = v === 4 ? 32 : 128;
  if (!v || resto.length || (p !== undefined && !/^\d{1,3}$/.test(p)) || Number(p ?? max) > max) {
    throw new Error(`TRUSTED_PROXIES inválido: "${texto}" (use IPs ou faixas CIDR separados por vírgula, ex.: 10.0.0.0/8,::1).`);
  }
  return { endereco, prefixo: Number(p ?? max), tipo: v === 4 ? 'ipv4' : 'ipv6' };
}

/** Why the token is unusable (docs placeholder, too repetitive), or null. */
function tokenFraco(token) {
  if (token.length < 16) return 'API_TOKEN precisa ter pelo menos 16 caracteres.';
  if (TOKENS_EXEMPLO.includes(token.trim().toLowerCase()) || /troque-por-um-token|change.?me/i.test(token)) {
    return 'API_TOKEN é o exemplo da documentação: gere um token aleatório (ex.: openssl rand -hex 24).';
  }
  if (new Set(token).size < 5) return 'API_TOKEN fraco demais (quase sem variação de caracteres): gere um token aleatório (ex.: openssl rand -hex 24).';
  return null;
}

export function lerConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const local = LOOPBACK.has(host);
  const cfg = {
    host,
    port: Number(env.PORT || 5180),
    local,
    /** API_TOKEN: when set, every /api/* call needs it (except /api/saude, /api/info, /api/openapi.json, /api/api-docs). */
    token: env.API_TOKEN || null,
    /** ALLOWED_HOSTS: public host names of the server (Host header), e.g. calc.empresa.com.br */
    hostsPermitidos: lista(env.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    /** CORS_ORIGINS: other sites allowed to call the API from a browser ("*" = any). */
    corsOrigens: lista(env.CORS_ORIGINS),
    /** RATE_LIMIT: requests per minute per client IP (0 = off). Default 120 when exposed. */
    limitePorMinuto: Number(env.RATE_LIMIT ?? (local ? 0 : 120)),
    /**
     * TRUST_PROXY=1: take the client IP from the rightmost X-Forwarded-For entry (the one your proxy
     * appended), only when the connection comes from TRUSTED_PROXIES (default: PROXIES_PADRAO).
     */
    confiarProxy: env.TRUST_PROXY === '1',
    proxiesConfiaveis: (lista(env.TRUSTED_PROXIES).length ? lista(env.TRUSTED_PROXIES) : PROXIES_PADRAO).map(faixaIp),
    publico: env.PUBLIC_API === '1',
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error(`PORT inválida: ${env.PORT}`);
  if (!Number.isFinite(cfg.limitePorMinuto) || cfg.limitePorMinuto < 0) throw new Error(`RATE_LIMIT inválido: ${env.RATE_LIMIT}`);
  if (lista(env.TRUSTED_PROXIES).length && !cfg.confiarProxy) throw new Error('TRUSTED_PROXIES só vale com TRUST_PROXY=1.');
  const fraco = cfg.token && tokenFraco(cfg.token);
  if (fraco) throw new Error(fraco);
  if (!local && !cfg.token && !cfg.publico) {
    throw new Error(`HOST=${host} expõe a API na rede. Defina API_TOKEN (recomendado) ou PUBLIC_API=1 para publicar sem token.`);
  }
  return cfg;
}
