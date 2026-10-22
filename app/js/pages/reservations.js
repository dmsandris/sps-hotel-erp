import { sb, q, rpc, esc, rp, fmtDate, fmtDay, toast, fail, modal, form, can, state, addDays, uid } from '../core.js';
import { onData } from '../main.js';
import { RES_SELECT, statusTag, openReservation, PAY_METHODS } from './shared.js';

export async function render(el) {
  const bd = state.property.business_date;
  let f = { status: 'ACTIVE', from: addDays(bd, -3), to: addDays(bd, 30), s: '' };
  const [types, plans] = await Promise.all([
    q(sb.from('room_types').select('*').order('sort_order')),
    q(sb.from('rate_plans').select('*').eq('is_active', true).order('code'))
  ]);

  async function load() {
    try {
      let qq = sb.from('reservations').select(RES_SELECT).gte('check_out', f.from).lte('check_in', f.to).order('check_in').limit(300);
      if (f.status === 'ACTIVE') qq = qq.in('status', ['PENDING_PAYMENT', 'CONFIRMED', 'IN_HOUSE']);
      else if (f.status) qq = qq.eq('status', f.status);
      let rows = await q(qq);
      if (f.s) { const s = f.s.toLowerCase(); rows = rows.filter((r) => (r.guests?.full_name || '').toLowerCase().includes(s) || r.confirmation_no.toLowerCase().includes(s) || (r.guests?.phone || '').includes(s) || (r.rooms?.number || '') === s); }
      el.querySelector('#rl').innerHTML = rows.map((r) => `<tr class="click" data-id="${r.id}">
        <td><b>${esc(r.guests?.full_name)}</b>${r.guests?.vip_level > 0 ? ' <span class="tag VIP">VIP</span>' : ''}<br><small class="muted">${esc(r.confirmation_no)}</small></td>
        <td>${fmtDate(r.check_in)} → ${fmtDate(r.check_out)}</td><td>${esc(r.room_types?.code)}${r.rooms ? ' · <b>' + esc(r.rooms.number) + '</b>' : ''}</td>
        <td>${esc(r.rate_plans?.code)}<br><small class="muted">${esc(r.channel)}</small></td>
        <td class="right num">${rp(r.total_amount)}</td><td>${statusTag(r.status)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Tidak ada reservasi.</td></tr>';
      el.querySelectorAll('[data-id]').forEach((t) => t.onclick = () => openReservation(t.dataset.id, load));
    } catch (e) { fail(e); }
  }

  el.innerHTML = `<div class="card"><div class="hd"><h3>Daftar reservasi</h3>
      <span class="sp">${can('fo', 'cashier') ? '<button class="btn pri" id="nb">+ Reservasi baru</button>' : ''}</span></div>
    <div class="bd"><div class="row" id="flt">
      <label class="f">Cari<input name="s" placeholder="Nama, no. konfirmasi, HP, no. kamar"></label>
      <label class="f">Status<select name="status"><option value="ACTIVE">Aktif</option><option value="">Semua</option>
        ${['PENDING_PAYMENT', 'CONFIRMED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW', 'EXPIRED'].map((s) => `<option>${s}</option>`).join('')}</select></label>
      <label class="f">Dari<input type="date" name="from" value="${f.from}"></label><label class="f">Sampai<input type="date" name="to" value="${f.to}"></label>
    </div></div>
    <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th>Tanggal</th><th>Kamar</th><th>Rate</th><th class="right">Total</th><th>Status</th></tr></thead><tbody id="rl"></tbody></table></div></div>`;
  el.querySelector('#flt').addEventListener('input', () => { f = { ...f, ...form(el.querySelector('#flt')) }; load(); });
  const nb = el.querySelector('#nb'); if (nb) nb.onclick = () => newBooking(types, plans, load);
  await load();
  return onData(load);
}

function newBooking(types, plans, reload) {
  const bd = state.property.business_date;
  const idem = 'HOLD:' + uid();
  modal({
    title: 'Reservasi baru', wide: true,
    body: `<div class="grid g2"><div>
      <div class="row"><label class="f">Check-in<input type="date" name="ci" value="${bd}" min="${bd}"></label>
        <label class="f">Check-out<input type="date" name="co" value="${addDays(bd, 1)}"></label></div>
      <div class="row"><label class="f">Tipe kamar<select name="rt">${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
        <label class="f">Rate plan<select name="rp">${plans.map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">Nama tamu<input name="gn" required></label><label class="f">No. HP<input name="gp"></label></div>
      <div class="row"><label class="f">Email<input name="ge" type="email"></label><label class="f">Dewasa<input name="ad" type="number" min="1" max="6" value="2"></label>
        <label class="f">Channel<select name="ch">${['DIRECT', 'WALK_IN', 'PHONE', 'OTA', 'CORPORATE'].map((c) => `<option>${c}</option>`).join('')}</select></label></div>
      <label class="f">Permintaan khusus<input name="sr" placeholder="Lantai tinggi, extra bed, dll."></label>
      </div><div id="qt"><p class="muted">Isi tanggal & tipe kamar untuk melihat harga per malam.</p></div></div>`,
    actions: [{ label: 'Tahan kamar 15 menit', cls: 'pri', run: async (m) => {
      const v = form(m);
      if (!v.gn.trim()) { toast('Nama tamu wajib.', 'err'); return false; }
      const h = await rpc('create_hold', { p_room_type: v.rt, p_rate_plan: v.rp, p_check_in: v.ci, p_check_out: v.co,
        p_guest_name: v.gn, p_guest_phone: v.gp || null, p_guest_email: v.ge || null, p_adults: Number(v.ad || 1),
        p_channel: v.ch, p_requests: v.sr || null, p_idempotency_key: idem });
      reload(); holdModal(h, reload);
    } }],
    onMount: (m) => {
      let t;
      const run = async () => {
        const v = form(m);
        if (!v.ci || !v.co || v.co <= v.ci) { m.querySelector('#qt').innerHTML = '<p class="muted">Tanggal tidak valid.</p>'; return; }
        try {
          const qs = await rpc('quote_stay', { p_room_type: v.rt, p_rate_plan: v.rp, p_check_in: v.ci, p_check_out: v.co });
          m.querySelector('#qt').innerHTML = `<div class="sum-row"><span class="muted">Tersedia</span><b>${qs.available > 0 ? qs.available + ' kamar' : '<span class="tag DIRTY">PENUH</span>'}</b></div>
            <table class="t"><thead><tr><th>Malam</th><th class="right">Harga</th><th>Kenapa</th></tr></thead><tbody>
            ${qs.nights.map((n) => `<tr><td>${fmtDay(n.date)}</td><td class="right num">${rp(n.price)}${n.addon > 0 ? `<br><small class="muted">+ BF ${rp(n.addon)}</small>` : ''}</td>
              <td><small class="muted">kal ×${n.calendar} · okup ${Math.round(n.occ * 100)}% → ×${n.demand}${n.event_name ? '<br>' + esc(n.event_name) : ''}</small></td></tr>`).join('')}
            </tbody></table>
            <div class="sum-row mt"><span>Subtotal</span><span>${rp(qs.net)}</span></div>
            <div class="sum-row"><span>Service</span><span>${rp(qs.service)}</span></div>
            <div class="sum-row"><span>Pajak</span><span>${rp(qs.tax)}</span></div>
            <div class="sum-row tot"><span>Total ${qs.los} malam</span><span>${rp(qs.total)}</span></div>
            ${qs.min_los > qs.los ? `<div class="alert err mt">Minimal menginap ${qs.min_los} malam untuk tanggal ini.</div>` : ''}`;
        } catch (e) { m.querySelector('#qt').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
      };
      m.addEventListener('input', (e) => { if (['ci', 'co', 'rt', 'rp'].includes(e.target.name)) { clearTimeout(t); t = setTimeout(run, 300); } });
      run();
    }
  });
}

function holdModal(h, reload) {
  let timer;
  const md = modal({
    title: 'Kamar ditahan · ' + h.confirmation_no,
    body: `<div class="row" style="align-items:flex-end"><div><div class="muted">Sisa waktu hold</div><div class="timer" id="tm">--:--</div></div>
        <div style="margin-left:auto" class="right"><div class="muted">Total</div><b style="font-size:18px">${rp(h.total)}</b></div></div>
      <p class="muted" style="font-size:12.5px">Inventori sudah dikunci di database. Bila tidak dikonfirmasi sebelum waktu habis, reservasi otomatis EXPIRED dan kamar dilepas.</p>
      <div class="row"><label class="f">Metode bayar / deposit<select name="m">${PAY_METHODS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="f">Jumlah<input name="amt" type="number" min="0" step="1000" value="${Math.round(h.total)}"></label></div>
      <label class="f">Referensi<input name="ref" placeholder="No. approval EDC / VA / QRIS"></label>`,
    actions: [
      { label: '+5 menit', run: async () => { const x = await rpc('extend_hold', { p_reservation: h.id }); h.expires_at = x; toast('Hold diperpanjang.', 'ok'); return false; } },
      { label: 'Konfirmasi', cls: 'pri', run: async (m) => {
        const v = form(m);
        await rpc('confirm_reservation', { p_reservation: h.id, p_payment_method: v.m, p_amount: Number(v.amt || 0), p_payment_ref: v.ref || null });
        clearInterval(timer); toast('Reservasi ' + h.confirmation_no + ' terkonfirmasi.', 'ok'); reload();
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
