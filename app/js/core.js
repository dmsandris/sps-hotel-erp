// Inti aplikasi: klien Supabase, state sesi, helper UI.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

function readConfig() {
  const c = window.SPS_CONFIG || {};
  let url = c.SUPABASE_URL, key = c.SUPABASE_ANON_KEY;
  if (!url || !key) {
    try {
      url = url || localStorage.getItem('sps.url') || '';
      key = key || localStorage.getItem('sps.key') || '';
    } catch (e) { /* storage diblok */ }
  }
  return { url, key };
}

export const cfg = readConfig();
export const sb = cfg.url && cfg.key ? createClient(cfg.url, cfg.key) : null;

export const state = { session: null, profile: null, property: null };

// ---------- format ----------
const idr = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
export const rp = (n) => { if (n == null || n === '' || isNaN(n)) return '-'; const v = Math.round(Number(n)); return (v < 0 ? '-Rp ' : 'Rp ') + idr.format(Math.abs(v)); };
export const num = (n) => (n == null ? '-' : idr.format(Number(n)));
export const fmtDate = (d) => d ? new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
export const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short' });
export const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
export const addDays = (d, n) => {   // tanpa toISOString: hindari geser hari akibat zona waktu (WIB = UTC+7)
  const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
};
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---------- pesan error domain -> bahasa manusia ----------
const ERR = {
  SOLD_OUT: 'Kamar tipe ini sudah penuh untuk tanggal tersebut.',
  ROOM_CONFLICT: 'Kamar sudah dipakai reservasi lain di tanggal itu. Pilih kamar lain.',
  NO_ROOM_AVAILABLE: 'Tidak ada nomor kamar kosong untuk tipe & tanggal ini.',
  HOLD_EXPIRED_OR_INVALID: 'Waktu tahan (hold) 15 menit sudah habis. Buat reservasi ulang.',
  CANNOT_EXTEND: 'Hold tidak bisa diperpanjang lagi.',
  CHECKIN_IN_PAST: 'Tanggal check-in tidak boleh sebelum business date.',
  INVALID_DATES: 'Tanggal tidak valid (maks. 30 malam).',
  GUEST_NAME_REQUIRED: 'Nama tamu wajib diisi.',
  ROOM_OCCUPIED: 'Kamar masih terisi.',
  EARLY_ARRIVAL_DATE: 'Tanggal check-in reservasi belum tiba.',
  FOLIO_CLOSED: 'Folio sudah ditutup.',
  NO_INHOUSE_GUEST_IN_ROOM: 'Tidak ada tamu in-house di kamar itu.',
  NOT_YOUR_TASK: 'Tugas ini milik staf lain.',
  NOTES_REQUIRED_ON_FAIL: 'Catatan wajib diisi bila inspeksi gagal.',
  REASON_REQUIRED: 'Alasan wajib diisi.',
  ALREADY_REVERSED: 'Posting ini sudah di-void.',
  ROOM_HAS_BOOKING_IN_RANGE: 'Kamar punya reservasi di rentang tanggal itu.',
  CANNOT_OOO_INVENTORY_FULL: 'Tidak bisa OOO: inventori tipe kamar sudah terjual penuh.',
  ROOM_TYPE_MISMATCH: 'Tipe kamar tidak sesuai reservasi.',
  ROOM_NOT_READY: 'Kamar tujuan belum READY.',
  USE_ROOM_MOVE: 'Tamu sudah in-house, gunakan Pindah Kamar.',
  REFUND_EXCEEDS_CREDIT: 'Refund melebihi saldo kredit tamu.',
  FORBIDDEN: 'Anda tidak punya hak untuk aksi ini.'
};
export function errText(e) {
  const m = (e && (e.message || e.error_description || e.details)) || String(e);
  for (const k of Object.keys(ERR)) if (m.includes(k)) return ERR[k];
  let x;
  if ((x = m.match(/FOLIO_UNSETTLED_([\d.]+)/))) return 'Folio belum lunas: ' + rp(x[1]);
  if ((x = m.match(/FOLIO_CREDIT_([\d.]+)/))) return 'Tamu punya saldo kredit ' + rp(x[1]) + ' — lakukan refund dulu.';
  if ((x = m.match(/ROOM_NOT_READY_(\w+)/))) return 'Kamar belum siap (status ' + x[1] + '). Minta prioritas inspeksi atau override supervisor.';
  if ((x = m.match(/MIN_LOS_(\d+)/))) return 'Minimal menginap ' + x[1] + ' malam untuk tanggal ini.';
  if ((x = m.match(/INVALID_STATUS_(\w+)/))) return 'Status saat ini (' + x[1] + ') tidak mengizinkan aksi ini.';
  return m;
}

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// ---------- toast & modal ----------
export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}
export const fail = (e) => { console.error(e); toast(errText(e), 'err'); };

export function modal({ title, body, actions = [], wide = false, onMount }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="hd"><h3>${esc(title)}</h3><button class="btn ghost sm x" data-x>Tutup</button></div>
    <div class="bd">${body}</div>
    ${actions.length ? `<div class="ft">${actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
  </div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.closest('[data-x]')) return close();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = actions[+b.dataset.a];
    b.disabled = true;
    try { const r = await a.run(bg.querySelector('.modal'), close); if (r !== false) close(); }
    catch (err) { fail(err); }
    finally { b.disabled = false; }
  });
  document.body.appendChild(bg);
  if (onMount) onMount(bg.querySelector('.modal'), close);
  const f = bg.querySelector('input,select,textarea'); if (f) f.focus();
  return { el: bg.querySelector('.modal'), close };
}

export function confirmBox(title, text, okLabel = 'Ya, lanjutkan', cls = 'pri') {
  return new Promise((res) => {
    modal({ title, body: `<p>${text}</p>`, actions: [
      { label: 'Batal', run: () => res(false) },
      { label: okLabel, cls, run: () => res(true) }] });
  });
}

export function form(el) {
  const o = {};
  el.querySelectorAll('[name]').forEach((i) => { o[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
  return o;
}

export const can = (...roles) => state.profile && (state.profile.role === 'admin' || roles.includes(state.profile.role));
export const ROLE_LABEL = { admin: 'Administrator', fo: 'Front Office', hk_supervisor: 'HK Supervisor',
  room_attendant: 'Room Attendant', cashier: 'Kasir / Outlet', finance: 'Finance', viewer: 'Viewer (menunggu role)' };

export function roomState(r) {
  if (r.hk_status === 'OOO') return 'OOO';
  if (r.fo_status === 'OCCUPIED') return 'OCC';
  if (r.hk_status === 'INSPECTED') return 'READY';
  return r.hk_status; // DIRTY / CLEANING / CLEAN
}
export const ROOM_LABEL = { READY: 'Ready', CLEAN: 'Tunggu inspeksi', DIRTY: 'Kotor', CLEANING: 'Dibersihkan', OCC: 'Terisi', OOO: 'Rusak (OOO)' };
