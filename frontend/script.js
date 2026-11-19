/* =========================================================
   SeatLock — front-end
   Fala com a API pelo mesmo endereço do NGINX (caminhos relativos).
   ========================================================= */

// ---------- Dados dos eventos ----------
const EVENTOS = [
  { id: 'tech-summit',          t: 'Tech Summit 2026',       cat: 'Palestras', dia: '14', mes: 'nov', hora: '19:00', loc: 'Centro de Convenções, São Paulo' },
  { id: 'noite-de-jazz',        t: 'Noite de Jazz',          cat: 'Shows',     dia: '02', mes: 'dez', hora: '20:30', loc: 'Arena Central' },
  { id: 'hamlet',               t: 'Hamlet: nova montagem',  cat: 'Teatros',   dia: '20', mes: 'nov', hora: '18:00', loc: 'Teatro Municipal' },
  { id: 'festival-verao',       t: 'Festival Verão Som',     cat: 'Festivais', dia: '09', mes: 'jan', hora: '16:00', loc: 'Parque da Cidade' },
  { id: 'ux-conf',              t: 'UX Conf 2026',           cat: 'Palestras', dia: '28', mes: 'nov', hora: '09:00', loc: 'Hub de Inovação' },
  { id: 'rock-in-concert',      t: 'Rock in Concert',        cat: 'Shows',     dia: '05', mes: 'dez', hora: '21:00', loc: 'Estádio Sul' },
  { id: 'auto-da-compadecida',  t: 'O Auto da Compadecida',  cat: 'Teatros',   dia: '22', mes: 'nov', hora: '20:00', loc: 'Teatro Central' },
  { id: 'festival-gastronomico',t: 'Festival Gastronômico',  cat: 'Festivais', dia: '15', mes: 'dez', hora: '12:00', loc: 'Praça das Artes' },
];
const CATEGORIAS = ['Todos', 'Shows', 'Teatros', 'Palestras', 'Festivais'];
const FILEIRAS = ['A', 'B', 'C', 'D', 'E'];
const ASSENTOS_POR_FILEIRA = 10;
const LOCK_SEGUNDOS = 300;                 // igual ao EX do Redis no servidor

function setor(fileira) {
  if (fileira === 'A' || fileira === 'B') return { nome: 'Premium',   preco: 120, cls: 't-prem' };
  if (fileira === 'C' || fileira === 'D') return { nome: 'Plateia',   preco: 80,  cls: 't-std' };
  return { nome: 'Econômica', preco: 60, cls: 't-eco' };
}
const brl = (n) => 'R$ ' + n.toFixed(2).replace('.', ',');
const $ = (id) => document.getElementById(id);
const eventoPorId = (id) => EVENTOS.find((e) => e.id === id);

// ---------- Estado ----------
const state = {
  tela: 'screen-login',
  evento: null,            // evento aberto no mapa
  ocupados: new Set(),     // lugares ocupados por outras pessoas (evento aberto)
  novos: new Set(),        // lugares que acabaram de ser ocupados por outros
  livres: {},              // id do evento -> quantidade de lugares livres
  holds: {},               // "evento|lugar" -> { ev, seat, token, expiraEm }
  confirmadas: [], // reservas confirmadas no backend durante a sessão
  pendentes: new Set(),    // lugares com requisição em andamento
  categoria: 'Todos',
  busca: '',
  offline: false,
  baseline: false,
  tick: 0,
};
const chave = (ev, seat) => `${ev}|${seat}`;
const holdsDoEvento = (ev) => Object.values(state.holds).filter((h) => h.ev === ev);

// ---------- API ----------
const API_BASE_URL = "https://seatlock-api-it25.onrender.com";
async function chamar(url, opcoes = {}) {
  const token = sessionStorage.getItem('seatlock_token');

  const headers = {
    ...(opcoes.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${url}`, {
    ...opcoes,
    headers
  });

  if (res.status === 401 && url !== '/login' && url !== '/cadastro') {
    encerrarSessao('<strong>Sua sessão expirou.</strong> Entre novamente.');
  }

  let corpo = null;

  try {
    corpo = await res.json();
  } catch (e) {
    // Resposta que não é JSON, como um erro 502 do NGINX.
  }

  return {
    status: res.status,
    ok: res.ok,
    corpo
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const api = {
  assentos: (ev) => chamar(`/assentos?evento=${encodeURIComponent(ev)}`),
  reservas: () => chamar('/reservas'),

  reservar: (ev, seat) => chamar('/reservas', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ evento: ev, assento: seat })
  }),

  confirmar: (ev, seat, token) => chamar(`/reservas/${seat}/confirmar`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ evento: ev, token })
  }),

  liberar: (ev, seat, token) => chamar(`/reservas/${seat}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify({ evento: ev, token })
  }),

  cancelarConfirmada: (ev, seat, codigo) => chamar(`/reservas/${seat}/confirmada`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      evento: ev,
      codigo_confirmacao: codigo
    })
  }),
};

// ---------- Avisos ----------
function aviso(html, tipo) {
  const el = document.createElement('div');
  el.className = 'toast' + (tipo ? ' is-' + tipo : '');
  el.innerHTML = html;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}
function marcarServidor(nome) {
  if (!nome) return;
  document.querySelectorAll('.strip .node').forEach((n) => n.classList.toggle('on', n.dataset.srv === nome));
}
function definirOffline(valor) {
  if (state.offline === valor) return;
  state.offline = valor;
  $('offline').hidden = !valor;
}

// ---------- Navegação ----------
function goto(id) {
  state.tela = id;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.body.dataset.tela = id;
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  window.scrollTo(0, 0);
  if (id === 'screen-events') sincronizarTodos();
  if (id === 'screen-confirm') renderConfirmacao();
  if (id === 'screen-reservations') renderReservas();
}
document.addEventListener('click', (e) => {
  const alvo = e.target.closest('[data-goto]');
  if (alvo) goto(alvo.dataset.goto);
});


// ---------- Login e cadastro ----------
let modoCadastro = false;

function definirModo(cadastro) {
  modoCadastro = cadastro;
  $('tab-login').classList.toggle('active', !cadastro);
  $('tab-signup').classList.toggle('active', cadastro);
  $('tab-login').setAttribute('aria-selected', String(!cadastro));
  $('tab-signup').setAttribute('aria-selected', String(cadastro));
  $('field-nome').hidden = !cadastro;
  $('auth-submit').textContent = cadastro ? 'Criar conta' : 'Entrar';
  $('auth-senha').autocomplete = cadastro ? 'new-password' : 'current-password';
  $('auth-erro').hidden = true;
}

$('tab-login').addEventListener('click', () => definirModo(false));
$('tab-signup').addEventListener('click', () => definirModo(true));

$('pw-eye').addEventListener('click', () => {
  const campo = $('auth-senha');
  const mostrar = campo.type === 'password';
  campo.type = mostrar ? 'text' : 'password';
  $('pw-eye').textContent = mostrar ? 'Ocultar' : 'Mostrar';
});

function definirUsuario(nome) {
  $('user-name').textContent = nome;
  $('user-avatar').textContent = nome.charAt(0).toUpperCase();
}

function encerrarSessao(mensagem) {
  sessionStorage.removeItem('seatlock_token');
  sessionStorage.removeItem('seatlock_usuario');
  state.holds = {};
  state.confirmadas = [];
  state.evento = null;
  definirUsuario('Visitante');
  $('auth-senha').value = '';
  $('auth-nome').value = '';
  goto('screen-login');
  if (mensagem) aviso(mensagem, 'warn');
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const erro = $('auth-erro');
  const email = $('auth-email').value.trim();
  const senha = $('auth-senha').value;
  const nome = $('auth-nome').value.trim();

  erro.hidden = true;

  if (!email.includes('@')) {
    erro.textContent = 'Digite um e-mail válido.';
    erro.hidden = false;
    return;
  }

  if (modoCadastro && !nome) {
    erro.textContent = 'Digite seu nome.';
    erro.hidden = false;
    return;
  }

  if (modoCadastro && senha.length < 8) {
    erro.textContent = 'A senha precisa ter pelo menos 8 caracteres.';
    erro.hidden = false;
    return;
  }

  const endpoint = modoCadastro ? '/cadastro' : '/login';

  const dados = modoCadastro
    ? { nome, email, senha }
    : { email, senha };

  const botao = $('auth-submit');
  botao.disabled = true;
  botao.textContent = 'Aguarde...';

  try {
    const resposta = await chamar(endpoint, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(dados)
    });

    if (!resposta.ok) {
      throw new Error(
        resposta.corpo?.erro || 'Não foi possível realizar a autenticação.'
      );
    }

    const { token, usuario } = resposta.corpo;

    if (!token || !usuario) {
      throw new Error('Resposta inválida do servidor.');
    }

    sessionStorage.setItem('seatlock_token', token);
    sessionStorage.setItem('seatlock_usuario', usuario.nome);

    definirUsuario(usuario.nome);

    $('auth-senha').value = '';
    $('auth-nome').value = '';

    goto('screen-events');

  } catch (e) {
    erro.textContent = e.message || 'Erro ao conectar com o servidor.';
    erro.hidden = false;

  } finally {
    botao.disabled = false;
    botao.textContent = modoCadastro ? 'Criar conta' : 'Entrar';
  }
});

$('btn-sair').addEventListener('click', () => encerrarSessao());

// =========================================================
// EVENTOS
// =========================================================
function renderDestaque() {
  const ev = EVENTOS[0];
  $('featured').innerHTML = `
    <img src="img/${ev.id}.svg" alt="">
    <div class="featured-body">
      <span class="featured-tag">Em destaque</span>
      <h2>${ev.t}</h2>
      <p>${ev.dia} de ${ev.mes} às ${ev.hora}. ${ev.loc}.</p>
      <button class="btn btn-primary" data-abrir="${ev.id}">Escolher lugares</button>
    </div>`;
}

function renderPills() {
  $('pills').innerHTML = CATEGORIAS.map((c) =>
    `<button class="pill${c === state.categoria ? ' active' : ''}" data-cat="${c}" aria-pressed="${c === state.categoria}">${c}</button>`).join('');
}

function eventosFiltrados() {
  const q = state.busca.trim().toLowerCase();
  return EVENTOS.filter((e) =>
    (state.categoria === 'Todos' || e.cat === state.categoria) &&
    (!q || (e.t + ' ' + e.loc + ' ' + e.cat).toLowerCase().includes(q)));
}

function renderCards() {
  const lista = eventosFiltrados();
  $('events-empty').hidden = lista.length > 0;
  const total = FILEIRAS.length * ASSENTOS_POR_FILEIRA;
  $('events-grid').innerHTML = lista.map((ev) => {
    const livres = state.livres[ev.id];
    const conhecido = typeof livres === 'number';
    const ocupadoPct = conhecido ? Math.round(((total - livres) / total) * 100) : 0;
    return `
    <article class="ev-card">
      <div class="ev-img"><img src="img/${ev.id}.svg" alt="" loading="lazy"><span class="ev-chip">${ev.cat}</span></div>
      <div class="ev-body">
        <div class="ev-date"><strong>${ev.dia}</strong><span>${ev.mes}</span></div>
        <div><h3 class="ev-title">${ev.t}</h3><p class="ev-meta">${ev.hora} · ${ev.loc}</p></div>
      </div>
      <div class="ev-perf" aria-hidden="true"></div>
      <div class="ev-foot">
        <div class="ev-free"><span>${conhecido ? `<strong>${livres}</strong> de ${total} lugares livres` : 'Consultando lugares…'}</span></div>
        <div class="ev-bar"><div style="width:${ocupadoPct}%"></div></div>
        <button class="btn btn-primary" data-abrir="${ev.id}">Escolher lugares</button>
      </div>
    </article>`;
  }).join('');
}

$('pills').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.categoria = b.dataset.cat;
  renderPills();
  renderCards();
});
$('busca').addEventListener('input', (e) => { state.busca = e.target.value; renderCards(); });
$('btn-limpar').addEventListener('click', () => {
  state.categoria = 'Todos'; state.busca = ''; $('busca').value = '';
  renderPills(); renderCards();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-abrir]');
  if (b) abrirEvento(b.dataset.abrir);
});

// =========================================================
// MAPA DE ASSENTOS
// =========================================================
function abrirEvento(id) {
  const ev = eventoPorId(id);
  state.evento = id;
  state.ocupados = new Set();
  state.novos = new Set();
  state.baseline = false;
  $('sm-title').textContent = ev.t;
  $('sm-meta').textContent = `${ev.dia} de ${ev.mes} às ${ev.hora} · ${ev.loc}`;
  renderMapa();
  goto('screen-seatmap');
  sincronizar(id).then(renderTudo).catch(() => {});
}

function renderMapa() {
  const hall = $('hall');
  const ev = state.evento;
  let html = '';
  FILEIRAS.forEach((f) => {
    const s = setor(f);
    html += `<div class="seat-row"><span class="row-label">${f}</span>`;
    for (let n = 1; n <= ASSENTOS_POR_FILEIRA; n++) {
      const id = f + n;
      const meu = !!state.holds[chave(ev, id)];
      const ocupado = state.ocupados.has(id);
      const classes = ['seat', s.cls];
      if (meu) classes.push('is-mine');
      else if (ocupado) classes.push('is-taken');
      if (state.novos.has(id)) classes.push('flash');
      if (state.pendentes.has(id)) classes.push('is-busy');
      const rotulo = meu ? `${id}, seu lugar. Toque para liberar`
        : ocupado ? `${id}, ocupado`
        : `${id}, ${s.nome}, ${brl(s.preco)}. Toque para reservar`;
      if (n === ASSENTOS_POR_FILEIRA / 2 + 1) html += '<span class="seat-gap"></span>';
      html += `<button class="${classes.join(' ')}" data-seat="${id}" data-tip="${id} · ${brl(s.preco)}" aria-label="${rotulo}" aria-pressed="${meu}" ${ocupado && !meu ? 'disabled' : ''}>${meu ? id : ''}</button>`;
    }
    html += `<span class="row-label">${f}</span></div>`;
  });
  hall.innerHTML = html;
  state.novos = new Set();
}

function renderPainel() {
  const ev = state.evento;
  const meus = holdsDoEvento(ev).sort((a, b) => a.seat.localeCompare(b.seat, 'pt', { numeric: true }));
  $('panel-empty').hidden = meus.length > 0;
  $('chosen').innerHTML = meus.map((h) => {
    const s = setor(h.seat[0]);
    return `<li><span class="seat-id">${h.seat}</span><span class="seat-tier">${s.nome}</span><span class="seat-price">${brl(s.preco)}</span><button class="x" data-liberar="${h.seat}" aria-label="Liberar o lugar ${h.seat}">×</button></li>`;
  }).join('');
  $('hold').hidden = meus.length === 0;
  const total = meus.reduce((soma, h) => soma + setor(h.seat[0]).preco, 0);
  $('co-total').textContent = brl(total);
  $('btn-prosseguir').disabled = meus.length === 0;
}

async function alternarLugar(seat, forcarLiberar) {
  const ev = state.evento;
  const k = chave(ev, seat);
  if (state.pendentes.has(seat)) return;
  state.pendentes.add(seat);
  renderMapa();
  try {
    const hold = state.holds[k];
    if (hold || forcarLiberar) {
      const r = await api.liberar(ev, seat, hold && hold.token);
      if (r.corpo && r.corpo.servidor) marcarServidor(r.corpo.servidor);
      if (r.ok || r.status === 404) delete state.holds[k];
      else if (r.status === 403) aviso('<strong>Não foi possível liberar.</strong> Esse lugar pertence a outra reserva.', 'warn');
    } else {
      const r = await api.reservar(ev, seat);
      if (r.corpo && r.corpo.servidor) marcarServidor(r.corpo.servidor);
      if (r.status === 201) {
        state.holds[k] = { ev, seat, token: r.corpo.token, expiraEm: Date.now() + LOCK_SEGUNDOS * 1000 };
      } else if (r.status === 409) {
        state.ocupados.add(seat);
        aviso(`<strong>O lugar ${seat} acabou de ser reservado.</strong> Outro pedido chegou antes e o lock impediu a reserva dupla. Escolha outro lugar.`, 'warn');
      } else {
        aviso('<strong>Não foi possível reservar.</strong> Tente de novo em instantes.', 'warn');
      }
    }
    definirOffline(false);
  } catch (e) {
    definirOffline(true);
    aviso('<strong>Sem conexão com o servidor.</strong> Tente de novo em instantes.', 'warn');
  }
  state.pendentes.delete(seat);
  try { await sincronizar(ev); } catch (e) { /* o ciclo de atualização tenta de novo */ }
  renderTudo();
}

$('hall').addEventListener('click', (e) => {
  const b = e.target.closest('.seat');
  if (b && !b.disabled) alternarLugar(b.dataset.seat);
});
$('chosen').addEventListener('click', (e) => {
  const b = e.target.closest('[data-liberar]');
  if (b) alternarLugar(b.dataset.liberar, true);
});
$('btn-prosseguir').addEventListener('click', () => goto('screen-confirm'));

// =========================================================
// SINCRONIZAÇÃO COM O SERVIDOR
// =========================================================
async function sincronizar(ev) {
  const r = await api.assentos(ev);
  if (!r.ok || !Array.isArray(r.corpo)) throw new Error('resposta inválida');
  definirOffline(false);
  const lista = r.corpo;
  const agora = Date.now();

  // reservas minhas: renova o tempo ou remove as que expiraram
  holdsDoEvento(ev).forEach((h) => {
    const a = lista.find((x) => x.id === h.seat);
    if (!a || a.status === 'livre') {
      delete state.holds[chave(ev, h.seat)];
      aviso(`<strong>A reserva do lugar ${h.seat} expirou.</strong> O lugar voltou a ficar livre.`, 'warn');
    } else {
      h.expiraEm = agora + a.ttl * 1000;
    }
  });

  state.livres[ev] = lista.filter((a) => a.status === 'livre').length;

  if (ev === state.evento) {
    const antes = state.ocupados;
    const agoraOcupados = new Set(lista.filter((a) => a.status === 'ocupado' && !state.holds[chave(ev, a.id)]).map((a) => a.id));
    // destaca (uma vez) os lugares que outra pessoa acabou de ocupar; a primeira leitura do evento não conta
    if (state.baseline) agoraOcupados.forEach((id) => { if (!antes.has(id)) state.novos.add(id); });
    state.baseline = true;
    state.ocupados = agoraOcupados;
  }
}

function sincronizarTodos() {
  Promise.allSettled(EVENTOS.map((e) => sincronizar(e.id))).then((res) => {
    definirOffline(res.every((r) => r.status === 'rejected'));
    renderTudo();
  });
}

async function ciclo() {
  state.tick++;
  const alvos = new Set(Object.values(state.holds).map((h) => h.ev));
  if (state.tela === 'screen-seatmap' && state.evento) alvos.add(state.evento);
  try {
    await Promise.all([...alvos].map((ev) => sincronizar(ev)));
    if (state.tela === 'screen-events' && state.tick % 5 === 0) sincronizarTodos();
  } catch (e) {
    definirOffline(true);
  }
  renderTudo();
}
setInterval(ciclo, 3000);

// =========================================================
// CONFIRMAÇÃO
// =========================================================
function renderConfirmacao() {
  const ev = eventoPorId(state.evento);
  if (!ev) return;
  const meus = holdsDoEvento(ev.id).sort((a, b) => a.seat.localeCompare(b.seat, 'pt', { numeric: true }));
  const total = meus.reduce((s, h) => s + setor(h.seat[0]).preco, 0);
  $('cf-img').src = `img/${ev.id}.svg`;
  $('cf-title').textContent = ev.t;
  $('cf-date').textContent = `${ev.dia} de ${ev.mes} às ${ev.hora}`;
  $('cf-local').textContent = ev.loc;
  $('cf-seats').textContent = meus.length ? meus.map((h) => h.seat).join(', ') : '—';
  $('cf-qty').textContent = meus.length + (meus.length === 1 ? ' ingresso' : ' ingressos');
  $('cf-total').textContent = brl(total);
  atualizarConfirmar(meus.length);
}
function atualizarConfirmar(qtd) {
  $('btn-confirm-reserve').disabled = !($('consent-chk').checked && qtd > 0);
}
$('consent-chk').addEventListener('change', () => atualizarConfirmar(holdsDoEvento(state.evento).length));
$('btn-confirm-reserve').addEventListener('click', async () => {
  const meus = [...holdsDoEvento(state.evento)];

  if (!meus.length) return;

  const botao = $('btn-confirm-reserve');
  botao.disabled = true;

  try {
    const confirmadas = [];

    for (const hold of meus) {
      const r = await api.confirmar(hold.ev, hold.seat, hold.token);

      if (r.corpo && r.corpo.servidor) {
        marcarServidor(r.corpo.servidor);
      }

      if (!r.ok) {
        throw new Error(
          r.corpo?.erro || `Não foi possível confirmar o assento ${hold.seat}`
        );
      }

      confirmadas.push(r.corpo);

      state.confirmadas.push({
 	 ev: hold.ev,
 	 seat: hold.seat,
 	 codigo: r.corpo.codigo_confirmacao
      });

      delete state.holds[chave(hold.ev, hold.seat)];
    }

    $('modal-code').textContent = confirmadas
      .map((r) => r.codigo_confirmacao)
      .join(', ');

    const modal = $('success-modal');
    modal.hidden = false;
    modal.classList.add('show');

    definirOffline(false);

  } catch (erro) {
    aviso(`<strong>Erro na confirmação.</strong> ${erro.message}`, 'warn');
  }

  renderTudo();
  atualizarConfirmar(holdsDoEvento(state.evento).length);
});
$('btn-to-reservations').addEventListener('click', () => {
  const modal = $('success-modal');
  modal.classList.remove('show');
  modal.hidden = true;
  $('consent-chk').checked = false;
  goto('screen-reservations');
});

// =========================================================
// MINHAS RESERVAS
// =========================================================

async function renderReservas() {
  // Busca as reservas confirmadas no banco de dados
  const resposta = await api.reservas();

  if (resposta.ok && Array.isArray(resposta.corpo)) {
    state.confirmadas = resposta.corpo.map((r) => ({
      ev: r.evento,
      seat: r.assento,
      codigo: r.codigo_confirmacao
    }));
  } else {
    aviso('Não foi possível carregar suas reservas.', 'erro');
  }

  const porEvento = {};

  // Agrupa bloqueios temporários
  Object.values(state.holds).forEach((h) => {
    if (!porEvento[h.ev]) {
      porEvento[h.ev] = { holds: [], confirmadas: [] };
    }
    porEvento[h.ev].holds.push(h);
  });

  // Agrupa reservas confirmadas
  state.confirmadas.forEach((r) => {
    if (!porEvento[r.ev]) {
      porEvento[r.ev] = { holds: [], confirmadas: [] };
    }
    porEvento[r.ev].confirmadas.push(r);
  });

  const ids = Object.keys(porEvento);

  $('res-empty').hidden = ids.length > 0;

  $('res-list').innerHTML = ids.map((id) => {
    const ev = eventoPorId(id);
    const dados = porEvento[id];

    const hs = dados.holds;
    const confirmadas = dados.confirmadas;

    return `
    <article class="res-card" data-ev="${id}">
      <img src="img/${id}.svg" alt="">
      <div>
        <h3 class="res-title">${ev.t}</h3>
        <p class="res-meta">${ev.dia} de ${ev.mes} às ${ev.hora} · ${ev.loc}</p>

        ${confirmadas.length ? `
          <p><strong>Reservas confirmadas</strong></p>
          <div class="res-seats">
            ${confirmadas.map((r) => `<span>${r.seat}</span>`).join('')}
          </div>
          ${confirmadas.map((r) => `
  <p class="res-meta">Código: ${r.codigo}</p>
  <button
    class="btn btn-ghost"
    data-cancelar-confirmada="${r.seat}"
    data-evento="${id}"
    data-codigo="${r.codigo}">
    Cancelar reserva ${r.seat}
  </button>
`).join('')}
        ` : ''}

        ${hs.length ? `
          <p><strong>Bloqueios temporários</strong></p>
          <div class="res-seats">
            ${hs.map((h) => `<span>${h.seat}</span>`).join('')}
          </div>
        ` : ''}
      </div>

      ${hs.length ? `
        <div class="res-side">
          <div class="res-timer">
            Bloqueios expiram em
            <strong data-expira-de="${id}">--:--</strong>
          </div>
          <div class="bar">
            <div class="bar-fill" data-barra-de="${id}"></div>
          </div>
          <button class="btn btn-ghost" data-cancelar="${id}">
            Liberar bloqueios
          </button>
        </div>
      ` : ''}
    </article>`;
  }).join('');

  atualizarContagens();
}

let reservaParaCancelar = null;
$('res-list').addEventListener('click', async (e) => {

  
  // Cancelamento de reserva confirmada
  const bc = e.target.closest('[data-cancelar-confirmada]');

  if (bc) {
    reservaParaCancelar = {
      ev: bc.dataset.evento,
      seat: bc.dataset.cancelarConfirmada,
      codigo: bc.dataset.codigo,
      botao: bc
    };

    $('cancel-modal-message').textContent =
      `Deseja realmente cancelar a reserva do assento ${reservaParaCancelar.seat}?`;

    $('cancel-modal').hidden = false;
    $('cancel-modal').classList.add('show');

    return;
  }

  // Cancelamento de bloqueios temporários (Redis)
  const b = e.target.closest('[data-cancelar]');

  if (!b) return;

  const ev = b.dataset.cancelar;
  b.disabled = true;

  try {
    await Promise.all(holdsDoEvento(ev).map((h) =>
      api.liberar(ev, h.seat, h.token).then((r) => {
        if (r.ok || r.status === 404) {
          delete state.holds[chave(ev, h.seat)];
        }
      })
    ));

    aviso('<strong>Reserva cancelada.</strong> Os lugares voltaram a ficar livres.', 'ok');
    definirOffline(false);

  } catch (err) {
    definirOffline(true);
    aviso('<strong>Sem conexão com o servidor.</strong> Não foi possível cancelar agora.', 'warn');
  }

  renderTudo();
});

// Fechar modal de cancelamento
function fecharModalCancelamento() {
  $('cancel-modal').classList.remove('show');
  $('cancel-modal').hidden = true;
  reservaParaCancelar = null;
}

// Botão Voltar
$('btn-cancel-back').addEventListener('click', () => {
  fecharModalCancelamento();
});

// Botão Sim, cancelar
$('btn-confirm-cancel').addEventListener('click', async () => {
  if (!reservaParaCancelar) return;

  const { ev, seat, codigo, botao } = reservaParaCancelar;
  const btnConfirmar = $('btn-confirm-cancel');

  btnConfirmar.disabled = true;
  btnConfirmar.textContent = 'Cancelando...';

  try {
    const resposta = await api.cancelarConfirmada(ev, seat, codigo);

    if (!resposta.ok) {
      aviso(
        resposta.corpo?.erro || 'Não foi possível cancelar a reserva.',
        'erro'
      );
      return;
    }

    fecharModalCancelamento();
    aviso('<strong>Reserva cancelada com sucesso!</strong>', 'ok');
    definirOffline(false);

    await renderReservas();

  } catch (err) {
    definirOffline(true);
    aviso(
      '<strong>Sem conexão com o servidor.</strong> Não foi possível cancelar agora.',
      'warn'
    );

  } finally {
    btnConfirmar.disabled = false;
    btnConfirmar.textContent = 'Sim, cancelar';

    if (botao) botao.disabled = false;
  }
});

// Fechar ao clicar fora do cartão
$('cancel-modal').addEventListener('click', (e) => {
  if (e.target === $('cancel-modal')) {
    fecharModalCancelamento();
  }
});

// Fechar com a tecla ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('cancel-modal').hidden) {
    fecharModalCancelamento();
  }
});


// =========================================================
// RENDER GERAL E CRONÔMETROS
// =========================================================
function renderTudo() {
  if (state.tela === 'screen-events') renderCards();
  if (state.tela === 'screen-seatmap') { renderMapa(); renderPainel(); }
  if (state.tela === 'screen-confirm') renderConfirmacao();
  if (state.tela === 'screen-reservations') renderReservas();
  atualizarContagens();
}

const mmss = (seg) => String(Math.floor(seg / 60)).padStart(2, '0') + ':' + String(seg % 60).padStart(2, '0');
function segundosRestantes(hs) {
  if (!hs.length) return 0;
  return Math.max(0, Math.round((Math.min(...hs.map((h) => h.expiraEm)) - Date.now()) / 1000));
}

function atualizarContagens() {
  const total = Object.keys(state.holds).length;
  const badge = $('nav-count');
  badge.textContent = total;
  badge.hidden = total === 0;

  // painel do mapa
  const meus = holdsDoEvento(state.evento);
  const resto = segundosRestantes(meus);
  $('timer-val').textContent = meus.length ? mmss(resto) : '--:--';
  $('timer-bar').style.width = meus.length ? Math.min(100, (resto / LOCK_SEGUNDOS) * 100) + '%' : '0%';
  $('cf-timer').textContent = meus.length ? mmss(resto) : '--:--';

  // cartões de "minhas reservas"
  document.querySelectorAll('[data-expira-de]').forEach((el) => {
    const s = segundosRestantes(holdsDoEvento(el.dataset.expiraDe));
    el.textContent = mmss(s);
  });
  document.querySelectorAll('[data-barra-de]').forEach((el) => {
    const s = segundosRestantes(holdsDoEvento(el.dataset.barraDe));
    el.style.width = Math.min(100, (s / LOCK_SEGUNDOS) * 100) + '%';
  });
}
setInterval(atualizarContagens, 1000);

// ---------- Início ----------
renderDestaque();
renderPills();
renderCards();
renderMapa();
renderPainel();
definirModo(false);
if (sessionStorage.getItem('seatlock_token') && sessionStorage.getItem('seatlock_usuario')) {
  definirUsuario(sessionStorage.getItem('seatlock_usuario'));
  goto('screen-events');
} else {
  goto('screen-login');
}
