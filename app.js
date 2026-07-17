const LS_KEYS = {
  owner: 'pp_owner',
  repo: 'pp_repo',
  branch: 'pp_branch',
  token: 'pp_token',
};

const WORKFLOW_MARCAR_CUMPRIDO = 'marcar-cumprido.yml';

let estado = {
  prazos: [],
  publicacoes: [],
};

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

// --- Render ---

function publicacaoDoPrazo(prazo) {
  return estado.publicacoes.find((p) => p.id === prazo.publicacao_id) || {};
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
    if (tribunal && pub.tribunal !== tribunal) return false;
    if (responsavel && !(p.responsavel || '').toLowerCase().includes(responsavel)) return false;
    if (busca && !(pub.numero_processo || '').toLowerCase().includes(busca)) return false;
    return true;
  }).sort((a, b) => (a.data_vencimento || '9999').localeCompare(b.data_vencimento || '9999'));
}

function renderTabela() {
  const lista = prazosFiltrados();
  const container = document.getElementById('tabela-container');

  if (lista.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhum prazo encontrado com os filtros atuais.</div>';
    return;
  }

  const linhas = lista.map((prazo) => {
    const pub = publicacaoDoPrazo(prazo);
    const badge = badgeUrgencia(prazo);
    const podeMarcarCumprido = prazo.status === 'pendente';
    return `
      <tr data-id="${prazo.id}">
        <td class="numerico">${formatarData(prazo.data_vencimento)}</td>
        <td><span class="badge ${badge.classe}">${badge.texto}</span></td>
        <td>${prazo.tipo_prazo || '—'}</td>
        <td>${pub.numero_processo || '—'}</td>
        <td>${pub.tribunal || '—'}</td>
        <td>${prazo.responsavel || '—'}</td>
        <td>
          ${podeMarcarCumprido
            ? `<button class="btn-marcar-cumprido" data-id="${prazo.id}">Marcar cumprido</button>`
            : '—'}
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Vencimento</th>
          <th>Urgência</th>
          <th>Tipo de prazo</th>
          <th>Processo</th>
          <th>Tribunal</th>
          <th>Responsável</th>
          <th>Ação</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
  `;

  container.querySelectorAll('.btn-marcar-cumprido').forEach((btn) => {
    btn.addEventListener('click', () => onMarcarCumprido(btn.dataset.id, btn));
  });
}

function renderTudo() {
  popularFiltroTribunal();
  renderStats();
  renderTabela();
}

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
    document.getElementById('tabela-container').innerHTML =
      '<div class="estado-vazio">Configure o acesso ao repositório de dados para começar.</div>';
    document.getElementById('stats').innerHTML = '';
    return;
  }

  mostrarErro(null);
  document.getElementById('fonte-info').textContent = 'Carregando…';

  try {
    const [prazos, publicacoes] = await Promise.all([
      fetchJsonDoRepo('data/prazos.json'),
      fetchJsonDoRepo('data/publicacoes.json'),
    ]);
    estado.prazos = prazos;
    estado.publicacoes = publicacoes;
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
    mostrarToast('Disparado! Clique em "Atualizar" em ~10-20s para ver o status atualizado.');
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
  document.getElementById(id).addEventListener('change', renderTabela));
['filtro-responsavel', 'filtro-busca'].forEach((id) =>
  document.getElementById(id).addEventListener('input', renderTabela));

carregarDados();
