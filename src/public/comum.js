const ITENS_MENU = [
  { href: '/', label: 'Overview', icone: '📊' },
  { href: '/campanhas', label: 'Campanhas', icone: '📣' },
  { href: '/criativos', label: 'Criativos', icone: '🎨' },
  { href: '/leads', label: 'Leads', icone: '👤' },
  { href: '/vendas', label: 'Vendas', icone: '🛒' },
  { href: '/eventos', label: 'Eventos', icone: '📡' },
  { href: '/eventos-manuais', label: 'Eventos Manuais', icone: '➕' },
  { href: '/configuracoes', label: 'Configurações', icone: '⚙️' },
];

function montarSidebar() {
  const caminhoAtual = window.location.pathname;
  const links = ITENS_MENU.map((item) => {
    const ativo = item.href === caminhoAtual ? 'ativo' : '';
    return `<a href="${item.href}" class="${ativo}">${item.icone} ${item.label}</a>`;
  }).join('');

  return `
    <div class="sidebar">
      <div class="marca">Sua Marca<small>TRACKING</small></div>
      <nav>${links}</nav>
      <div class="rodape"><span class="ponto"></span> Sistema operacional</div>
    </div>
  `;
}

function montarTopbar(titulo, comFiltroData = true, comSeletorConta = true) {
  return `
    <div class="topbar">
      <div>
        <div class="eyebrow">Dashboard</div>
        <h1>${titulo}</h1>
      </div>
      ${comFiltroData ? `
      <div class="filtros">
        ${comSeletorConta ? `
        <select id="contaSelect" style="background:#171a21; border:1px solid #23262f; color:#e5e7eb; padding:6px 10px; border-radius:7px; font-size:12px;">
          <option value="">Todas as contas</option>
        </select>` : ''}
        <span class="chip" data-periodo="hoje">Hoje</span>
        <span class="chip" data-periodo="ontem">Ontem</span>
        <span class="chip ativo" data-periodo="7d">7d</span>
        <span class="chip" data-periodo="30d">30d</span>
        <input type="date" id="dataInicio">
        <input type="date" id="dataFim">
        <button class="primary" onclick="window.aplicarFiltro && window.aplicarFiltro()">Aplicar</button>
        <button onclick="window.sincronizarAgora && window.sincronizarAgora()">🔄</button>
      </div>` : ''}
    </div>
  `;
}

function formatarMoeda(v) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Formata telefone bruto (só dígitos, com DDI) pro padrao +55 (DD) 99999-9999
function formatarTelefone(tel) {
  if (!tel) return '--';
  const d = String(tel).replace(/\D/g, '');
  if (d.length < 12) return '+' + d;
  const cc = d.slice(0, 2);
  const ddd = d.slice(2, 4);
  const resto = d.slice(4);
  if (resto.length === 9) {
    return `+${cc} (${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
  }
  return `+${cc} (${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
}

// Monta o link direto pro anuncio dentro do Gerenciador de Anuncios do Meta
function linkAdsManager(metaAccountId, adId) {
  if (!metaAccountId || !adId) return null;
  const contaNumero = metaAccountId.replace('act_', '');
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${contaNumero}&selected_ad_ids=${adId}`;
}

async function carregarContasNoSeletor() {
  const select = document.getElementById('contaSelect');
  if (!select) return;
  try {
    const contas = await fetch('/api/ad-accounts').then(r => r.json());
    contas.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nome;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      window.contaFiltro = select.value;
      window.aplicarFiltro && window.aplicarFiltro();
    });
  } catch (e) { /* silencioso: dropdown so nao vem populado */ }
}

window.contaFiltro = '';

function iniciarFiltrosDeData(onAplicar) {
  const hoje = new Date();
  const setPeriodo = (dias) => {
    const inicio = new Date(Date.now() - dias * 86400000);
    document.getElementById('dataInicio').value = inicio.toISOString().slice(0, 10);
    document.getElementById('dataFim').value = hoje.toISOString().slice(0, 10);
  };
  setPeriodo(7);

  document.querySelectorAll('.chip[data-periodo]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-periodo]').forEach((c) => c.classList.remove('ativo'));
      chip.classList.add('ativo');
      const periodo = chip.dataset.periodo;
      if (periodo === 'hoje') setPeriodo(0);
      else if (periodo === 'ontem') {
        const ontem = new Date(Date.now() - 86400000);
        document.getElementById('dataInicio').value = ontem.toISOString().slice(0, 10);
        document.getElementById('dataFim').value = ontem.toISOString().slice(0, 10);
      } else if (periodo === '7d') setPeriodo(7);
      else if (periodo === '30d') setPeriodo(30);
      onAplicar();
    });
  });

  window.aplicarFiltro = onAplicar;
  carregarContasNoSeletor();
}

async function verificarLogin() {
  const resp = await fetch('/api/auth/me').then((r) => r.json());
  if (!resp.autenticado) window.location.href = '/login.html';
}

async function sair() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

verificarLogin();
