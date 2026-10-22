import { sb, q, rpc, esc, rp, fmtTime, toast, fail, can, state, confirmBox, roomState } from '../core.js';
import { onData, refreshProperty } from '../main.js';
import { RES_SELECT, readiness, openReservation, checkInFlow, checkOutFlow } from './shared.js';
import { boardHtml, bindBoard } from './rooms.js';

export async function render(el) {
  async function load() {
    const bd = state.property.business_date;
    try {
      const [d, arr, dep, rooms, folios] = await Promise.all([
        rpc('fo_dashboard'),
        q(sb.from('reservations').select(RES_SELECT).eq('status', 'CONFIRMED').lte('check_in', bd).order('check_in')),
        q(sb.from('reservations').select(RES_SELECT).eq('status', 'IN_HOUSE').lte('check_out', bd).order('check_out')),
        q(sb.from('rooms').select('*, room_types(code, name)').order('floor').order('number')),
        q(sb.from('folios').select('reservation_id, balance').eq('status', 'OPEN'))
      ]);
      const bal = Object.fromEntries(folios.map((f) => [f.reservation_id, f.balance]));
      const occ = d.rooms_total ? Math.round((d.otb_tonight / d.rooms_total) * 100) : 0;
      arr.sort((a, b) => (b.guests?.vip_level || 0) - (a.guests?.vip_level || 0) || (roomState(b.rooms || {}) === 'READY') - (roomState(a.rooms || {}) === 'READY'));

      const alerts = [];
      if (d.dirty_over_45) alerts.push(`${d.dirty_over_45} kamar kotor menunggu > 45 menit`);
      if (d.unassigned_tasks) alerts.push(`${d.unassigned_tasks} tugas HK belum ada petugas (cek staf on-duty)`);
      if (d.unsettled_departures) alerts.push(`${d.unsettled_departures} departure dengan folio belum lunas`);
      if (d.holds_expiring) alerts.push(`${d.holds_expiring} hold booking kedaluwarsa < 5 menit`);
      const vipNotReady = arr.filter((r) => r.guests?.vip_level > 0 && roomState(r.rooms || {}) !== 'READY').length;
      if (vipNotReady) alerts.push(`${vipNotReady} tamu VIP tiba, kamar belum siap`);

      el.innerHTML = `
        <div class="kpis">
          <div class="kpi"><div class="l">Arrival hari ini</div><div class="v">${d.arrivals}</div><div class="s">${d.arrivals_done} sudah check-in</div></div>
          <div class="kpi"><div class="l">Departure</div><div class="v">${d.departures}</div><div class="s">${d.departures_done} sudah check-out</div></div>
          <div class="kpi"><div class="l">In-house</div><div class="v">${d.in_house}</div><div class="s">${d.occupied}/${d.rooms_total} kamar terisi</div></div>
          <div class="kpi"><div class="l">Okupansi malam ini</div><div class="v">${occ}%</div><div class="s">ADR ${rp(d.adr_tonight)}</div></div>
          <div class="kpi"><div class="l">Kamar siap jual</div><div class="v">${d.ready}</div><div class="s">${d.dirty} kotor · ${d.ooo} OOO</div></div>
          <div class="kpi"><div class="l">Tunggu inspeksi</div><div class="v">${d.pending_inspection}</div><div class="s">${d.holds_active} hold aktif</div></div>
        </div>
        <div class="grid g2">
          <div class="card"><div class="hd"><h3>Arrival queue</h3><span class="muted">VIP & kamar siap di atas</span></div>
            <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th>Tipe</th><th>Kamar</th><th></th></tr></thead><tbody>
            ${arr.map((r) => `<tr><td><a href="#" data-open="${r.id}">${esc(r.guests?.full_name)}</a>${r.guests?.vip_level > 0 ? ' <span class="tag VIP">VIP</span>' : ''}<br><small class="muted">${esc(r.confirmation_no)} · ${esc(r.channel)}</small></td>
              <td>${esc(r.room_types?.code)}</td><td>${r.rooms ? esc(r.rooms.number) + '<br>' : ''}${readiness(r)}</td>
              <td class="right">${can('fo') ? `<button class="btn sm pri" data-ci="${r.id}">Check-in</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Tidak ada arrival tertunda.</td></tr>'}
            </tbody></table></div></div>
          <div class="card"><div class="hd"><h3>Departure & folio</h3></div>
            <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th>Kamar</th><th class="right">Saldo</th><th></th></tr></thead><tbody>
            ${dep.map((r) => `<tr><td><a href="#" data-open="${r.id}">${esc(r.guests?.full_name)}</a><br><small class="muted">${esc(r.confirmation_no)}</small></td>
              <td>${esc(r.rooms?.number || '-')}</td><td class="right num">${Number(bal[r.id] || 0) > 0 ? `<span class="tag DIRTY">${rp(bal[r.id])}</span>` : '<span class="tag READY">Siap out</span>'}</td>
              <td class="right">${can('fo', 'cashier') ? `<button class="btn sm pri" data-co="${r.id}">Check-out</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Tidak ada departure tertunda.</td></tr>'}
            </tbody></table></div></div>
        </div>
        <div class="grid g2 mt" style="grid-template-columns: 2fr 1fr">
          <div class="card"><div class="hd"><h3>Papan kamar</h3><span class="sp"><a class="btn sm" href="#/kamar">Detail</a></span></div><div class="bd">${boardHtml(rooms)}</div></div>
          <div class="card"><div class="hd"><h3>Alert operasional</h3></div><div class="bd"><div class="alerts">
            ${alerts.map((a) => `<div class="alert">${esc(a)}</div>`).join('') || '<div class="alert ok">Semua normal.</div>'}
          </div>
          ${can('fo') ? `<div class="mt"><p class="muted" style="font-size:12.5px">Night Audit memposting kamar malam ini ke folio, menandai no-show, membuat tugas stayover, lalu memajukan business date.</p>
            <button class="btn" id="na">Jalankan Night Audit</button></div>` : ''}</div></div>
        </div>`;

      el.querySelectorAll('[data-open]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openReservation(a.dataset.open, load); });
      el.querySelectorAll('[data-ci]').forEach((b) => b.onclick = () => checkInFlow(arr.find((r) => r.id === b.dataset.ci), load));
      el.querySelectorAll('[data-co]').forEach((b) => b.onclick = () => checkOutFlow(dep.find((r) => r.id === b.dataset.co), load));
      bindBoard(el, rooms, load);
      const na = el.querySelector('#na');
      if (na) na.onclick = async () => {
        if (!await confirmBox('Night Audit', `Tutup business date <b>${esc(state.property.business_date)}</b>? Proses ini tidak dapat dibatalkan.`, 'Jalankan')) return;
        try {
          const res = await rpc('night_audit');
          toast(`Night audit selesai: ${res.room_nights_posted} malam diposting, ${res.no_show} no-show. Business date → ${res.new_business_date}`, 'ok');
          await refreshProperty(); load();
        } catch (e) { fail(e); }
      };
    } catch (e) { fail(e); }
  }
  await load();
  const off = onData(load);
  const t = setInterval(load, 60000);
  return () => { off(); clearInterval(t); };
}
