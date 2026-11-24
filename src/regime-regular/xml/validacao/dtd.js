// DOCTYPE and internal DTD subset of the document under validation: the declarations scanner of
// the JDK Xerces (XMLDocumentScannerImpl.scanDoctypeDecl + XMLScanner.scanExternalID +
// XMLDTDScannerImpl.scanDecls and the scan*Decl methods) for the internal subset only — the
// external subset and every external entity are refused (accessExternalDTD=""), and there is no
// DTD validation (only entity declarations and ATTLIST defaults matter afterwards). Parameter
// entity references between declarations are expanded; inside markup of the internal subset they
// are errors. These methods are mixed into LeitorXml (they use its scanner primitives).
import { ehAlta, ehPubid, hex } from './caracteres.js';
import { LIMITES, ORIGEM } from './limites.js';
import { caminhoSeguro } from './acesso-externo.js';

const ehAspa = (c) => c === 0x22 || c === 0x27;

/**
 * normalizeAttrValue / normalizeDefaultAttrValue of the DTD processor for attribute types other
 * than CDATA: no leading or trailing space, inner runs of spaces collapsed to one.
 */
export function normalizarValorDtd(v) {
  return v.replace(/ +/g, ' ').replace(/^ | $/g, '');
}

export const MetodosDtd = {
  /** scanDoctypeDecl after "<!DOCTYPE" (document scanner), then the internal subset and the external one. */
  lerDoctype() {
    if (!this.pularEspacos()) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ROOT_ELEMENT_TYPE_IN_DOCTYPEDECL');
    const nome = this.lerNome();
    if (nome == null) throw this.erro('MSG_ROOT_ELEMENT_TYPE_REQUIRED');
    let sistema = null;
    if (this.pularEspacos()) {
      sistema = this.lerIdExterno(false).sistema;
      this.pularEspacos();
    }
    this.temGramatica = true;
    if (this.pularCaractere(0x5b)) {
      // the DTD scanner closes the entity before reporting the end of input (-1, -1)
      this.naDeclaracaoXml = 'fechada';
      this.lerSubconjuntoInterno();
      if (!this.pularCaractere(0x5d)) throw this.erro('DoctypedeclNotClosed', [nome]);
      this.pularEspacos();
      if (!this.pularCaractere(0x3e)) throw this.erro('DoctypedeclUnterminated', [nome]);
      this.naDeclaracaoXml = false;
    } else {
      this.pularEspacos();
      if (!this.pularCaractere(0x3e)) throw this.erro('DoctypedeclUnterminated', [nome]);
    }
    this.profundidade--;
    if (sistema != null) {
      // SCANNER_STATE_DTD_EXTERNAL: checkAccess(fDoctypeSystemId) with the literal system id
      const protocolo = this.protocoloRecusado(sistema);
      throw this.erro('AccessExternalDTD', [caminhoSeguro(sistema), protocolo]);
    }
  },

  /** XMLScanner.scanExternalID: { sistema, publico } (both null when there is no external id). */
  lerIdExterno(sistemaOpcional) {
    let sistema = null;
    let publico = null;
    if (this.pularTexto('PUBLIC')) {
      if (!this.pularEspacos()) throw this.erro('SpaceRequiredAfterPUBLIC');
      publico = this.lerLiteralPublico();
      if (!this.pularEspacos() && !sistemaOpcional) throw this.erro('SpaceRequiredBetweenPublicAndSystem');
    }
    if (publico != null || this.pularTexto('SYSTEM')) {
      if (publico == null && !this.pularEspacos()) throw this.erro('SpaceRequiredAfterSYSTEM');
      const aspa = this.espiar();
      if (!ehAspa(aspa)) {
        if (publico != null && sistemaOpcional) return { sistema: null, publico };
        throw this.erro('QuoteRequiredInSystemID');
      }
      this.consumir();
      let s = '';
      for (;;) {
        const c = this.espiar();
        if (c === aspa) break;
        if (this.ehInvalidoLiteral(c) || ehAlta(c)) throw this.erro('InvalidCharInSystemID', [hex(c)]);
        s += String.fromCharCode(this.consumir());
      }
      this.consumir();
      sistema = s;
    }
    return { sistema, publico };
  },

  /** scanPubidLiteral: white space collapsed, PubidChar only. */
  lerLiteralPublico() {
    const aspa = this.consumir();
    if (!ehAspa(aspa)) throw this.erro('QuoteRequiredInPublicID');
    let s = '';
    let pularEspaco = true;
    for (;;) {
      const c = this.consumir();
      if (c === 0x20 || c === 0x0a || c === 0x0d) {
        if (!pularEspaco) { s += ' '; pularEspaco = true; }
      } else if (c === aspa) {
        if (pularEspaco) s = s.slice(0, -1);
        return s;
      } else if (ehPubid(c)) {
        s += String.fromCharCode(c);
        pularEspaco = false;
      } else {
        throw this.erro('InvalidCharInPublicID', [hex(c)]);
      }
    }
  },

  /** Parameter entities open around the current position (fPEDepth). */
  profundidadePE() {
    let n = this.entidade.parametro ? 1 : 0;
    for (const q of this.pilhaEntidades) if (q.entidade.parametro) n++;
    return n;
  },

  /**
   * skipSeparator(spaceRequired, lookForPERefs): white space (a parameter entity boundary counts as
   * a separator); between declarations "%name;" starts that parameter entity.
   */
  pularSeparador(espacoObrigatorio, procurarPE) {
    const profundidade = this.profundidadePE();
    const viuEspaco = this.pularEspacos();
    if (!procurarPE || !this.pularCaractere(0x25)) {
      return !espacoObrigatorio || viuEspaco || profundidade !== this.profundidadePE();
    }
    for (;;) {
      const nome = this.lerNome();
      if (nome == null) throw this.erro('NameRequiredInPEReference');
      if (!this.pularCaractere(0x3b)) throw this.erro('SemicolonRequiredInPEReference', [nome]);
      this.iniciarPE(nome);
      this.pularEspacos();
      if (!this.pularCaractere(0x25)) return true;
    }
  },

  /** startPE: an undeclared parameter entity is skipped (no validation). */
  iniciarPE(nome) {
    const e = this.entidades.get(`%${nome}`);
    if (e) this.iniciarEntidade(e);
  },

  /** scanDTDInternalSubset → scanDecls(complete): declarations up to the ']' of the internal subset. */
  lerSubconjuntoInterno() {
    this.naDtd = true;
    this.profundidadeDtd = 0;
    try {
      this.pularSeparador(false, true);
      for (;;) {
        if (this.pularCaractere(0x3c)) {
          this.profundidadeDtd++;
          if (this.pularCaractere(0x3f)) {
            this.lerPI();
          } else if (this.pularCaractere(0x21)) {
            if (this.pularCaractere(0x2d)) {
              if (!this.pularCaractere(0x2d)) throw this.erro('MSG_MARKUP_NOT_RECOGNIZED_IN_DTD');
              this.lerComentario();
            } else if (this.pularTexto('ELEMENT')) {
              this.lerDeclElemento();
            } else if (this.pularTexto('ATTLIST')) {
              this.lerDeclListaAtributos();
            } else if (this.pularTexto('ENTITY')) {
              this.lerDeclEntidade();
            } else if (this.pularTexto('NOTATION')) {
              this.lerDeclNotacao();
            } else {
              // a conditional section is not allowed in the internal subset ('[' is consumed)
              this.pularCaractere(0x5b);
              this.profundidadeDtd--;
              throw this.erro('MSG_MARKUP_NOT_RECOGNIZED_IN_DTD');
            }
          } else {
            this.profundidadeDtd--;
            throw this.erro('MSG_MARKUP_NOT_RECOGNIZED_IN_DTD');
          }
        } else if (this.espiar() === 0x5d) {
          return;
        } else if (!this.pularEspacos()) {
          throw this.erro('MSG_MARKUP_NOT_RECOGNIZED_IN_DTD');
        }
        this.pularSeparador(false, true);
      }
    } finally {
      this.naDtd = false;
    }
  },

  // ─── <!ELEMENT ──────────────────────────────────────────────────────────────────────────
  /** scanElementDecl: syntax only (the content model is not used without DTD validation). */
  lerDeclElemento() {
    if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ELEMENT_TYPE_IN_ELEMENTDECL');
    const nome = this.lerNome();
    if (nome == null) throw this.erro('MSG_ELEMENT_TYPE_REQUIRED_IN_ELEMENTDECL');
    if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_CONTENTSPEC_IN_ELEMENTDECL', [nome]);
    if (!this.pularTexto('EMPTY') && !this.pularTexto('ANY')) {
      if (!this.pularCaractere(0x28)) throw this.erro('MSG_OPEN_PAREN_OR_ELEMENT_TYPE_REQUIRED_IN_CHILDREN', [nome]);
      this.profundidadeDtd++;
      this.pularSeparador(false, false);
      if (this.pularTexto('#PCDATA')) this.lerConteudoMisto(nome);
      else this.lerConteudoFilhos(nome);
    }
    this.pularSeparador(false, false);
    if (!this.pularCaractere(0x3e)) throw this.erro('ElementDeclUnterminated', [nome]);
    this.profundidadeDtd--;
  },

  /** scanMixed after "(#PCDATA". */
  lerConteudoMisto(nome) {
    let filho = null;
    this.pularSeparador(false, false);
    while (this.pularCaractere(0x7c)) {
      this.pularSeparador(false, false);
      filho = this.lerNome();
      if (filho == null) throw this.erro('MSG_ELEMENT_TYPE_REQUIRED_IN_MIXED_CONTENT', [nome]);
      this.pularSeparador(false, false);
    }
    if (this.pularTexto(')*')) {
      // ok
    } else if (filho != null) {
      throw this.erro('MixedContentUnterminated', [nome]);
    } else if (!this.pularCaractere(0x29)) {
      throw this.erro('MSG_CLOSE_PAREN_REQUIRED_IN_CHILDREN', [nome]);
    }
    this.profundidadeDtd--;
  },

  /** scanChildren after "(": nested groups with ',' or '|' and the occurrence suffixes. */
  lerConteudoFilhos(nome) {
    const pilha = [0];
    let operador = 0;
    for (;;) {
      if (this.pularCaractere(0x28)) {
        this.profundidadeDtd++;
        pilha.push(operador);
        operador = 0;
        this.pularSeparador(false, false);
        continue;
      }
      this.pularSeparador(false, false);
      if (this.lerNome() == null) throw this.erro('MSG_OPEN_PAREN_OR_ELEMENT_TYPE_REQUIRED_IN_CHILDREN', [nome]);
      let c = this.espiar();
      if (c === 0x3f || c === 0x2a || c === 0x2b) this.consumir();
      for (;;) {
        this.pularSeparador(false, false);
        c = this.espiar();
        if (c === 0x2c && operador !== 0x7c) { operador = c; this.consumir(); break; }
        if (c === 0x7c && operador !== 0x2c) { operador = c; this.consumir(); break; }
        if (c !== 0x29) throw this.erro('MSG_CLOSE_PAREN_REQUIRED_IN_CHILDREN', [nome]);
        operador = pilha.pop();
        if (!this.pularTexto(')?') && !this.pularTexto(')+') && !this.pularTexto(')*')) this.consumir();
        this.profundidadeDtd--;
        if (pilha.length === 0) return;
      }
      this.pularSeparador(false, false);
    }
  },

  // ─── <!ATTLIST ──────────────────────────────────────────────────────────────────────────
  /** scanAttlistDecl: the declarations are kept for the defaults and the normalization of the attributes. */
  lerDeclListaAtributos() {
    if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ELEMENT_TYPE_IN_ATTLISTDECL');
    const elemento = this.lerNome();
    if (elemento == null) throw this.erro('MSG_ELEMENT_TYPE_REQUIRED_IN_ATTLISTDECL');
    if (!this.pularSeparador(true, false)) {
      if (this.pularCaractere(0x3e)) { this.profundidadeDtd--; return; }
      throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ATTRIBUTE_NAME_IN_ATTDEF', [elemento]);
    }
    while (!this.pularCaractere(0x3e)) {
      const nome = this.lerNome();
      if (nome == null) throw this.erro('AttNameRequiredInAttDef', [elemento]);
      if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ATTTYPE_IN_ATTDEF', [elemento, nome]);
      const tipo = this.lerTipoAtributo(elemento, nome);
      if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_DEFAULTDECL_IN_ATTDEF', [elemento, nome]);
      let padrao = this.lerPadraoAtributo(elemento, nome);
      if (padrao != null && tipo !== 'CDATA') padrao = normalizarValorDtd(padrao);
      // name → declaration, in declaration order (Map keeps insertion order); O(1) duplicate check
      let decls = this.declsAtributos.get(elemento);
      if (!decls) this.declsAtributos.set(elemento, (decls = new Map()));
      if (!decls.has(nome)) decls.set(nome, { nome, tipo, padrao });
      this.pularSeparador(false, false);
    }
    this.profundidadeDtd--;
  },

  /** scanAttType (the longer keywords are tried first, except ENTITY before ENTITIES, as in Xerces). */
  lerTipoAtributo(elemento, atributo) {
    for (const tipo of ['CDATA', 'IDREFS', 'IDREF', 'ID', 'ENTITY', 'ENTITIES', 'NMTOKENS', 'NMTOKEN']) {
      if (this.pularTexto(tipo)) return tipo;
    }
    if (this.pularTexto('NOTATION')) {
      if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_AFTER_NOTATION_IN_NOTATIONTYPE', [elemento, atributo]);
      if (this.consumir() !== 0x28) throw this.erro('MSG_OPEN_PAREN_REQUIRED_IN_NOTATIONTYPE', [elemento, atributo]);
      this.profundidadeDtd++;
      let c;
      do {
        this.pularSeparador(false, false);
        if (this.lerNome() == null) throw this.erro('MSG_NAME_REQUIRED_IN_NOTATIONTYPE', [elemento, atributo]);
        this.pularSeparador(false, false);
        c = this.consumir();
      } while (c === 0x7c);
      if (c !== 0x29) throw this.erro('NotationTypeUnterminated', [elemento, atributo]);
      this.profundidadeDtd--;
      return 'NOTATION';
    }
    if (this.consumir() !== 0x28) throw this.erro('AttTypeRequiredInAttDef', [elemento, atributo]);
    this.profundidadeDtd++;
    let c;
    do {
      this.pularSeparador(false, false);
      if (this.lerNmtoken() == null) throw this.erro('MSG_NMTOKEN_REQUIRED_IN_ENUMERATION', [elemento, atributo]);
      this.pularSeparador(false, false);
      c = this.consumir();
    } while (c === 0x7c);
    if (c !== 0x29) throw this.erro('EnumerationUnterminated', [elemento, atributo]);
    this.profundidadeDtd--;
    return 'ENUMERATION';
  },

  /** scanAttDefaultDecl: the default value (null for #REQUIRED/#IMPLIED). */
  lerPadraoAtributo(elemento, atributo) {
    if (this.pularTexto('#REQUIRED') || this.pularTexto('#IMPLIED')) return null;
    if (this.pularTexto('#FIXED') && !this.pularSeparador(true, false)) {
      throw this.erro('MSG_SPACE_REQUIRED_AFTER_FIXED_IN_DEFAULTDECL', [elemento, atributo]);
    }
    return this.lerValorAtributo(elemento, atributo);
  },

  // ─── <!ENTITY ───────────────────────────────────────────────────────────────────────────
  /** scanEntityDecl (internal subset): the first declaration of a name wins. */
  lerDeclEntidade() {
    let parametro = false;
    if (!this.pularEspacos()) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ENTITY_NAME_IN_ENTITYDECL');
    if (this.pularCaractere(0x25)) {
      if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_ENTITY_NAME_IN_ENTITYDECL');
      parametro = true;
    }
    const nome = this.lerNome();
    if (nome == null) throw this.erro('MSG_ENTITY_NAME_REQUIRED_IN_ENTITYDECL');
    if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_AFTER_ENTITY_NAME_IN_ENTITYDECL', [nome]);
    const { sistema } = this.lerIdExterno(false);
    let notacao = null;
    const viuEspaco = this.pularSeparador(true, false);
    if (!parametro && this.pularTexto('NDATA')) {
      if (!viuEspaco) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_NDATA_IN_UNPARSED_ENTITYDECL', [nome]);
      if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_NOTATION_NAME_IN_UNPARSED_ENTITYDECL', [nome]);
      notacao = this.lerNome();
      if (notacao == null) throw this.erro('MSG_NOTATION_NAME_REQUIRED_FOR_UNPARSED_ENTITYDECL', [nome]);
    }
    const valor = sistema == null ? this.lerValorEntidade(nome, parametro) : null;
    this.pularSeparador(false, false);
    if (!this.pularCaractere(0x3e)) throw this.erro('EntityDeclUnterminated', [nome]);
    this.profundidadeDtd--;
    const chave = parametro ? `%${nome}` : nome;
    if (this.entidades.has(chave)) return;
    this.entidades.set(chave, {
      nome: chave, valor, parametro, geral: !parametro, externa: sistema != null, naoAnalisada: notacao != null, sistema,
    });
  },

  /**
   * scanEntityValue: the literal with its character references expanded and its general entity
   * references kept as text; a parameter entity reference inside it is an error in the internal
   * subset. The size limits are checked as the literal grows (MaxEntitySizeLimit).
   */
  lerValorEntidade(nome, parametro) {
    const aspa = this.consumir();
    if (!ehAspa(aspa)) throw this.erro('OpenQuoteMissingInDecl');
    const profundidade = this.pilhaEntidades.length;
    const limite = parametro ? LIMITES.tamanhoEntidadeParametro : LIMITES.tamanhoEntidadeGeral;
    const verificar = (valor) => {
      if (valor.length > limite) {
        throw this.erro('MaxEntitySizeLimit', [parametro ? `%${nome}` : nome, valor.length, limite, parametro ? ORIGEM.parametro : ORIGEM.geral]);
      }
    };
    let valor = '';
    for (;;) {
      // scanLiteral: a run of plain characters up to the quote or a character handled below
      while (this.p < this.n) {
        const c = this.t.charCodeAt(this.p);
        if ((c === aspa && this.pilhaEntidades.length === profundidade) || c === 0x26 || c === 0x25 || c === 0x3c || c === 0x5d
          || c === 0x0a || c === 0x0d || ehAlta(c) || this.ehInvalidoLiteral(c)) break;
        valor += String.fromCharCode(this.consumir());
      }
      const c = this.espiar();
      if (c === aspa && this.pilhaEntidades.length === profundidade) break;
      if (c === 0x26) {
        this.consumir();
        if (this.pularCaractere(0x23)) {
          valor += this.lerReferenciaCaractere();
        } else {
          valor += '&';
          const ref = this.lerNome();
          if (ref == null) throw this.erro('NameRequiredInReference');
          valor += ref;
          if (!this.pularCaractere(0x3b)) throw this.erro('SemicolonRequiredInReference', [ref]);
          valor += ';';
        }
      } else if (c === 0x25) {
        this.consumir();
        const pe = this.lerNome();
        if (pe == null) throw this.erro('NameRequiredInPEReference');
        if (!this.pularCaractere(0x3b)) throw this.erro('SemicolonRequiredInPEReference', [pe]);
        throw this.erro('PEReferenceWithinMarkup', [pe]);
      } else if (ehAlta(c)) {
        valor += this.lerSubstitutos('InvalidCharInLiteral', (v) => [hex(v)]);
      } else if (this.ehInvalidoLiteral(c)) {
        throw this.erro('InvalidCharInLiteral', [hex(c)]);
      } else {
        valor += String.fromCharCode(this.consumir());
      }
      verificar(valor);
    }
    verificar(valor);
    this.consumir();
    return valor;
  },

  // ─── <!NOTATION ─────────────────────────────────────────────────────────────────────────
  /** scanNotationDecl: syntax only. */
  lerDeclNotacao() {
    if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_BEFORE_NOTATION_NAME_IN_NOTATIONDECL');
    const nome = this.lerNome();
    if (nome == null) throw this.erro('MSG_NOTATION_NAME_REQUIRED_IN_NOTATIONDECL');
    if (!this.pularSeparador(true, false)) throw this.erro('MSG_SPACE_REQUIRED_AFTER_NOTATION_NAME_IN_NOTATIONDECL', [nome]);
    const { sistema, publico } = this.lerIdExterno(true);
    if (sistema == null && publico == null) throw this.erro('ExternalIDorPublicIDRequired', [nome]);
    this.pularSeparador(false, false);
    if (!this.pularCaractere(0x3e)) throw this.erro('NotationDeclUnterminated', [nome]);
    this.profundidadeDtd--;
  },
};

