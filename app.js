import { isDiaUtil, addDays } from './lib/prazosEngine.mjs';

const LS_KEYS = {
  owner: 'pp_owner',
  repo: 'pp_repo',
  branch: 'pp_branch',
  token: 'pp_token',
};

const WORKFLOW_MARCAR_CUMPRIDO = 'marcar-cumprido.yml';
const WHATSAPP_NUMERO = '5567992113995';

let estado = {
  prazos: [],
  publicacoes: [],
  processos: [],
  status: null,
  feriadosNacionais: new Set(),
  feriadosForenses: new Set(),
  teorExpandido: new Set(),
  trilhaExpandida: new Set(),
  visualizacao: 'cards', // 'cards' | 'calendario'
  mesCalendario: (() => { const h = new Date(); return { ano: h.getFullYear(), mes: h.getMonth() }; })(),
  diaCalendarioSelecionado: null,
};

// Limite de "sem atualização há tempo demais" — o cron roda 1x/dia; 36h dá folga
// pra fusos/atraso sem disparar alarme falso, mas ainda pega uma falha real rápido.
const LIMITE_HORAS_SEM_ATUALIZACAO = 36;

function getConfig() {
  return {
    owner: localStorage.getItem(LS_KEYS.owner) || '',
    repo: localStorage.getItem(LS_KEYS.repo) || '',
    branch: localStorage.getItem(LS_KEYS.branch) || 'main',
    token: localStorage.getItem(LS_KEYS.token) || '',
  };
}

function setConfig({ owner, repo, branch, token }) {
  localStorage.setItem(LS_KEYS.owner, owner);
  localStorage.setItem(LS_KEYS.repo, repo);
  localStorage.setItem(LS_KEYS.branch, branch || 'main');
  localStorage.setItem(LS_KEYS.token, token);
}

function configCompleta() {
  const c = getConfig();
  return Boolean(c.owner && c.repo && c.token);
}

// Decodifica base64 preservando UTF-8 (atob puro corrompe acentos).
function decodeBase64Utf8(base64) {
  const binario = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function githubApi(path, options = {}) {
  const { owner, repo, token } = getConfig();
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  return resp;
}

async function fetchJsonDoRepo(caminhoArquivo) {
  const { branch } = getConfig();
  const resp = await githubApi(`/contents/${caminhoArquivo}?ref=${encodeURIComponent(branch)}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });

  if (!resp.ok) {
    if (resp.status === 404) throw new Error(`Arquivo ${caminhoArquivo} não encontrado no repositório.`);
    if (resp.status === 401 || resp.status === 403) throw new Error('Token sem permissão ou inválido (verifique escopo "Contents: Read").');
    throw new Error(`GitHub API respondeu ${resp.status} ao buscar ${caminhoArquivo}.`);
  }

  // O header Accept pede o conteúdo raw, mas algumas variações da API podem devolver
  // o envelope JSON (com content em base64) mesmo assim — distinguimos pelo formato,
  // já que ambos os casos são JSON válido (try/catch não diferenciaria os dois).
  const texto = await resp.text();
  let corpo;
  try {
    corpo = JSON.parse(texto);
  } catch {
    throw new Error(`Resposta de ${caminhoArquivo} não é JSON válido.`);
  }

  const ehEnvelopeDaContentsApi = corpo && !Array.isArray(corpo) &&
    typeof corpo.content === 'string' && corpo.encoding === 'base64' && typeof corpo.sha === 'string';

  return ehEnvelopeDaContentsApi ? JSON.parse(decodeBase64Utf8(corpo.content)) : corpo;
}

async function dispararMarcarCumprido(prazoId) {
  const { branch } = getConfig();
  const resp = await githubApi(`/actions/workflows/${WORKFLOW_MARCAR_CUMPRIDO}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ ref: branch, inputs: { prazo_id: prazoId } }),
  });
  if (resp.status !== 204) {
    const texto = await resp.text().catch(() => '');
    throw new Error(`Falha ao disparar workflow (${resp.status}). ${texto}`);
  }
}

// --- Urgência / formatação ---

function diasAteHoje(dataStr) {
  const hoje = new Date();
  const hojeUtc = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const [y, m, d] = dataStr.split('-').map(Number);
  const alvo = Date.UTC(y, m - 1, d);
  return Math.round((alvo - hojeUtc) / 86_400_000);
}

// Urgência é medida em dias ÚTEIS, não corridos — é o que conta num prazo processual
// (mesmo critério do item "dias úteis restantes" da Fase 1). diasAteHoje só entra pra
// saber se a data-calendário já passou ("vencido"), o que é binário e não tem "dia útil".
function badgeUrgencia(prazo) {
  if (prazo.status === 'cumprido') return { classe: 'badge-good', texto: '✓ Cumprido' };
  if (prazo.status === 'prorrogado') return { classe: 'badge-neutro', texto: '↻ Prorrogado' };
  if (prazo.status === 'perdido') return { classe: 'badge-critical', texto: '⛔ Perdido' };

  if (!prazo.data_vencimento) return { classe: 'badge-neutro', texto: '— Aguardando cálculo' };

  const diasCorridos = diasAteHoje(prazo.data_vencimento);
  if (diasCorridos < 0) return { classe: 'badge-critical', texto: `⛔ Vencido há ${Math.abs(diasCorridos)}d` };

  const dias = diasUteisRestantes(prazo.data_vencimento) ?? 0;
  if (dias <= 2) return { classe: 'badge-critical', texto: `⚠ Vence em ${dias} dia(s) útil(eis)` };
  if (dias <= 5) return { classe: 'badge-warning', texto: `⏳ Vence em ${dias} dia(s) útil(eis)` };
  return { classe: 'badge-good', texto: `✓ Vence em ${dias} dia(s) útil(eis)` };
}

function formatarData(dataStr) {
  if (!dataStr) return '—';
  const [y, m, d] = dataStr.split('-');
  return `${d}/${m}/${y}`;
}

function hojeStr() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
}

// Conta dias úteis de hoje até a data de vencimento (inclusive), usando o mesmo motor
// puro do backend (scripts/lib/prazosEngine.mjs, copiado para lib/) — nunca reimplementa
// a regra de dia útil no frontend, pra não haver risco de divergência entre os dois lados.
function diasUteisRestantes(dataVencimento) {
  if (!dataVencimento) return null;
  const opts = { feriadosNacionais: estado.feriadosNacionais, feriadosForenses: estado.feriadosForenses };
  let atual = hojeStr();
  if (atual > dataVencimento) return null; // já vencido
  let contados = 0;
  while (atual <= dataVencimento) {
    if (isDiaUtil(atual, opts)) contados += 1;
    atual = addDays(atual, 1);
  }
  return contados;
}

// --- Trilha auditável (dia a dia do cálculo, resumida em faixas para leitura) ---

const MOTIVO_LABEL = {
  fim_de_semana: 'fim de semana',
  feriado_nacional: 'feriado nacional',
  feriado_forense: 'feriado forense/local',
  recesso: 'recesso forense',
  nao_util: 'dia não útil',
};

const MARCO_LABEL = {
  disponibilizacao: 'Disponibilização',
  intimacao_considerada: 'Intimação considerada',
  inicio_contagem: 'Início da contagem',
  vencimento: 'Vencimento',
};

// Agrupa dias consecutivos com o mesmo status (contado ou pulado pelo mesmo motivo) em
// faixas, pra não renderizar uma linha por dia (um recesso de 33 dias viraria 33 linhas).
// Dias com marco (disponibilização/intimação/início/vencimento) nunca se agrupam — ficam
// sempre em linha própria, são os pontos de referência que o advogado precisa achar rápido.
function resumirTrilha(trilha) {
  const grupos = [];
  for (const dia of trilha) {
    const temMarco = dia.marcos.length > 0;
    const chave = dia.contado ? 'contado' : (dia.motivoPulo || 'sem_motivo');
    const anterior = grupos[grupos.length - 1];

    if (!temMarco && anterior && !anterior.temMarco && anterior.chave === chave) {
      anterior.fim = dia.data;
      anterior.qtd += 1;
      if (dia.numeroContagem) anterior.numeroFim = dia.numeroContagem;
    } else {
      grupos.push({
        chave,
        marcos: dia.marcos,
        temMarco,
        inicio: dia.data,
        fim: dia.data,
        qtd: 1,
        numeroInicio: dia.numeroContagem,
        numeroFim: dia.numeroContagem,
      });
    }
  }
  return grupos;
}

function descreverGrupo(grupo) {
  if (grupo.temMarco) {
    const marcos = grupo.marcos.map((m) => MARCO_LABEL[m] || m).join(' + ');
    if (grupo.chave === 'contado') {
      return `${marcos} — dia ${grupo.numeroInicio} da contagem`;
    }
    return grupo.chave === 'sem_motivo' ? marcos : `${marcos} (${MOTIVO_LABEL[grupo.chave] || grupo.chave})`;
  }
  if (grupo.chave === 'contado') {
    return grupo.qtd === 1
      ? `dia ${grupo.numeroInicio} da contagem`
      : `dias ${grupo.numeroInicio}–${grupo.numeroFim} da contagem`;
  }
  return `${MOTIVO_LABEL[grupo.chave] || grupo.chave} — não contado`;
}

function renderTrilha(trilha) {
  const grupos = resumirTrilha(trilha);
  const linhas = grupos.map((g) => {
    const intervalo = g.inicio === g.fim ? formatarData(g.inicio) : `${formatarData(g.inicio)}–${formatarData(g.fim)}`;
    const classe = g.temMarco ? 'marco' : (g.chave === 'contado' ? 'contado' : 'pulado');
    return `
      <div class="trilha-linha ${classe}">
        <span class="trilha-data">${intervalo}</span>
        <span class="trilha-desc">${escapeHtml(descreverGrupo(g))}</span>
      </div>
    `;
  }).join('');
  return `<div class="trilha">${linhas}</div>`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Relacionamentos entre dados ---

function publicacaoDoPrazo(prazo) {
  return estado.publicacoes.find((p) => p.id === prazo.publicacao_id) || {};
}

function processoDoPrazo(prazo) {
  const pub = publicacaoDoPrazo(prazo);
  return estado.processos.find((p) => p.id === (prazo.processo_id || pub.processo_id)) || {};
}

// --- WhatsApp ---

function montarMensagemWhatsapp(prazo) {
  const pub = publicacaoDoPrazo(prazo);
  const proc = processoDoPrazo(prazo);
  const partes = (proc.partes || [])
    .map((p) => `• ${p.nome} (${p.papel})`)
    .join('\n');

  const linhas = [
    `*Prazo: ${prazo.tipo_prazo || '—'}*`,
    `Vencimento: ${formatarData(prazo.data_vencimento)}`,
    '',
    `Processo: ${proc.numero_processo || pub.numero_processo || '—'}`,
    `${proc.tribunal || pub.tribunal || ''}${proc.orgao ? ' — ' + proc.orgao : ''}`,
    '',
    'Do que se trata:',
    proc.resumo || '(sem resumo disponível)',
  ];

  if (partes) {
    linhas.push('', 'Partes:', partes);
  }

  if (pub.teor_resumido) {
    linhas.push('', `Última movimentação (${formatarData(pub.data_disponibilizacao)}):`, pub.teor_resumido.slice(0, 600));
  }

  return linhas.join('\n');
}

function abrirWhatsapp(prazo) {
  const mensagem = montarMensagemWhatsapp(prazo);
  const url = `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(mensagem)}`;
  window.open(url, '_blank', 'noopener');
}

// --- Exportar .ics ---

function escaparIcs(texto) {
  return String(texto ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function timestampIcsAgora() {
  return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function gerarEventoIcs(prazo) {
  const proc = processoDoPrazo(prazo);
  const pub = publicacaoDoPrazo(prazo);
  const resumoLinha = `Prazo: ${prazo.tipo_prazo || 'Prazo'} — ${proc.numero_processo || pub.numero_processo || 'processo não identificado'}`;
  const descricao = [
    proc.resumo,
    prazo.responsavel ? `Responsável: ${prazo.responsavel}` : '',
    prazo.observacao ? `Atenção: ${prazo.observacao}` : '',
  ].filter(Boolean).join('\n');

  return [
    'BEGIN:VEVENT',
    `UID:${prazo.id}@prazos-processuais`,
    `DTSTAMP:${timestampIcsAgora()}`,
    `DTSTART;VALUE=DATE:${prazo.data_vencimento.replaceAll('-', '')}`,
    `DTEND;VALUE=DATE:${addDays(prazo.data_vencimento, 1).replaceAll('-', '')}`,
    `SUMMARY:${escaparIcs(resumoLinha)}`,
    `DESCRIPTION:${escaparIcs(descricao)}`,
    'END:VEVENT',
  ].join('\r\n');
}

function gerarIcs(prazos) {
  const eventos = prazos.filter((p) => p.data_vencimento).map(gerarEventoIcs);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Prazos Processuais//PT-BR',
    'CALSCALE:GREGORIAN',
    ...eventos,
    'END:VCALENDAR',
  ].join('\r\n');
}

function baixarArquivo(nomeArquivo, conteudo, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportarIcsUnico(prazoId) {
  const prazo = estado.prazos.find((p) => p.id === prazoId);
  if (!prazo || !prazo.data_vencimento) return;
  baixarArquivo(`prazo-${prazo.tipo_prazo || 'sem-tipo'}.ics`, gerarIcs([prazo]), 'text/calendar');
}

function exportarIcsFiltrados() {
  const lista = prazosFiltrados().filter((p) => p.data_vencimento);
  if (lista.length === 0) { mostrarToast('Nenhum prazo com vencimento calculado nos filtros atuais.'); return; }
  baixarArquivo('prazos-processuais.ics', gerarIcs(lista), 'text/calendar');
}

// --- Render ---

function renderSkeleton() {
  const cardFalso = `
    <div class="card skeleton">
      <div class="sk-linha sk-w30" style="height:20px"></div>
      <div class="sk-linha sk-w60" style="height:18px; margin-top:4px"></div>
      <div class="sk-linha sk-w90"></div>
      <div class="sk-linha sk-w70"></div>
      <div class="sk-linha sk-w50"></div>
    </div>
  `;
  document.getElementById('lista-container').innerHTML = `<div class="cards-grid">${cardFalso.repeat(4)}</div>`;
  document.getElementById('stats').innerHTML = ['', '', ''].map(() => `
    <div class="stat-tile"><div class="sk-linha sk-w30" style="height:26px"></div><div class="sk-linha sk-w60" style="margin-top:6px"></div></div>
  `).join('');
}

function popularFiltroTribunal() {
  const select = document.getElementById('filtro-tribunal');
  const atual = select.value;
  const tribunais = new Set(
    estado.prazos.map((p) => publicacaoDoPrazo(p).tribunal).filter(Boolean),
  );
  select.innerHTML = '<option value="">Todos os tribunais</option>' +
    [...tribunais].sort().map((t) => `<option value="${t}">${t}</option>`).join('');
  select.value = atual;
}

function renderBannerFrescor() {
  const el = document.getElementById('banner-frescor');
  const status = estado.status;

  if (!status || !status.ultima_execucao) {
    el.hidden = false;
    el.className = 'banner-alerta critico';
    el.innerHTML = '⚠ Não foi possível determinar quando os dados foram atualizados pela última vez (data/status_execucao.json ausente ou ilegível).';
    return;
  }

  const horasDesde = (Date.now() - new Date(status.ultima_execucao).getTime()) / 3_600_000;
  const horasArredondado = Math.round(horasDesde);

  if (status.sucesso === false) {
    el.hidden = false;
    el.className = 'banner-alerta critico';
    el.innerHTML = `⚠ A última atualização automática FALHOU há ${horasArredondado}h (${escapeHtml(status.erro || 'ver logs do GitHub Actions')}). Os dados podem estar desatualizados.`;
    return;
  }

  if (horasDesde > LIMITE_HORAS_SEM_ATUALIZACAO) {
    el.hidden = false;
    el.className = 'banner-alerta critico';
    el.innerHTML = `⚠ Sem atualização confirmada há ${horasArredondado}h — pode haver publicações ainda não capturadas.`;
    return;
  }

  el.hidden = false;
  el.className = 'banner-alerta ok';
  el.innerHTML = `✓ Dados atualizados há ${horasArredondado}h`;
}

function renderSecaoRevisao() {
  const el = document.getElementById('secao-revisao');
  const pendentesDeRevisao = estado.prazos.filter((p) => p.status === 'pendente' && p.revisado_por_humano !== true);

  if (pendentesDeRevisao.length === 0) {
    el.innerHTML = '';
    return;
  }

  const ordenados = [...pendentesDeRevisao].sort((a, b) => (a.data_vencimento || '9999').localeCompare(b.data_vencimento || '9999'));
  el.innerHTML = `
    <div class="secao-revisao">
      <div class="secao-revisao-titulo">⚠ Precisam da sua confirmação (${ordenados.length})</div>
      <div class="cards-grid">${ordenados.map(renderCard).join('')}</div>
    </div>
  `;
}

// Hero enxuto: só os 3 números que respondem "o que preciso olhar agora" — hoje, esta
// semana, e vencidos ainda não confirmados por um humano (os mais arriscados de ignorar).
function renderStats() {
  const pendentes = estado.prazos.filter((p) => p.status === 'pendente' && p.data_vencimento);
  const hoje = hojeStr();
  const fimSemana = addDays(hoje, 7);

  const vencemHoje = pendentes.filter((p) => p.data_vencimento === hoje);
  const vencemSemana = pendentes.filter((p) => p.data_vencimento > hoje && p.data_vencimento <= fimSemana);
  const vencidosNaoConfirmados = pendentes.filter((p) => p.data_vencimento < hoje && p.revisado_por_humano !== true);

  const tiles = [
    { valor: vencemHoje.length, rotulo: 'Vencem hoje', destaque: vencemHoje.length > 0 },
    { valor: vencemSemana.length, rotulo: 'Vencem esta semana' },
    { valor: vencidosNaoConfirmados.length, rotulo: 'Vencidos não confirmados', destaque: vencidosNaoConfirmados.length > 0 },
  ];

  document.getElementById('stats').innerHTML = tiles.map((t) => `
    <div class="stat-tile ${t.destaque ? 'stat-destaque' : ''}">
      <div class="valor">${t.valor}</div>
      <div class="rotulo">${t.rotulo}</div>
    </div>
  `).join('');
}

function prazosFiltrados() {
  const status = document.getElementById('filtro-status').value;
  const tribunal = document.getElementById('filtro-tribunal').value;
  const responsavel = document.getElementById('filtro-responsavel').value.trim().toLowerCase();
  const busca = document.getElementById('filtro-busca').value.trim().toLowerCase();

  return estado.prazos.filter((p) => {
    if (status !== 'todos' && p.status !== status) return false;
    const pub = publicacaoDoPrazo(p);
    const proc = processoDoPrazo(p);
    if (tribunal && pub.tribunal !== tribunal) return false;
    if (responsavel && !(p.responsavel || '').toLowerCase().includes(responsavel)) return false;
    if (busca && !(proc.numero_processo || pub.numero_processo || '').toLowerCase().includes(busca)) return false;
    return true;
  }).sort((a, b) => (a.data_vencimento || '9999').localeCompare(b.data_vencimento || '9999'));
}

function renderCard(prazo) {
  const pub = publicacaoDoPrazo(prazo);
  const proc = processoDoPrazo(prazo);
  const badge = badgeUrgencia(prazo);
  const podeMarcarCumprido = prazo.status === 'pendente';
  const expandido = estado.teorExpandido.has(prazo.id);
  const teor = pub.teor_resumido || '';
  const teorCurto = teor.length > 220 && !expandido ? teor.slice(0, 220) + '…' : teor;
  const trilhaAberta = estado.trilhaExpandida.has(prazo.id);

  const partesHtml = (proc.partes || []).slice(0, 6).map((p) => `
    <li><span class="parte-papel">${escapeHtml(p.papel)}:</span> ${escapeHtml(p.nome)}</li>
  `).join('');

  return `
    <article class="card" data-id="${prazo.id}">
      <div class="card-topo">
        <span class="badge ${badge.classe}">${badge.texto}</span>
        <span class="card-vencimento">${formatarData(prazo.data_vencimento)}</span>
      </div>

      <h3 class="card-titulo">${escapeHtml(prazo.tipo_prazo || 'Prazo')}</h3>
      ${prazo.revisado_por_humano !== true ? '<span class="selo-nao-revisado">⚠ sugerido, aguardando revisão</span>' : ''}
      <div class="card-processo">
        ${escapeHtml(proc.numero_processo || pub.numero_processo || '—')}
        <span class="card-tribunal">${escapeHtml(proc.tribunal || pub.tribunal || '')}${proc.orgao ? ' · ' + escapeHtml(proc.orgao) : ''}</span>
      </div>

      ${proc.resumo ? `<p class="card-resumo">${escapeHtml(proc.resumo)}</p>` : ''}

      ${partesHtml ? `<ul class="card-partes">${partesHtml}</ul>` : ''}

      ${teor ? `
        <div class="card-teor">
          <div class="card-teor-label">Última movimentação ${pub.data_disponibilizacao ? '(' + formatarData(pub.data_disponibilizacao) + ')' : ''}</div>
          <p class="card-teor-texto">${escapeHtml(teorCurto)}</p>
          ${teor.length > 220 ? `<button class="link-ver-mais" data-id="${prazo.id}">${expandido ? 'ver menos' : 'ver mais'}</button>` : ''}
        </div>
      ` : ''}

      ${prazo.observacao ? `<p class="card-observacao">⚠ ${escapeHtml(prazo.observacao)}</p>` : ''}

      ${prazo.trilha_calculo ? `
        <button class="link-ver-calculo" data-id="${prazo.id}">${trilhaAberta ? '▾ ocultar como foi calculado' : '▸ conferir como esse prazo foi calculado'}</button>
        ${trilhaAberta ? renderTrilha(prazo.trilha_calculo) : ''}
      ` : ''}

      <div class="card-rodape">
        <span class="card-responsavel">${escapeHtml(prazo.responsavel || '—')}</span>
        <div class="card-acoes">
          ${prazo.data_vencimento ? `<button class="btn-ics" data-id="${prazo.id}" title="Exportar para calendário (.ics)">📅 .ics</button>` : ''}
          <button class="btn-whatsapp" data-id="${prazo.id}" title="Enviar resumo pelo WhatsApp">📱 WhatsApp</button>
          ${podeMarcarCumprido
            ? `<button class="btn-marcar-cumprido primary" data-id="${prazo.id}">Marcar cumprido</button>`
            : ''}
        </div>
      </div>
    </article>
  `;
}

const URGENCIA_ORDEM = ['badge-critical', 'badge-warning', 'badge-good', 'badge-neutro'];
const URGENCIA_ROTULO = {
  'badge-critical': 'Crítico (vencido ou ≤2 dias úteis)',
  'badge-warning': 'Atenção (≤5 dias úteis)',
  'badge-good': 'Tranquilo',
  'badge-neutro': 'Outros status',
};

// Agrupa a lista já filtrada/ordenada por responsável, dia de vencimento ou faixa de
// urgência — puramente de exibição, não reordena os critérios de filtro/prazo em si.
function agruparPrazos(lista, criterio) {
  if (!criterio || criterio === 'nenhum') return [{ titulo: null, itens: lista }];

  const grupos = new Map();
  for (const p of lista) {
    let chave;
    if (criterio === 'responsavel') chave = p.responsavel || 'Sem responsável';
    else if (criterio === 'dia') chave = p.data_vencimento || '9999-99-99';
    else chave = badgeUrgencia(p).classe;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(p);
  }

  let chaves = [...grupos.keys()];
  if (criterio === 'responsavel') chaves.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (criterio === 'dia') chaves.sort();
  if (criterio === 'urgencia') chaves.sort((a, b) => URGENCIA_ORDEM.indexOf(a) - URGENCIA_ORDEM.indexOf(b));

  return chaves.map((chave) => {
    let titulo = chave;
    if (criterio === 'dia') titulo = chave === '9999-99-99' ? 'Sem data calculada' : formatarData(chave);
    if (criterio === 'urgencia') titulo = URGENCIA_ROTULO[chave] || chave;
    return { titulo, itens: grupos.get(chave) };
  });
}

function renderLista() {
  const lista = prazosFiltrados();
  const container = document.getElementById('lista-container');

  if (estado.visualizacao === 'calendario') return renderCalendario();

  if (lista.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhum prazo encontrado com os filtros atuais.</div>';
    return;
  }

  const criterio = document.getElementById('agrupar-por')?.value || 'nenhum';
  const grupos = agruparPrazos(lista, criterio);
  container.innerHTML = grupos.map((g) => `
    ${g.titulo ? `<div class="grupo-titulo">${escapeHtml(g.titulo)} <span class="grupo-contagem">${g.itens.length}</span></div>` : ''}
    <div class="cards-grid">${g.itens.map(renderCard).join('')}</div>
  `).join('');
}

function renderTudo() {
  renderBannerFrescor();
  popularFiltroTribunal();
  renderStats();
  renderSecaoRevisao();
  renderLista();
}

// --- Visão de calendário ---

const NOMES_DIA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function mudarMes(delta) {
  let { ano, mes } = estado.mesCalendario;
  mes += delta;
  if (mes < 0) { mes = 11; ano -= 1; }
  if (mes > 11) { mes = 0; ano += 1; }
  estado.mesCalendario = { ano, mes };
  estado.diaCalendarioSelecionado = null;
  renderLista();
}

function renderCalendario() {
  const container = document.getElementById('lista-container');
  const { ano, mes } = estado.mesCalendario;

  const primeiroDiaMes = new Date(Date.UTC(ano, mes, 1));
  const diaSemanaInicio = primeiroDiaMes.getUTCDay();
  const totalDias = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();

  const prazosPorDia = new Map();
  for (const p of prazosFiltrados()) {
    if (!p.data_vencimento) continue;
    if (!prazosPorDia.has(p.data_vencimento)) prazosPorDia.set(p.data_vencimento, []);
    prazosPorDia.get(p.data_vencimento).push(p);
  }

  const celulas = [];
  for (let i = 0; i < diaSemanaInicio; i++) celulas.push('<div class="cal-dia cal-vazio"></div>');
  for (let dia = 1; dia <= totalDias; dia++) {
    const dataStr = `${ano}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    const prazosDoDia = prazosPorDia.get(dataStr) || [];
    const chips = prazosDoDia.slice(0, 3).map((p) => `<div class="cal-chip ${badgeUrgencia(p).classe}">${escapeHtml((p.tipo_prazo || 'Prazo').slice(0, 16))}</div>`).join('');
    const extra = prazosDoDia.length > 3 ? `<div class="cal-mais">+${prazosDoDia.length - 3}</div>` : '';
    const classes = ['cal-dia'];
    if (dataStr === hojeStr()) classes.push('cal-hoje');
    if (prazosDoDia.length) classes.push('cal-tem-prazo');
    if (dataStr === estado.diaCalendarioSelecionado) classes.push('cal-selecionado');
    celulas.push(`
      <div class="${classes.join(' ')}" data-data="${dataStr}">
        <div class="cal-numero">${dia}</div>
        ${chips}${extra}
      </div>
    `);
  }

  const nomeMes = primeiroDiaMes.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const prazosDoDiaSelecionado = estado.diaCalendarioSelecionado ? (prazosPorDia.get(estado.diaCalendarioSelecionado) || []) : [];

  container.innerHTML = `
    <div class="cal-header">
      <button id="cal-anterior" class="icon-btn">‹</button>
      <div class="cal-titulo">${escapeHtml(nomeMes)}</div>
      <button id="cal-seguinte" class="icon-btn">›</button>
    </div>
    <div class="cal-grid">
      ${NOMES_DIA_SEMANA.map((n) => `<div class="cal-cabecalho">${n}</div>`).join('')}
      ${celulas.join('')}
    </div>
    ${estado.diaCalendarioSelecionado ? `
      <div class="cal-detalhe">
        <div class="grupo-titulo">${formatarData(estado.diaCalendarioSelecionado)} <span class="grupo-contagem">${prazosDoDiaSelecionado.length}</span></div>
        ${prazosDoDiaSelecionado.length
          ? `<div class="cards-grid">${prazosDoDiaSelecionado.map(renderCard).join('')}</div>`
          : '<div class="estado-vazio">Nenhum prazo filtrado vence nesse dia.</div>'}
      </div>
    ` : ''}
  `;
}

// --- Relatório imprimível da semana ---

function prazosDaSemana() {
  const hoje = hojeStr();
  const limite = addDays(hoje, 7);
  return estado.prazos
    .filter((p) => p.status === 'pendente' && p.data_vencimento && p.data_vencimento <= limite)
    .sort((a, b) => a.data_vencimento.localeCompare(b.data_vencimento));
}

function imprimirSemana() {
  const lista = prazosDaSemana();
  const linhas = lista.map((p) => {
    const proc = processoDoPrazo(p);
    const pub = publicacaoDoPrazo(p);
    const vencido = diasAteHoje(p.data_vencimento) < 0;
    return `
      <tr class="${vencido ? 'linha-vencida' : ''}">
        <td>${formatarData(p.data_vencimento)}</td>
        <td>${escapeHtml(p.tipo_prazo || '—')}</td>
        <td>${escapeHtml(proc.numero_processo || pub.numero_processo || '—')}</td>
        <td>${escapeHtml(proc.tribunal || pub.tribunal || '—')}</td>
        <td>${escapeHtml(p.responsavel || '—')}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('relatorio-impressao').innerHTML = `
    <h1>Relatório de prazos — próximos 7 dias</h1>
    <p>Gerado em ${new Date().toLocaleString('pt-BR')} · ${lista.length} prazo(s)</p>
    <table>
      <thead><tr><th>Vencimento</th><th>Tipo</th><th>Processo</th><th>Tribunal</th><th>Responsável</th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="5">Nenhum prazo pendente nos próximos 7 dias.</td></tr>'}</tbody>
    </table>
  `;
  window.print();
}

// --- Busca rápida (Cmd+K) ---

function abrirPalette() {
  document.getElementById('overlay-palette').hidden = false;
  const input = document.getElementById('palette-input');
  input.value = '';
  input.focus();
  renderPaletteResultados('');
}

function fecharPalette() {
  document.getElementById('overlay-palette').hidden = true;
}

function renderPaletteResultados(termo) {
  const t = termo.trim().toLowerCase();
  const el = document.getElementById('palette-resultados');

  if (!t) { el.innerHTML = '<div class="estado-vazio">Digite pra buscar por processo, parte ou responsável.</div>'; return; }

  const resultados = estado.prazos.filter((p) => {
    const proc = processoDoPrazo(p);
    const pub = publicacaoDoPrazo(p);
    const alvo = [
      proc.numero_processo, pub.numero_processo, p.responsavel, p.tipo_prazo, proc.resumo,
      ...(proc.partes || []).map((x) => x.nome),
    ].filter(Boolean).join(' ').toLowerCase();
    return alvo.includes(t);
  }).slice(0, 15);

  if (resultados.length === 0) { el.innerHTML = '<div class="estado-vazio">Nada encontrado.</div>'; return; }

  el.innerHTML = resultados.map((p) => {
    const proc = processoDoPrazo(p);
    const pub = publicacaoDoPrazo(p);
    return `
      <button class="palette-item" data-id="${p.id}">
        <strong>${escapeHtml(proc.numero_processo || pub.numero_processo || '—')}</strong>
        <span>${escapeHtml(p.tipo_prazo || '')} · ${escapeHtml(p.responsavel || 'sem responsável')}</span>
      </button>
    `;
  }).join('');
}

function irParaPrazo(id) {
  fecharPalette();
  estado.visualizacao = 'cards';
  document.getElementById('filtro-status').value = 'todos';
  renderTudo();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('card-destacado');
    setTimeout(() => el.classList.remove('card-destacado'), 2000);
  });
}

// Delegação de eventos num único listener por tipo de ação: os cards são renderizados
// em dois containers (lista principal e seção "precisa confirmação"), então cabear
// botão por botão a cada render duplicaria a lógica — um listener em document cobre os dois.
document.addEventListener('click', (event) => {
  const btnCumprido = event.target.closest('.btn-marcar-cumprido');
  if (btnCumprido) return onMarcarCumprido(btnCumprido.dataset.id, btnCumprido);

  const btnWhatsapp = event.target.closest('.btn-whatsapp');
  if (btnWhatsapp) {
    const prazo = estado.prazos.find((p) => p.id === btnWhatsapp.dataset.id);
    if (prazo) abrirWhatsapp(prazo);
    return;
  }

  const btnVerMais = event.target.closest('.link-ver-mais');
  if (btnVerMais) {
    const id = btnVerMais.dataset.id;
    if (estado.teorExpandido.has(id)) estado.teorExpandido.delete(id);
    else estado.teorExpandido.add(id);
    return renderTudo();
  }

  const btnVerCalculo = event.target.closest('.link-ver-calculo');
  if (btnVerCalculo) {
    const id = btnVerCalculo.dataset.id;
    if (estado.trilhaExpandida.has(id)) estado.trilhaExpandida.delete(id);
    else estado.trilhaExpandida.add(id);
    return renderTudo();
  }

  const btnIcs = event.target.closest('.btn-ics');
  if (btnIcs) return exportarIcsUnico(btnIcs.dataset.id);

  const calAnterior = event.target.closest('#cal-anterior');
  if (calAnterior) return mudarMes(-1);

  const calSeguinte = event.target.closest('#cal-seguinte');
  if (calSeguinte) return mudarMes(1);

  const calDia = event.target.closest('.cal-dia[data-data]');
  if (calDia) {
    const data = calDia.dataset.data;
    estado.diaCalendarioSelecionado = estado.diaCalendarioSelecionado === data ? null : data;
    return renderLista();
  }

  const paletteItem = event.target.closest('.palette-item');
  if (paletteItem) return irParaPrazo(paletteItem.dataset.id);

  if (event.target.id === 'overlay-palette') return fecharPalette();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    abrirPalette();
    return;
  }
  if (event.key === 'Escape' && !document.getElementById('overlay-palette').hidden) {
    fecharPalette();
  }
});

// --- Ações ---

function mostrarErro(msg) {
  const el = document.getElementById('erro');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function mostrarToast(msg, duracaoMs = 4000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => { el.hidden = true; }, duracaoMs);
}

async function carregarDados() {
  if (!configCompleta()) {
    document.getElementById('lista-container').innerHTML =
      '<div class="estado-vazio">Configure o acesso ao repositório de dados para começar.</div>';
    document.getElementById('stats').innerHTML = '';
    return;
  }

  mostrarErro(null);
  document.getElementById('fonte-info').textContent = 'Carregando…';
  renderSkeleton();

  try {
    const [prazos, publicacoes, processos] = await Promise.all([
      fetchJsonDoRepo('data/prazos.json'),
      fetchJsonDoRepo('data/publicacoes.json'),
      fetchJsonDoRepo('data/processos.json'),
    ]);
    estado.prazos = prazos;
    estado.publicacoes = publicacoes;
    estado.processos = processos;

    // Status de execução e feriados são só para os indicadores de confiabilidade
    // (frescor + dias úteis restantes) — se algum desses 3 falhar, o dashboard ainda
    // funciona com os dados essenciais acima, só perde esses indicadores extras.
    try {
      estado.status = await fetchJsonDoRepo('data/status_execucao.json');
    } catch {
      estado.status = null;
    }
    try {
      const [feriadosNacionaisRaw, feriadosForensesRaw] = await Promise.all([
        fetchJsonDoRepo('data/feriados_nacionais_cache.json'),
        fetchJsonDoRepo('data/feriados_forenses.json'),
      ]);
      estado.feriadosNacionais = new Set(Object.values(feriadosNacionaisRaw).flat());
      estado.feriadosForenses = new Set((feriadosForensesRaw.feriados || []).map((f) => f.data));
    } catch {
      estado.feriadosNacionais = new Set();
      estado.feriadosForenses = new Set();
    }

    const { owner, repo, branch } = getConfig();
    document.getElementById('fonte-info').textContent = `${owner}/${repo}@${branch} — atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
    renderTudo();
  } catch (err) {
    mostrarErro(err.message);
    document.getElementById('fonte-info').textContent = 'Erro ao carregar';
  }
}

async function onMarcarCumprido(prazoId, btn) {
  if (!confirm('Marcar este prazo como cumprido? Isso dispara um workflow no GitHub que atualiza o repositório em alguns segundos.')) return;
  btn.disabled = true;
  btn.textContent = 'Disparando…';
  try {
    await dispararMarcarCumprido(prazoId);
    mostrarToast('Disparado! Toque em "Atualizar" em ~10-20s para ver o status atualizado.');
  } catch (err) {
    mostrarErro(err.message);
    btn.disabled = false;
    btn.textContent = 'Marcar cumprido';
  }
}

// --- Configuração ---

function abrirConfig() {
  const c = getConfig();
  document.getElementById('cfg-owner').value = c.owner;
  document.getElementById('cfg-repo').value = c.repo;
  document.getElementById('cfg-branch').value = c.branch;
  document.getElementById('cfg-token').value = c.token;
  document.getElementById('overlay-config').hidden = false;
}

function fecharConfig() {
  document.getElementById('overlay-config').hidden = true;
}

function salvarConfig() {
  setConfig({
    owner: document.getElementById('cfg-owner').value.trim(),
    repo: document.getElementById('cfg-repo').value.trim(),
    branch: document.getElementById('cfg-branch').value.trim() || 'main',
    token: document.getElementById('cfg-token').value.trim(),
  });
  fecharConfig();
  carregarDados();
}

// --- Wiring ---

document.getElementById('btn-config').addEventListener('click', abrirConfig);
document.getElementById('btn-cancelar-config').addEventListener('click', fecharConfig);
document.getElementById('btn-salvar-config').addEventListener('click', salvarConfig);
document.getElementById('btn-atualizar').addEventListener('click', carregarDados);
['filtro-status', 'filtro-tribunal', 'agrupar-por'].forEach((id) =>
  document.getElementById(id).addEventListener('change', renderLista));
['filtro-responsavel', 'filtro-busca'].forEach((id) =>
  document.getElementById(id).addEventListener('input', renderLista));

function trocarVisualizacao(nova) {
  estado.visualizacao = nova;
  document.getElementById('btn-view-cards').classList.toggle('view-ativa', nova === 'cards');
  document.getElementById('btn-view-calendario').classList.toggle('view-ativa', nova === 'calendario');
  renderLista();
}
document.getElementById('btn-view-cards').addEventListener('click', () => trocarVisualizacao('cards'));
document.getElementById('btn-view-calendario').addEventListener('click', () => trocarVisualizacao('calendario'));
document.getElementById('btn-busca-rapida').addEventListener('click', abrirPalette);
document.getElementById('btn-exportar-ics').addEventListener('click', exportarIcsFiltrados);
document.getElementById('btn-imprimir-semana').addEventListener('click', imprimirSemana);
document.getElementById('palette-input').addEventListener('input', (e) => renderPaletteResultados(e.target.value));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

carregarDados();
