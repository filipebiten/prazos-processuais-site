// Motor de cálculo de prazos processuais (dias úteis / corridos, feriados, recesso forense, prazo em dobro).
// Datas sempre como string "YYYY-MM-DD", tratadas em UTC para evitar bugs de fuso horário.

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDate(d);
}

function getWeekday(dateStr) {
  return parseDate(dateStr).getUTCDay(); // 0=domingo, 6=sábado
}

export function isFimDeSemana(dateStr) {
  const wd = getWeekday(dateStr);
  return wd === 0 || wd === 6;
}

// Recesso forense: 20/dez a 20/jan (Lei 5.010/66 art. 62; CPC art. 220), inclusive nas pontas.
export function isRecesso(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return (m === 12 && d >= 20) || (m === 1 && d <= 20);
}

export function isDiaUtil(dateStr, opts = {}) {
  const {
    feriadosNacionais = new Set(),
    feriadosForenses = new Set(),
    considerarRecesso = true,
  } = opts;
  if (isFimDeSemana(dateStr)) return false;
  if (feriadosNacionais.has(dateStr)) return false;
  if (feriadosForenses.has(dateStr)) return false;
  if (considerarRecesso && isRecesso(dateStr)) return false;
  return true;
}

// Primeiro dia útil a partir de `dateStr`. Por padrão busca estritamente após (inclusive=false).
export function proximoDiaUtil(dateStr, opts = {}, { inclusive = false } = {}) {
  let atual = inclusive ? dateStr : addDays(dateStr, 1);
  while (!isDiaUtil(atual, opts)) {
    atual = addDays(atual, 1);
  }
  return atual;
}

// Conta `quantidade` dias úteis a partir de `dataInicio`, que já deve ser um dia útil e conta como dia 1.
export function somarDiasUteis(dataInicio, quantidade, opts = {}) {
  let atual = dataInicio;
  let contados = 1;
  while (contados < quantidade) {
    atual = addDays(atual, 1);
    if (isDiaUtil(atual, opts)) contados++;
  }
  return atual;
}

// Dias corridos: soma `quantidade - 1` dias corridos; se o vencimento cair em dia não útil, prorroga
// para o próximo dia útil (CPC art. 224 §1º combinado com a regra de prorrogação de prazos finais).
export function somarDiasCorridos(dataInicio, quantidade, opts = {}) {
  let atual = addDays(dataInicio, quantidade - 1);
  if (!isDiaUtil(atual, opts)) {
    atual = proximoDiaUtil(atual, opts, { inclusive: true });
  }
  return atual;
}

// Motivo pelo qual um dia não foi contado — usado tanto na espera por intimação/início
// quanto na contagem em si, para a trilha auditável renderizada no dashboard.
function motivoDoDia(dataStr, opts) {
  // Recesso primeiro: é a razão menos óbvia e mais relevante de destacar na auditoria
  // visual — um fim de semana dentro do recesso é mais informativo rotulado como recesso.
  if (opts.considerarRecesso !== false && isRecesso(dataStr)) return 'recesso';
  if (isFimDeSemana(dataStr)) return 'fim_de_semana';
  if (opts.feriadosNacionais?.has(dataStr)) return 'feriado_nacional';
  if (opts.feriadosForenses?.has(dataStr)) return 'feriado_forense';
  return 'nao_util';
}

// Monta a trilha dia-a-dia de disponibilização até vencimento, para auditoria visual:
// cada dia marca seus marcos (disponibilização/intimação/início/vencimento), se foi
// contado como dia do prazo e, se não, por quê (fim de semana, feriado, recesso).
// `dataVencimentoBruto` (só para dias corridos) é o vencimento antes da prorrogação —
// dias entre ele e o vencimento final são só a espera pela prorrogação, não contam.
function construirTrilha({
  dataDisponibilizacao,
  dataIntimacaoConsiderada,
  dataInicio,
  dataVencimento,
  dataVencimentoBruto,
  contagemTipo,
  opts,
}) {
  const trilha = [];
  let atual = dataDisponibilizacao;
  let contador = 0;

  while (atual <= dataVencimento) {
    const marcos = [];
    if (atual === dataDisponibilizacao) marcos.push('disponibilizacao');
    if (atual === dataIntimacaoConsiderada) marcos.push('intimacao_considerada');
    if (atual === dataInicio) marcos.push('inicio_contagem');
    if (atual === dataVencimento) marcos.push('vencimento');

    let contado = false;
    let motivoPulo = null;

    if (atual < dataInicio) {
      // aguardando intimação/início da contagem — não conta, mas mostra por que demorou
      if (!isDiaUtil(atual, opts)) motivoPulo = motivoDoDia(atual, opts);
    } else if (contagemTipo === 'corridos') {
      // Em dias corridos, fins de semana/feriados contam normalmente dentro do N —
      // só os dias após o bruto (esperando a prorrogação) não contam. O próprio dia do
      // vencimento final é onde a prorrogação "pousa" (já é dia útil, por construção),
      // não um dia pulado, então não recebe motivoPulo.
      contado = atual <= dataVencimentoBruto;
      if (!contado && atual < dataVencimento) motivoPulo = motivoDoDia(atual, opts);
    } else if (isDiaUtil(atual, opts)) {
      contado = true;
    } else {
      motivoPulo = motivoDoDia(atual, opts);
    }

    if (contado) contador += 1;
    trilha.push({ data: atual, marcos, contado, numeroContagem: contado ? contador : null, motivoPulo });
    atual = addDays(atual, 1);
  }

  return trilha;
}

/**
 * Calcula o prazo completo a partir da data de disponibilização de uma publicação.
 *
 * Regras aplicadas:
 * - Intimação considerada realizada no 1º dia útil seguinte à disponibilização (Lei 11.419/2006, art. 4º §3º).
 * - Contagem do prazo começa no 1º dia útil seguinte à intimação considerada (CPC art. 231, 224 §3º).
 * - Contagem em dias úteis exclui fins de semana, feriados nacionais/forenses e o recesso forense.
 * - `dobro`: dobra a quantidade de dias (litisconsórcio com procuradores distintos, Fazenda Pública, Defensoria).
 *
 * Além das datas, retorna `trilha`: o dia-a-dia de disponibilização até vencimento,
 * para a timeline auditável do dashboard (cada dia marcado como contado ou pulado e por quê).
 */
export function calcularPrazo({
  dataDisponibilizacao,
  dias,
  contagemTipo = 'uteis',
  dobro = false,
  feriadosNacionais = new Set(),
  feriadosForenses = new Set(),
}) {
  const opts = { feriadosNacionais, feriadosForenses };
  const dataIntimacaoConsiderada = proximoDiaUtil(dataDisponibilizacao, opts);
  const dataInicio = proximoDiaUtil(dataIntimacaoConsiderada, opts);
  const diasEfetivos = dobro ? dias * 2 : dias;
  const dataVencimento = contagemTipo === 'corridos'
    ? somarDiasCorridos(dataInicio, diasEfetivos, opts)
    : somarDiasUteis(dataInicio, diasEfetivos, opts);
  const dataVencimentoBruto = contagemTipo === 'corridos' ? addDays(dataInicio, diasEfetivos - 1) : null;

  const trilha = construirTrilha({
    dataDisponibilizacao,
    dataIntimacaoConsiderada,
    dataInicio,
    dataVencimento,
    dataVencimentoBruto,
    contagemTipo,
    opts,
  });

  return { dataIntimacaoConsiderada, dataInicio, dataVencimento, diasEfetivos, trilha };
}
