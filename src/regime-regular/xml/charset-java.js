// Decoding of a request body the way the JDK charsets do it for Spring's StringHttpMessageConverter
// (InputStreamReader with CodingErrorAction.REPLACE: every malformed sequence becomes one U+FFFD).
// The Unicode charsets follow sun.nio.cs.UnicodeDecoder / UTF_32Coder (byte-order mark detection
// only for "UTF-16"/"UTF-32", big-endian by default); the others use the platform decoders.
import { decodificarUtf8Java } from '../comum/java.js';

const SUBSTITUTO = '�';

/** sun.nio.cs.UnicodeDecoder: UTF-16 (ordem: 'auto' | 'be' | 'le'). */
function decodificarUtf16(bytes, ordem) {
  let i = 0;
  let le = ordem === 'le';
  if (ordem === 'auto' && bytes.length >= 2) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) i = 2;
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; i = 2; }
  }
  const unidade = (k) => (le ? bytes[k] | (bytes[k + 1] << 8) : (bytes[k] << 8) | bytes[k + 1]);
  let out = '';
  while (i + 1 < bytes.length) {
    const c = unidade(i);
    i += 2;
    if (c === 0xfffe) { out += SUBSTITUTO; continue; } // a reversed mark cannot occur inside the stream
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= bytes.length) { out += SUBSTITUTO; i = bytes.length; break; }
      const c2 = unidade(i);
      i += 2;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) out += String.fromCharCode(c, c2);
      else out += SUBSTITUTO; // malformed for length 4: both units are replaced by one character
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) { out += SUBSTITUTO; continue; }
    out += String.fromCharCode(c);
  }
  if (i < bytes.length) out += SUBSTITUTO;
  return out;
}

/** sun.nio.cs.UTF_32Coder.Decoder (ordem: 'auto' | 'be' | 'le'). */
function decodificarUtf32(bytes, ordem) {
  let i = 0;
  let le = ordem === 'le';
  if (ordem === 'auto' && bytes.length >= 4) {
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) i = 4;
    else if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) { le = true; i = 4; }
  }
  let out = '';
  while (i + 3 < bytes.length) {
    const cp = le
      ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0
      : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    i += 4;
    out += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? SUBSTITUTO : String.fromCodePoint(cp);
  }
  if (i < bytes.length) out += SUBSTITUTO;
  return out;
}

/** windows-1252 bytes the JDK leaves unmapped (the WHATWG decoder maps them to C1 controls). */
const SEM_MAPEAMENTO_1252 = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** Decodes `bytes` with the Java charset `charset` (default UTF-8). */
export function decodificarCharsetJava(bytes, charset) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const cs = charset ? String(charset).toLowerCase() : 'utf-8';
  switch (cs) {
    case 'utf-8': case 'utf8': return decodificarUtf8Java(buf, true);
    case 'iso-8859-1': case 'latin1': case 'iso8859_1': case 'iso_8859_1': return buf.toString('latin1');
    case 'us-ascii': case 'ascii': return [...buf].map((b) => (b < 0x80 ? String.fromCharCode(b) : SUBSTITUTO)).join('');
    case 'utf-16': case 'utf_16': case 'unicode': return decodificarUtf16(buf, 'auto');
    case 'utf-16be': case 'utf_16be': case 'unicodebigunmarked': return decodificarUtf16(buf, 'be');
    case 'utf-16le': case 'utf_16le': case 'unicodelittleunmarked': return decodificarUtf16(buf, 'le');
    case 'utf-32': case 'utf_32': return decodificarUtf32(buf, 'auto');
    case 'utf-32be': case 'utf_32be': return decodificarUtf32(buf, 'be');
    case 'utf-32le': case 'utf_32le': return decodificarUtf32(buf, 'le');
    case 'windows-1252': case 'cp1252': {
      const texto = new TextDecoder('windows-1252').decode(buf);
      let out = '';
      for (let k = 0; k < buf.length; k++) out += SEM_MAPEAMENTO_1252.has(buf[k]) ? SUBSTITUTO : texto[k];
      return out;
    }
    default: return new TextDecoder(cs).decode(buf);
  }
}
