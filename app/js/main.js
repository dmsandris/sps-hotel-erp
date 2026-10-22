import { sb, state, esc, toast, fail, ROLE_LABEL, rpc, fmtDate, q } from './core.js';
import { icon, applyTheme, getTheme, toggleTheme, initials } from './ui.js';

applyTheme(getTheme());

const ROUTES = [
  { path: 'dashboard',  label: 'Dasbor',            icon: 'dash',    grp: 'Front Office', roles: ['fo', 'cashier', 'finance', 'viewer', 'hk_supervisor'], mod: './pages/dashboard.js', mob: 1 },
  { path: 'tapechart',  label: 'Kalender Kamar',    icon: 'tape',    grp: 'Front Office', roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/tapechart.js', mob: 1 },
  { path: 'reservasi',  label: 'Reservasi & Grup',  icon: 'res',     grp: 'Front Office', roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/reservations.js' },
  { path: 'tamu',       label: 'Tamu (CRM)',        icon: 'guest',   grp: 'Front Office', roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/guests.js' },
  { path: 'kamar',      label: 'Papan Kamar',       icon: 'room',    grp: 'Operasional',  roles: ['fo', 'cashier', 'finance', 'viewer', 'hk_supervisor', 'room_attendant'], mod: './pages/rooms.js', mob: 1 },
  { path: 'hk',         label: 'Tugas Saya (HK)',   icon: 'hk',      grp: 'Operasional',  roles: ['room_attendant', 'hk_supervisor'], mod: './pages/housekeeping.js', mob: 1 },
  { path: 'inspeksi',   label: 'Inspeksi & Tim HK', icon: 'insp',    grp: 'Operasional',  roles: ['hk_supervisor'], mod: './pages/inspection.js' },
  { path: 'laundry',    label: 'Laundry',           icon: 'laundry', grp: 'Operasional',  roles: ['fo', 'cashier', 'hk_supervisor', 'room_attendant'], mod: './pages/laundry.js' },
  { path: 'fasilitas',  label: 'Fasilitas',         icon: 'fac',     grp: 'Layanan',      roles: ['fo', 'cashier', 'viewer'], mod: './pages/facilities.js' },
  { path: 'event',      label: 'Meeting & Event',   icon: 'event',   grp: 'Layanan',      roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/events.js' },
  { path: 'breakfast',  label: 'Breakfast',         icon: 'bf',      grp: 'Layanan',      roles: ['fo', 'cashier'], mod: './pages/breakfast.js' },
  { path: 'outlet',     label: 'Outlet / POS',      icon: 'pos',     grp: 'Layanan',      roles: ['fo', 'cashier', 'finance'], mod: './pages/outlet.js' },
  { path: 'folio',      label: 'Folio & Billing',   icon: 'folio',   grp: 'Keuangan',     roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/folio.js', mob: 1 },
  { path: 'shift',      label: 'Shift Kasir',       icon: 'shift',   grp: 'Keuangan',     roles: ['fo', 'cashier', 'finance'], mod: './pages/shift.js' },
  { path: 'perusahaan', label: 'Perusahaan & AR',   icon: 'company', grp: 'Keuangan',     roles: ['fo', 'finance', 'viewer'], mod: './pages/companies.js' },
  { path: 'gl',         label: 'Buku Besar (GL)',   icon: 'gl',      grp: 'Keuangan',     roles: ['finance'], mod: './pages/gl.js' },
  { path: 'laporan',    label: 'Laporan & Analitik',icon: 'report',  grp: 'Manajemen',    roles: ['fo', 'finance', 'viewer', 'hk_supervisor'], mod: './pages/reports.js' },
  { path: 'harga',      label: 'Harga Dinamis',     icon: 'price',   grp: 'Manajemen',    roles: ['fo', 'finance', 'viewer'], mod: './pages/pricing.js' },
  { path: 'pengaturan', label: 'Pengaturan',        icon: 'set',     grp: 'Manajemen',    roles: [], mod: './pages/settings.js' }
];
const allowed = (r) => state.profile && (state.profile.role === 'admin' || r.roles.includes(state.profile.role));

const app = document.getElementById('app');
let cleanup = null;
let realtimeCh = null;

const LOGIN_FEATS = ['Kalender kamar', 'Harga dinamis', 'Anti double-booking', 'Housekeeping real-time', 'Folio terpadu', 'Fasilitas & event', 'City ledger & GL', 'Laporan RevPAR'];

// ---------------------------------------------------------------- setup
function renderSetup() {
  app.innerHTML = `<div class="login"><div class="art"><img src="assets/logo-sps-white.png" alt="Sirius Parama Sistem">
    <p>Hotel ERP All-in-One — konfigurasi awal</p></div>
    <div class="form"><div class="box">
      <h2 class="display">Hubungkan Supabase</h2>
      <p class="muted">Isi dari Supabase &rarr; Project Settings &rarr; API. Disimpan di browser ini saja. Untuk produksi, set lewat GitHub Variables (lihat README).</p>
      <label class="f">Project URL<input id="u" placeholder="https://xxxx.supabase.co"></label>
      <label class="f">Anon public key<textarea id="k" rows="3" placeholder="eyJhbGciOi..."></textarea></label>
      <button class="btn pri lg" id="save">Simpan & muat ulang</button>
    </div></div></div>`;
  document.getElementById('save').onclick = () => {
    try {
      localStorage.setItem('sps.url', document.getElementById('u').value.trim());
      localStorage.setItem('sps.key', document.getElementById('k').value.trim());
      location.reload();
    } catch (e) { toast('Browser memblokir penyimpanan lokal.', 'err'); }
  };
}

// ---------------------------------------------------------------- login
function renderLogin() {
  app.innerHTML = `<div class="login"><div class="art"><img src="assets/logo-sps-white.png" alt="Sirius Parama Sistem">
    <p>Satu sistem untuk reservasi, front desk, housekeeping, F&amp;B, fasilitas, event, dan keuangan hotel.</p>
    <div class="feat">${LOGIN_FEATS.map((f) => `<span>${f}</span>`).join('')}</div></div>
    <div class="form"><div class="box">
      <h2 class="display">Masuk</h2><p class="muted" style="margin-top:0">SPS Hotel ERP</p>
      <form id="lf">
        <label class="f">Email<input name="email" type="email" required autocomplete="username"></label>
        <label class="f">Password<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
        <label class="f" id="nm" hidden>Nama lengkap<input name="full_name"></label>
        <button class="btn pri lg" id="go">Masuk</button>
      </form>
      <p class="muted" style="font-size:12.5px">Belum punya akun? <a href="#" id="sw">Daftar</a>. Akun pertama otomatis menjadi Administrator; akun berikutnya menunggu role dari admin.</p>
    </div></div></div>`;
  let signup = false;
  const f = document.getElementById('lf');
  document.getElementById('sw').onclick = (e) => {
    e.preventDefault(); signup = !signup;
    document.getElementById('nm').hidden = !signup;
    document.getElementById('go').textContent = signup ? 'Daftar' : 'Masuk';
    e.target.textContent = signup ? 'Masuk' : 'Daftar';
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const b = document.getElementById('go'); b.disabled = true;
    try {
      if (signup) {
        const { data, error } = await sb.auth.signUp({ email: d.email, password: d.password, options: { data: { full_name: d.full_name } } });
        if (error) throw error;
        if (!data.session) toast('Cek email untuk konfirmasi akun, lalu masuk.', 'ok');
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: d.email, password: d.password });
        if (error) throw error;
      }
    } catch (err) { fail(err); } finally { b.disabled = false; }
  };
}

// ---------------------------------------------------------------- shell
async function loadProfile() {
  const uidv = state.session.user.id;
  state.profile = (await q(sb.from('profiles').select('*').eq('user_id', uidv).maybeSingle())) || null;
  state.property = state.profile?.property_id
    ? await q(sb.from('properties').select('*').eq('id', state.profile.property_id).maybeSingle()) : null;
}

const isMini = () => { try { return localStorage.getItem('sps.mini') === '1'; } catch (e) { return false; } };

function renderShell() {
  const p = state.profile;
  const routes = ROUTES.filter(allowed);
  let lastGrp = '';
  const nav = routes.map((r) => {
    const g = r.grp !== lastGrp ? `<div class="grp">${r.grp}</div>` : '';
    lastGrp = r.grp;
    return `${g}<a href="#/${r.path}" data-p="${r.path}" title="${r.label}">${icon(r.icon)}<span>${r.label}</span></a>`;
  }).join('');
  const mob = routes.filter((r) => r.mob).slice(0, 4);
  const name = p?.full_name || state.session.user.email;
  app.innerHTML = `<div class="shell ${isMini() ? 'mini' : ''}" id="shell">
    <aside class="side" id="side">
      <div class="brand"><a class="logo" href="#/"><img src="assets/icon-sps.png" alt=""><span>Sirius Parama Sistem</span></a><small>Hotel ERP · ${esc(state.property?.name || '-')}</small></div>
      <nav>${nav || '<p class="muted" style="padding:12px">Belum ada menu untuk role Anda.</p>'}</nav>
      <div class="me"><div class="av">${esc(initials(name))}</div><div class="who"><b>${esc(name)}</b><small>${esc(ROLE_LABEL[p?.role] || '-')}</small></div>
        <button class="icon-btn" id="out" title="Keluar" style="background:var(--side-2);border-color:var(--side-3);color:var(--side-ink)">${icon('out')}</button></div>
    </aside>
    <div class="main">
      <header class="top">
        <button class="icon-btn menu-btn" id="mb" title="Menu">${icon('menu')}</button>
        <button class="icon-btn collapse-btn" id="cb" title="Ciutkan menu">${icon('side')}</button>
        <div><div class="crumb" id="crumb"></div><h1 class="display" id="ttl"></h1></div>
        <div class="sp">
          <button class="search-btn" id="sbtn">${icon('search')}<span>Cari tamu, kamar, reservasi…</span><kbd>Ctrl K</kbd></button>
          <span class="bd" id="bd">Business date <b>${fmtDate(state.property?.business_date)}</b></span>
          <button class="icon-btn" id="theme" title="Tema terang/gelap">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
        </div>
      </header>
      <div class="content" id="view"></div>
    </div>
    <nav class="bottom-nav">${mob.map((r) => `<a href="#/${r.path}" data-p="${r.path}">${icon(r.icon)}${r.label.split(' ')[0]}</a>`).join('')}
      <a href="#" id="bmore">${icon('menu')}Menu</a></nav>
  </div>`;
  document.getElementById('out').onclick = () => sb.auth.signOut();
  document.getElementById('mb').onclick = () => document.getElementById('side').classList.toggle('open');
  document.getElementById('bmore').onclick = (e) => { e.preventDefault(); document.getElementById('side').classList.toggle('open'); };
  document.getElementById('cb').onclick = () => {
    const s = document.getElementById('shell'); s.classList.toggle('mini');
    try { localStorage.setItem('sps.mini', s.classList.contains('mini') ? '1' : '0'); } catch (e) { /* abaikan */ }
  };
  document.getElementById('theme').onclick = (e) => { const t = toggleTheme(); e.currentTarget.innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); };
  document.getElementById('sbtn').onclick = openPalette;
  if (!routes.length) {
    document.getElementById('ttl').textContent = 'Menunggu akses';
    document.getElementById('view').innerHTML = `<div class="card"><div class="bd"><p>Akun Anda (<b>${esc(state.session.user.email)}</b>) sudah terdaftar dengan role <b>Viewer</b>.
      Minta Administrator membuka menu <b>Pengaturan</b> dan memberi role yang sesuai.</p></div></div>`;
  }
}

export async function refreshProperty() {
  state.property = await q(sb.from('properties').select('*').eq('id', state.profile.property_id).maybeSingle());
  const el = document.getElementById('bd');
  if (el) el.innerHTML = 'Business date <b>' + fmtDate(state.property?.business_date) + '</b>';
}

const listeners = new Set();
export const onData = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function startRealtime() {
  if (realtimeCh) sb.removeChannel(realtimeCh);
  let t = null;
  const fire = (payload) => { clearTimeout(t); t = setTimeout(() => listeners.forEach((fn) => fn(payload)), 400); };
  realtimeCh = sb.channel('sps-live');
  ['rooms', 'hk_tasks', 'reservations', 'facility_bookings', 'laundry_orders', 'event_orders']
    .forEach((tb) => realtimeCh.on('postgres_changes', { event: '*', schema: 'public', table: tb }, fire));
  realtimeCh.subscribe();
}

// ---------------------------------------------------------------- palet pencarian (Ctrl+K)
const KIND = { reservation: 'Reservasi', guest: 'Tamu', room: 'Kamar', folio: 'Folio', company: 'Perusahaan', page: 'Menu' };
function openPalette() {
  if (!state.profile || document.querySelector('.palette')) return;
  const el = document.createElement('div');
  el.className = 'palette';
  el.innerHTML = `<div class="box"><input placeholder="Ketik nama tamu, no. konfirmasi, no. kamar, folio, perusahaan, atau menu…" autofocus>
    <div class="res"></div><div class="hint"><span><kbd>↑</kbd><kbd>↓</kbd> pilih</span><span><kbd>Enter</kbd> buka</span><span><kbd>Esc</kbd> tutup</span></div></div>`;
  document.body.appendChild(el);
  const inp = el.querySelector('input'), res = el.querySelector('.res');
  let items = [], sel = 0, t;
  const pages = ROUTES.filter(allowed).map((r) => ({ kind: 'page', id: r.path, label: r.label, sub: r.grp }));
  const draw = () => {
    res.innerHTML = items.map((x, i) => `<div class="it ${i === sel ? 'on' : ''}" data-i="${i}"><span class="k">${KIND[x.kind]}</span><div><b>${esc(x.label)}</b><small>${esc(x.sub || '')}</small></div></div>`).join('')
      || '<div class="empty">Ketik minimal 2 huruf.</div>';
    res.querySelectorAll('[data-i]').forEach((n) => n.onclick = () => go(items[+n.dataset.i]));
  };
  const close = () => { el.remove(); document.removeEventListener('keydown', key, true); };
  const go = async (x) => {
    if (!x) return; close();
    if (x.kind === 'page') { location.hash = '#/' + x.id; return; }
    if (x.kind === 'reservation') { (await import('./pages/shared.js')).openReservation(x.id, () => listeners.forEach((f) => f())); return; }
    if (x.kind === 'guest') { location.hash = '#/tamu?id=' + x.id; return; }
    if (x.kind === 'folio') { location.hash = '#/folio?id=' + x.id; return; }
    if (x.kind === 'company') { location.hash = '#/perusahaan?id=' + x.id; return; }
    if (x.kind === 'room') { location.hash = '#/kamar?room=' + x.id; return; }
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[sel]); }
  };
  document.addEventListener('keydown', key, true);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const s = inp.value.trim().toLowerCase();
    const pg = pages.filter((p) => s && p.label.toLowerCase().includes(s));
    items = pg; sel = 0; draw();
    if (s.length < 2) return;
    t = setTimeout(async () => {
      try { const r = await rpc('global_search', { p_q: s }); items = [...(r || []), ...pg]; sel = 0; draw(); }
      catch (err) { items = pg; draw(); }
    }, 220);
  });
  items = pages.slice(0, 8); draw();
  setTimeout(() => inp.focus(), 10);
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
});

async function route() {
  if (!state.profile) return;
  const routes = ROUTES.filter(allowed);
  if (!routes.length) return;
  const want = (location.hash.replace(/^#\//, '').split('?')[0]) || '';
  let r = routes.find((x) => x.path === want);
  if (!r) {
    const def = state.profile.role === 'room_attendant' ? 'hk' : state.profile.role === 'hk_supervisor' ? 'inspeksi' : state.profile.role === 'finance' ? 'laporan' : 'dashboard';
    r = routes.find((x) => x.path === def) || routes[0];
    if (location.hash !== '#/' + r.path) { location.hash = '#/' + r.path; return; }
  }
  document.querySelectorAll('[data-p]').forEach((a) => a.classList.toggle('on', a.dataset.p === r.path));
  document.getElementById('side').classList.remove('open');
  document.getElementById('ttl').textContent = r.label;
  document.getElementById('crumb').textContent = r.grp;
  document.title = r.label + ' · SPS Hotel ERP';
  const view = document.getElementById('view');
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { /* abaikan */ } }
  cleanup = null;
  view.innerHTML = '<div class="skel" style="height:90px;margin-bottom:14px"></div><div class="skel" style="height:320px"></div>';
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
  try {
    const m = await import(r.mod);
    cleanup = await m.render(view);
  } catch (e) { fail(e); view.innerHTML = `<div class="alert err">${esc(e.message || e)}</div>`; }
}

// ---------------------------------------------------------------- boot
async function boot(session) {
  state.session = session;
  if (!session) { if (realtimeCh) { sb.removeChannel(realtimeCh); realtimeCh = null; } return renderLogin(); }
  try { await loadProfile(); } catch (e) { fail(e); }
  if (!state.profile) {
    app.innerHTML = '<div class="content"><div class="alert err">Profil tidak ditemukan. Pastikan migration sudah dijalankan (trigger on_auth_user_created) lalu daftar ulang.</div></div>';
    return;
  }
  renderShell();
  startRealtime();
  rpc('expire_holds').catch(() => {});   // jaring pengaman bila pg_cron belum aktif
  route();
}

if (!sb) {
  renderSetup();
} else {
  let started = false;
  sb.auth.onAuthStateChange((evt, session) => {
    if (evt === 'TOKEN_REFRESHED') { state.session = session; return; }
    if (evt === 'INITIAL_SESSION' || evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') {
      if (evt === 'SIGNED_IN' && started && state.session?.user?.id === session?.user?.id) return;
      started = true;
      boot(session);
    }
  });
  window.addEventListener('hashchange', route);
  setInterval(() => { if (state.session) rpc('expire_holds').catch(() => {}); }, 60000);
}
