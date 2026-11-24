// Activity choices shown to the user, in plain language. Each one says
//  - how the DAS is computed (LC 123 art. 18: Anexo, Fator "r", ISS/ICMS adjustments), and
//  - which official activity code (cAtivSN, NT 2026.005 catalog in the RFB database) the
//    official CBS/IBS calculator receives.
// Goods made by the company itself: Anexo II until 2026; from 1/1/2027 LC 214 art. 517 moves
// industrialized goods to Anexo I (LC 123 art. 18 §4 I), keeping Anexo II only for products still
// under IPI (ZFM, ADCT art. 126 III "a") — which is why the official catalog has cAtivSN 01 = Anexo I
// for "venda de mercadorias industrializadas" and 03/04 = Anexo II for the ZFM.

export const ATIVIDADES = [
  { id: 'servicos-iii', grupo: 'Serviços', nome: 'Serviços do Anexo III (com ISS)', exemplos: 'cursos e treinamentos, escolas, manutenção e reparos, contabilidade, agência de viagens, hotelaria, salão de beleza, fotografia', cAtivSN: '07', das: { anexo: 'III' }, tipo: 'servico' },
  { id: 'servicos-fator-r', grupo: 'Serviços', nome: 'Serviços sujeitos ao Fator "r" (Anexo III ou V)', exemplos: 'consultoria, perícias e laudos, engenharia, desenvolvimento de software, medicina, odontologia, psicologia, publicidade, auditoria, representação comercial', cAtivSN: '09', das: { anexo: 'V', anexoFatorR: 'III' }, tipo: 'servico' },
  { id: 'servicos-iv', grupo: 'Serviços', nome: 'Serviços do Anexo IV (CPP paga à parte)', exemplos: 'vigilância, limpeza e conservação, advocacia, paisagismo', cAtivSN: '14', das: { anexo: 'IV' }, tipo: 'servico' },
  { id: 'construcao-iv', grupo: 'Serviços', nome: 'Construção civil (obras, subitens 7.02 e 7.05) — Anexo IV', exemplos: 'execução de obras, reformas, demolição', cAtivSN: '13', das: { anexo: 'IV' }, tipo: 'servico' },
  { id: 'construcao-iii', grupo: 'Serviços', nome: 'Construção civil (subitens 7.02 e 7.05) — Anexo III', exemplos: 'instalação, reparos e manutenção em obras', cAtivSN: '12', das: { anexo: 'III' }, tipo: 'servico' },
  { id: 'transporte-municipal', grupo: 'Serviços', nome: 'Transporte municipal de passageiros (subitem 16.01)', exemplos: 'ônibus, vans, metrô, barcas dentro do município', cAtivSN: '10', das: { anexo: 'III' }, tipo: 'servico' },
  { id: 'contabil-iss-fixo', grupo: 'Serviços', nome: 'Escritório contábil com ISS fixo pago ao município', exemplos: 'contabilidade autorizada a pagar ISS em valor fixo', cAtivSN: '08', das: { anexo: 'III', semIss: true }, tipo: 'servico' },
  { id: 'sem-iss', grupo: 'Serviços', nome: 'Locação de bens móveis e outras receitas sem ISS', exemplos: 'aluguel de equipamentos, cessão de direitos e bens imateriais', cAtivSN: '11', das: { anexo: 'III', semIss: true }, tipo: 'servico' },
  { id: 'transporte-carga', grupo: 'Serviços', nome: 'Transporte intermunicipal ou interestadual', exemplos: 'frete entre cidades ou estados (com ICMS)', cAtivSN: '05', das: { anexo: 'III', semIss: true, maisIcmsDoI: true }, tipo: 'servico', tpDoc: '57' },
  { id: 'comunicacao', grupo: 'Serviços', nome: 'Serviços de comunicação', exemplos: 'provedores e serviços de comunicação (com ICMS)', cAtivSN: '06', das: { anexo: 'III', semIss: true, maisIcmsDoI: true }, tipo: 'servico', tpDoc: '62' },
  { id: 'comercio', grupo: 'Mercadorias', nome: 'Revenda de mercadorias (comércio) — Anexo I', exemplos: 'loja, distribuidora, e-commerce de produtos de terceiros', cAtivSN: '01', das: { anexo: 'I' }, tipo: 'mercadoria' },
  { id: 'industria', grupo: 'Mercadorias', nome: 'Venda de produtos fabricados pela empresa (indústria) — Anexo II até 2026, Anexo I a partir de 2027', exemplos: 'fábrica, confecção, alimentos produzidos pela empresa', cAtivSN: '01', das: { anexo: 'I', anexoAte2026: 'II' }, tipo: 'mercadoria' },
  { id: 'bens-sem-icms', grupo: 'Mercadorias', nome: 'Outros bens sem ICMS — Anexo I sem ICMS', exemplos: 'demais bens materiais sem incidência de ICMS', cAtivSN: '02', das: { anexo: 'I', semIcms: true }, tipo: 'mercadoria' },
  { id: 'industria-zfm', grupo: 'Mercadorias', nome: 'Indústria com incentivo da Zona Franca de Manaus — Anexo II', exemplos: 'industrialização incentivada na ZFM', cAtivSN: '03', das: { anexo: 'II' }, tipo: 'mercadoria' },
  { id: 'industria-zfm-sem-icms', grupo: 'Mercadorias', nome: 'Bens industrializados na ZFM sem ICMS — Anexo II sem ICMS', exemplos: 'demais bens materiais com industrialização incentivada na ZFM', cAtivSN: '04', das: { anexo: 'II', semIcms: true }, tipo: 'mercadoria' },
  { id: 'nao-tributavel', grupo: 'Outros', nome: 'Operação que não é receita tributável', exemplos: 'remessas, devoluções, bonificações', cAtivSN: '90', das: null, tipo: 'mercadoria' },
];

export const atividadePorId = (id) => ATIVIDADES.find((a) => a.id === id) ?? null;

// LC 116 service list (item.subitem) → suggested activity, with the LC 123 art. 18 basis.
// The Anexo depends on the nature of the activity, not on the service code, so this is a
// suggestion the user confirms (NT SE/CGNFS-e 009: the issuer informs cAtvSN).
const R = 'servicos-fator-r', III = 'servicos-iii', IV = 'servicos-iv';
const SUB = {
  '1': [R, '§5-D IV a VI e §5-I: programas de computador, licenciamento, páginas e consultoria em TI (Fator "r")'],
  '1.03': [III, '§5-F: processamento, armazenamento e hospedagem de dados (Anexo III)'],
  '1.09': [III, '§5-F: disponibilização de conteúdo pela internet (Anexo III)'],
  '2': [R, '§5-I VI: pesquisa e desenvolvimento (Fator "r")'],
  '3': [III, '§5-F: cessão de uso de espaços e direitos (Anexo III)'],
  '4': [R, '§5-B XVI, XIX a XXI e §5-D XII a XIV: saúde (Fator "r")'],
  '4.07': [III, '§5-F: serviços farmacêuticos (Anexo III)'],
  '4.17': [III, '§5-F: casas de repouso e similares (Anexo III)'],
  '5': [R, '§5-I II: medicina veterinária (Fator "r")'],
  '5.08': [III, '§5-F: guarda, embelezamento e alojamento de animais (Anexo III)'],
  '6': [III, '§5-F: cuidados pessoais e estética (Anexo III)'],
  '6.04': [R, '§5-D II e III: academias e escolas de esportes (Fator "r")'],
  '7.01': [R, '§5-I VI: engenharia, arquitetura e afins (Fator "r")'],
  '7.02': ['construcao-iv', '§5-C I: construção de imóveis e obras de engenharia (Anexo IV)'],
  '7.03': [R, '§5-I VI: projetos de engenharia (Fator "r")'],
  '7.04': ['construcao-iv', '§5-C I: demolição em obras (Anexo IV)'],
  '7.05': ['construcao-iv', '§5-C I: reparação e reforma de edificações (Anexo IV)'],
  '7.09': [IV, '§5-C VI: limpeza (Anexo IV)'],
  '7.10': [IV, '§5-C VI: limpeza e conservação de imóveis (Anexo IV)'],
  '7.11': [IV, '§5-C I: paisagismo e decoração (Anexo IV)'],
  '7.17': ['construcao-iv', '§5-C I: obras de engenharia (Anexo IV)'],
  '7.18': [IV, '§5-C VI: limpeza (Anexo IV)'],
  '7.19': [R, '§5-I VI: engenharia (Fator "r")'],
  '7.20': [R, '§5-I VI: topografia, cartografia (Fator "r")'],
  '7.21': [R, '§5-I VI: geologia e pesquisa (Fator "r")'],
  '7': [III, '§5-B IX: instalação, reparos e manutenção (Anexo III)'],
  '8': [III, '§5-B I: ensino, cursos livres e treinamentos (Anexo III). Treinamento personalizado/consultivo pode ser atividade intelectual com Fator "r" (SC Cosit 166/2026)'],
  '9': [III, '§5-B III e §5-F: hotelaria, agência de viagens e turismo (Anexo III)'],
  '10': [R, '§5-I VII: intermediação e agenciamento de negócios (Fator "r")'],
  '10.01': [III, '§5-B XVII: corretagem de seguros (Anexo III)'],
  '11.02': [IV, '§5-C VI: vigilância e segurança (Anexo IV)'],
  '11.03': [IV, '§5-C VI: escolta (Anexo IV)'],
  '11': [III, '§5-F: guarda e armazenamento (Anexo III)'],
  '12': [III, '§5-B XV e §5-F: diversões, lazer e produções artísticas (Anexo III)'],
  '13': [III, '§5-B XV: fotografia, cinema, gravação (Anexo III)'],
  '14': [III, '§5-B IX: conserto e manutenção de bens (Anexo III)'],
  '15': [III, '§5-F: serviços bancários permitidos (Anexo III)'],
  '16.01': ['transporte-municipal', '§5-B XIII: transporte municipal de passageiros (Anexo III)'],
  '16': [III, '§5-F: transporte municipal (Anexo III)'],
  '17.01': [R, '§5-I IX: assessoria e consultoria (Fator "r")'],
  '17.03': [R, '§5-I IX: planejamento e coordenação (Fator "r")'],
  '17.06': [R, '§5-I X: propaganda e publicidade (Fator "r")'],
  '17.09': [R, '§5-I VI e VIII: perícias, laudos e análises técnicas (Fator "r")'],
  '17.12': [R, '§5-I IX: administração (Fator "r")'],
  '17.13': [R, '§5-I VIII: leilão (Fator "r")'],
  '17.14': [IV, '§5-C VII: advocacia (Anexo IV)'],
  '17.15': [R, '§5-I XII: arbitragem (Fator "r")'],
  '17.16': [R, '§5-I IX: auditoria (Fator "r")'],
  '17.17': [R, '§5-I IX: organização e métodos (Fator "r")'],
  '17.18': [R, '§5-I XII: atuária (Fator "r")'],
  '17.19': [III, '§5-B XIV: contabilidade (Anexo III)'],
  '17.20': [R, '§5-I IX: consultoria econômica e financeira (Fator "r")'],
  '17.21': [R, '§5-I XII: estatística (Fator "r")'],
  '17.24': [R, '§5-I XII: palestras e atividade intelectual (Fator "r")'],
  '17.25': [R, '§5-I X: publicidade (Fator "r")'],
  '17': [III, '§5-F: apoio administrativo e comercial (Anexo III)'],
  '18': [R, '§5-I VIII: regulação de sinistros e avaliação (Fator "r")'],
  '19': [III, '§5-B V: loterias (Anexo III)'],
  '20': [III, '§5-F: serviços portuários e aeroportuários (Anexo III)'],
  '21': [III, '§5-F (Anexo III)'],
  '22': [III, '§5-F (Anexo III)'],
  '23': [R, '§5-I VI: design (Fator "r")'],
  '24': [III, '§5-F (Anexo III)'],
  '25': [III, '§5-F: serviços funerários (Anexo III)'],
  '26': [III, '§5-B II e §5-F: courier e correios (Anexo III)'],
  '27': [III, '§5-F: assistência social (Anexo III)'],
  '28': [R, '§5-I VIII: avaliação de bens (Fator "r")'],
  '29': [R, '§5-I XII: biblioteconomia (Fator "r")'],
  '30': [R, '§5-I XII: biologia e química (Fator "r")'],
  '31': [R, '§5-I VI: serviços técnicos (Fator "r")'],
  '32': [R, '§5-I VI: desenho técnico (Fator "r")'],
  '33': [R, '§5-I V: despachantes e desembaraço aduaneiro (Fator "r")'],
  '34': [III, '§5-F: investigação (Anexo III)'],
  '35': [R, '§5-I X: jornalismo e relações públicas (Fator "r")'],
  '36': [R, '§5-I XII: meteorologia (Fator "r")'],
  '37': [R, '§5-I XII: artistas, atletas e modelos (Fator "r")'],
  '38': [R, '§5-I XII: museologia (Fator "r")'],
  '39': [III, '§5-F: ourivesaria e lapidação (Anexo III)'],
  '40': [III, '§5-F: obras de arte sob encomenda (Anexo III)'],
  '99': ['sem-iss', 'NT 009: receitas sem ISS (bens imateriais, locações, condomínios)'],
};

/** Suggest an activity from the NFS-e "código de tributação nacional" (e.g. "080201" or "08.02.01"). */
export function sugerirAtividade(cTribNac) {
  const d = String(cTribNac ?? '').replace(/\D/g, '');
  if (d.length < 4) return null;
  const item = String(Number(d.slice(0, 2)));
  const sub = `${item}.${d.slice(2, 4)}`;
  const hit = SUB[sub] ?? SUB[item];
  if (!hit) return null;
  const curto = hit[1].split(': ')[1]?.split(' (')[0] ?? hit[1];
  return { atividade: hit[0], curto: `código ${sub}: ${curto}`, motivo: `LC 123, art. 18 ${hit[1]}`, subitemLc116: sub };
}

/** CFOP (last 3 digits) of sales of the establishment's own production vs goods bought from others. */
const CFOP_PRODUCAO = new Set(['101', '103', '105', '107', '109', '111', '113', '116', '118', '122', '124', '125', '127', '401', '402', '501', '651', '653', '655', '658', '660', '662', '667']);
const CFOP_TERCEIROS = new Set(['102', '104', '106', '108', '110', '112', '114', '115', '117', '119', '120', '123', '403', '404', '405', '502', '652', '654', '656', '657', '659', '661', '663', '664', '665', '666']);
/** Outgoing CFOPs that are not revenue (remessas, devoluções, transferências, bonificações, retornos). */
const CFOP_NAO_RECEITA = /^[567](15\d|2\d\d|3\d\d|4(08|09|1\d)|55\d|6(02|05)|9\d\d)$/;

/** Suggest an activity for an NF-e item by CFOP. Unknown sale CFOPs return null (user chooses). */
export function sugerirPorCfop(cfop) {
  const c = String(cfop ?? '');
  if (!/^[567]\d{3}$/.test(c)) return null;
  const fim = c.slice(1);
  if (fim === '933') return { atividade: 'servicos-iii', motivo: `CFOP ${c}: prestação de serviço sujeita ao ISS em NF-e conjugada — confira o tipo de serviço` };
  if (CFOP_PRODUCAO.has(fim)) return { atividade: 'industria', motivo: `CFOP ${c}: venda de produção do próprio estabelecimento` };
  if (CFOP_TERCEIROS.has(fim)) return { atividade: 'comercio', motivo: `CFOP ${c}: venda de mercadoria adquirida de terceiros (Anexo I)` };
  if (CFOP_NAO_RECEITA.test(c) && fim !== '933') return { atividade: 'nao-tributavel', motivo: `CFOP ${c}: não é venda (remessa, devolução, transferência ou outra saída)` };
  return null;
}

/** CFOP x401..x405 (ICMS by substitution): for the substituted seller (x404/x405) the ICMS share leaves the DAS (LC 123 art. 18 §4-A I). */
export const icmsSubstituido = (cfop) => /^[56]40[45]$/.test(String(cfop ?? ''));
/** CFOP 7xxx and x501/x502 (export, direct or with specific export purpose). */
export const cfopExportacao = (cfop) => /^7\d{3}$|^[56]50[12]$/.test(String(cfop ?? ''));
