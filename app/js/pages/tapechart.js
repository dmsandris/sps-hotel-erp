// Kalender kamar (tape chart): baris = kamar, kolom = tanggal, batang = menginap.
import { sb, q, rpc, esc, toast, fail, can, state, addDays, fmtDate } from '../core.js';
import { onData } from '../main.js';
import { openReservation, statusTag } from './shared.js';
import { icon, bindTips } from '../ui.js';

const CELL = 66;
const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export async function render(el) {
  const bd = state.property.business_date;
  let from = addDays(bd, -2), days = 14, picked = null;

  async function load() {
    const to = addDays(from, days);
    try {
      const [rooms, types, res, ooo, inv] = await Promise.all([
        q(sb.from('rooms').select('id, number, floor, room_type_id, hk_status, fo_status').order('number')),
        q(sb.from('room_types').select('*').order('sort_order')),
        q(sb.from('reservations').select('id, confirmation_no, status, check_in, check_out, room_id, room_type_id, adults, group_id, channel, guests(full_name, vip_level)')
          .in('status', ['PENDING_PAYMENT', 'CONFIRMED', 'IN_HOUSE', 'CHECKED_OUT']).lt('check_in', to).gt('check_out', from).limit(1000)),
        q(sb.from('room_assignments').select('id, room_id, stay_range, reason').eq('kind', 'OOO').eq('is_active', true)),
        q(sb.from('room_type_inventory').select('room_type_id, stay_date, total_rooms, out_of_order, sold, held').gte('stay_date', from).lt('stay_date', to))
      ]);
      const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
      const idx = (d) => dates.indexOf(d);
      const invMap = {}; inv.forEach((i) => { invMap[i.room_type_id + i.stay_date] = i; });
      const unassigned = res.filter((r) => !r.room_id && ['PENDING_PAYMENT', 'CONFIRMED'].includes(r.status));
      const byRoom = {}; res.filter((r) => r.room_id).forEach((r) => (byRoom[r.room_id] = byRoom[r.room_id] || []).push(r));
      const oooBy = {}; ooo.forEach((a) => { const m = a.stay_range.match(/[[(]([\d-]+),([\d-]+)/); if (m) (oooBy[a.room_id] = oooBy[a.room_id] || []).push({ ci: m[1], co: m[2], reason: a.reason }); });

      const bar = (ci, co, cls, label, attrs) => {
        const s = ci < from ? 0 : idx(ci), e = co > to ? days : idx(co);
        if (s < 0 || e <= s) return '';
        return { s, html: `<div class="bar ${cls}" style="width:${(e - s) * CELL - 6}px" ${attrs}>${label}</div>` };
      };
      const head = dates.map((d) => {
        const dt = new Date(d + 'T12:00:00'), we = [0, 6].includes(dt.getDay());
        return `<th class="${d === bd ? 'today' : ''} ${we ? 'we' : ''}" style="width:${CELL}px">${DOW[dt.getDay()]}<br>${dt.getDate()}/${dt.getMonth() + 1}</th>`;
      }).join('');

      let body = '';
      types.forEach((t) => {
        const tr = rooms.filter((r) => r.room_type_id === t.id);
        if (!tr.length) return;
        body += `<tr class="type"><td class="rh">${esc(t.name)}</td>${dates.map((d) => {
          const i = invMap[t.id + d]; const av = i ? i.total_rooms - i.out_of_order - i.sold - i.held : tr.length;
          return `<td class="center" data-tip="${esc(t.name)} ${fmtDate(d)}: sisa ${av} dari ${i ? i.total_rooms - i.out_of_order : tr.length}" style="color:${av <= 0 ? 'var(--st-dirty)' : 'inherit'}">${av}</td>`;
        }).join('')}</tr>`;
        tr.forEach((rm) => {
          const bars = {};
          (byRoom[rm.id] || []).forEach((r) => {
            const vip = r.guests?.vip_level > 0 ? ' vip' : '', grp = r.group_id ? ' grp' : '';
            const b = bar(r.check_in, r.check_out, r.status + vip + grp, esc(r.guests?.full_name || r.confirmation_no),
              `data-res="${r.id}" data-tip="${esc(r.guests?.full_name)} · ${esc(r.confirmation_no)}<br>${fmtDate(r.check_in)} → ${fmtDate(r.check_out)} · ${esc(r.status)}"`);
            if (b) bars[b.s] = (bars[b.s] || '') + b.html;
          });
          (oooBy[rm.id] || []).forEach((o) => {
            const b = bar(o.ci, o.co, 'OOO', 'OOO', `data-tip="Out of order: ${esc(o.reason || '')}"`);
            if (b) bars[b.s] = (bars[b.s] || '') + b.html;
          });
          const dot = rm.hk_status === 'INSPECTED' ? 'var(--st-ready)' : rm.hk_status === 'CLEAN' ? 'var(--st-clean)' : rm.hk_status === 'OOO' ? 'var(--st-ooo)' : 'var(--st-dirty)';
          body += `<tr><td class="rh"><span class="dot" style="background:${dot}" title="${esc(rm.hk_status)}"></span>${esc(rm.number)}<small>lt ${rm.floor}</small></td>
            ${dates.map((d, i) => `<td class="cell ${d === bd ? 'today' : ''}" data-room="${rm.id}" data-type="${rm.room_type_id}" data-d="${d}">${bars[i] || ''}</td>`).join('')}</tr>`;
        });
      });

      el.innerHTML = `
        <div class="card mb"><div class="bd row" style="justify-content:space-between">
          <div class="row">
            <button class="btn sm" id="prev">${'‹'} ${days} hari</button>
            <button class="btn sm" id="today">Hari ini</button>
            <button class="btn sm" id="next">${days} hari ›</button>
            <input type="date" id="from" value="${from}">
            <div class="seg">${[7, 14, 30].map((n) => `<button data-days="${n}" class="${n === days ? 'on' : ''}">${n}h</button>`).join('')}</div>
          </div>
          <div class="legend"><span><i style="background:#a855f7"></i>Confirmed</span><span><i style="background:#5b0aa8"></i>In-house</span>
            <span><i style="background:#f59e0b"></i>Hold</span><span><i style="background:#94a3b8"></i>Checked-out</span><span><i style="background:#71717a"></i>OOO</span>
            <span>⧉ Grup</span></div>
        </div></div>
        ${unassigned.length ? `<div class="card mb"><div class="hd"><h3>Belum dapat kamar (${unassigned.length})</h3><span class="sub">Pilih reservasi, lalu klik sel kamar bertipe sama untuk menetapkan.</span></div>
          <div class="bd unassigned">${unassigned.map((r) => `<button class="chip ${picked === r.id ? 'on' : ''}" data-pick="${r.id}">
            <b>${esc(r.guests?.full_name)}</b> · ${esc(types.find((t) => t.id === r.room_type_id)?.code || '')} · ${fmtDate(r.check_in)}–${fmtDate(r.check_out)} ${r.status === 'PENDING_PAYMENT' ? statusTag('PENDING_PAYMENT') : ''}</button>`).join('')}
            ${can('fo') ? `<button class="btn sm" id="auto">Tetapkan otomatis semua yang tiba ≤ besok</button>` : ''}</div></div>` : ''}
        <div class="card"><div class="tape"><table><thead><tr><th class="rh">Kamar</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
          <div class="bd muted small">Klik sel kosong untuk reservasi baru di kamar & tanggal itu. Klik batang untuk detail. Titik warna = status kebersihan kamar saat ini.</div></div>`;

      bindTips(el);
      el.querySelector('#prev').onclick = () => { from = addDays(from, -days); load(); };
      el.querySelector('#next').onclick = () => { from = addDays(from, days); load(); };
      el.querySelector('#today').onclick = () => { from = addDays(bd, -2); load(); };
      el.querySelector('#from').onchange = (e) => { from = e.target.value; load(); };
      el.querySelectorAll('[data-days]').forEach((b) => b.onclick = () => { days = +b.dataset.days; load(); });
      el.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { picked = picked === b.dataset.pick ? null : b.dataset.pick; load(); });
      el.querySelectorAll('[data-res]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openReservation(b.dataset.res, load); });
      const au = el.querySelector('#auto');
      if (au) au.onclick = async () => {
        const list = unassigned.filter((r) => r.status === 'CONFIRMED' && r.check_in <= addDays(bd, 1));
        let n = 0;
        for (const r of list) { try { await rpc('assign_room', { p_reservation: r.id, p_room: null }); n++; } catch (e) { fail(e); } }
        toast(`${n} reservasi mendapat kamar.`, 'ok'); load();
      };
      el.querySelectorAll('td.cell').forEach((c) => c.onclick = async () => {
        if (c.querySelector('.bar')) return;
        if (picked) {
          const r = unassigned.find((x) => x.id === picked);
          if (r.room_type_id !== c.dataset.type) return toast('Tipe kamar tidak cocok dengan reservasi.', 'err');
          if (r.status !== 'CONFIRMED') return toast('Konfirmasi hold dulu sebelum menetapkan kamar.', 'err');
          try { await rpc('assign_room', { p_reservation: r.id, p_room: c.dataset.room }); toast('Kamar ditetapkan.', 'ok'); picked = null; load(); } catch (e) { fail(e); }
          return;
        }
        if (!can('fo', 'cashier') || c.dataset.d < bd) return;
        const m = await import('./reservations.js');
        m.newBooking({ room_type_id: c.dataset.type, check_in: c.dataset.d, room_id: c.dataset.room }, load);
      });
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
  return onData(load);
}
