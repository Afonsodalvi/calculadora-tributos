// Port of domain/service/MemoriaCalculoService + token/{TokenizerService, TemplateTokenizerService,
// TokenCacheService, TextToken}: the calculation memory text of CBS, IBS and Imposto Seletivo, from
// the CLTR_MEMORIA_CALCULO template of the classification (placeholders [chave]).
import { Dec } from '../../../core/decimal.js';
import { MODO } from '../../comum/arredondamento.js';
import { javaIsBlank } from '../../comum/java.js';
import { CbsIbsOutput } from './dominios.js';

/**
 * new DecimalFormat(padrao, pt-BR symbols) with setRoundingMode(HALF_EVEN), formatting a BigDecimal
 * exactly: rounded to maxFrac places, trailing zeros removed down to minFrac, '.' grouping every 3
 * digits, ',' decimal separator, '-' prefix. The sign is taken before rounding, so a negative
 * value that rounds to zero keeps it ("-0,00"), like the JDK.
 */
function decimalFormatBR(v, minFrac, maxFrac) {
  const neg = v.signum() < 0;
  let s = v.abs().setScale(maxFrac, MODO);
  while (s.scale() > minFrac && s.unscaledValue() % 10n === 0n) s = new Dec(s.unscaledValue() / 10n, s.scale() - 1);
  const [inteiro, fracao = ''] = s.toPlainString().split('.');
  const agrupado = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + agrupado + (fracao ? ',' + fracao : '');
}

/** MemoriaCalculoService.formatarMoeda: "#,##0.00"; null → formats ZERO. */
export const formatarMoeda = (valor) => decimalFormatBR(valor ?? Dec.ZERO, 2, 2);
/** MemoriaCalculoService.formatarPercentual: "#,##0.00##"; null → formats ZERO. */
export const formatarPercentual = (valor) => decimalFormatBR(valor ?? Dec.ZERO, 2, 4);

/** StringUtils.defaultString(s): null → "". */
const defaultString = (s) => s ?? '';

/** TemplateTokenizerService.tokenize: literal parts { text } and placeholders { key } ("[a [b]" → key "a [b"). */
export function tokenizar(template) {
  const tokens = [];
  let last = 0;
  const len = template.length;
  while (last < len) {
    const open = template.indexOf('[', last);
    if (open < 0) { tokens.push({ text: template.substring(last), key: null }); break; }
    const close = template.indexOf(']', open + 1);
    if (close < 0) { tokens.push({ text: template.substring(last), key: null }); break; }
    if (open > last) tokens.push({ text: template.substring(last, open), key: null });
    tokens.push({ text: null, key: template.substring(open + 1, close) });
    last = close + 1;
  }
  return tokens;
}

/** TokenizerService.substituirPlaceholders(template, values): unknown key → "". */
export function substituirPlaceholders(template, valores) {
  if (!template.includes('[')) return template;
  let r = '';
  for (const t of tokenizar(template)) r += t.key == null ? t.text : (valores.get(t.key) ?? '');
  return r;
}

const SEM_TEXTO = 'Texto de memória de cálculo não encontrado';

/**
 * MemoriaCalculoService over the engine services. `habilitada` = application.memoriacalculo.enabled
 * (true in the offline and testes profiles).
 */
export function criarMemoriaCalculo({ fundamentacaoClassificacaoService, tratamentoService }, { habilitada = true } = {}) {
  /**
   * gerarMemoriaCalculoCbsIbs(tc, tributo, baseCalculoInformada, quantidade, unidade, data) → string | null.
   * `tributo` = CbsIbsOutput before the government purchase redistribution; null for a CST without
   * the IBS/CBS group (the informed base and rate zero are shown).
   */
  function gerarMemoriaCalculoCbsIbs(tc, tributo, baseCalculoInformada, quantidade, unidade, data) {
    if (!habilitada) return null;
    if (tributo == null) tributo = CbsIbsOutput.builder({ baseCalculo: baseCalculoInformada });
    const fundamentacao = fundamentacaoClassificacaoService.buscar(tc.idClassificacaoTributaria, data);
    const tt = tratamentoService.buscar(tc.idTratamentoTributario);

    const mono = tributo.grupoMonofasia?.tributoMonofasico;
    const aliquotaAdRem = mono != null && mono.aliquotaAdRem != null ? formatarPercentual(mono.aliquotaAdRem) : formatarPercentual(null);
    const percentualReducao = tributo.grupoReducao != null && tributo.grupoReducao.pRedAliq != null
      ? formatarPercentual(tributo.grupoReducao.pRedAliq) : formatarPercentual(null);
    const dif = tributo.grupoDiferimento;
    const comDiferimento = dif != null && dif.pDif != null && dif.vDif != null;
    const valores = new Map([
      ['norma', defaultString(fundamentacao.textoCurto)],
      ['tratamento', defaultString(tt.descricao)],
      ['base_calculo', formatarMoeda(tributo.baseCalculo)],
      ['aliquota_ad_valorem', formatarPercentual(tributo.aliquota)],
      ['aliquota_ad_rem', aliquotaAdRem],
      // BigDecimal.toString(): scientific notation when the scale is negative or the exponent < -6
      ['quantidade', quantidade != null ? quantidade.toJavaString() : '0'],
      ['unidade', defaultString(unidade)],
      ['percentual_reducao', percentualReducao],
      ['percentual_diferimento', comDiferimento ? formatarPercentual(dif.pDif) : formatarPercentual(null)],
      ['valor_diferimento', comDiferimento ? formatarMoeda(dif.vDif) : formatarMoeda(null)],
      ['aliquota_desoneracao', formatarPercentual(null)],
      ['montante_desoneracao', formatarMoeda(null)],
    ]);
    const texto = fundamentacao.memoriaCalculo;
    return texto == null || javaIsBlank(texto) ? SEM_TEXTO : substituirPlaceholders(texto, valores);
  }

  /** gerarMemoriaCalculoImpostoSeletivo(tc, isDomain, quantidade, unidade, data): fills isDomain.memoriaCalculo. */
  function gerarMemoriaCalculoImpostoSeletivo(tc, tributo, quantidade, unidade, data) {
    if (!habilitada) return;
    const fundamentacao = fundamentacaoClassificacaoService.buscar(tc.idClassificacaoTributaria, data);
    const tt = tratamentoService.buscar(tc.idTratamentoTributario);
    const valores = new Map([
      ['norma', defaultString(fundamentacao.textoCurto)],
      ['tratamento', defaultString(tt.descricao)],
      ['base_calculo', formatarMoeda(tributo.vBCIS)],
      ['aliquota_ad_valorem', formatarPercentual(tributo.pIS)],
      ['aliquota_ad_rem', formatarPercentual(tributo.pISEspec)],
      ['quantidade', quantidade != null ? quantidade.toJavaString() : ''], // Objects.toString(quantidade, "")
      ['unidade', defaultString(unidade)],
    ]);
    const texto = fundamentacao.memoriaCalculo;
    tributo.memoriaCalculo = texto == null || javaIsBlank(texto) ? SEM_TEXTO : substituirPlaceholders(texto, valores);
  }

  return { gerarMemoriaCalculoCbsIbs, gerarMemoriaCalculoImpostoSeletivo };
}
