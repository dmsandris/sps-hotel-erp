// Breakfast: validasi di pintu restoran per nomor kamar. Paket BF dari rate plan semalam; tambahan di-charge ke folio.
import { rpc, esc, rp, toast, fail, state, confirmBox } from '../core.js';
import { onData } from '../main.js';
import { icon, emptyState, comboChart } from '../ui.js';

export async function render(el) {
  async function load() {
    try {
      const rows = await rpc('breakfast_list', { p_date: null });
      const ent = rows.filter((r) => r.entitled), tot = ent.reduce((a, r) => a + r.pax, 0), used = ent.reduce((a, r) => a + r.redeemed, 0);
      el.innerHTML = `<div class="kpis">
          <div class="kpi"><div class="l">Kamar berhak BF</div><div class="v">${ent.length}</div></div>
          <div class="kpi"><div class="l">Porsi dijatah</div><div class="v">${tot}</div><div class="s">untuk perencanaan dapur</div></div>
          <div class="kpi"><div class="l">Sudah sarapan</div><div class="v">${used}</div><div class="bar"><i style="width:${tot ? (used / tot) * 100 : 0}%"></i></div></div>
          <div class="kpi"><div class="l">Sisa</div><div class="v">${Math.max(tot - used, 0)}</div></div></div>
        <div class="grid g21"><div class="card"><div class="hd"><h3>Daftar kamar · ${esc(state.property.business_date)}</h3></div>
          <div class="tw"><table class="t"><thead><tr><th>Kamar</th><th>Tamu</th><th class="center">Pax</th><th class="center">Sudah</th><th>Paket</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td><b class="display" style="font-size:20px">${esc(r.room_number)}</b></td><td>${esc(r.guest_name)}${r.status === 'CHECKED_OUT' ? ' <small class="muted">(sudah check-out)</small>' : ''}</td>
            <td class="center">${r.pax}</td><td class="center">${r.redeemed}</td><td>${r.entitled ? (r.redeemed >= r.pax ? '<span class="tag CLOSED">Selesai</span>' : '<span class="tag READY">Termasuk BF</span>') : '<span class="tag OPEN">Room only</span>'}</td></tr>`).join('')
            || `<tr><td colspan="5">${emptyState('Belum ada tamu menginap semalam.', 'bf')}</td></tr>`}</tbody></table></div></div>
        <div class="card"><div class="hd"><h3>Scan / input di pintu</h3></div><div class="bd">
          <label class="f">Nomor kamar<input id="rm" inputmode="numeric" placeholder="mis. 201" style="font-size:22px;padding:12px" autofocus></label>
          <label class="f">Jumlah orang<input id="px" type="number" min="1" value="1" style="font-size:18px"></label>
          <button class="btn pri lg" id="go">${icon('check')}Validasi</button>
          <div id="out" class="mt"></div>
          <p class="muted small mt">Di luar jatah paket akan ditawarkan charge ${rp(state.property.breakfast_price)}/pax ke folio kamar.</p></div></div></div>`;
      const go = async () => {
        const room = el.querySelector('#rm').value.trim(), pax = Number(el.querySelector('#px').value || 1);
        if (!room) return;
        const out = el.querySelector('#out');
        try {
          const r = await rpc('breakfast_redeem', { p_room_number: room, p_pax: pax, p_charge_extra: false });
          out.innerHTML = `<div class="alert ok">${icon('check')}Silakan — ${esc(r.guest)} · ${r.free} pax termasuk paket.</div>`;
          toast(`Kamar ${room}: ${r.free} pax OK.`, 'ok'); load();
        } catch (e) {
          const m = String(e.message || '').match(/BREAKFAST_NOT_ENTITLED_(\d+)/);
          if (m && await confirmBox('Di luar paket', `${m[1]} pax kamar ${esc(room)} tidak termasuk paket. Charge ${rp(state.property.breakfast_price * m[1])} ke folio?`, 'Charge ke kamar')) {
            try { const r = await rpc('breakfast_redeem', { p_room_number: room, p_pax: pax, p_charge_extra: true }); toast(`Kamar ${room}: ${r.free} gratis, ${r.charged} di-charge.`, 'ok'); load(); }
            catch (e2) { fail(e2); }
          } else if (!m) { out.innerHTML = ''; fail(e); }
        }
      };
      el.querySelector('#go').onclick = go;
      el.querySelector('#rm').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
  return onData(load);
}
