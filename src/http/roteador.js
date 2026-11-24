// Minimal router + request helpers. Each module registers its routes; a handler receives a
// context and returns { status, body, headers?, tipo? } (body object → JSON, string → text).
// Route options for the official APIs (src/regime-regular/comum/spring.js, hooked in src/app.js):
//   oficial: 'regime-regular' | 'simples'  — Spring/Tomcat behaviour for the path (404/405/415/406…);
//   consome: ['application/json']           — consumes (default for POST); produz: ['application/json'].
// Official regime-regular handlers return `body` already serialized (string) with its exact `tipo`.

export class ErroHttp extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const grande = () => new ErroHttp(413, 'Conteúdo grande demais.');
    if (Number(req.headers['content-length'] ?? 0) > limite) { req.resume(); reject(grande()); return; }
    const partes = [];
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) { req.removeAllListeners('data'); req.resume(); reject(grande()); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

/** JSON.parse keeping number lexemes as text, like Jackson does for String/BigDecimal fields ("0.10", "1e3"). */
export const jsonComLexemas = (buf) => JSON.parse(buf.toString('utf8'), (k, v, ctx) => (typeof v === 'number' && ctx?.source ? ctx.source : v));

export function criarRoteador() {
  const rotas = [];
  const add = (method) => (path, handler, opcoes = {}) => rotas.push({ method, path, handler, ...opcoes });

  /** Finds the route; reports whether the path exists with another method (405). */
  function achar(method, pathname) {
    const m = method === 'HEAD' ? 'GET' : method;
    let outroMetodo = null;
    for (const r of rotas) {
      const casou = typeof r.path === 'string' ? (r.path === pathname ? [] : null) : r.path.exec(pathname)?.slice(1);
      if (!casou) continue;
      if (r.method !== m) { outroMetodo ??= []; outroMetodo.push(r.method); continue; }
      return { rota: r, params: casou.map((p) => decodeURIComponent(p)) };
    }
    return { outroMetodo };
  }

  return { get: add('GET'), post: add('POST'), achar, rotas };
}

/** Context passed to handlers. */
export function criarContexto(req, url, params) {
  const host = String(req.headers.host ?? 'localhost');
  return {
    req,
    url,
    params,
    query: url.searchParams,
    /** like Spring's ServletUriComponentsBuilder base URL (scheme + host without port). */
    baseURL: `http://${host.replace(/:\d+$/, '')}`,
    corpo: (limite = 2 * 1024 * 1024) => lerCorpo(req, limite),
    json: async (limite = 2 * 1024 * 1024) => JSON.parse((await lerCorpo(req, limite)).toString('utf8')),
    jsonLexemas: async (limite = 2 * 1024 * 1024) => jsonComLexemas(await lerCorpo(req, limite)),
  };
}
