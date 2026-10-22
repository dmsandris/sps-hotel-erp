import { sb, q, rpc, esc, rp, fmtDate, fmtDay, toast, fail, modal, form, can, state, addDays, uid } from '../core.js';
import { onData } from '../main.js';
import { RES_SELECT, statusTag, openReservation, PAY_METHODS } from './shared.js';
import { icon, emptyState, downloadXLSX } from '../ui.js';

const CHANNELS = ['DIRECT', 'WALK_IN', 'PHONE', 'OTA', 'CORPORATE'];

export async function render(el) {
  const bd = state.property.business_date;
  let f = { status: 'ACTIVE', from: addDays(bd, -3), to: addDays(bd, 30), s: '', ch: '' };
  let tab = 'list';
  let rows = [];

  async function load() {
    try {
      if (tab === 'groups') return loadGroups();
      let qq = sb.from('reservations').select(RES_SELECT + ', reservation_groups(name)').gte('check_out', f.from).lte('check_in', f.to).order('check_in').limit(500);
      if (f.status === 'ACTIVE') qq = qq.in('status', ['PENDING_PAYMENT', 'CONFIRMED', 'IN_HOUSE']);
      else if (f.status) qq = qq.eq('status', f.status);
      if (f.ch) qq = qq.eq('channel', f.ch);
      rows = await q(qq);
      if (f.s) { const s = f.s.toLowerCase(); rows = rows.filter((r) => (r.guests?.full_name || '').toLowerCase().includes(s) || r.confirmation_no.toLowerCase().includes(s) || (r.guests?.phone || '').includes(s) || (r.rooms?.number || '') === s || (r.reservation_groups?.name || '').toLowerCase().includes(s)); }
      const tot = rows.reduce((a, r) => a + Number(r.total_amount), 0);
      const nights = rows.reduce((a, r) => a + (new Date(r.check_out) - new Date(r.check_in)) / 864e5, 0);
      el.querySelector('#sum').innerHTML = `<b>${rows.length}</b> reservasi · <b>${nights}</b> room night · nilai <b>${rp(tot)}</b>`;
      el.querySelector('#rl').innerHTML = rows.map((r) => `<tr class="click" data-id="${r.id}">
        <td><b>${esc(r.guests?.full_name)}</b>${r.guests?.vip_level > 0 ? ' <span class="tag VIP">VIP</span>' : ''}${r.reservation_groups ? ` <span class="tag MASTER">⧉ ${esc(r.reservation_groups.name)}</span>` : ''}<br><small class="muted">${esc(r.confirmation_no)}</small></td>
        <td class="nowrap">${fmtDate(r.check_in)} → ${fmtDate(r.check_out)}</td><td>${esc(r.room_types?.code)}${r.rooms ? ' · <b>' + esc(r.rooms.number) + '</b>' : ''}</td>
        <td>${esc(r.rate_plans?.code)}<br><small class="muted">${esc(r.channel)}</small></td>
        <td class="right num">${rp(r.total_amount)}</td><td>${statusTag(r.status)}</td></tr>`).join('') || `<tr><td colspan="6">${emptyState('Tidak ada reservasi di filter ini.', 'res')}</td></tr>`;
      el.querySelectorAll('[data-id]').forEach((t) => t.onclick = () => openReservation(t.dataset.id, load));
    } catch (e) { fail(e); }
  }

  async function loadGroups() {
    const gs = await q(sb.from('reservation_groups').select('*, companies(name), reservations(id, status, check_in, check_out, total_amount)').order('created_at', { ascending: false }).limit(100));
    el.querySelector('#gl').innerHTML = gs.map((g) => {
      const act = g.reservations.filter((r) => !['CANCELLED', 'EXPIRED'].includes(r.status));
      const ci = act.map((r) => r.check_in).sort()[0], co = act.map((r) => r.check_out).sort().slice(-1)[0];
      const st = [...new Set(act.map((r) => r.status))];
      return `<tr class="click" data-g="${g.id}"><td><b>${esc(g.name)}</b><br><small class="muted">${esc(g.companies?.name || g.contact_name || '-')}</small></td>
        <td>${act.length} kamar</td><td class="nowrap">${ci ? fmtDate(ci) + ' → ' + fmtDate(co) : '-'}</td>
        <td class="right num">${rp(act.reduce((a, r) => a + Number(r.total_amount), 0))}</td><td>${st.map(statusTag).join(' ')}</td></tr>`;
    }).join('') || `<tr><td colspan="5">${emptyState('Belum ada grup.', 'res')}</td></tr>`;
    el.querySelectorAll('[data-g]').forEach((t) => t.onclick = () => groupModal(t.dataset.g, load));
  }

  function shell() {
    el.innerHTML = `<div class="tabs"><button data-tab="list" class="${tab === 'list' ? 'on' : ''}">Reservasi</button><button data-tab="groups" class="${tab === 'groups' ? 'on' : ''}">Grup & rooming list</button></div>
    ${tab === 'list' ? `<div class="card"><div class="hd"><h3>Daftar reservasi</h3><span class="sub" id="sum"></span>
      <span class="sp"><button class="btn sm" id="xl">${icon('dl')}Excel</button>${can('fo', 'cashier') ? `<button class="btn" id="ng">${icon('plus')}Grup</button><button class="btn pri" id="nb">${icon('plus')}Reservasi</button>` : ''}</span></div>
    <div class="bd"><div class="row" id="flt">
      <label class="f">Cari<input name="s" value="${esc(f.s)}" placeholder="Nama, no. konfirmasi, HP, kamar, grup"></label>
      <label class="f">Status<select name="status"><option value="ACTIVE">Aktif</option><option value="">Semua</option>
        ${['PENDING_PAYMENT', 'CONFIRMED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW', 'EXPIRED'].map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="f">Channel<select name="ch"><option value="">Semua</option>${CHANNELS.map((c) => `<option ${f.ch === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f">Dari<input type="date" name="from" value="${f.from}"></label><label class="f">Sampai<input type="date" name="to" value="${f.to}"></label>
    </div></div>
    <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th>Tanggal</th><th>Kamar</th><th>Rate</th><th class="right">Total</th><th>Status</th></tr></thead><tbody id="rl"></tbody></table></div></div>`
    : `<div class="card"><div class="hd"><h3>Grup</h3><span class="sp">${can('fo') ? `<button class="btn pri" id="ng">${icon('plus')}Grup baru</button>` : ''}</span></div>
      <div class="tw"><table class="t"><thead><tr><th>Grup</th><th>Kamar</th><th>Tanggal</th><th class="right">Nilai</th><th>Status</th></tr></thead><tbody id="gl"></tbody></table></div></div>`}`;
    el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; shell(); load(); });
    const flt = el.querySelector('#flt'); if (flt) flt.addEventListener('input', () => { f = { ...f, ...form(flt) }; load(); });
    const nb = el.querySelector('#nb'); if (nb) nb.onclick = () => newBooking({}, load);
    const ng = el.querySelector('#ng'); if (ng) ng.onclick = () => newGroup(load);
    const xl = el.querySelector('#xl'); if (xl) xl.onclick = () => downloadXLSX('reservasi-' + bd, { Reservasi: rows.map((r) => ({
      konfirmasi: r.confirmation_no, tamu: r.guests?.full_name, hp: r.guests?.phone, check_in: r.check_in, check_out: r.check_out,
      tipe: r.room_types?.code, kamar: r.rooms?.number, rate: r.rate_plans?.code, channel: r.channel, status: r.status, total: Number(r.total_amount), grup: r.reservation_groups?.name })) });
  }
  shell();
  await load();
  return onData(load);
}

async function masterData() {
  const [types, plans, companies] = await Promise.all([
    q(sb.from('room_types').select('*').order('sort_order')),
    q(sb.from('rate_plans').select('*').eq('is_active', true).order('code')),
    q(sb.from('companies').select('id, name').eq('is_active', true).order('name')).catch(() => [])
  ]);
  return { types, plans, companies };
}

function quoteBox(m, fields) {
  let t;
  const run = async () => {
    const v = form(m);
    const box = m.querySelector('#qt');
    if (!v.ci || !v.co || v.co <= v.ci) { box.innerHTML = '<p class="muted">Tanggal tidak valid.</p>'; return; }
    try {
      const qs = await rpc('quote_stay', { p_room_type: v.rt, p_rate_plan: v.rp, p_check_in: v.ci, p_check_out: v.co });
      const n = Number(v.rooms || 1);
      box.innerHTML = `<div class="sum-row"><span class="muted">Tersedia</span><b>${qs.available >= n ? qs.available + ' kamar' : `<span class="tag DIRTY">Sisa ${qs.available}</span>`}</b></div>
        <div class="tw" style="max-height:240px"><table class="t"><thead><tr><th>Malam</th><th class="right">Harga</th><th>Kenapa</th></tr></thead><tbody>
        ${qs.nights.map((x) => `<tr><td>${fmtDay(x.date)}</td><td class="right num">${rp(x.price)}${x.addon > 0 ? `<br><small class="muted">+ BF ${rp(x.addon)}</small>` : ''}</td>
          <td><small class="muted">kal ×${x.calendar} · okup ${Math.round(x.occ * 100)}% → ×${x.demand}${x.event_name ? '<br>' + esc(x.event_name) : ''}</small></td></tr>`).join('')}
        </tbody></table></div>
        <div class="sum-row mt"><span>Subtotal</span><span>${rp(qs.net)}</span></div>
        <div class="sum-row"><span>Service</span><span>${rp(qs.service)}</span></div>
        <div class="sum-row"><span>Pajak</span><span>${rp(qs.tax)}</span></div>
        <div class="sum-row tot"><span>Total ${qs.los} malam${n > 1 ? ' × ' + n + ' kamar' : ''}</span><span>${rp(qs.total * n)}</span></div>
        ${qs.min_los > qs.los ? `<div class="alert err mt">Minimal menginap ${qs.min_los} malam untuk tanggal ini.</div>` : ''}`;
    } catch (e) { box.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  };
  m.addEventListener('input', (e) => { if (fields.includes(e.target.name)) { clearTimeout(t); t = setTimeout(run, 300); } });
  run();
}

/** prefill: { room_type_id, check_in, room_id } */
export async function newBooking(prefill = {}, reload = () => {}) {
  const { types, plans, companies } = await masterData();
  const bd = state.property.business_date;
  const ci = prefill.check_in || bd;
  const idem = 'HOLD:' + uid();
  const room = prefill.room_id ? await q(sb.from('rooms').select('number').eq('id', prefill.room_id).single()) : null;
  modal({
    title: 'Reservasi baru' + (room ? ' · kamar ' + room.number : ''), wide: true,
    body: `<div class="grid g2"><div>
      <div class="row"><label class="f">Check-in<input type="date" name="ci" value="${ci}" min="${bd}"></label>
        <label class="f">Check-out<input type="date" name="co" value="${addDays(ci, 1)}"></label></div>
      <div class="row"><label class="f">Tipe kamar<select name="rt" ${prefill.room_id ? 'disabled' : ''}>${types.map((t) => `<option value="${t.id}" ${t.id === prefill.room_type_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <label class="f">Rate plan<select name="rp">${plans.map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">Nama tamu<input name="gn" required></label><label class="f">No. HP<input name="gp" placeholder="Cocokkan tamu lama"></label></div>
      <div class="row"><label class="f">Email<input name="ge" type="email"></label><label class="f" style="max-width:90px">Dewasa<input name="ad" type="number" min="1" max="6" value="2"></label>
        <label class="f">Channel<select name="ch">${CHANNELS.map((c) => `<option>${c}</option>`).join('')}</select></label></div>
      ${companies.length ? `<label class="f">Perusahaan (opsional — untuk City Ledger)<select name="co_id"><option value="">—</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      <label class="f">Permintaan khusus<input name="sr" placeholder="Lantai tinggi, extra bed, dll."></label>
      <div id="gw"></div>
      </div><div id="qt"><p class="muted">Isi tanggal & tipe kamar untuk melihat harga per malam.</p></div></div>`,
    actions: [{ label: 'Tahan kamar 15 menit', cls: 'pri', run: async (m) => {
      const v = form(m);
      v.rt = v.rt || prefill.room_type_id;
      if (!v.gn.trim()) { toast('Nama tamu wajib.', 'err'); return false; }
      const h = await rpc('create_hold', { p_room_type: v.rt, p_rate_plan: v.rp, p_check_in: v.ci, p_check_out: v.co,
        p_guest_name: v.gn, p_guest_phone: v.gp || null, p_guest_email: v.ge || null, p_adults: Number(v.ad || 1),
        p_channel: v.ch, p_requests: v.sr || null, p_idempotency_key: idem });
      if (v.co_id) { try { await rpc('set_reservation_company', { p_reservation: h.id, p_company: v.co_id }); } catch (e) { fail(e); } }
      reload(); holdModal(h, reload, prefill.room_id);
    } }],
    onMount: (m) => {
      if (prefill.room_id) { const s = m.querySelector('[name=rt]'); s.disabled = false; s.setAttribute('data-locked', '1'); s.style.pointerEvents = 'none'; s.style.opacity = '.7'; }
      quoteBox(m, ['ci', 'co', 'rt', 'rp']);
      // peringatan tamu lama / blacklist
      let t;
      m.querySelector('[name=gp]').addEventListener('input', (e) => {
        clearTimeout(t);
        const v = e.target.value.trim(); if (v.length < 6) { m.querySelector('#gw').innerHTML = ''; return; }
        t = setTimeout(async () => {
          const g = await q(sb.from('guests').select('full_name, vip_level, is_blacklisted, notes').eq('phone', v).limit(1)).catch(() => []);
          if (!g.length) { m.querySelector('#gw').innerHTML = ''; return; }
          const x = g[0];
          m.querySelector('#gw').innerHTML = x.is_blacklisted ? `<div class="alert err">⚠ ${esc(x.full_name)} masuk BLACKLIST. ${esc(x.notes || '')}</div>`
            : `<div class="alert info">Tamu lama: <b>${esc(x.full_name)}</b>${x.vip_level > 0 ? ' · VIP ' + x.vip_level : ''}${x.notes ? ' · ' + esc(x.notes) : ''}</div>`;
          const gn = m.querySelector('[name=gn]'); if (!gn.value) gn.value = x.full_name;
        }, 350);
      });
    }
  });
}

function holdModal(h, reload, roomId) {
  let timer;
  const md = modal({
    title: 'Kamar ditahan · ' + h.confirmation_no,
    body: `<div class="row" style="align-items:flex-end"><div><div class="muted">Sisa waktu hold</div><div class="timer" id="tm">--:--</div></div>
        <div style="margin-left:auto" class="right"><div class="muted">Total</div><b style="font-size:18px">${rp(h.total)}</b></div></div>
      <p class="muted small">Inventori sudah dikunci di database. Bila tidak dikonfirmasi sebelum waktu habis, reservasi otomatis EXPIRED dan kamar dilepas.</p>
      <div class="row"><label class="f">Metode bayar / deposit<select name="m">${PAY_METHODS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="f">Jumlah<input name="amt" type="number" min="0" step="1000" value="${Math.round(h.total)}"></label></div>
      <label class="f">Referensi<input name="ref" placeholder="No. approval EDC / VA / QRIS"></label>`,
    actions: [
      { label: '+5 menit', run: async () => { const x = await rpc('extend_hold', { p_reservation: h.id }); h.expires_at = x; toast('Hold diperpanjang.', 'ok'); return false; } },
      { label: 'Konfirmasi', cls: 'pri', run: async (m) => {
        const v = form(m);
        await rpc('confirm_reservation', { p_reservation: h.id, p_payment_method: v.m, p_amount: Number(v.amt || 0), p_payment_ref: v.ref || null });
        clearInterval(timer);
        if (roomId) { try { await rpc('assign_room', { p_reservation: h.id, p_room: roomId }); } catch (e) { fail(e); } }
        toast('Reservasi ' + h.confirmation_no + ' terkonfirmasi.', 'ok'); reload();
      } }
    ]
  });
  const tick = () => {
    const el = md.el.querySelector('#tm'); if (!el) return clearInterval(timer);
    const s = Math.max(0, Math.floor((new Date(h.expires_at) - Date.now()) / 1000));
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    el.classList.toggle('warn', s < 120);
    if (s === 0) { clearInterval(timer); el.textContent = 'HABIS'; rpc('expire_holds').then(reload).catch(() => {}); }
  };
  tick(); timer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------- grup
async function newGroup(reload) {
  const { types, plans, companies } = await masterData();
  const bd = state.property.business_date;
  const idem = 'GRP-' + uid();
  modal({
    title: 'Booking grup', wide: true,
    body: `<div class="grid g2"><div>
      <div class="row"><label class="f">Nama grup / acara<input name="gname" required placeholder="mis. Gathering PT Maju"></label></div>
      <div class="row"><label class="f">Perusahaan<select name="comp"><option value="">— tanpa perusahaan —</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">PIC<input name="pic"></label><label class="f">HP PIC<input name="phone"></label></div>
      <div class="row"><label class="f">Check-in<input type="date" name="ci" value="${bd}" min="${bd}"></label><label class="f">Check-out<input type="date" name="co" value="${addDays(bd, 2)}"></label></div>
      <div class="row"><label class="f">Tipe kamar<select name="rt">${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
        <label class="f">Rate plan<select name="rp">${plans.map((p) => `<option value="${p.id}">${esc(p.code)}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">Jumlah kamar<input type="number" name="rooms" min="1" max="100" value="5"></label><label class="f">Dewasa/kamar<input type="number" name="ad" min="1" max="6" value="2"></label></div>
      <label class="check" style="border:0;padding:4px 0;font-size:13.5px"><input type="checkbox" name="master" checked> Buat <b>master folio</b> (tagihan kamar dikirim ke 1 folio grup)</label>
      <div class="row small" style="margin:4px 0 8px">Routing ke master: <label><input type="checkbox" name="r_room" checked> Kamar</label> <label><input type="checkbox" name="r_fb"> F&B</label> <label><input type="checkbox" name="r_all"> Semua charge</label></div>
      </div><div id="qt"></div></div>`,
    onMount: (m) => quoteBox(m, ['ci', 'co', 'rt', 'rp', 'rooms']),
    actions: [{ label: 'Tahan semua kamar', cls: 'pri', run: async (m) => {
      const v = form(m);
      if (!v.gname.trim()) { toast('Nama grup wajib.', 'err'); return false; }
      const grps = v.r_all ? ['ROOM', 'FB', 'LAUNDRY', 'FACILITY', 'MEETING', 'MINIBAR', 'PENALTY'] : [...(v.r_room ? ['ROOM'] : []), ...(v.r_fb ? ['FB'] : [])];
      const g = await rpc('create_group_booking', { p_name: v.gname, p_company: v.comp || null, p_contact: v.pic || null, p_phone: v.phone || null,
        p_room_type: v.rt, p_rate_plan: v.rp, p_check_in: v.ci, p_check_out: v.co, p_rooms: Number(v.rooms), p_adults: Number(v.ad),
        p_channel: 'CORPORATE', p_master_folio: v.master, p_route_grps: grps, p_idempotency_key: idem });
      toast(`${v.rooms} kamar ditahan untuk grup ${v.gname}.`, 'ok'); reload();
      groupModal(g.group_id, reload, grps);
    } }]
  });
}

async function groupModal(id, reload, grps = ['ROOM']) {
  let g;
  try { g = await q(sb.from('reservation_groups').select('*, companies(name), reservations(id, confirmation_no, status, check_in, check_out, total_amount, expires_at, guests(full_name, phone), rooms(number), room_types(code))').eq('id', id).single()); }
  catch (e) { return fail(e); }
  const res = g.reservations.sort((a, b) => a.confirmation_no.localeCompare(b.confirmation_no));
  const pending = res.filter((r) => r.status === 'PENDING_PAYMENT');
  const active = res.filter((r) => !['CANCELLED', 'EXPIRED'].includes(r.status));
  const total = active.reduce((a, r) => a + Number(r.total_amount), 0);
  const exp = pending.map((r) => r.expires_at).sort()[0];
  modal({
    title: 'Grup · ' + g.name, xwide: true, wide: true,
    body: `<div class="row mb"><span class="pill">${esc(g.companies?.name || 'Tanpa perusahaan')}</span><span class="pill">${active.length} kamar</span><span class="pill">${rp(total)}</span>
        ${g.master_folio_id ? `<a class="btn sm" href="#/folio?id=${g.master_folio_id}">Buka master folio</a>` : ''}
        ${exp ? `<span class="tag PENDING_PAYMENT">Hold sampai ${new Date(exp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}</div>
      <p class="muted small">Rooming list: ganti nama tamu per kamar (otomatis membuat/menautkan profil tamu).</p>
      <div class="tw"><table class="t"><thead><tr><th>Konfirmasi</th><th>Nama tamu</th><th>HP</th><th>Kamar</th><th>Status</th><th></th></tr></thead><tbody>
      ${res.map((r) => `<tr data-r="${r.id}"><td><a href="#" data-open="${r.id}">${esc(r.confirmation_no)}</a></td>
        <td><input name="n" value="${esc(r.guests?.full_name)}" style="width:100%"></td><td><input name="p" value="${esc(r.guests?.phone || '')}" style="width:130px"></td>
        <td>${esc(r.room_types?.code)} ${r.rooms ? '<b>' + esc(r.rooms.number) + '</b>' : ''}</td><td>${statusTag(r.status)}</td>
        <td>${['PENDING_PAYMENT', 'CONFIRMED'].includes(r.status) ? `<button class="btn sm" data-save="${r.id}">Simpan</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      ${pending.length ? `<div class="card mt"><div class="bd"><b>Konfirmasi ${pending.length} kamar</b>
        <div class="row mt"><label class="f">Deposit grup<select name="m">${PAY_METHODS.map(([k, v]) => `<option value="${k}" ${k === 'TRANSFER' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f">Jumlah<input name="amt" type="number" min="0" value="0"></label></div></div></div>` : ''}`,
    actions: pending.length ? [{ label: 'Konfirmasi grup', cls: 'pri', run: async (m) => {
      const v = form(m.querySelector('.card .bd'));
      const r = await rpc('confirm_group', { p_group: g.id, p_payment_method: v.m, p_amount: Number(v.amt || 0), p_route_grps: grps });
      toast(`${r.confirmed} kamar terkonfirmasi${r.master_folio_id ? ' · routing ke master folio aktif' : ''}.`, 'ok'); reload();
    } }] : [],
    onMount: (m, close) => {
      m.querySelectorAll('[data-save]').forEach((b) => b.onclick = async () => {
        const tr = m.querySelector(`tr[data-r="${b.dataset.save}"]`);
        try { await rpc('set_reservation_guest', { p_reservation: b.dataset.save, p_name: tr.querySelector('[name=n]').value, p_phone: tr.querySelector('[name=p]').value, p_email: null }); toast('Nama tamu disimpan.', 'ok'); }
        catch (e) { fail(e); }
      });
      m.querySelectorAll('[data-open]').forEach((a) => a.onclick = (e) => { e.preventDefault(); close(); openReservation(a.dataset.open, reload); });
    }
  });
}
