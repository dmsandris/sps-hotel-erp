import { sb, q, rpc, esc, fmtDate, toast, fail, modal, form, can, state, roomState, ROOM_LABEL, addDays } from '../core.js';
import { onData } from '../main.js';
import { statusTag, roomTag, openReservation } from './shared.js';

export function boardHtml(rooms) {
  const floors = {};
  rooms.forEach((r) => (floors[r.floor] = floors[r.floor] || []).push(r));
  const legend = `<div class="legend" style="margin-bottom:10px">
    <span><i style="background:var(--st-ready)"></i>Ready</span><span><i style="background:var(--st-clean)"></i>Tunggu inspeksi</span>
    <span><i style="background:var(--st-cleaning)"></i>Dibersihkan</span><span><i style="background:var(--st-dirty)"></i>Kotor</span>
    <span><i style="background:var(--st-occ)"></i>Terisi</span><span><i style="background:var(--st-ooo)"></i>OOO</span></div>`;
  return legend + Object.keys(floors).sort().map((f) => `<div class="board-floor"><h4>Lantai ${esc(f)}</h4><div class="rooms">
    ${floors[f].map((r) => {
      const s = roomState(r);
      const sub = s === 'OCC' && r.hk_status !== 'INSPECTED' ? ` dirtyocc` : '';
      return `<div class="room ${s}${sub}" data-room="${r.id}" title="${esc(r.number)} · ${ROOM_LABEL[s]}">
        <div class="n">${esc(r.number)}</div><div class="ty">${esc(r.room_types?.code || '')}</div><div class="st">${ROOM_LABEL[s]}</div></div>`;
    }).join('')}</div></div>`).join('');
}

export function bindBoard(el, rooms, reload) {
  el.querySelectorAll('[data-room]').forEach((c) => c.onclick = () => roomModal(rooms.find((r) => r.id === c.dataset.room), reload));
}

async function roomModal(room, reload) {
  let res = [], tasks = [], hist = [], blocks = [];
  try {
    [res, tasks, hist, blocks] = await Promise.all([
      q(sb.from('reservations').select('id, confirmation_no, status, check_in, check_out, guests(full_name)').eq('room_id', room.id).in('status', ['CONFIRMED', 'IN_HOUSE']).order('check_in')),
      q(sb.from('hk_tasks').select('*, profiles(full_name)').eq('room_id', room.id).order('created_at', { ascending: false }).limit(5)),
      q(sb.from('room_status_history').select('*').eq('room_id', room.id).order('changed_at', { ascending: false }).limit(6)),
      q(sb.from('room_assignments').select('*').eq('room_id', room.id).eq('kind', 'OOO').eq('is_active', true))
    ]);
  } catch (e) { return fail(e); }
  const bd = state.property.business_date;
  const acts = [];
  if (can('hk_supervisor')) {
    if (blocks.length || room.hk_status === 'OOO') acts.push({ label: 'Selesai perbaikan (lepas OOO)', cls: 'ok', run: async () => { await rpc('release_room_ooo', { p_room: room.id }); toast('OOO dilepas, kamar masuk antrian HK.', 'ok'); reload(); } });
    else acts.push({ label: 'Set Out-of-Order', cls: 'bad', run: () => { oooModal(room, bd, reload); } });
  }
  modal({
    title: `Kamar ${room.number} · ${room.room_types?.name || ''}`, wide: true,
    body: `<div class="grid g2"><div>
      <div class="sum-row"><span class="muted">Status</span><span>${roomTag(room)} ${statusTag(room.fo_status)}</span></div>
      <div class="sum-row"><span class="muted">Lantai</span><span>${room.floor}</span></div>
      <h4 class="mt">Reservasi aktif</h4>
      ${res.map((r) => `<div class="sum-row"><a href="#" data-r="${r.id}">${esc(r.guests?.full_name)} · ${esc(r.confirmation_no)}</a><span>${fmtDate(r.check_in)}–${fmtDate(r.check_out)} ${statusTag(r.status)}</span></div>`).join('') || '<p class="muted">Tidak ada.</p>'}
      ${blocks.map((b) => `<div class="alert">OOO ${esc(b.stay_range)} · ${esc(b.reason || '')}</div>`).join('')}
      </div><div>
      <h4>Tugas HK terakhir</h4>
      ${tasks.map((t) => `<div class="sum-row"><span>${esc(t.task_type)} · ${esc(t.profiles?.full_name || 'belum ditugaskan')}</span>${statusTag(t.status)}</div>`).join('') || '<p class="muted">Belum ada.</p>'}
      <h4 class="mt">Riwayat status</h4>
      ${hist.map((h) => `<div class="sum-row"><small>${esc(h.from_status)} → <b>${esc(h.to_status)}</b></small><small class="muted">${new Date(h.changed_at).toLocaleString('id-ID')}</small></div>`).join('') || '<p class="muted">-</p>'}
      </div></div>`,
    actions: acts,
    onMount: (m, close) => m.querySelectorAll('[data-r]').forEach((a) => a.onclick = (e) => { e.preventDefault(); close(); openReservation(a.dataset.r, reload); })
  });
}

function oooModal(room, bd, reload) {
  modal({
    title: 'Out-of-Order · Kamar ' + room.number,
    body: `<p class="muted">Kamar dikeluarkan dari inventori jual untuk rentang ini.</p>
      <div class="row"><label class="f">Dari<input type="date" name="f" value="${bd}"></label><label class="f">Sampai (eksklusif)<input type="date" name="t" value="${addDays(bd, 1)}"></label></div>
      <label class="f">Alasan<input name="r" required placeholder="mis. AC bocor"></label>`,
    actions: [{ label: 'Simpan OOO', cls: 'bad', run: async (el) => {
      const f = form(el); if (!f.r) { toast('Alasan wajib.', 'err'); return false; }
      await rpc('set_room_ooo', { p_room: room.id, p_from: f.f, p_to: f.t, p_reason: f.r });
      toast('Kamar di-set OOO.', 'ok'); reload();
    } }]
  });
}

export async function render(el) {
  let filter = '';
  async function load() {
    try {
      const [rooms, types] = await Promise.all([
        q(sb.from('rooms').select('*, room_types(code, name)').order('floor').order('number')),
        q(sb.from('room_types').select('*').order('sort_order'))
      ]);
      const list = filter ? rooms.filter((r) => r.room_type_id === filter) : rooms;
      const cnt = {}; list.forEach((r) => { const s = roomState(r); cnt[s] = (cnt[s] || 0) + 1; });
      el.innerHTML = `<div class="tabs"><button data-f="" class="${filter ? '' : 'on'}">Semua (${rooms.length})</button>
        ${types.map((t) => `<button data-f="${t.id}" class="${filter === t.id ? 'on' : ''}">${esc(t.name)}</button>`).join('')}</div>
        <div class="kpis">${['READY', 'CLEAN', 'CLEANING', 'DIRTY', 'OCC', 'OOO'].map((s) => `<div class="kpi"><div class="l">${ROOM_LABEL[s]}</div><div class="v">${cnt[s] || 0}</div></div>`).join('')}</div>
        <div class="card"><div class="bd">${boardHtml(list)}</div></div>`;
      el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { filter = b.dataset.f; load(); });
      bindBoard(el, list, load);
    } catch (e) { fail(e); }
  }
  await load();
  const rid = new URLSearchParams(location.hash.split('?')[1] || '').get('room');
  if (rid) { const r = (await q(sb.from('rooms').select('*, room_types(code, name)').eq('id', rid))).at(0); if (r) roomModal(r, load); }
  return onData(load);
}
