import { sb, cfg, state, esc, toast, fail, ROLE_LABEL, rpc, fmtDate, q } from './core.js';

const ICON = {
  dash: '<path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z"/>',
  res: '<path d="M7 3v2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2V3h-2v2H9V3zm-2 7h14v9H5z"/>',
  room: '<path d="M4 4h16v16H4zm2 2v12h12V6zm2 2h3v3H8zm5 0h3v3h-3zm-5 5h3v3H8zm5 0h3v3h-3z"/>',
  hk: '<path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6zm-1 14-4-4 1.4-1.4L11 13.2l4.6-4.6L17 10z"/>',
  insp: '<path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/>',
  folio: '<path d="M6 2h9l5 5v15H6zm8 1.5V8h4.5zM8 12h8v2H8zm0 4h8v2H8z"/>',
  pos: '<path d="M3 3h18v4H3zm2 6h14v12H5zm3 3v2h8v-2z"/>',
  price: '<path d="M3 17l6-6 4 4 8-8v4h2V3h-8v2h4l-6 6-4-4-8 8z"/>',
  set: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1L11 21h4l.4-2.9a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>'
};
const svg = (k) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICON[k]}</svg>`;

const ROUTES = [
  { path: 'dashboard',  label: 'Dasbor Front Desk', icon: 'dash',  grp: 'Front Office', roles: ['fo', 'cashier', 'finance', 'viewer', 'hk_supervisor'], mod: './pages/dashboard.js' },
  { path: 'reservasi',  label: 'Reservasi',         icon: 'res',   grp: 'Front Office', roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/reservations.js' },
  { path: 'kamar',      label: 'Papan Kamar',       icon: 'room',  grp: 'Operasional',  roles: ['fo', 'cashier', 'finance', 'viewer', 'hk_supervisor', 'room_attendant'], mod: './pages/rooms.js' },
  { path: 'hk',         label: 'Tugas Saya (HK)',   icon: 'hk',    grp: 'Operasional',  roles: ['room_attendant', 'hk_supervisor'], mod: './pages/housekeeping.js' },
  { path: 'inspeksi',   label: 'Inspeksi & Tim HK', icon: 'insp',  grp: 'Operasional',  roles: ['hk_supervisor'], mod: './pages/inspection.js' },
  { path: 'folio',      label: 'Folio & Billing',   icon: 'folio', grp: 'Keuangan',     roles: ['fo', 'cashier', 'finance', 'viewer'], mod: './pages/folio.js' },
  { path: 'outlet',     label: 'Outlet / Charge',   icon: 'pos',   grp: 'Keuangan',     roles: ['fo', 'cashier', 'finance'], mod: './pages/outlet.js' },
  { path: 'harga',      label: 'Harga Dinamis',     icon: 'price', grp: 'Revenue',      roles: ['fo', 'finance', 'viewer'], mod: './pages/pricing.js' },
  { path: 'pengaturan', label: 'Pengaturan',        icon: 'set',   grp: 'Admin',        roles: [], mod: './pages/settings.js' }
];
const allowed = (r) => state.profile && (state.profile.role === 'admin' || r.roles.includes(state.profile.role));

const app = document.getElementById('app');
let cleanup = null;
let realtimeCh = null;

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
    <p>Reservasi, harga dinamis, housekeeping, front desk, dan folio terpadu dalam satu sistem.</p></div>
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

function renderShell() {
  const p = state.profile;
  const routes = ROUTES.filter(allowed);
  let lastGrp = '';
  const nav = routes.map((r) => {
    const g = r.grp !== lastGrp ? `<div class="grp">${r.grp}</div>` : '';
    lastGrp = r.grp;
    return `${g}<a href="#/${r.path}" data-p="${r.path}">${svg(r.icon)}<span>${r.label}</span></a>`;
  }).join('');
  app.innerHTML = `<div class="shell">
    <aside class="side" id="side">
      <div class="brand"><a class="logo" href="#/"><img src="assets/icon-sps.png" alt=""><span>Sirius Parama Sistem</span></a><small>Hotel ERP · ${esc(state.property?.name || '-')}</small></div>
      <nav>${nav || '<p class="muted" style="padding:12px">Belum ada menu untuk role Anda.</p>'}</nav>
      <div class="me"><b>${esc(p?.full_name || state.session.user.email)}</b>${esc(ROLE_LABEL[p?.role] || '-')}
        <button class="btn sm" id="out">Keluar</button></div>
    </aside>
    <div class="main">
      <header class="top"><button class="btn sm menu-btn" id="mb">Menu</button><h1 class="display" id="ttl"></h1>
        <span class="bd" id="bd">Business date: ${fmtDate(state.property?.business_date)}</span></header>
      <div class="content" id="view"></div>
    </div></div>`;
  document.getElementById('out').onclick = () => sb.auth.signOut();
  document.getElementById('mb').onclick = () => document.getElementById('side').classList.toggle('open');
  if (!routes.length) {
    document.getElementById('ttl').textContent = 'Menunggu akses';
    document.getElementById('view').innerHTML = `<div class="card"><div class="bd"><p>Akun Anda (<b>${esc(state.session.user.email)}</b>) sudah terdaftar dengan role <b>Viewer</b>.
      Minta Administrator membuka menu <b>Pengaturan</b> dan memberi role yang sesuai.</p></div></div>`;
  }
}

export async function refreshProperty() {
  state.property = await q(sb.from('properties').select('*').eq('id', state.profile.property_id).maybeSingle());
  const el = document.getElementById('bd');
  if (el) el.textContent = 'Business date: ' + fmtDate(state.property?.business_date);
}

const listeners = new Set();
export const onData = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function startRealtime() {
  if (realtimeCh) sb.removeChannel(realtimeCh);
  let t = null;
  const fire = (payload) => { clearTimeout(t); t = setTimeout(() => listeners.forEach((fn) => fn(payload)), 400); };
  realtimeCh = sb.channel('sps-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, fire)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'hk_tasks' }, fire)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, fire)
    .subscribe();
}

async function route() {
  if (!state.profile) return;
  const routes = ROUTES.filter(allowed);
  if (!routes.length) return;
  const want = (location.hash.replace(/^#\//, '').split('?')[0]) || '';
  let r = routes.find((x) => x.path === want);
  if (!r) {
    const def = state.profile.role === 'room_attendant' ? 'hk' : state.profile.role === 'hk_supervisor' ? 'inspeksi' : 'dashboard';
    r = routes.find((x) => x.path === def) || routes[0];
    if (location.hash !== '#/' + r.path) { location.hash = '#/' + r.path; return; }
  }
  document.querySelectorAll('.side nav a').forEach((a) => a.classList.toggle('on', a.dataset.p === r.path));
  document.getElementById('side').classList.remove('open');
  document.getElementById('ttl').textContent = r.label;
  const view = document.getElementById('view');
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { /* abaikan */ } }
  cleanup = null;
  view.innerHTML = '<p class="muted">Memuat…</p>';
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
