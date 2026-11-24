// XML scanner with the behaviour of the JDK 25 internal Xerces that the official API uses to read
// the document under validation (XMLNSDocumentScannerImpl + XMLDocumentScannerImpl drivers +
// XMLEntityScanner/XMLEntityManager, XML11Configuration with the XMLNSDTDValidator): streaming
// events to a handler (the schema validator), fatal well-formedness errors with the XMLMessages
// texts, and the locator position Xerces has when it reports (line/column of the next character to
// read in the CURRENT entity; columns in UTF-16 units; "\r\n" and "\r" are one line break in the
// document entity).
//
// Supported: XML declaration (1.0 and 1.1), prolog (comments, PIs, DOCTYPE with an internal subset —
// see dtd.js; an external DTD or external entity is refused like accessExternalDTD=""), internal
// general entities (each one scanned as its own entity: positions restart at 1:1, markup must be
// balanced, recursion is refused), elements, attributes (normalization, character and entity
// references, DTD defaults), namespaces (bound by the scanner, or by the DTD validator once a
// DOCTYPE is present), character data, CDATA sections, comments, PIs, the trailing section and the
// JDK processing limits (limites.js).
import { ErroXml, mensagemXml } from './mensagens.js';
import {
  ehEspaco, ehAlta, ehBaixa, hex, ehValido10, ehValido11, ehLiteral11, ehInicioNome, ehNome, ehNCName,
} from './caracteres.js';
import { MetodosDtd, normalizarValorDtd } from './dtd.js';
import { LIMITES, ORIGEM, BLOCO_ENTIDADE, AnalisadorLimites } from './limites.js';
import { ErroAcessoIO, protocoloRecusado, caminhoSeguro, expandirSistema } from './acesso-externo.js';

export { ehNCName };

const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
const XML_URI = 'http://www.w3.org/XML/1998/namespace';
/** Name of the document entity (XMLEntityManager.XMLEntity). */
const DOCUMENTO = '[xml]';
/** Built-in entities (resolved before any declaration is looked up). */
const PREDEFINIDAS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Stop signal of the scanner when the document entity ends (EOF). */
class FimDaEntidade extends Error {}

/**
 * Scanner. `manipulador`: { inicioDocumento(), inicioElemento(qn, atributos), elementoVazio(qn, atributos),
 * fimElemento(qn), caracteres(texto), fimDocumento() }. qn = { prefixo, local, bruto, uri };
 * atributo = { prefixo, local, bruto, uri, valor, especificado, tipo }.
 */
export class LeitorXml {
  constructor(texto, manipulador) {
    this.t = texto;
    this.n = texto.length;
    this.p = 0;
    this.linha = 1;
    this.coluna = 1;
    this.h = manipulador;
    this.versao11 = false;
    /** fMarkupDepth of the document scanner: open markup + open elements. */
    this.profundidade = 0;
    /** fMarkUpDepth of the DTD scanner (internal subset). */
    this.profundidadeDtd = 0;
    this.elementos = [];
    this.contextosNs = [new Map([['xml', XML_URI], ['xmlns', XMLNS_URI]])];
    /** Current entity: the document, or an internal entity being expanded. */
    this.entidade = { nome: DOCUMENTO, documento: true };
    /** Entities of the parents of the current one: { t, n, p, linha, coluna, entidade, profundidadeMarcacao, profundidadeDtd }. */
    this.pilhaEntidades = [];
    /** Declared entities: name (parameter entities as "%name") → { nome, valor, externa, naoAnalisada, sistema, parametro, geral }. */
    this.entidades = new Map();
    /** ATTLIST declarations: element rawname → Map(attribute name → { nome, tipo, padrao }) in declaration order (the first declaration of an attribute wins). */
    this.declsAtributos = new Map();
    /** A DOCTYPE was read: a DTD grammar exists and the XMLNSDTDValidator binds the namespaces. */
    this.temGramatica = false;
    /** The internal subset is being scanned (the DTD scanner is the entity handler). */
    this.naDtd = false;
    this.limites = new AnalisadorLimites();
    /** Character data of a general entity is being counted per 64-character buffer (see consumirEmBloco). */
    this.contandoTexto = false;
    /** References are being read: their characters do not count against the entity sizes (NameType.REFERENCE). */
    this.lendoReferencia = 0;
    this.blocoPendente = 0;
    this.naDeclaracaoXml = false;
    this.semLocal = false;
    this.fase = 'prologo'; // 'prologo' | 'conteudo' | 'final'
    this.viuDoctype = false;
  }

  // ─── Locator / errors ─────────────────────────────────────────────────────────────────────
  local() { return this.semLocal ? { linha: -1, coluna: -1 } : { linha: this.linha, coluna: this.coluna }; }

  erro(chave, args = null) {
    const { linha, coluna } = this.local();
    return new ErroXml(linha, coluna, mensagemXml(chave, args));
  }

  /**
   * End of the document entity reached while reading (XMLEntityScanner.load → endEntity):
   * open markup → MarkupEntityMismatch at the end position; in the XML declaration the entity is
   * closed before the error (PrematureEOF at -1, -1); otherwise PrematureEOF.
   */
  fimDoDocumento() {
    if (this.naDeclaracaoXml === 'fechada') { this.semLocal = true; return this.erro('PrematureEOF'); }
    if (this.profundidade !== 0) return this.erro('MarkupEntityMismatch');
    if (this.fase === 'final') return new FimDaEntidade();
    return this.erro('PrematureEOF');
  }

  // ─── Entity scanner primitives ───────────────────────────────────────────────────────────
  /**
   * Next UTF-16 unit, or -1 at the end of the current entity. In the document entity "\r" reads as
   * "\n" (and NEL/LSEP in XML 1.1); an internal entity is not normalized (a "\r" there can only
   * come from a character reference in the entity value and stays a "\r").
   */
  espiarCru() {
    if (this.p >= this.n) return -1;
    const c = this.t.charCodeAt(this.p);
    if (this.pilhaEntidades.length) return c;
    if (c === 0x0d) return 0x0a;
    if (this.versao11 && (c === 0x85 || c === 0x2028)) return 0x0a;
    return c;
  }

  /** peekChar: at the end of an expanded entity returns to the parent; at the end of the document → EOF handling. */
  espiar() {
    while (this.p >= this.n) {
      if (this.pilhaEntidades.length) { this.fimEntidade(); continue; }
      throw this.fimDoDocumento();
    }
    return this.espiarCru();
  }

  /** scanChar: consumes one unit (a "\r\n" pair of the document counts as one line break). */
  consumir() {
    const c = this.espiar();
    const bruto = this.t.charCodeAt(this.p);
    this.p++;
    if (this.pilhaEntidades.length) {
      if (bruto === 0x0a) { this.linha++; this.coluna = 1; } else this.coluna++;
      if (this.entidade.geral && !this.contandoTexto && !this.lendoReferencia) this.contarEntidade(1);
      return c;
    }
    if (bruto === 0x0d) {
      if (this.p < this.n && this.ehParDoCr(this.t.charCodeAt(this.p))) this.p++;
      this.linha++; this.coluna = 1;
    } else if (c === 0x0a) {
      this.linha++; this.coluna = 1;
    } else {
      this.coluna++;
    }
    return c;
  }

  /**
   * Leading newline block of scanContent/scanLiteral/scanData (XMLEntityScanner): consumes the
   * consecutive line breaks and returns how many there were. Its newline normalization counts a
   * lone "\r" twice, so unless the block runs into the last character of the input (the early
   * return of those methods) the rest of the line ends up one column to the left per lone "\r".
   */
  consumirQuebras() {
    if (this.pilhaEntidades.length) { this.consumirEmBloco(); return 1; }
    let quebras = 0;
    let sozinhos = 0;
    do {
      const c = this.t.charCodeAt(this.p);
      if (c !== 0x0d && c !== 0x0a && !(this.versao11 && (c === 0x85 || c === 0x2028))) break;
      if (c === 0x0d && !(this.p + 1 < this.n && this.ehParDoCr(this.t.charCodeAt(this.p + 1)))) sozinhos++;
      this.consumir();
      quebras++;
    } while (this.p < this.n - 1);
    if (this.p < this.n - 1) this.coluna = 1 - sozinhos;
    return quebras;
  }

  /** The unit that forms one line break with a preceding "\r" ("\n"; also NEL in XML 1.1). */
  ehParDoCr(c) { return c === 0x0a || (this.versao11 && c === 0x85); }

  pularCaractere(c) {
    if (this.espiar() !== c) return false;
    this.consumir();
    return true;
  }

  /** skipSpaces: true when at least one space was skipped (entity boundaries are crossed). */
  pularEspacos() {
    let viu = false;
    while (ehEspaco(this.espiar())) { this.consumir(); viu = true; }
    return viu;
  }

  /** skipString: consumes `s` only when the current entity continues with it (never crosses its end). */
  pularTexto(s) {
    // XMLEntityScanner.skipString: arrangeCapacity without changing entity — at the end of the
    // entity it just answers false
    if (this.p + s.length > this.n) return false;
    for (let i = 0; i < s.length; i++) {
      if (this.t.charCodeAt(this.p + i) !== s.charCodeAt(i)) return false;
    }
    for (let i = 0; i < s.length; i++) this.consumir();
    return true;
  }

  consumirAte(fim) { while (this.p < fim) this.consumir(); }

  /**
   * scanName (non-namespace aware): null when the next char cannot start a name. A name never
   * crosses the end of the entity it starts in. `verificarLimite`: maxXMLNameLimit.
   */
  lerNome(verificarLimite = true) {
    if (!ehInicioNome(this.espiarCodePoint())) return null;
    let s = this.consumirCodePoint();
    while (this.p < this.n && ehNome(this.espiarCodePoint())) s += this.consumirCodePoint();
    if (verificarLimite) this.verificarTamanhoNome(s.length);
    return s;
  }

  /** maxXMLNameLimit, checked when a name has been read (position after it). */
  verificarTamanhoNome(tamanho) {
    if (tamanho > LIMITES.nome) throw this.erro('MaxXMLNameLimit', [this.entidade.nome, tamanho, LIMITES.nome, ORIGEM.jaxp]);
  }

  /** scanNmtoken: name characters (at least one) or null. */
  lerNmtoken() {
    let s = '';
    while ((s === '' || this.p < this.n) && ehNome(this.espiarCodePoint())) s += this.consumirCodePoint();
    return s === '' ? null : s;
  }

  espiarCodePoint() {
    const c = this.espiar();
    if (ehAlta(c) && this.p + 1 < this.n) {
      const d = this.t.charCodeAt(this.p + 1);
      if (ehBaixa(d)) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
    }
    return c;
  }

  consumirCodePoint() {
    const cp = this.espiarCodePoint();
    this.consumir();
    if (cp > 0xffff) this.consumir();
    return String.fromCodePoint(cp);
  }

  /**
   * scanQName (XMLEntityScanner): { prefixo, local, bruto } or null. The first colon after the
   * first character separates the prefix; a second colon ends the name. The prefix is checked
   * against the name limit while the name is being scanned (the column has not moved yet); then a
   * local part that does not start an NCName is an IllegalQName, and its length is checked.
   */
  lerQName() {
    const { linha, coluna } = this;
    if (!ehInicioNome(this.espiarCodePoint())) return null;
    let bruto = this.consumirCodePoint();
    let doisPontos = -1;
    while (this.p < this.n && ehNome(this.espiarCodePoint())) {
      if (this.espiar() === 0x3a) {
        if (doisPontos >= 0) break;
        doisPontos = bruto.length;
        if (doisPontos > LIMITES.nome && !this.semLocal) {
          throw new ErroXml(linha, coluna, mensagemXml('MaxXMLNameLimit', [this.entidade.nome, doisPontos, LIMITES.nome, ORIGEM.jaxp]));
        }
      }
      bruto += this.consumirCodePoint();
    }
    if (doisPontos < 0) {
      this.verificarTamanhoNome(bruto.length);
      return { prefixo: null, local: bruto, bruto };
    }
    const qn = { prefixo: bruto.slice(0, doisPontos), local: bruto.slice(doisPontos + 1), bruto };
    if (!qn.local || !ehInicioNome(qn.local.codePointAt(0), false)) throw this.erro('IllegalQName', []); // formatted by MessageFormat (quotes removed)
    this.verificarTamanhoNome(qn.local.length);
    return qn;
  }

  ehInvalidoLiteral(c) {
    if (this.versao11) return !ehLiteral11(c) && !ehAlta(c) && !ehBaixa(c);
    return !ehValido10(c);
  }

  /** scanSurrogates: a high surrogate must be followed by a low one. */
  lerSubstitutos(chaveErro, argsErro) {
    const alta = this.espiar();
    const baixa = this.p + 1 < this.n ? this.t.charCodeAt(this.p + 1) : -1;
    if (!ehBaixa(baixa)) {
      throw this.erro(chaveErro, argsErro(alta));
    }
    const s = this.t.slice(this.p, this.p + 2);
    this.consumir();
    this.consumir();
    return s;
  }

  // ─── Entities (XMLEntityManager) ───────────────────────────────────────────────────────────
  /**
   * startEntity of a declared entity: an external one is refused (accessExternalDTD=""), a
   * recursive reference is an error, otherwise its replacement text becomes the current entity
   * (positions restart at line 1, column 1) and counts against the expansion limit.
   */
  iniciarEntidade(e) {
    if (e.externa) {
      const expandido = expandirSistema(e.sistema);
      const protocolo = this.protocoloRecusado(expandido);
      throw this.erro('AccessExternalEntity', [caminhoSeguro(expandido), protocolo]);
    }
    const ativos = [...this.pilhaEntidades.map((q) => q.entidade), this.entidade];
    for (let i = ativos.length - 1; i >= 0; i--) {
      if (ativos[i].nome !== e.nome) continue;
      let caminho = e.nome;
      for (let j = i + 1; j < ativos.length - 1; j++) caminho += ` -> ${ativos[j].nome}`;
      caminho += ` -> ${this.entidade.nome} -> ${e.nome}`;
      throw this.erro('RecursiveReference', [e.nome, caminho]);
    }
    this.pilhaEntidades.push({
      t: this.t, n: this.n, p: this.p, linha: this.linha, coluna: this.coluna, entidade: this.entidade,
      profundidadeMarcacao: this.profundidade, profundidadeDtd: this.profundidadeDtd,
    });
    this.entidade = e;
    this.t = e.valor;
    this.n = e.valor.length;
    this.p = 0;
    this.linha = 1;
    this.coluna = 1;
    if (++this.limites.expansoes > LIMITES.expansoes) throw this.erro('EntityExpansionLimit', [String(LIMITES.expansoes)]);
  }

  /**
   * endEntity: the handler runs while the ending entity is still the current one (its position).
   * Document scanner: the markup must be balanced inside a general entity; DTD scanner: a
   * parameter entity used as a whole declaration must contain complete declarations.
   */
  fimEntidade() {
    const quadro = this.pilhaEntidades[this.pilhaEntidades.length - 1];
    const e = this.entidade;
    if (e.parametro) {
      if (quadro.profundidadeDtd === 0 && quadro.profundidadeDtd < this.profundidadeDtd) {
        throw this.erro('ILL_FORMED_PARAMETER_ENTITY_WHEN_USED_IN_DECL', [e.nome]);
      }
    } else if (!this.naDtd && this.profundidade !== quadro.profundidadeMarcacao) {
      throw this.erro('MarkupEntityMismatch');
    }
    if (e.geral) this.limites.fimEntidade(e.nome);
    this.pilhaEntidades.pop();
    this.t = quadro.t;
    this.n = quadro.n;
    this.p = quadro.p;
    this.linha = quadro.linha;
    this.coluna = quadro.coluna;
    this.entidade = quadro.entidade;
  }

  /** fMarkupDepth when the current entity started (fEntityStack[fEntityDepth - 1]); 0 in the document. */
  profundidadeInicioEntidade() {
    return this.pilhaEntidades.length ? this.pilhaEntidades[this.pilhaEntidades.length - 1].profundidadeMarcacao : 0;
  }

  /** SecuritySupport.checkAccess: the refused protocol; a malformed URL is an IOException. */
  protocoloRecusado(sistema) {
    try {
      return protocoloRecusado(sistema);
    } catch (e) {
      if (e instanceof ErroAcessoIO) throw new ErroXml(-1, -1, e.message, { io: true });
      throw e;
    }
  }

  /** XMLEntityScanner.checkEntityLimit: characters read from a general entity (size limits). */
  contarEntidade(n) {
    const nome = this.entidade.nome;
    const v = this.limites.adicionar(nome, n);
    if (v > LIMITES.tamanhoEntidadeGeral) throw this.erro('MaxEntitySizeLimit', [nome, v, LIMITES.tamanhoEntidadeGeral, ORIGEM.geral]);
    if (this.limites.total > LIMITES.tamanhoTotal) throw this.erro('TotalEntitySizeLimit', [this.limites.total, LIMITES.tamanhoTotal, ORIGEM.total]);
  }

  /** A built-in entity reference counts one character for the current entity (XMLScanner.checkEntityLimit). */
  contarPredefinida() {
    const nome = this.entidade.nome;
    const v = this.limites.adicionar(nome, 1);
    if (v > LIMITES.tamanhoEntidadeGeral) throw this.erro('MaxEntitySizeLimit', [nome, v, LIMITES.tamanhoEntidadeGeral, ORIGEM.jaxp]);
    if (this.limites.total > LIMITES.tamanhoTotal) throw this.erro('TotalEntitySizeLimit', [this.limites.total, LIMITES.tamanhoTotal, ORIGEM.jaxp]);
  }

  /**
   * Consumes one character of a run of character data. Inside a general entity the run is counted
   * one 64-character buffer at a time (scanContent/scanLiteral count what they read per load).
   */
  consumirEmBloco() {
    if (!this.entidade.geral) return this.consumir();
    this.contandoTexto = true;
    let c;
    try { c = this.consumir(); } finally { this.contandoTexto = false; }
    this.blocoPendente++;
    if (this.p % BLOCO_ENTIDADE === 0) this.fecharBloco();
    return c;
  }

  fecharBloco() {
    if (!this.blocoPendente) return;
    const n = this.blocoPendente;
    this.blocoPendente = 0;
    this.contarEntidade(n);
  }

  // ─── Document ─────────────────────────────────────────────────────────────────────────────
  analisar() {
    try {
      this.h.inicioDocumento?.();
      this.lerDeclaracaoXml();
      this.lerPrologo();
      this.lerConteudo();
      this.lerFinal();
      this.h.fimDocumento?.();
    } catch (e) {
      if (e instanceof FimDaEntidade) { this.h.fimDocumento?.(); return; }
      throw e;
    }
  }

  /**
   * XMLVersionDetector.determineDocVersion (XML11Configuration) reads up to `<?xml version="x.y"`
   * before the scanner starts: the end of input inside that window is a PrematureEOF reported
   * after the entity was closed (line/column -1).
   */
  detectarVersao() {
    const t = this.t;
    const n = this.n;
    const fim = () => { this.semLocal = true; return this.erro('PrematureEOF'); };
    const espaco = (i) => ehEspaco(t.charCodeAt(i));
    let i = 5;
    if (i >= n) throw fim();
    if (!espaco(i)) return;
    while (i < n && espaco(i)) i++;
    if (i >= n) throw fim();
    if (n - i < 7 || t.slice(i, i + 7) !== 'version') return;
    i += 7;
    while (i < n && espaco(i)) i++;
    if (i >= n) throw fim();
    if (t[i] !== '=') return;
    i++;
    while (i < n && espaco(i)) i++;
    if (i + 5 > n) throw fim();
  }

  /** XMLDeclDriver: "<?xml" followed by a space starts the XML declaration. */
  lerDeclaracaoXml() {
    if (this.n < 5 || !this.t.startsWith('<?xml', 0)) return;
    this.detectarVersao();
    if (!ehEspaco(this.t.charCodeAt(5))) {
      // the detector gave up right after "<?xml" (fixupCurrentEntity): the prolog reads it as a
      // processing instruction and the columns of the first line come out 5 to the right
      this.coluna += 5;
      return;
    }
    this.consumirAte(5);
    this.profundidade++;
    let versao = null;
    let estado = 0;
    let achouDados = false;
    let viuEspaco = this.pularEspacos();
    while (this.espiar() !== 0x3f) {
      achouDados = true;
      const [nome, valor] = this.lerPseudoAtributo();
      if (estado === 0) {
        if (nome === 'version') {
          if (!viuEspaco) throw this.erro('SpaceRequiredBeforeVersionInXMLDecl');
          versao = valor;
          estado = 1;
          if (versao !== '1.0' && versao !== '1.1') throw this.erro('VersionNotSupported', [versao]);
          if (versao === '1.1') this.versao11 = true;
        } else if (nome === 'encoding') {
          throw this.erro('VersionInfoRequired');
        } else {
          throw this.erro('VersionInfoRequired');
        }
      } else if (estado === 1) {
        if (nome === 'encoding') {
          if (!viuEspaco) throw this.erro('SpaceRequiredBeforeEncodingInXMLDecl');
          estado = 2;
        } else if (nome === 'standalone') {
          if (!viuEspaco) throw this.erro('SpaceRequiredBeforeStandalone');
          estado = 3;
          if (valor !== 'yes' && valor !== 'no') throw this.erro('SDDeclInvalid', [valor]);
        } else {
          throw this.erro('EncodingDeclRequired');
        }
      } else if (estado === 2) {
        if (nome === 'standalone') {
          if (!viuEspaco) throw this.erro('SpaceRequiredBeforeStandalone');
          estado = 3;
          if (valor !== 'yes' && valor !== 'no') throw this.erro('SDDeclInvalid', [valor]);
        } else {
          throw this.erro('SDDeclNameInvalid');
        }
      } else {
        throw this.erro('NoMorePseudoAttributes');
      }
      viuEspaco = this.pularEspacos();
    }
    if (!achouDados && versao == null) throw this.erro('VersionInfoRequired');
    if (!this.pularCaractere(0x3f)) throw this.erro('XMLDeclUnterminated');
    if (!this.pularCaractere(0x3e)) throw this.erro('XMLDeclUnterminated');
    this.profundidade--;
  }

  /** scanPseudoAttribute (XML declaration). */
  lerPseudoAtributo() {
    let nome = null;
    const c = this.espiar();
    for (const candidato of ['version', 'encoding', 'standalone']) {
      if (c === candidato.charCodeAt(0) && this.pularTexto(candidato)) { nome = candidato; break; }
    }
    if (nome == null) throw this.erro('PseudoAttrNameExpected');
    this.pularEspacos();
    if (!this.pularCaractere(0x3d)) throw this.erro('EqRequiredInXMLDecl', [nome]);
    this.pularEspacos();
    const aspa = this.espiar();
    if (aspa !== 0x27 && aspa !== 0x22) throw this.erro('QuoteRequiredInXMLDecl', [nome]);
    this.consumir();
    let valor = '';
    for (;;) {
      const x = this.espiar();
      if (x === aspa) break;
      if (ehAlta(x)) { valor += this.lerSubstitutos('InvalidCharInXMLDecl', (v) => [hex(v)]); continue; }
      if (this.ehInvalidoLiteral(x)) throw this.erro('InvalidCharInXMLDecl', [hex(x)]);
      valor += String.fromCharCode(this.consumir());
    }
    this.consumir();
    return [nome, valor];
  }

  /** PrologDriver. */
  lerPrologo() {
    for (;;) {
      this.pularEspacos();
      const c = this.espiar();
      if (c === 0x3c) {
        this.consumir();
        this.profundidade++;
        if (this.pularCaractere(0x3f)) { this.lerPI(); continue; }
        if (this.pularCaractere(0x21)) {
          if (this.pularCaractere(0x2d)) {
            if (!this.pularCaractere(0x2d)) throw this.erro('InvalidCommentStart');
            this.lerComentario();
            continue;
          }
          if (this.pularTexto('DOCTYPE')) {
            if (this.viuDoctype) throw this.erro('AlreadySeenDoctype');
            this.viuDoctype = true;
            this.lerDoctype();
            continue;
          }
          throw this.erro('MarkupNotRecognizedInProlog');
        }
        if (ehInicioNome(this.espiarCodePoint())) return; // root element
        throw this.erro('MarkupNotRecognizedInProlog');
      }
      if (c === 0x26) throw (this.consumir(), this.erro('ReferenceIllegalInProlog'));
      throw this.erro('ContentIllegalInProlog');
    }
  }

  /** scanPI after "<?" (document or DTD). */
  lerPI() {
    const alvo = this.lerNome();
    if (alvo == null) throw this.erro('PITargetRequired');
    this.lerDadosPI(alvo);
  }

  /** The markup that just ended (PI, comment) closes one level of the scanner that is running. */
  fecharMarcacao() {
    if (this.naDtd) this.profundidadeDtd--; else this.profundidade--;
  }

  /** scanPIData. */
  lerDadosPI(alvo) {
    if (alvo.length === 3 && alvo.toLowerCase() === 'xml') throw this.erro('ReservedPITarget');
    if (!this.pularEspacos()) {
      if (this.pularTexto('?>')) { this.fecharMarcacao(); return; }
      throw this.erro('SpaceRequiredInPI');
    }
    this.lerDadosAte('?>', 'InvalidCharInPI', (c) => [c.toString(16)]);
    this.fecharMarcacao();
  }

  /** scanData(delimiter) loops: text up to the delimiter (consumed), invalid characters reported where they are. */
  lerDadosAte(delimitador, chaveInvalido, argsInvalido) {
    let s = '';
    for (;;) {
      if (this.n - this.p < delimitador.length && !this.pilhaEntidades.length) {
        // XMLEntityScanner.scanData: fewer characters left than the delimiter → they are appended,
        // the column grows by their count (no line break processing) and the entity ends
        this.coluna += this.n - this.p;
        this.p = this.n;
        throw this.fimDoDocumento();
      }
      if (this.p + delimitador.length <= this.n && this.t.startsWith(delimitador, this.p)) {
        for (let i = 0; i < delimitador.length; i++) this.consumir();
        return s;
      }
      const c = this.espiar();
      if (ehAlta(c)) { s += this.lerSubstitutos(chaveInvalido, argsInvalido); continue; }
      if (c === 0x0a) { s += '\n'.repeat(this.consumirQuebras()); continue; }
      if (this.ehInvalidoLiteral(c)) throw this.erro(chaveInvalido, argsInvalido(c));
      s += String.fromCharCode(this.consumir());
    }
  }

  /** scanComment after "<!--". */
  lerComentario() {
    this.lerDadosAte('--', 'InvalidCharInComment', (c) => [c.toString(16)]);
    if (!this.pularCaractere(0x3e)) throw this.erro('DashDashInComment');
    this.fecharMarcacao();
  }

  // ─── Content ──────────────────────────────────────────────────────────────────────────────
  lerConteudo() {
    this.fase = 'conteudo';
    // the prolog driver already consumed '<' of the root element
    this.lerInicioElemento();
    while (this.elementos.length) {
      const c = this.espiar();
      if (c === 0x3c) {
        this.consumir();
        this.profundidade++;
        this.lerMarcacao();
      } else if (c === 0x26) {
        this.lendoReferencia++;
        try {
          this.consumir();
          this.lerReferenciaConteudo();
        } finally {
          this.lendoReferencia--;
        }
      } else {
        this.lerTexto();
      }
    }
  }

  /** SCANNER_STATE_START_OF_MARKUP in content. */
  lerMarcacao() {
    if (this.pularCaractere(0x3f)) { this.lerPI(); return; }
    if (this.pularCaractere(0x21)) {
      if (this.pularCaractere(0x2d)) {
        if (!this.pularCaractere(0x2d)) throw this.erro('InvalidCommentStart');
        this.lerComentario();
        return;
      }
      if (this.pularTexto('[CDATA[')) { this.lerCDATA(); return; }
      if (this.pularTexto('DOCTYPE')) throw new ErroXml(-1, -1, 'Scanner State 24 not Recognized ', { semLocal: true });
      throw this.erro('MarkupNotRecognizedInContent');
    }
    if (this.pularCaractere(0x2f)) { this.lerFimElemento(); return; }
    if (ehInicioNome(this.espiarCodePoint())) { this.lerInicioElemento(); return; }
    throw this.erro('MarkupNotRecognizedInContent');
  }

  /** scanContent: character data up to '<' or '&'; "]]>" and invalid characters are errors. */
  lerTexto() {
    let s = '';
    for (;;) {
      if (this.p >= this.n && this.pilhaEntidades.length) {
        if (s) { this.h.caracteres(s); s = ''; }
        this.fecharBloco();
        this.fimEntidade();
        return;
      }
      const c = this.espiar();
      if (c === 0x3c || c === 0x26) break;
      if (c === 0x5d) {
        this.fecharBloco();
        s += String.fromCharCode(this.consumir());
        if (this.pularCaractere(0x5d)) {
          s += ']';
          while (this.pularCaractere(0x5d)) s += ']';
          if (this.pularCaractere(0x3e)) throw this.erro('CDEndInContent');
        }
        continue;
      }
      if (ehAlta(c)) { this.fecharBloco(); s += this.lerSubstitutos('InvalidCharInContent', (v) => [hex(v)]); continue; }
      if (c === 0x0a) { s += '\n'.repeat(this.consumirQuebras()); continue; }
      if (this.ehInvalidoLiteral(c)) {
        if (s) this.h.caracteres(s);
        this.fecharBloco();
        throw this.erro('InvalidCharInContent', [hex(c)]);
      }
      s += String.fromCharCode(this.consumirEmBloco());
    }
    this.fecharBloco();
    if (s) this.h.caracteres(s);
  }

  lerCDATA() {
    const s = this.lerDadosAte(']]>', 'InvalidCharInCDSect', (c) => [hex(c)]);
    this.profundidade--;
    if (s) this.h.caracteres(s);
  }

  /** scanCharReferenceValue after "&#": returns the characters. */
  lerReferenciaCaractere() {
    let hexa = false;
    let digitos = '';
    if (this.pularCaractere(0x78)) {
      hexa = true;
      const ehHex = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
      if (!ehHex(this.espiar())) throw this.erro('HexdigitRequiredInCharRef');
      while (ehHex(this.espiar())) digitos += String.fromCharCode(this.consumir());
    } else {
      const ehDec = (c) => c >= 0x30 && c <= 0x39;
      if (!ehDec(this.espiar())) throw this.erro('DigitRequiredInCharRef');
      while (ehDec(this.espiar())) digitos += String.fromCharCode(this.consumir());
    }
    if (!this.pularCaractere(0x3b)) throw this.erro('SemicolonRequiredInCharRef');
    const texto = (hexa ? 'x' : '') + digitos;
    // Integer.parseInt overflows above 2^31-1 (NumberFormatException → InvalidCharRef)
    const valor = digitos.length > 10 ? -1 : parseInt(digitos, hexa ? 16 : 10);
    const invalido = valor < 0 || valor > 0x7fffffff || valor > 0x10ffff
      || (valor <= 0xffff && (this.versao11 ? !ehValido11(valor) : !ehValido10(valor)));
    if (invalido) throw this.erro('InvalidCharRef', [texto]);
    return String.fromCodePoint(valor);
  }

  /** scanEntityReference: reference in content after '&'. */
  lerReferenciaConteudo() {
    if (this.pularCaractere(0x23)) {
      this.h.caracteres(this.lerReferenciaCaractere());
      return;
    }
    const nome = this.lerNome();
    if (nome == null) throw this.erro('NameRequiredInReference');
    if (!this.pularCaractere(0x3b)) throw this.erro('SemicolonRequiredInReference', [nome]);
    const e = this.entidades.get(nome);
    if (e?.naoAnalisada) throw this.erro('ReferenceToUnparsedEntity', [nome]);
    const predefinida = PREDEFINIDAS[nome];
    if (predefinida !== undefined) {
      this.contarPredefinida();
      this.h.caracteres(predefinida);
      return;
    }
    if (!e) throw this.erro('EntityNotDeclared', [nome]);
    this.iniciarEntidade(e);
  }

  /**
   * scanAttributeValue (document attributes and ATTLIST defaults): quotes, normalization of
   * white space, character and entity references (a quote inside an entity does not close the
   * value), '<' forbidden.
   */
  lerValorAtributo(elemento, atributo) {
    const aspa = this.espiar();
    if (aspa !== 0x27 && aspa !== 0x22) throw this.erro('OpenQuoteExpected', [elemento, atributo]);
    this.consumir();
    let valor = '';
    const profundidadeEntidade = this.pilhaEntidades.length;
    for (;;) {
      if (this.p >= this.n && this.pilhaEntidades.length > profundidadeEntidade) { this.fecharBloco(); this.fimEntidade(); continue; }
      const c = this.espiar();
      if (c === aspa && this.pilhaEntidades.length === profundidadeEntidade) break;
      if (c === 0x26) {
        this.fecharBloco();
        this.lendoReferencia++;
        try {
          valor += this.lerReferenciaAtributo();
        } finally {
          this.lendoReferencia--;
        }
        continue;
      }
      if (c === 0x3c) { this.fecharBloco(); throw this.erro('LessthanInAttValue', [elemento, atributo]); }
      if (c === 0x0a) { valor += ' '.repeat(this.consumirQuebras()); continue; }
      if (c === 0x09 || c === 0x0d) { this.consumirEmBloco(); valor += ' '; continue; }
      if (ehAlta(c)) { this.fecharBloco(); valor += this.lerSubstitutos('InvalidCharInAttValue', (v) => [elemento, atributo, hex(v)]); continue; }
      if (this.ehInvalidoLiteral(c)) { this.fecharBloco(); throw this.erro('InvalidCharInAttValue', [elemento, atributo, hex(c)]); }
      valor += String.fromCharCode(this.consumirEmBloco());
    }
    this.fecharBloco();
    this.consumir();
    return valor;
  }

  /**
   * Reference inside an attribute value (from '&'): the characters it stands for, or '' when an
   * entity was started (its replacement text is read next). The XML 1.1 scanner of the JDK does
   * not see the entities declared in the DTD from attribute values: anything but a built-in
   * entity is "not declared" there (DTD defaults are not affected).
   */
  lerReferenciaAtributo() {
    this.consumir();
    if (this.pularCaractere(0x23)) return this.lerReferenciaCaractere();
    const nome = this.lerNome();
    if (nome == null) throw this.erro('NameRequiredInReference');
    if (!this.pularCaractere(0x3b)) throw this.erro('SemicolonRequiredInReference', [nome]);
    const predefinida = PREDEFINIDAS[nome];
    if (predefinida !== undefined) { this.contarPredefinida(); return predefinida; }
    if (this.versao11 && !this.naDtd) throw this.erro('EntityNotDeclared', [nome]);
    const e = this.entidades.get(nome);
    if (e?.externa) throw this.erro('ReferenceToExternalEntity', [nome]);
    if (!e) throw this.erro('EntityNotDeclared', [nome]);
    this.iniciarEntidade(e);
    return '';
  }

  /** scanStartElement (namespace aware) after '<'. */
  lerInicioElemento() {
    const qn = this.lerQName();
    const bruto = qn.bruto;
    const profundidadeElemento = this.elementos.length + 1;
    if (profundidadeElemento > LIMITES.profundidade) {
      throw this.erro('MaxElementDepthLimit', [bruto, profundidadeElemento, LIMITES.profundidade, ORIGEM.profundidade]);
    }
    const contexto = new Map();
    this.contextosNs.push(contexto);
    const atributos = [];
    let vazio = false;
    let xmlnsDeclarado = false;
    for (;;) {
      const viuEspaco = this.pularEspacos();
      const c = this.espiar();
      if (c === 0x3e) { this.consumir(); break; }
      if (c === 0x2f) {
        this.consumir();
        if (!this.pularCaractere(0x3e)) throw this.erro('ElementUnterminated', [bruto]);
        vazio = true;
        break;
      }
      if (!ehInicioNome(this.espiarCodePoint()) || !viuEspaco) throw this.erro('ElementUnterminated', [bruto]);
      // attribute
      const an = this.lerQName();
      this.pularEspacos();
      if (!this.pularCaractere(0x3d)) throw this.erro('EqRequiredInAttribute', [bruto, an.bruto]);
      this.pularEspacos();
      const valor = this.lerValorAtributo(bruto, an.bruto);
      const prefixo = an.prefixo ?? '';
      const ehDeclNs = prefixo === 'xmlns' || (prefixo === '' && an.local === 'xmlns');
      if (this.temGramatica) {
        // no binding by the scanner: every attribute is unique by its raw name
        if (atributos.some((a) => a.bruto === an.bruto)) throw this.erro('AttributeNotUnique', [bruto, an.bruto]);
        atributos.push({ prefixo: an.prefixo, local: an.local, bruto: an.bruto, uri: null, valor, especificado: true, tipo: 'CDATA', declNs: ehDeclNs });
      } else if (ehDeclNs) {
        const uri = valor;
        if (prefixo === 'xmlns' && an.local === 'xmlns') throw this.erro('CantBindXMLNS', [qnameJava(an)]);
        if (uri === XMLNS_URI) throw this.erro('CantBindXMLNS', [qnameJava(an)]);
        if (an.local === 'xml') { if (uri !== XML_URI) throw this.erro('CantBindXML', [qnameJava(an)]); }
        else if (uri === XML_URI) throw this.erro('CantBindXML', [qnameJava(an)]);
        const p = an.local !== 'xmlns' ? an.local : '';
        if (uri === '' && an.local !== 'xmlns') throw this.erro('EmptyPrefixedAttName', [qnameJava(an)]);
        if (contexto.has(p)) throw this.erro('AttributeNotUnique', [bruto, an.bruto]);
        if (p === 'xml' || p === 'xmlns') {
          if (xmlnsDeclarado) throw this.erro('AttributeNotUnique', [bruto, an.bruto]);
          xmlnsDeclarado = true;
        } else {
          contexto.set(p, uri.length ? uri : null);
        }
        atributos.push({ prefixo: an.prefixo ?? (an.local === 'xmlns' ? 'xmlns' : null), local: an.local, bruto: an.bruto, uri: XMLNS_URI, valor, especificado: true, tipo: 'CDATA' });
      } else {
        // duplicates are found by checkDuplicatesNS after the whole start tag
        atributos.push({ prefixo: an.prefixo, local: an.local, bruto: an.bruto, uri: null, valor, especificado: true, tipo: 'CDATA' });
      }
      if (atributos.length > LIMITES.atributosPorElemento) throw this.erro('ElementAttributeLimit', [bruto, LIMITES.atributosPorElemento]);
    }
    let elemento;
    if (this.temGramatica) {
      if (vazio) this.fecharElementoVazio(bruto);
      // XMLNSDTDValidator.handleStartElement: DTD defaults and normalization, then the namespaces
      this.aplicarDeclsAtributos(bruto, atributos);
      elemento = this.vincularPeloValidadorDtd(qn, atributos, contexto);
    } else {
      elemento = this.vincularPeloScanner(qn, atributos);
      if (vazio) this.fecharElementoVazio(bruto);
    }
    if (vazio) {
      this.h.elementoVazio(elemento, atributos);
      this.contextosNs.pop();
      if (this.elementos.length === 0) this.fase = 'final';
    } else {
      this.elementos.push(elemento);
      this.h.inicioElemento(elemento, atributos);
    }
  }

  /** Empty-element tag: the markup closes here and must belong to the entity it started in. */
  fecharElementoVazio(bruto) {
    this.profundidade--;
    if (this.profundidade < this.profundidadeInicioEntidade()) throw this.erro('ElementEntityMismatch', [bruto]);
  }

  /** XMLNSDocumentScannerImpl (fBindNamespaces): element, then prefixed attributes, then duplicates. */
  vincularPeloScanner(qn, atributos) {
    const bruto = qn.bruto;
    if (qn.prefixo === 'xmlns') throw this.erro('ElementXMLNSPrefix', [bruto]);
    const uri = this.resolverPrefixo(qn.prefixo ?? '');
    if (qn.prefixo != null && uri == null) throw this.erro('ElementPrefixUnbound', [qn.prefixo, bruto]);
    for (const a of atributos) {
      if (a.uri === XMLNS_URI) continue;
      const ap = a.prefixo ?? '';
      if (ap === '') continue;
      const u = this.resolverPrefixo(ap);
      if (u == null) throw this.erro('AttributePrefixUnbound', [bruto, a.bruto, ap]);
      a.uri = u;
    }
    if (atributos.length > 1) {
      const vistos = new Set();
      for (const a of atributos) {
        const chave = a.uri == null ? `|${a.bruto}` : `${a.uri}|${a.local}`;
        if (vistos.has(chave)) {
          if (a.uri != null) throw this.erro('AttributeNSNotUnique', [bruto, a.local, a.uri]);
          throw this.erro('AttributeNotUnique', [bruto, a.bruto]);
        }
        vistos.add(chave);
      }
    }
    return { prefixo: qn.prefixo, local: qn.local, bruto, uri };
  }

  /**
   * XMLDTDValidator.addDTDDefaultAttrsAndValidate (no validation): the ATTLIST defaults of the
   * element are added at the end, and the specified attributes declared with a type other than
   * CDATA are normalized (leading/trailing spaces removed, inner runs collapsed).
   */
  aplicarDeclsAtributos(bruto, atributos) {
    const decls = this.declsAtributos.get(bruto);
    if (!decls) return;
    // the names are unique per element, so the defaults added below never collide with a later declaration
    const especificados = new Set(atributos.map((a) => a.bruto));
    for (const d of decls.values()) {
      if (d.padrao == null || especificados.has(d.nome)) continue;
      const i = d.nome.indexOf(':');
      const prefixo = i < 0 ? null : d.nome.slice(0, i);
      const local = i < 0 ? d.nome : d.nome.slice(i + 1);
      atributos.push({
        prefixo, local, bruto: d.nome, uri: null, valor: d.padrao, especificado: false, tipo: d.tipo,
        declNs: prefixo === 'xmlns' || (prefixo == null && local === 'xmlns'),
      });
    }
    for (const a of atributos) {
      const d = decls.get(a.bruto);
      if (!d) continue;
      a.tipo = d.tipo;
      if (a.especificado && d.tipo !== 'CDATA') a.valor = normalizarValorDtd(a.valor);
    }
  }

  /**
   * XMLNSDTDValidator.startNamespaceScope: namespace declarations (in attribute order), the element,
   * the prefixed attributes and the duplicate check — reported after the whole start tag.
   */
  vincularPeloValidadorDtd(qn, atributos, contexto) {
    const bruto = qn.bruto;
    if (qn.prefixo === 'xmlns') throw this.erro('ElementXMLNSPrefix', [bruto]);
    for (const a of atributos) {
      if (!a.declNs) continue;
      const uri = a.valor;
      if (a.prefixo === 'xmlns' && a.local === 'xmlns') throw this.erro('CantBindXMLNS', [a.bruto]);
      if (uri === XMLNS_URI) throw this.erro('CantBindXMLNS', [a.bruto]);
      if (a.local === 'xml') { if (uri !== XML_URI) throw this.erro('CantBindXML', [a.bruto]); }
      else if (uri === XML_URI) throw this.erro('CantBindXML', [a.bruto]);
      const p = a.local !== 'xmlns' ? a.local : '';
      if (uri === '' && a.local !== 'xmlns') throw this.erro('EmptyPrefixedAttName', [a.bruto]);
      if (p !== 'xml' && p !== 'xmlns') contexto.set(p, uri.length ? uri : null);
    }
    const uri = this.resolverPrefixo(qn.prefixo ?? '');
    if (qn.prefixo != null && uri == null) throw this.erro('ElementPrefixUnbound', [qn.prefixo, bruto]);
    for (const a of atributos) {
      if (a.declNs) { a.uri = XMLNS_URI; continue; }
      const ap = a.prefixo ?? '';
      if (ap === '') continue;
      a.uri = this.resolverPrefixo(ap);
      if (a.uri == null) throw this.erro('AttributePrefixUnbound', [bruto, a.bruto, ap]);
    }
    for (let i = 0; i < atributos.length - 1; i++) {
      const a = atributos[i];
      if (a.uri == null || a.uri === XMLNS_URI) continue;
      for (let j = i + 1; j < atributos.length; j++) {
        const b = atributos[j];
        if (a.local === b.local && a.uri === b.uri) throw this.erro('AttributeNSNotUnique', [bruto, a.local, a.uri]);
      }
    }
    return { prefixo: qn.prefixo, local: qn.local, bruto, uri };
  }

  resolverPrefixo(prefixo) {
    for (let i = this.contextosNs.length - 1; i >= 0; i--) {
      const c = this.contextosNs[i];
      if (c.has(prefixo)) return c.get(prefixo);
    }
    return null;
  }

  /** scanEndElement after "</". */
  lerFimElemento() {
    const elemento = this.elementos.pop();
    if (!this.pularTexto(elemento.bruto)) throw this.erro('ETagRequired', [elemento.bruto]);
    this.pularEspacos();
    if (!this.pularCaractere(0x3e)) throw this.erro('ETagUnterminated', [elemento.bruto]);
    this.profundidade -= 2;
    if (this.profundidade < this.profundidadeInicioEntidade()) throw this.erro('ElementEntityMismatch', [elemento.bruto]);
    if (this.elementos.length === 0) this.fase = 'final';
    this.h.fimElemento(elemento);
    this.contextosNs.pop();
  }

  // ─── Trailing section ─────────────────────────────────────────────────────────────────────
  lerFinal() {
    this.fase = 'final';
    for (;;) {
      this.pularEspacos();
      let c;
      try { c = this.espiar(); } catch (e) { if (e instanceof FimDaEntidade) return; throw e; }
      if (c === 0x3c) {
        this.consumir();
        this.profundidade++;
        if (this.pularCaractere(0x3f)) { this.lerPI(); continue; }
        if (this.pularCaractere(0x21)) {
          if (!this.pularTexto('--')) throw this.erro('InvalidCommentStart');
          this.lerComentario();
          continue;
        }
        throw this.erro('MarkupNotRecognizedInMisc');
      }
      // TrailingMiscDriver: anything else (a reference included) is content in the trailing section
      throw this.erro('ContentIllegalInTrailingMisc');
    }
  }
}

Object.assign(LeitorXml.prototype, MetodosDtd);

/** QName.toString() used by the namespace binding errors of the scanner. */
function qnameJava(q) {
  return `prefix="${q.prefixo ?? 'null'}",localpart="${q.local}",rawname="${q.bruto}"`;
}

