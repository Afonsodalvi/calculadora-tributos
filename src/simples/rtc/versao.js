// Port of api/versao of calculadora-rtc-simples-nacional 1.0.2 (profile offline):
//   VersaoAplicacaoService.getHeaders → X-CALC-APP-VERSION / X-CALC-DB-VERSION,
//   VersaoService.getVersao → GET /api/versao (VersaoDomain, @JsonInclude(NON_NULL)).
// GET /api/versao/status (VersaoOfflineController) is NOT served by this module: the same path
// belongs to the regime-regular API with another body (see the Simples module notes).

/** info.app.version of the official jar. */
export const VERSAO_APLICACAO = '1.0.2';
/** application.db.filename and versao.ambiente of application-offline.yml. */
const ARQUIVO_BASE = 'calculadora-pro.db';
const AMBIENTE = 'offline';

/** @param {{ versao(): { v, d, s } | null }} base  VersaoBaseDadosRepository.findTopByOrderByIdDesc */
export function criarVersaoService(base) {
  function ultimaVersao() {
    const r = base.versao();
    if (!r) throw new Error('Nenhuma versão de base de dados encontrada');
    // VRBD_DATA is read as LocalDate (driver date format yyyy-MM-dd): the date part of the text
    return { numeroVersao: r.v, descricao: r.s, data: String(r.d).slice(0, 10) };
  }
  return {
    /** VersaoAplicacaoService.getHeaders */
    headers() {
      return { 'x-calc-app-version': VERSAO_APLICACAO, 'x-calc-db-version': ultimaVersao().numeroVersao ?? '' };
    },
    /** VersaoService.getVersao (NON_NULL: null fields are omitted) */
    getVersao() {
      const u = ultimaVersao();
      const o = { versaoApp: VERSAO_APLICACAO, versaoDb: u.numeroVersao, descricaoVersaoDb: u.descricao, dataVersaoDb: u.data, arquivoDb: ARQUIVO_BASE, ambiente: AMBIENTE };
      return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
    },
  };
}
