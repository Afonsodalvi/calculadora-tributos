// Bean Validation (Hibernate Validator 9.1.5) for the @Valid request bodies of this slice:
// the constraint semantics HV applies and the default messages it interpolates in the request
// locale (idioma.js). Message bundles: mensagens-validacao.json = the nine constraint keys used
// here, read from org/hibernate/validator/ValidationMessages*.properties of
// hibernate-validator-9.1.5.Final.jar (all 28 bundles, \uXXXX already decoded).
//
// Violations are collected in declaration order; Java iterates a HashSet (identity hash), so the
// order of the "[campo: mensagem] " segments varies between runs there (the differential test
// compares them as a multiset).
import MENSAGENS from './mensagens-validacao.json' with { type: 'json' };
import { javaIsBlank } from '../comum/java.js';
import { ErroValidacaoCorpo } from '../comum/problema.js';
import { cadeiaDePacotes } from './idioma.js';

const PACOTES = new Set(Object.keys(MENSAGENS));

/**
 * The only EL expression of these bundles (ValidationMessages_az, Min/Max): the Azerbaijani
 * suffix chosen from `value`. Evaluated by a fixed interpreter of that grammar (no eval).
 */
const EL_AZ = /\$\{value != 0 && value % 1000000 != 0 && value % 1000000000 != 0 && \(([^)]*)\) \? '([^']*)' : '([^']*)'\}/;

function avaliarElAz(modelo, valor) {
  return modelo.replace(EL_AZ, (_, disjuncao, sim, nao) => {
    const v = BigInt(valor);
    const termos = disjuncao.split('||').map((t) => /value % (\d+) == (\d+)/.exec(t.trim())).filter(Boolean);
    const algum = termos.some(([, m, r]) => v % BigInt(m) === BigInt(r));
    return v !== 0n && v % 1000000n !== 0n && v % 1000000000n !== 0n && algum ? sim : nao;
  });
}

/** Default message of a constraint (`NotNull`, `Min`…) in the locale, with its attributes. */
export function mensagemPadrao(locale, restricao, atributos = {}) {
  let modelo = null;
  for (const p of cadeiaDePacotes(locale, PACOTES)) {
    if (MENSAGENS[p][restricao] !== undefined) { modelo = MENSAGENS[p][restricao]; break; }
  }
  if (modelo === null) return `{jakarta.validation.constraints.${restricao}.message}`;
  if (modelo.includes('${')) modelo = avaliarElAz(modelo, atributos.value ?? 0);
  return modelo.replace(/\{(\w+)\}/g, (m, nome) => (atributos[nome] !== undefined ? String(atributos[nome]) : m));
}

/**
 * Collector of violations for one request body. Each check follows the HV validator of the
 * constraint (null is valid for everything but @NotNull/@NotBlank/@NotEmpty).
 */
export class Validacao {
  constructor(locale) { this.locale = locale; this.violacoes = []; }

  adicionar(campo, restricao, atributos, personalizada) {
    this.violacoes.push([campo, personalizada ?? mensagemPadrao(this.locale, restricao, atributos)]);
  }

  /** @NotNull */
  naoNulo(campo, v, msg) { if (v === null || v === undefined) this.adicionar(campo, 'NotNull', {}, msg); }

  /** @NotBlank (CharSequence): null or String.isBlank(). */
  naoEmBranco(campo, v, msg) { if (v == null || javaIsBlank(v)) this.adicionar(campo, 'NotBlank', {}, msg); }

  /** @NotEmpty (Collection): null or empty. */
  naoVazio(campo, v, msg) { if (v == null || v.length === 0) this.adicionar(campo, 'NotEmpty', {}, msg); }

  /** @Positive (Integer, Long, BigDecimal). */
  positivo(campo, v) { if (v != null && sinal(v) <= 0) this.adicionar(campo, 'Positive'); }

  /** @PositiveOrZero. */
  positivoOuZero(campo, v) { if (v != null && sinal(v) < 0) this.adicionar(campo, 'PositiveOrZero'); }

  /** @Min(value) (Integer/Long). */
  minimo(campo, v, valor) { if (v != null && BigInt(v) < BigInt(valor)) this.adicionar(campo, 'Min', { value: valor }); }

  /** @Max(value). */
  maximo(campo, v, valor) { if (v != null && BigInt(v) > BigInt(valor)) this.adicionar(campo, 'Max', { value: valor }); }

  /** @Size(min, max) on a String (UTF-16 length). */
  tamanho(campo, v, min, max) { if (v != null && (v.length < min || v.length > max)) this.adicionar(campo, 'Size', { min, max }); }

  /**
   * @Digits(integer, fraction) on a BigDecimal (DigitsValidatorForNumber of HV 9: no
   * stripTrailingZeros, so 200.000 has 3 fraction digits).
   */
  digitos(campo, v, inteiros, fracao) {
    if (v == null) return;
    const parteInteira = v.precision() - v.scale();
    const parteFracao = v.scale() < 0 ? 0 : v.scale();
    if (parteInteira > inteiros || parteFracao > fracao) this.adicionar(campo, 'Digits', { integer: inteiros, fraction: fracao });
  }

  /** @Pattern(regexp) with a custom message (Matcher.matches()). */
  padrao(campo, v, regex, msg) { if (v != null && !regex.test(v)) this.adicionar(campo, 'Pattern', {}, msg); }

  /** MethodArgumentNotValidException when anything failed. */
  lancar() { if (this.violacoes.length) throw new ErroValidacaoCorpo(this.violacoes); }
}

function sinal(v) {
  if (typeof v === 'number') return Math.sign(v);
  if (typeof v === 'bigint') return v > 0n ? 1 : v < 0n ? -1 : 0;
  return v.signum();
}
