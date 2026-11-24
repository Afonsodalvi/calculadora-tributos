// accessExternalDTD="" (the official SchemaFactory/Validator setting) applied to the document under
// validation: every external DTD subset, external general entity and external parameter entity is
// refused before anything is read — nothing here opens a file or a connection. Ports of the pieces
// of the JDK that build the refusal message: SecuritySupport.checkAccess (the protocol, through
// java.net.URL), SecuritySupport.sanitizePath and XMLEntityManager.expandSystemId (simplified: a
// relative identifier becomes a file: URI under the working directory).

/** IOException thrown while checking the access (java.net.MalformedURLException). */
export class ErroAcessoIO extends Error {}

/** Protocols with a URLStreamHandler in the JDK 25 (java.base). */
const PROTOCOLOS_JDK = new Set(['file', 'ftp', 'http', 'https', 'jar', 'jmod', 'jrt', 'mailto']);

const ehProtocoloValido = (s) => /^[a-zA-Z][a-zA-Z0-9.+-]*$/.test(s);

/**
 * new URL(spec): protocol (lower case) and, for jar:, the part after it. Throws ErroAcessoIO with the
 * MalformedURLException message ("no protocol: …", "unknown protocol: …", "no !/ in spec").
 */
function urlJava(spec) {
  let inicio = 0;
  let fim = spec.length;
  while (fim > 0 && spec.charCodeAt(fim - 1) <= 0x20) fim--;
  while (inicio < fim && spec.charCodeAt(inicio) <= 0x20) inicio++;
  if (spec.slice(inicio, inicio + 4).toLowerCase() === 'url:') inicio += 4;
  let protocolo = null;
  if (spec[inicio] !== '#') {
    for (let i = inicio; i < fim && spec[i] !== '/'; i++) {
      if (spec[i] === ':') {
        const s = spec.slice(inicio, i).toLowerCase();
        if (ehProtocoloValido(s)) { protocolo = s; inicio = i + 1; }
        break;
      }
    }
  }
  if (protocolo == null) throw new ErroAcessoIO(`no protocol: ${spec}`);
  if (!PROTOCOLOS_JDK.has(protocolo)) throw new ErroAcessoIO(`unknown protocol: ${protocolo}`);
  const resto = spec.slice(inicio, fim);
  if (protocolo === 'jar' && !resto.includes('!/')) throw new ErroAcessoIO('no !/ in spec');
  return { protocolo, resto };
}

/**
 * SecuritySupport.checkAccess(systemId, "", "all"): the protocol that is refused (no protocol is
 * allowed). "jar:" names the protocol of the inner URL.
 */
export function protocoloRecusado(sistema) {
  if (!sistema.includes(':')) return 'file';
  const { protocolo, resto } = urlJava(sistema);
  if (protocolo === 'jar') {
    const caminho = resto.slice(0, resto.indexOf('!/'));
    const i = caminho.indexOf(':');
    return i < 0 ? caminho : caminho.slice(0, i);
  }
  return protocolo;
}

/** SecuritySupport.sanitizePath: the part after the last '/' (the whole text when there is none at index > 0). */
export function caminhoSeguro(uri) {
  if (uri == null) return '';
  const i = uri.lastIndexOf('/');
  return i > 0 ? uri.slice(i + 1) : uri;
}

/**
 * XMLEntityManager.expandSystemId(systemId, null, false), enough for the refusal message (only its
 * protocol and its last path segment are ever shown): an absolute URI stays as it is, anything
 * else becomes a file: URI (Java resolves it under user.dir; the directory never reaches the message).
 */
export function expandirSistema(sistema) {
  if (sistema == null) return null;
  const m = /^([^:/?#]+):/.exec(sistema);
  if (m && m[1].length > 1 && ehProtocoloValido(m[1])) return sistema;
  return `file:///${sistema.replace(/^\/+/, '')}`;
}
