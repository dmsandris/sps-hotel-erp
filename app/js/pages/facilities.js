// Fasilitas: tennis (eksklusif per jam), gym & kolam (kapasitas), meeting room. Anti-bentrok di database.
import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, can, state, addDays, uid } from '../core.js';
import { onData } from '../main.js';
import { statusTag, PAY_METHODS } from './shared.js';
import { icon, bindTips, hhmm, emptyState } from '../ui.js';

const KIND = { TENNIS: 'Tennis', GYM: 'Gym', POOL: 'Kolam', MEETING: 'Meeting', SPA: 'Spa', OTHER: 'Lainnya' };
const pad = (n) => String(n).padStart(2, '0');

export async function render(el) {
  let date = state.property.business_date, kind = '';
  async function load() {
    try {
      const dayStart = new Date(date + 'T00:00:00'), dayEnd = new Date(addDays(date, 1) + 'T00:00:00');
      const [res, all, inh] = await Promise.all([
        q(sb.from('facility_resources').select('*').eq('is_active', true).order('sort_order')),
        q(sb.from('facility_bookings').select('*, event_orders(event_no, name)').neq('status', 'CANCELLED')
          .filter('time_range', 'ov', `[${dayStart.toISOString()},${dayEnd.toISOString()})`).limit(1000)),
        q(sb.from('reservations').select('rooms(number), guests(full_name)').eq('status', 'IN_HOUSE'))
      ]);
      const parse = (r) => { const m = r.match(/[[(]"?([^",]+)"?,"?([^")\]]+)"?[)\]]/); return m ? [new Date(m[1]), new Date(m[2])] : [null, null]; };
      const bookings = all.map((b) => { const [s, e] = parse(b.time_range); return { ...b, s, e }; }).filter((b) => b.s && b.s < dayEnd && b.e > dayStart);
      const list = kind ? res.filter((r) => r.kind === kind) : res;
      const hStart = Math.min(...list.map((r) => +r.open_time.slice(0, 2)), 6), hEnd = Math.max(...list.map((r) => Math.ceil(+r.close_time.slice(0, 2) + (+r.close_time.slice(3, 5) > 0 ? 1 : 0))), 22);
      const hours = Array.from({ length: Math.max(hEnd - hStart, 1) }, (_, i) => hStart + i);
      const now = new Date();

      const rows = list.map((r) => {
        const rb = bookings.filter((b) => b.resource_id === r.id);
        const cells = hours.map((h) => {
          const cs = new Date(`${date}T${pad(h)}:00:00`), ce = new Date(cs.getTime() + 3600e3);
          const open = h >= +r.open_time.slice(0, 2) && h < +r.close_time.slice(0, 2) + (+r.close_time.slice(3, 5) > 0 ? 1 : 0);
          const past = ce <= now;
          let inner = '';
          if (r.mode === 'EXCLUSIVE') {
            rb.filter((b) => b.s >= cs && b.s < ce || (h === hours[0] && b.s < cs && b.e > cs)).forEach((b) => {
              const startH = Math.max(b.s, new Date(`${date}T${pad(hours[0])}:00:00`));
              const span = Math.max((Math.min(b.e, dayEnd) - startH) / 3600e3, .5);
              const frac = Math.max((startH - cs) / 3600e3, 0);
              inner += `<div class="bk ${b.event_id ? 'ev' : ''} ${b.status === 'CHECKED_IN' ? 'ci' : ''}" data-b="${b.id}" style="left:calc(${frac * 100}% + 3px);width:calc(${span * 100}% + ${(Math.ceil(span) - 1)}px - 6px);right:auto"
                data-tip="${esc(b.guest_name)} · ${hhmm(b.s)}–${hhmm(b.e)}${b.amount > 0 ? ' · ' + rp(b.amount) : ''}">${esc(b.event_orders?.name || b.guest_name)}</div>`;
            });
          } else {
            const used = rb.filter((b) => b.s < ce && b.e > cs).reduce((a, b) => a + b.pax, 0);
            if (used) inner = `<div class="cap" data-tip="${used}/${r.capacity} orang"><i style="width:${Math.min(used / r.capacity, 1) * 100}%"></i><span>${used}/${r.capacity}</span></div>`;
          }
          return `<td class="slot ${!open ? 'past' : past ? 'past' : ''}" data-r="${r.id}" data-h="${h}" ${open && !past ? '' : 'data-closed="1"'}>${inner}</td>`;
        }).join('');
        return `<tr><td class="rh"><b>${esc(r.name)}</b><small>${KIND[r.kind]} · ${r.mode === 'EXCLUSIVE' ? 'per jam' : 'kapasitas ' + r.capacity} · tamu ${rp(r.rate_guest)} / umum ${rp(r.rate_public)}</small></td>${cells}</tr>`;
      }).join('');

      const todays = bookings.filter((b) => list.some((r) => r.id === b.resource_id)).sort((a, b) => a.s - b.s);
      el.innerHTML = `<div class="card mb"><div class="bd row" style="justify-content:space-between">
          <div class="row"><button class="btn sm" id="pv">‹</button><input type="date" id="d" value="${date}"><button class="btn sm" id="nx">›</button>
            <div class="seg">${['', 'TENNIS', 'GYM', 'POOL', 'MEETING'].map((k) => `<button data-k="${k}" class="${kind === k ? 'on' : ''}">${k ? KIND[k] : 'Semua'}</button>`).join('')}</div></div>
          <div class="row">${can() ? `<button class="btn sm" id="mg">${icon('set')}Kelola fasilitas</button>` : ''}<button class="btn pri" id="nb">${icon('plus')}Booking</button></div></div></div>
        <div class="card"><div class="sched"><table><thead><tr><th class="rh">Fasilitas</th>${hours.map((h) => `<th>${pad(h)}:00</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
          <div class="bd muted small">Klik slot kosong untuk booking. Tennis & meeting room eksklusif (database menolak jadwal bentrok); gym & kolam berbasis kapasitas per jam.</div></div>
        <div class="card mt"><div class="hd"><h3>Booking ${fmtDate(date)}</h3></div><div class="tw"><table class="t"><thead><tr><th>Jam</th><th>Fasilitas</th><th>Tamu</th><th class="center">Pax</th><th class="right">Tarif</th><th>Bayar</th><th>Status</th><th></th></tr></thead><tbody>
          ${todays.map((b) => `<tr><td class="nowrap">${hhmm(b.s)}–${hhmm(b.e)}</td><td>${esc(res.find((r) => r.id === b.resource_id)?.name)}</td>
            <td>${esc(b.guest_name)}${b.event_orders ? ` <span class="tag EVENT">${esc(b.event_orders.event_no)}</span>` : ''}</td><td class="center">${b.pax}</td>
            <td class="right num">${rp(b.amount)}</td><td>${esc(b.paid_method || (b.amount > 0 ? 'Belum' : '-'))}</td><td>${statusTag(b.status)}</td>
            <td class="right nowrap">${b.status === 'CONFIRMED' && !b.event_id ? `<button class="btn sm" data-ci="${b.id}">Hadir</button> <button class="btn sm ghost" data-x="${b.id}">Batal</button>` : ''}</td></tr>`).join('')
            || `<tr><td colspan="8">${emptyState('Belum ada booking.', 'fac')}</td></tr>`}</tbody></table></div></div>`;

      bindTips(el);
      el.querySelector('#d').onchange = (e) => { date = e.target.value; load(); };
      el.querySelector('#pv').onclick = () => { date = addDays(date, -1); load(); };
      el.querySelector('#nx').onclick = () => { date = addDays(date, 1); load(); };
      el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { kind = b.dataset.k; load(); });
      el.querySelector('#nb').onclick = () => bookModal(res, inh, date, null, null, load);
      const mg = el.querySelector('#mg'); if (mg) mg.onclick = () => manage(res, load);
      el.querySelectorAll('td.slot').forEach((c) => c.onclick = (e) => {
        if (e.target.closest('.bk')) return;
        if (c.dataset.closed) return;
        bookModal(res, inh, date, c.dataset.r, +c.dataset.h, load);
      });
      el.querySelectorAll('[data-b]').forEach((b) => b.onclick = () => {
        const x = bookings.find((y) => y.id === b.dataset.b);
        if (x.event_id) { location.hash = '#/event?id=' + x.event_id; return; }
        modal({ title: res.find((r) => r.id === x.resource_id)?.name, body: `<div class="sum-row"><span class="muted">Tamu</span><b>${esc(x.guest_name)}</b></div>
          <div class="sum-row"><span class="muted">Waktu</span><span>${hhmm(x.s)}–${hhmm(x.e)}</span></div><div class="sum-row"><span class="muted">Pax</span><span>${x.pax}</span></div>
          <div class="sum-row"><span class="muted">Tarif</span><span>${rp(x.amount)} · ${esc(x.paid_method || '-')}</span></div><div class="sum-row"><span class="muted">Status</span>${statusTag(x.status)}</div>`,
          actions: x.status === 'CONFIRMED' ? [{ label: 'Batalkan', cls: 'bad', run: () => cancel(x.id, load) }, { label: 'Tandai hadir', cls: 'pri', run: async () => { await rpc('checkin_facility', { p_id: x.id }); load(); } }] : [] });
      });
      el.querySelectorAll('[data-ci]').forEach((b) => b.onclick = async () => { try { await rpc('checkin_facility', { p_id: b.dataset.ci }); load(); } catch (e) { fail(e); } });
      el.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => cancel(b.dataset.x, load));
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
  return onData(load);
}

async function cancel(id, load) {
  const reason = prompt('Alasan pembatalan:'); if (!reason) return false;
  try { await rpc('cancel_facility_booking', { p_id: id, p_reason: reason }); toast('Booking dibatalkan (charge folio di-void bila ada).', 'ok'); load(); } catch (e) { fail(e); }
}

function bookModal(res, inh, date, resId, hour, reload) {
  const idem = 'FAC-' + uid();
  const rooms = inh.filter((r) => r.rooms).sort((a, b) => a.rooms.number.localeCompare(b.rooms.number));
  const usable = res.filter((r) => r.kind !== 'MEETING');
  modal({
    title: 'Booking fasilitas',
    body: `<label class="f">Fasilitas<select name="r">${usable.map((r) => `<option value="${r.id}" ${r.id === resId ? 'selected' : ''}>${esc(r.name)} (${r.mode === 'EXCLUSIVE' ? 'per jam' : 'kapasitas ' + r.capacity})</option>`).join('')}</select></label>
      ${res.find((r) => r.id === resId)?.kind === 'MEETING' ? '<div class="alert info mb">Untuk meeting room gunakan menu Meeting & Event (BEO).</div>' : ''}
      <div class="row"><label class="f">Tanggal<input type="date" name="d" value="${date}"></label><label class="f">Mulai<input type="time" name="t" step="1800" value="${pad(hour ?? Math.max(new Date().getHours() + 1, 6))}:00"></label>
        <label class="f">Durasi (jam)<select name="dur">${[0.5, 1, 1.5, 2, 3, 4].map((h) => `<option value="${h}" ${h === 1 ? 'selected' : ''}>${h}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">Pax<input type="number" name="pax" min="1" value="1"></label>
        <label class="f">Kamar tamu (in-house)<select name="room"><option value="">— Non-tamu / umum —</option>${rooms.map((r) => `<option value="${esc(r.rooms.number)}">${esc(r.rooms.number)} · ${esc(r.guests?.full_name)}</option>`).join('')}</select></label></div>
      <div class="row" id="pub"><label class="f">Nama (non-tamu)<input name="g"></label><label class="f">Bayar<select name="m"><option value="">Belum bayar</option>${PAY_METHODS.filter(([k]) => k !== 'CL').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
      <label class="f">Catatan<input name="n"></label><div id="pr" class="alert info"></div>`,
    onMount: (m) => {
      const calc = () => {
        const v = form(m); const r = res.find((x) => x.id === v.r); if (!r) return;
        const rate = v.room ? r.rate_guest : r.rate_public;
        const qty = r.mode === 'EXCLUSIVE' ? Number(v.dur) : Number(v.pax || 1);
        m.querySelector('#pub').style.display = v.room ? 'none' : '';
        m.querySelector('#pr').innerHTML = `Tarif ${rp(rate)} × ${qty} ${r.mode === 'EXCLUSIVE' ? 'jam' : 'orang'} = <b>${rp(rate * qty)}</b> (+service & pajak) ${v.room ? '· charge ke kamar ' + esc(v.room) : ''}`;
      };
      m.addEventListener('input', calc); calc();
    },
    actions: [{ label: 'Simpan booking', cls: 'pri', run: async (m) => {
      const v = form(m);
      const start = new Date(`${v.d}T${v.t}:00`), end = new Date(start.getTime() + Number(v.dur) * 3600e3);
      const r = await rpc('book_facility', { p_resource: v.r, p_start: start.toISOString(), p_end: end.toISOString(), p_pax: Number(v.pax),
        p_guest_name: v.g || null, p_room_number: v.room || null, p_payment_method: v.m || null, p_notes: v.n || null, p_idempotency_key: idem });
      toast(r.posted ? 'Booking tersimpan & tagihan diposting.' : 'Booking tersimpan.', 'ok'); reload();
    } }]
  });
}

function manage(res, reload) {
  modal({
    title: 'Kelola fasilitas', xwide: true,
    body: `<div class="tw"><table class="t"><thead><tr><th>Nama</th><th>Mode</th><th>Kapasitas</th><th>Buka</th><th>Tutup</th><th>Tarif tamu</th><th>Tarif umum</th><th>Buffer (mnt)</th><th></th></tr></thead><tbody>
      ${res.map((r) => `<tr data-id="${r.id}"><td><input name="name" value="${esc(r.name)}"></td><td>${r.mode === 'EXCLUSIVE' ? 'Per jam' : 'Kapasitas'}</td>
        <td><input type="number" name="capacity" value="${r.capacity}" style="width:70px"></td><td><input type="time" name="open_time" value="${r.open_time.slice(0, 5)}"></td>
        <td><input type="time" name="close_time" value="${r.close_time.slice(0, 5)}"></td><td><input type="number" name="rate_guest" value="${r.rate_guest}" style="width:110px"></td>
        <td><input type="number" name="rate_public" value="${r.rate_public}" style="width:110px"></td><td><input type="number" name="buffer_minutes" value="${r.buffer_minutes}" style="width:70px"></td>
        <td><button class="btn sm pri" data-s="${r.id}">Simpan</button></td></tr>`).join('')}</tbody></table></div>
      <p class="muted small mt">Tambah fasilitas baru lewat Supabase Table Editor (tabel <code>facility_resources</code>).</p>`,
    onMount: (m) => m.querySelectorAll('[data-s]').forEach((b) => b.onclick = async () => {
      const f = form(m.querySelector(`tr[data-id="${b.dataset.s}"]`));
      try {
        await q(sb.from('facility_resources').update({ name: f.name, capacity: Number(f.capacity), open_time: f.open_time, close_time: f.close_time,
          rate_guest: Number(f.rate_guest), rate_public: Number(f.rate_public), buffer_minutes: Number(f.buffer_minutes) }).eq('id', b.dataset.s));
        toast('Fasilitas disimpan.', 'ok'); reload();
      } catch (e) { fail(e); }
    })
  });
}
