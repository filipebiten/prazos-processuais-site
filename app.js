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

function badgeUrgencia(prazo) {
  if (prazo.status === 'cumprido') return { classe: 'badge-good', texto: '✓ Cumprido' };
  if (prazo.status === 'prorrogado') return { classe: 'badge-neutro', texto: '↻ Prorrogado' };
  if (prazo.status === 'perdido') return { classe: 'badge-critical', texto: '⛔ Perdido' };

  if (!prazo.data_vencimento) return { classe: 'badge-neutro', texto: '— Aguardando cálculo' };

  const dias = diasAteHoje(prazo.data_vencimento);
  if (dias < 0) return { classe: 'badge-critical', texto: `⛔ Vencido há ${Math.abs(dias)}d` };
  if (dias <= 2) return { classe: 'badge-critical', texto: `⚠ Vence em ${dias}d` };
  if (dias <= 5) return { classe: 'badge-warning', texto: `⏳ Vence em ${dias}d` };
  return { classe: 'badge-good', texto: `✓ Vence em ${dias}d` };
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

// --- Render ---

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

function renderStats() {
  const pendentes = estado.prazos.filter((p) => p.status === 'pendente' && p.data_vencimento);
  const vencendoEmBreve = pendentes.filter((p) => {
    const d = diasAteHoje(p.data_vencimento);
    return d >= 0 && d <= 5;
  });
  const vencidos = pendentes.filter((p) => diasAteHoje(p.data_vencimento) < 0);

  const tiles = [
    { valor: pendentes.length, rotulo: 'Prazos pendentes' },
    { valor: vencendoEmBreve.length, rotulo: 'Vencendo em até 5 dias' },
    { valor: vencidos.length, rotulo: 'Vencidos' },
  ];

  document.getElementById('stats').innerHTML = tiles.map((t) => `
    <div class="stat-tile">
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
  const diasUteis = prazo.status === 'pendente' ? diasUteisRestantes(prazo.data_vencimento) : null;
  const trilhaAberta = estado.trilhaExpandida.has(prazo.id);

  const partesHtml = (proc.partes || []).slice(0, 6).map((p) => `
    <li><span class="parte-papel">${escapeHtml(p.papel)}:</span> ${escapeHtml(p.nome)}</li>
  `).join('');

  return `
    <article class="card" data-id="${prazo.id}">
      <div class="card-topo">
        <span class="badge ${badge.classe}">${badge.texto}</span>
        <span class="card-vencimento">
          ${formatarData(prazo.data_vencimento)}
          ${diasUteis !== null ? `<span class="dias-uteis-restantes">· ${diasUteis} dia(s) útil(eis)</span>` : ''}
        </span>
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
          <button class="btn-whatsapp" data-id="${prazo.id}" title="Enviar resumo pelo WhatsApp">📱 WhatsApp</button>
          ${podeMarcarCumprido
            ? `<button class="btn-marcar-cumprido primary" data-id="${prazo.id}">Marcar cumprido</button>`
            : ''}
        </div>
      </div>
    </article>
  `;
}

function renderLista() {
  const lista = prazosFiltrados();
  const container = document.getElementById('lista-container');

  if (lista.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhum prazo encontrado com os filtros atuais.</div>';
    return;
  }

  container.innerHTML = `<div class="cards-grid">${lista.map(renderCard).join('')}</div>`;
}

function renderTudo() {
  renderBannerFrescor();
  popularFiltroTribunal();
  renderStats();
  renderSecaoRevisao();
  renderLista();
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
['filtro-status', 'filtro-tribunal'].forEach((id) =>
  document.getElementById(id).addEventListener('change', renderLista));
['filtro-responsavel', 'filtro-busca'].forEach((id) =>
  document.getElementById(id).addEventListener('input', renderLista));

carregarDados();
