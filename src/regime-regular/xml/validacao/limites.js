// JDK XML processing limits (XMLSecurityManager + XMLLimitAnalyzer) in force for the official
// validator: FEATURE_SECURE_PROCESSING with the values of the JDK 25 conf/jaxp.properties. They are
// what keeps entity expansion bombs, huge entities, deep nesting and huge names from exhausting the
// server; the port enforces the same numbers with the same messages.
//   jdk.xml.entityExpansionLimit=2500        jdk.xml.totalEntitySizeLimit=100000
//   jdk.xml.maxGeneralEntitySizeLimit=100000 jdk.xml.maxParameterEntitySizeLimit=15000
//   jdk.xml.elementAttributeLimit=200        jdk.xml.maxElementDepth=100
//   jdk.xml.maxXMLNameLimit=1000             (jdk.xml.entityReplacementLimit=100000: the total size
//                                            limit is always reached first, since every node of an
//                                            entity costs at least one counted character)
export const LIMITES = Object.freeze({
  expansoes: 2500,
  tamanhoTotal: 100000,
  tamanhoEntidadeGeral: 100000,
  tamanhoEntidadeParametro: 15000,
  atributosPorElemento: 200,
  profundidade: 100,
  nome: 1000,
});

/** How the message names where a limit came from (XMLSecurityManager state literal or property name). */
export const ORIGEM = Object.freeze({
  jaxp: 'jaxp.properties',
  total: 'jdk.xml.totalEntitySizeLimit',
  geral: 'jdk.xml.maxGeneralEntitySizeLimit',
  parametro: 'jdk.xml.maxParameterEntitySizeLimit',
  profundidade: 'jdk.xml.maxElementDepth',
});

/**
 * Internal entities are read 64 characters at a time (XMLEntityScanner.load with mayReadChunks
 * false: DEFAULT_XMLDECL_BUFFER_SIZE); a run of character data is counted one buffer at a time.
 */
export const BLOCO_ENTIDADE = 64;

/** XMLLimitAnalyzer: running totals of one document. */
export class AnalisadorLimites {
  constructor() {
    this.expansoes = 0;
    this.total = 0;
    /** size accumulated by each entity being expanded (removed at its end) */
    this.porEntidade = new Map();
  }

  /** One more character counted against the general entity `nome` (and the total). */
  adicionar(nome, n) {
    this.total += n;
    const v = (this.porEntidade.get(nome) ?? 0) + n;
    this.porEntidade.set(nome, v);
    return v;
  }

  fimEntidade(nome) { this.porEntidade.delete(nome); }
}
