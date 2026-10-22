import { sb, q, rpc, esc, rp, toast, fail, can, state, confirmBox, roomState, addDays, fmtDay, ROOM_LABEL } from '../core.js';
import { onData, refreshProperty } from '../main.js';
import { RES_SELECT, readiness, openReservation, checkInFlow, checkOutFlow } from './shared.js';
import { boardHtml, bindBoard } from './rooms.js';
import { icon, comboChart, donut, bindTips, pct, rpShort, emptyState } from '../ui.js';

export async function render(el) {
  let first = true;
  async function load() {
    const bd = state.property.business_date;
    try {
      const [d, arr, dep, rooms, folios, fc, past] = await Promise.all([
        rpc('fo_dashboard'),
        q(sb.from('reservations').select(RES_SELECT).eq('status', 'CONFIRMED').lte('check_in', bd).order('check_in')),
        q(sb.from('reservations').select(RES_SELECT).eq('status', 'IN_HOUSE').lte('check_out', bd).order('check_out')),
        q(sb.from('rooms').select('*, room_types(code, name)').order('floor').order('number')),
        q(sb.from('folios').select('reservation_id, balance').eq('status', 'OPEN')),
        rpc('report_range', { p_from: bd, p_to: addDays(bd, 13) }).catch(() => null),
        rpc('report_range', { p_from: addDays(bd, -7), p_to: addDays(bd, -1) }).catch(() => null)
      ]);
      const bal = Object.fromEntries(folios.map((f) => [f.reservation_id, f.balance]));
      const occ = d.rooms_total ? Math.round((d.otb_tonight / d.rooms_total) * 100) : 0;
      arr.sort((a, b) => (b.guests?.vip_level || 0) - (a.guests?.vip_level || 0) || (roomState(b.rooms || {}) === 'READY') - (roomState(a.rooms || {}) === 'READY'));
      const vipNotReady = arr.filter((r) => r.guests?.vip_level > 0 && roomState(r.rooms || {}) !== 'READY').length;
      const alerts = [
        d.dirty_over_45 && [`${d.dirty_over_45} kamar kotor menunggu > 45 menit`, 'warn'],
        d.unassigned_tasks && [`${d.unassigned_tasks} tugas HK belum ada petugas (cek staf on-duty)`, 'warn'],
        d.unsettled_departures && [`${d.unsettled_departures} departure dengan folio belum lunas`, 'err'],
        d.holds_expiring && [`${d.holds_expiring} hold booking kedaluwarsa < 5 menit`, 'warn'],
        vipNotReady && [`${vipNotReady} tamu VIP tiba, kamar belum siap`, 'err']
      ].filter(Boolean);

      const cnt = {}; rooms.forEach((r) => { const s = roomState(r); cnt[s] = (cnt[s] || 0) + 1; });
      const pastRev = past ? past.reduce((a, x) => a + Number(x.room_revenue) + Number(x.other_revenue), 0) : 0;
      const pastOcc = past && past.length ? past.reduce((a, x) => a + Number(x.occ || 0), 0) / past.length : null;

      el.innerHTML = `
        <div class="kpis">
          <div class="kpi"><div class="l">${icon('in')}Arrival hari ini</div><div class="v">${d.arrivals}</div><div class="s">${d.arrivals_done} sudah check-in</div><div class="bar"><i style="width:${d.arrivals ? (d.arrivals_done / d.arrivals) * 100 : 0}%"></i></div></div>
          <div class="kpi"><div class="l">${icon('out')}Departure</div><div class="v">${d.departures}</div><div class="s">${d.departures_done} sudah check-out</div><div class="bar"><i style="width:${d.departures ? (d.departures_done / d.departures) * 100 : 0}%"></i></div></div>
          <div class="kpi"><div class="l">${icon('bed')}In-house</div><div class="v">${d.in_house}</div><div class="s">${d.occupied}/${d.rooms_total} kamar terisi</div></div>
          <div class="kpi"><div class="l">${icon('report')}Okupansi malam ini</div><div class="v">${occ}%</div><div class="s">7 hari lalu rata-rata ${pct(pastOcc)}</div><div class="bar"><i style="width:${occ}%"></i></div></div>
          <div class="kpi"><div class="l">${icon('money')}ADR · RevPAR</div><div class="v" style="font-size:28px">${rpShort(d.adr_tonight)}</div><div class="s">RevPAR ${rp(d.rooms_total ? d.room_rev_tonight / d.rooms_total : 0)}</div></div>
          <div class="kpi"><div class="l">${icon('check')}Siap jual</div><div class="v">${d.ready}</div><div class="s">${d.pending_inspection} tunggu inspeksi · ${d.dirty} kotor</div></div>
        </div>

        <div class="grid g21 mb">
          <div class="card"><div class="hd"><h3>Forecast 14 hari</h3><span class="sub">okupansi on-the-books & pendapatan kamar</span>
            <span class="sp"><a class="btn sm" href="#/laporan">Laporan lengkap</a></span></div>
            <div class="bd">${fc ? comboChart({ labels: fc.map((x) => fmtDay(x.d).replace(/^\w+, /, '')),
              bars: [{ name: 'Pendapatan kamar', values: fc.map((x) => Number(x.room_revenue)), fmt: rp }],
              lines: [{ name: 'Okupansi', values: fc.map((x) => Number(x.occ || 0)), axis: 'right', fmt: pct, color: 'var(--c2)' }], y2Max: 100, height: 230 })
              : '<div class="alert info">Jalankan SQL upgrade-04 untuk mengaktifkan grafik.</div>'}</div></div>
          <div class="card"><div class="hd"><h3>Status kamar</h3></div><div class="bd">
            ${donut(['READY', 'OCC', 'CLEAN', 'CLEANING', 'DIRTY', 'OOO'].map((s, i) => ({ label: ROOM_LABEL[s], value: cnt[s] || 0,
              color: ['var(--st-ready)', 'var(--st-occ)', 'var(--st-clean)', 'var(--st-cleaning)', 'var(--st-dirty)', 'var(--st-ooo)'][i] })), { center: 'Kamar', centerValue: rooms.length })}
            <div class="sum-row mt small"><span class="muted">Pendapatan 7 hari terakhir</span><b>${rp(pastRev)}</b></div>
          </div></div>
        </div>

        <div class="grid g2">
          <div class="card"><div class="hd"><h3>Arrival queue</h3><span class="sub">VIP & kamar siap di atas</span><span class="sp"><a class="btn sm" href="#/tapechart">Kalender</a></span></div>
            <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th>Tipe</th><th>Kamar</th><th></th></tr></thead><tbody>
            ${arr.map((r) => `<tr><td><a href="#" data-open="${r.id}">${esc(r.guests?.full_name)}</a>${r.guests?.vip_level > 0 ? ' <span class="tag VIP">VIP</span>' : ''}<br><small class="muted">${esc(r.confirmation_no)} · ${esc(r.channel)}</small></td>
              <td>${esc(r.room_types?.code)}</td><td>${r.rooms ? esc(r.rooms.number) + '<br>' : ''}${readiness(r)}</td>
              <td class="right">${can('fo') ? `<button class="btn sm pri" data-ci="${r.id}">Check-in</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('Tidak ada arrival tertunda.', 'in')}</td></tr>`}
            </tbody></table></div></div>
          <div class="card"><div class="hd"><h3>Departure & folio</h3></div>
            <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th>Kamar</th><th class="right">Saldo</th><th></th></tr></thead><tbody>
            ${dep.map((r) => `<tr><td><a href="#" data-open="${r.id}">${esc(r.guests?.full_name)}</a><br><small class="muted">${esc(r.confirmation_no)}</small></td>
              <td>${esc(r.rooms?.number || '-')}</td><td class="right num">${Number(bal[r.id] || 0) > 0 ? `<span class="tag DIRTY">${rp(bal[r.id])}</span>` : '<span class="tag READY">Siap out</span>'}</td>
              <td class="right">${can('fo', 'cashier') ? `<button class="btn sm pri" data-co="${r.id}">Check-out</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('Tidak ada departure tertunda.', 'out')}</td></tr>`}
            </tbody></table></div></div>
        </div>
        <div class="grid g21 mt">
          <div class="card"><div class="hd"><h3>Papan kamar</h3><span class="sp"><a class="btn sm" href="#/kamar">Detail</a></span></div><div class="bd">${boardHtml(rooms)}</div></div>
          <div class="card"><div class="hd"><h3>Alert operasional</h3></div><div class="bd"><div class="alerts">
            ${alerts.map(([a, k]) => `<div class="alert ${k === 'err' ? 'err' : ''}">${icon('warn')}${esc(a)}</div>`).join('') || `<div class="alert ok">${icon('check')}Semua normal.</div>`}
          </div>
          ${can('fo') ? `<div class="mt"><p class="muted small">Night Audit memposting kamar malam ini ke folio, menandai no-show, membuat tugas stayover, lalu memajukan business date.</p>
            <button class="btn" id="na">${icon('shift')}Jalankan Night Audit</button></div>` : ''}</div></div>
        </div>`;

      bindTips(el);
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
    } catch (e) { fail(e); if (first) el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
    first = false;
  }
  await load();
  const off = onData(load);
  const t = setInterval(load, 60000);
  return () => { off(); clearInterval(t); };
}
