// Komponen bersama: detail reservasi, check-in, check-out, pembayaran.
import { sb, q, rpc, esc, rp, fmtDate, fmtTime, toast, fail, modal, form, can, uid, roomState, ROOM_LABEL, state, confirmBox } from '../core.js';

export const RES_SELECT = '*, guests(full_name, phone, email, vip_level), room_types(name, code), rate_plans(code, name), rooms(number, hk_status, fo_status)';
export const statusTag = (s) => `<span class="tag ${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;
export const roomTag = (r) => { const s = roomState(r); return `<span class="tag ${s === 'OCC' ? 'OCCUPIED' : s}">${ROOM_LABEL[s]}</span>`; };
export const PAY_METHODS = [['CASH', 'Tunai'], ['CARD', 'Kartu'], ['QRIS', 'QRIS'], ['TRANSFER', 'Transfer'], ['CL', 'City Ledger']];

export function readiness(r) {
  if (!r.rooms) return '<span class="tag OPEN">Belum ada kamar</span>';
  return roomTag(r.rooms);
}

export async function openReservation(id, onDone = () => {}) {
  let r, nights, folio;
  try {
    [r, nights, folio] = await Promise.all([
      q(sb.from('reservations').select(RES_SELECT).eq('id', id).single()),
      q(sb.from('reservation_night_rates').select('*').eq('reservation_id', id).is('superseded_at', null).order('stay_date')),
      q(sb.from('folios').select('*').eq('reservation_id', id).maybeSingle())
    ]);
  } catch (e) { return fail(e); }
  const bd = state.property.business_date;
  const acts = [];
  const done = () => { onDone(); };
  if (r.status === 'PENDING_PAYMENT') acts.push({ label: 'Konfirmasi / Bayar', cls: 'pri', run: () => { confirmFlow(r, done); } });
  if (r.status === 'CONFIRMED' && can('fo')) {
    acts.push({ label: r.room_id ? 'Ganti Kamar' : 'Tetapkan Kamar', run: () => { assignFlow(r, done); } });
    if (r.check_in <= bd) acts.push({ label: 'Check-in', cls: 'pri', run: () => { checkInFlow(r, done); } });
  }
  if (r.status === 'IN_HOUSE' && can('fo', 'cashier')) acts.push({ label: 'Check-out', cls: 'pri', run: () => { checkOutFlow(r, done); } });
  if (['PENDING_PAYMENT', 'CONFIRMED'].includes(r.status) && can('fo')) acts.push({ label: 'Batalkan', cls: 'bad', run: async () => {
    const reason = prompt('Alasan pembatalan:'); if (!reason) return false;
    await rpc('cancel_reservation', { p_reservation: r.id, p_reason: reason }); toast('Reservasi dibatalkan.', 'ok'); done();
  } });
  if (folio) acts.unshift({ label: 'Buka Folio', run: () => { location.hash = '#/folio?id=' + folio.id; } });

  const vip = r.guests?.vip_level > 0 ? ' <span class="tag VIP">VIP</span>' : '';
  modal({
    title: `${r.confirmation_no} · ${r.guests?.full_name || ''}`, wide: true,
    body: `<div class="grid g2">
      <div>
        <div class="sum-row"><span class="muted">Status</span>${statusTag(r.status)}</div>
        <div class="sum-row"><span class="muted">Tamu</span><span>${esc(r.guests?.full_name)}${vip}</span></div>
        <div class="sum-row"><span class="muted">Kontak</span><span>${esc(r.guests?.phone || '-')} ${esc(r.guests?.email || '')}</span></div>
        <div class="sum-row"><span class="muted">Menginap</span><span>${fmtDate(r.check_in)} → ${fmtDate(r.check_out)} (${nights.length} malam)</span></div>
        <div class="sum-row"><span class="muted">Tipe / Rate</span><span>${esc(r.room_types?.name)} · ${esc(r.rate_plans?.code)}</span></div>
        <div class="sum-row"><span class="muted">Kamar</span><span>${r.rooms ? esc(r.rooms.number) + ' ' + roomTag(r.rooms) : '-'}</span></div>
        <div class="sum-row"><span class="muted">Channel / Pax</span><span>${esc(r.channel)} · ${r.adults} dewasa</span></div>
        ${r.expires_at ? `<div class="sum-row"><span class="muted">Hold berakhir</span><b>${fmtTime(r.expires_at)}</b></div>` : ''}
        ${r.special_requests ? `<div class="sum-row"><span class="muted">Permintaan</span><span>${esc(r.special_requests)}</span></div>` : ''}
        ${folio ? `<div class="sum-row tot"><span>Saldo folio ${esc(folio.folio_no)}</span><span>${rp(folio.balance)}</span></div>` : ''}
      </div>
      <div><div class="tw"><table class="t"><thead><tr><th>Malam</th><th class="right">Harga</th><th>Faktor</th></tr></thead><tbody>
        ${nights.map((n) => {
          const a = n.adjustments || {};
          return `<tr><td>${fmtDate(n.stay_date)}</td><td class="right num">${rp(n.net_rate)}${n.addon_amount > 0 ? `<br><small class="muted">+BF ${rp(n.addon_amount)}</small>` : ''}</td>
            <td><small class="muted">kal ×${a.calendar ?? '-'} · dem ×${a.demand ?? '-'}${a.event_name ? ' · ' + esc(a.event_name) : ''}</small></td></tr>`;
        }).join('')}
      </tbody></table></div>
      <div class="sum-row tot"><span>Total (incl. service & pajak)</span><span>${rp(r.total_amount)}</span></div></div>
    </div>`,
    actions: acts
  });
}

export function confirmFlow(r, onDone) {
  modal({
    title: 'Konfirmasi ' + r.confirmation_no,
    body: `<p>Total menginap <b>${rp(r.total_amount)}</b>. Isi pembayaran/deposit (boleh 0 untuk bayar di hotel / garansi).</p>
      <div class="row"><label class="f">Metode<select name="m">${PAY_METHODS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="f">Jumlah<input name="amt" type="number" min="0" step="1000" value="${Math.round(r.total_amount)}"></label></div>
      <label class="f">Referensi (no. approval / VA)<input name="ref"></label>`,
    actions: [{ label: 'Konfirmasi', cls: 'pri', run: async (el) => {
      const f = form(el);
      await rpc('confirm_reservation', { p_reservation: r.id, p_payment_method: f.m, p_amount: Number(f.amt || 0), p_payment_ref: f.ref || null });
      toast('Reservasi terkonfirmasi.', 'ok'); onDone();
    } }]
  });
}

async function roomOptions(r) {
  const rooms = await q(sb.from('rooms').select('id, number, floor, hk_status, fo_status').eq('room_type_id', r.room_type_id).order('number'));
  const busy = await q(sb.from('room_assignments').select('room_id, reservation_id, stay_range').eq('is_active', true));
  const overlaps = (range) => { const m = range.match(/[[(]([\d-]+),([\d-]+)[)\]]/); return m && m[1] < r.check_out && m[2] > r.check_in; };
  return rooms.map((x) => ({ ...x, taken: busy.some((b) => b.room_id === x.id && b.reservation_id !== r.id && overlaps(b.stay_range)) }));
}

export async function assignFlow(r, onDone) {
  const opts = await roomOptions(r);
  modal({
    title: 'Tetapkan kamar · ' + r.room_types?.name,
    body: `<label class="f">Nomor kamar<select name="room"><option value="">Otomatis (prioritas kamar READY)</option>
      ${opts.map((o) => `<option value="${o.id}" ${o.taken || o.hk_status === 'OOO' ? 'disabled' : ''}>${o.number} — ${ROOM_LABEL[roomState(o)]}${o.taken ? ' (terpakai)' : ''}</option>`).join('')}</select></label>`,
    actions: [{ label: 'Simpan', cls: 'pri', run: async (el) => {
      const f = form(el);
      await rpc('assign_room', { p_reservation: r.id, p_room: f.room || null });
      toast('Kamar ditetapkan.', 'ok'); onDone();
    } }]
  });
}

export async function checkInFlow(r, onDone) {
  const opts = await roomOptions(r);
  const canOverride = can('hk_supervisor');
  modal({
    title: 'Check-in · ' + (r.guests?.full_name || ''),
    body: `<label class="f">Kamar<select name="room">
        ${r.room_id ? '' : '<option value="">Otomatis</option>'}
        ${opts.map((o) => `<option value="${o.id}" ${o.id === r.room_id ? 'selected' : ''} ${o.taken || o.hk_status === 'OOO' || o.fo_status === 'OCCUPIED' ? 'disabled' : ''}>${o.number} — ${ROOM_LABEL[roomState(o)]}${o.taken ? ' (terpakai)' : ''}</option>`).join('')}
      </select></label>
      <label class="f">No. KTP / Paspor<input name="idn" placeholder="Opsional"></label>
      ${canOverride ? '<label class="f">Alasan override (hanya bila kamar belum READY)<input name="ovr"></label>' : '<p class="muted" style="font-size:12.5px">Kamar harus READY (lulus inspeksi). Override hanya oleh supervisor/admin.</p>'}`,
    actions: [{ label: 'Check-in', cls: 'pri', run: async (el) => {
      const f = form(el);
      const res = await rpc('check_in', { p_reservation: r.id, p_room: f.room || null, p_override_reason: f.ovr || null, p_id_number: f.idn || null });
      toast('Check-in berhasil · kamar ' + res.room, 'ok'); onDone();
    } }]
  });
}

export async function checkOutFlow(r, onDone) {
  const folio = await q(sb.from('folios').select('*').eq('reservation_id', r.id).maybeSingle());
  const bal = folio ? Number(folio.balance) : 0;
  const ok = await confirmBox('Check-out ' + (r.guests?.full_name || ''),
    `Malam yang belum ter-posting akan diposting otomatis. Saldo saat ini: <b>${rp(bal)}</b>.<br>Bila masih ada saldo, check-out ditolak sampai dibayar.`, 'Check-out');
  if (!ok) return;
  try {
    await rpc('check_out', { p_reservation: r.id });
    toast('Check-out selesai. Kamar masuk antrian housekeeping.', 'ok'); onDone();
  } catch (e) {
    const m = String(e.message || '');
    if (m.includes('FOLIO_UNSETTLED') && folio) {
      const f2 = await q(sb.from('folios').select('*').eq('id', folio.id).single());
      payModal(f2, Number(f2.balance), async () => {
        try { await rpc('check_out', { p_reservation: r.id }); toast('Lunas & check-out selesai.', 'ok'); } catch (err) { fail(err); }
        onDone();
      });
    } else if (m.includes('FOLIO_CREDIT') && folio) {
      const f2 = await q(sb.from('folios').select('*').eq('id', folio.id).single());
      refundModal(f2, async (skipReason) => {
        try { await rpc('check_out', { p_reservation: r.id, p_force_reason: skipReason || null }); toast('Check-out selesai.', 'ok'); } catch (err) { fail(err); }
        onDone();
      });
    } else fail(e);
  }
}

// Saldo kredit (deposit lebih / early check-out): refund atau check-out tanpa refund dengan alasan
export function refundModal(folio, onDone, allowSkip = true) {
  const credit = -Number(folio.balance);
  modal({
    title: 'Saldo kredit · ' + folio.folio_no,
    body: `<p>Tamu kelebihan bayar <b>${rp(credit)}</b>.</p>
      <div class="row"><label class="f">Metode refund<select name="m">${PAY_METHODS.filter(([k]) => k !== 'CL').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="f">Jumlah<input name="amt" type="number" min="1" value="${Math.round(credit)}"></label></div>
      <label class="f">Alasan<input name="why" value="Kelebihan deposit"></label>`,
    actions: [
      ...(allowSkip ? [{ label: 'Check-out tanpa refund', run: async (el) => { const f = form(el); if (!f.why) { toast('Isi alasan.', 'err'); return false; } onDone('Tanpa refund: ' + f.why); } }] : []),
      { label: 'Refund', cls: 'pri', run: async (el) => {
        const f = form(el);
        await rpc('post_refund', { p_folio: folio.id, p_method: f.m, p_amount: Number(f.amt), p_reason: f.why, p_idempotency_key: 'RFD:' + uid() });
        toast('Refund tercatat.', 'ok'); onDone && onDone(allowSkip ? null : undefined);
      } }]
  });
}

export function payModal(folio, amount, onDone) {
  modal({
    title: 'Pembayaran · ' + folio.folio_no,
    body: `<p>Saldo terbuka <b>${rp(folio.balance)}</b>.</p>
      <div class="row"><label class="f">Metode<select name="m">${PAY_METHODS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="f">Jumlah<input name="amt" type="number" min="1" step="1" value="${Math.max(0, Math.round(amount))}"></label></div>
      <label class="f">Referensi<input name="ref"></label>`,
    actions: [{ label: 'Terima Pembayaran', cls: 'pri', run: async (el) => {
      const f = form(el);
      await rpc('post_payment', { p_folio: folio.id, p_method: f.m, p_amount: Number(f.amt), p_reference: f.ref || '', p_idempotency_key: 'PAY:' + uid() });
      toast('Pembayaran tercatat.', 'ok'); onDone && onDone();
    } }]
  });
}
