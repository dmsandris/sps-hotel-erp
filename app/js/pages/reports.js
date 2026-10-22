// Laporan & analitik: daily flash, kinerja periode (Occ/ADR/RevPAR), pickup, channel, produktivitas HK.
import { rpc, esc, rp, fmtDate, fmtDay, fail, state, addDays, num } from '../core.js';
import { icon, comboChart, donut, bindTips, pct, rpShort, downloadXLSX, emptyState } from '../ui.js';

const GRP = { ROOM: 'Kamar', FB: 'F&B', LAUNDRY: 'Laundry', FACILITY: 'Fasilitas', MEETING: 'Meeting/Event', MINIBAR: 'Minibar', PENALTY: 'Denda', ADJUSTMENT: 'Penyesuaian' };
const CH = { DIRECT: 'Direct', WALK_IN: 'Walk-in', PHONE: 'Telepon', OTA: 'OTA', CORPORATE: 'Korporat' };

export async function render(el) {
  const bd = state.property.business_date;
  let tab = 'flash', day = addDays(bd, -1), from = addDays(bd, -30), to = addDays(bd, 30);
  const presets = [['7 hari lalu', addDays(bd, -7), addDays(bd, -1)], ['30 hari lalu', addDays(bd, -30), addDays(bd, -1)], ['Bulan ini', bd.slice(0, 8) + '01', addDays(bd, -1)],
    ['30 hari ke depan', bd, addDays(bd, 29)], ['±30 hari', addDays(bd, -30), addDays(bd, 30)], ['90 hari ke depan', bd, addDays(bd, 89)]];

  function shell(inner) {
    el.innerHTML = `<div class="tabs no-print">${[['flash', 'Daily flash'], ['perf', 'Kinerja periode'], ['pickup', 'Pickup & forecast'], ['channel', 'Channel mix'], ['hk', 'Produktivitas HK']]
      .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>${inner}`;
    el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; load(); });
    bindTips(el);
  }
  const rangeBar = () => `<div class="card mb no-print"><div class="bd row" style="justify-content:space-between"><div class="row">
      <label class="f" style="margin:0">Dari<input type="date" id="rf" value="${from}"></label><label class="f" style="margin:0">Sampai<input type="date" id="rt" value="${to}"></label>
      <div class="seg">${presets.map((p, i) => `<button data-pr="${i}" class="${p[1] === from && p[2] === to ? 'on' : ''}">${p[0]}</button>`).join('')}</div></div>
      <div class="row"><button class="btn sm" id="xl">${icon('dl')}Excel</button><button class="btn sm" onclick="print()">${icon('print')}Cetak</button></div></div></div>`;
  const bindRange = () => {
    el.querySelector('#rf').onchange = (e) => { from = e.target.value; load(); };
    el.querySelector('#rt').onchange = (e) => { to = e.target.value; load(); };
    el.querySelectorAll('[data-pr]').forEach((b) => b.onclick = () => { [, from, to] = presets[+b.dataset.pr]; load(); });
  };

  async function load() {
    try {
      if (tab === 'flash') {
        const [d, prev] = await Promise.all([rpc('report_daily', { p_date: day }), rpc('report_daily', { p_date: addDays(day, -7) })]);
        const delta = (a, b) => { if (!Number(b)) return ''; const x = ((a - b) / Math.abs(b)) * 100; return `<span class="delta ${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '▲' : '▼'} ${Math.abs(x).toFixed(1)}% vs minggu lalu</span>`; };
        const rev = Object.entries(d.revenue_by_grp || {}).map(([k, v]) => ({ label: GRP[k] || k, value: Number(v) }));
        const totRev = rev.reduce((a, x) => a + x.value, 0);
        const pays = Object.entries(d.payments || {}).map(([k, v]) => ({ label: k, value: Number(v) }));
        shell(`<div class="card mb no-print"><div class="bd row" style="justify-content:space-between"><div class="row"><button class="btn sm" id="pv">‹</button><input type="date" id="dd" value="${day}"><button class="btn sm" id="nx">›</button>
            <span class="pill">${d.is_actual ? 'Aktual (sudah night audit)' : 'On-the-books / forecast'}</span></div>
            <div class="row"><button class="btn sm" id="xl">${icon('dl')}Excel</button><button class="btn sm" onclick="print()">${icon('print')}Cetak</button></div></div></div>
          <h2 class="display mb" style="font-size:30px">Daily Flash · ${fmtDate(day)}</h2>
          <div class="kpis">
            <div class="kpi"><div class="l">Okupansi</div><div class="v">${pct(d.occ)}</div><div class="s">${d.sold}/${d.available} kamar</div>${delta(d.occ, prev.occ)}</div>
            <div class="kpi"><div class="l">ADR</div><div class="v" style="font-size:28px">${rp(d.adr)}</div>${delta(d.adr, prev.adr)}</div>
            <div class="kpi"><div class="l">RevPAR</div><div class="v" style="font-size:28px">${rp(d.revpar)}</div>${delta(d.revpar, prev.revpar)}</div>
            <div class="kpi"><div class="l">Pendapatan kamar</div><div class="v" style="font-size:28px">${rp(d.room_revenue)}</div>${delta(d.room_revenue, prev.room_revenue)}</div>
            <div class="kpi"><div class="l">Total pendapatan</div><div class="v" style="font-size:28px">${rp(totRev)}</div><div class="s">+ service ${rp(d.service)} · pajak ${rp(d.tax)}</div></div>
            <div class="kpi"><div class="l">Pax in-house</div><div class="v">${d.pax_inhouse}</div></div></div>
          <div class="grid g3">
            <div class="card"><div class="hd"><h3>Pendapatan per departemen</h3></div><div class="bd">${donut(rev, { fmt: rp, center: 'Net', centerValue: rpShort(totRev) })}</div></div>
            <div class="card"><div class="hd"><h3>Penerimaan per metode</h3></div><div class="bd">${donut(pays, { fmt: rp, center: 'Diterima', centerValue: rpShort(pays.reduce((a, x) => a + x.value, 0)) })}</div></div>
            <div class="card"><div class="hd"><h3>Pergerakan</h3></div><div class="bd">
              ${[['Arrival', d.arrivals], ['Departure', d.departures], ['Booking baru', d.new_bookings], ['Pembatalan', d.cancelled], ['No-show', d.no_show], ['Void posting', d.voids]]
                .map(([l, v]) => `<div class="sum-row"><span class="muted">${l}</span><b>${num(v)}</b></div>`).join('')}
              <h4 class="mt mb small muted">Room night per channel</h4>
              ${Object.entries(d.channel_mix || {}).map(([k, v]) => `<div class="sum-row"><span>${CH[k] || k}</span><b>${v}</b></div>`).join('') || '<span class="muted small">-</span>'}</div></div></div>`);
        el.querySelector('#dd').onchange = (e) => { day = e.target.value; load(); };
        el.querySelector('#pv').onclick = () => { day = addDays(day, -1); load(); };
        el.querySelector('#nx').onclick = () => { day = addDays(day, 1); load(); };
        el.querySelector('#xl').onclick = () => downloadXLSX('daily-flash-' + day, { Ringkasan: [{ tanggal: day, okupansi: d.occ, kamar_terjual: d.sold, kamar_tersedia: d.available, adr: d.adr, revpar: d.revpar,
          pendapatan_kamar: d.room_revenue, service: d.service, pajak: d.tax, arrival: d.arrivals, departure: d.departures, no_show: d.no_show, batal: d.cancelled }],
          Pendapatan: rev.map((x) => ({ departemen: x.label, net: x.value })), Pembayaran: pays.map((x) => ({ metode: x.label, jumlah: x.value })) });
        return;
      }
      if (tab === 'perf') {
        const rows = await rpc('report_range', { p_from: from, p_to: to });
        const s = (k) => rows.reduce((a, x) => a + Number(x[k] || 0), 0);
        const av = s('available'), so = s('sold'), rr = s('room_revenue');
        shell(rangeBar() + `<div class="kpis">
            <div class="kpi"><div class="l">Okupansi rata-rata</div><div class="v">${pct(av ? (so / av) * 100 : 0)}</div><div class="s">${so} room night terjual</div></div>
            <div class="kpi"><div class="l">ADR</div><div class="v" style="font-size:28px">${rp(so ? rr / so : 0)}</div></div>
            <div class="kpi"><div class="l">RevPAR</div><div class="v" style="font-size:28px">${rp(av ? rr / av : 0)}</div></div>
            <div class="kpi"><div class="l">Pendapatan kamar</div><div class="v" style="font-size:28px">${rp(rr)}</div></div>
            <div class="kpi"><div class="l">Pendapatan lain (aktual)</div><div class="v" style="font-size:28px">${rp(s('other_revenue'))}</div></div></div>
          <div class="card mb"><div class="hd"><h3>Okupansi, ADR & RevPAR</h3><span class="sub">batang pudar = forecast (on-the-books)</span></div><div class="bd">
            ${comboChart({ labels: rows.map((x) => fmtDay(x.d).replace(/^\w+, /, '')), dim: rows.map((x) => !x.is_actual),
              bars: [{ name: 'ADR', values: rows.map((x) => Number(x.adr || 0)), fmt: rp }, { name: 'RevPAR', values: rows.map((x) => Number(x.revpar || 0)), fmt: rp }],
              lines: [{ name: 'Okupansi', values: rows.map((x) => Number(x.occ || 0)), axis: 'right', fmt: pct, color: 'var(--c3)' }], y2Max: 100, height: 280 })}</div></div>
          <div class="card"><div class="tw" style="max-height:420px"><table class="t"><thead><tr><th>Tanggal</th><th class="right">Tersedia</th><th class="right">Terjual</th><th class="right">Okupansi</th><th class="right">ADR</th><th class="right">RevPAR</th><th class="right">Pend. kamar</th><th class="right">Pend. lain</th><th></th></tr></thead><tbody>
            ${rows.map((x) => `<tr><td class="nowrap">${fmtDay(x.d)}</td><td class="right">${x.available}</td><td class="right">${x.sold}</td><td class="right">${pct(x.occ)}</td><td class="right num">${rp(x.adr)}</td>
              <td class="right num">${rp(x.revpar)}</td><td class="right num">${rp(x.room_revenue)}</td><td class="right num">${rp(x.other_revenue)}</td><td>${x.is_actual ? '' : '<small class="muted">forecast</small>'}</td></tr>`).join('')}
          </tbody><tfoot><tr><td>Total</td><td class="right">${av}</td><td class="right">${so}</td><td class="right">${pct(av ? (so / av) * 100 : 0)}</td><td class="right num">${rp(so ? rr / so : 0)}</td><td class="right num">${rp(av ? rr / av : 0)}</td><td class="right num">${rp(rr)}</td><td class="right num">${rp(s('other_revenue'))}</td><td></td></tr></tfoot></table></div></div>`);
        bindRange();
        el.querySelector('#xl').onclick = () => downloadXLSX(`kinerja-${from}-sd-${to}`, { Kinerja: rows.map((x) => ({ tanggal: x.d, tersedia: x.available, terjual: x.sold, okupansi: Number(x.occ), adr: Number(x.adr || 0), revpar: Number(x.revpar || 0), pendapatan_kamar: Number(x.room_revenue), pendapatan_lain: Number(x.other_revenue), aktual: x.is_actual })) });
        return;
      }
      if (tab === 'pickup') {
        const rows = await rpc('report_pickup', { p_from: bd, p_days: 30, p_window: 7 });
        shell(`<div class="card mb"><div class="hd"><h3>On-the-books 30 hari ke depan</h3><span class="sub">pickup = room night yang dipesan dalam 7 hari terakhir</span>
            <span class="sp"><button class="btn sm" id="xl">${icon('dl')}Excel</button></span></div><div class="bd">
          ${comboChart({ labels: rows.map((x) => fmtDay(x.stay_date).replace(/^\w+, /, '')),
            bars: [{ name: 'OTB (kamar)', values: rows.map((x) => x.otb - x.pickup) }, { name: 'Pickup 7 hari', values: rows.map((x) => x.pickup), color: 'var(--c2)' }],
            lines: [{ name: 'Okupansi OTB', values: rows.map((x) => x.available ? Math.round((x.otb / x.available) * 100) : 0), axis: 'right', fmt: pct, color: 'var(--c5)' }], y2Max: 100, height: 260 })}</div></div>
          <div class="card"><div class="tw" style="max-height:420px"><table class="t"><thead><tr><th>Tanggal menginap</th><th class="right">OTB</th><th class="right">Pickup 7h</th><th class="right">Tersedia</th><th class="right">Okupansi</th><th class="right">Pendapatan OTB</th></tr></thead><tbody>
          ${rows.map((x) => `<tr><td>${fmtDay(x.stay_date)}</td><td class="right">${x.otb}</td><td class="right">${x.pickup ? '<b style="color:var(--magenta)">+' + x.pickup + '</b>' : '0'}</td><td class="right">${x.available}</td>
            <td class="right">${pct(x.available ? (x.otb / x.available) * 100 : 0)}</td><td class="right num">${rp(x.revenue)}</td></tr>`).join('')}</tbody></table></div></div>`);
        el.querySelector('#xl').onclick = () => downloadXLSX('pickup-' + bd, { Pickup: rows.map((x) => ({ tanggal: x.stay_date, otb: x.otb, pickup_7_hari: x.pickup, tersedia: x.available, pendapatan: Number(x.revenue) })) });
        return;
      }
      if (tab === 'channel') {
        const rows = await rpc('report_channel', { p_from: from, p_to: to });
        const tr = rows.reduce((a, x) => a + Number(x.revenue), 0), tn = rows.reduce((a, x) => a + x.room_nights, 0);
        shell(rangeBar() + `<div class="grid g2"><div class="card"><div class="hd"><h3>Pendapatan kamar per channel</h3></div><div class="bd">${donut(rows.map((x) => ({ label: CH[x.channel] || x.channel, value: Number(x.revenue) })), { fmt: rp, centerValue: rpShort(tr) })}</div></div>
          <div class="card"><div class="tw"><table class="t"><thead><tr><th>Channel</th><th class="right">Booking</th><th class="right">Room night</th><th class="right">Share</th><th class="right">ADR</th><th class="right">Pendapatan</th></tr></thead><tbody>
          ${rows.map((x) => `<tr><td><b>${CH[x.channel] || x.channel}</b></td><td class="right">${x.bookings}</td><td class="right">${x.room_nights}</td><td class="right">${pct(tn ? (x.room_nights / tn) * 100 : 0)}</td><td class="right num">${rp(x.adr)}</td><td class="right num">${rp(x.revenue)}</td></tr>`).join('') || `<tr><td colspan="6">${emptyState('Tidak ada data.')}</td></tr>`}
          </tbody></table></div><div class="bd muted small">Direct share tinggi = komisi OTA lebih rendah. Pantau rate parity: harga direct ≤ OTA.</div></div></div>`);
        bindRange();
        el.querySelector('#xl').onclick = () => downloadXLSX(`channel-${from}-sd-${to}`, { Channel: rows.map((x) => ({ channel: x.channel, booking: x.bookings, room_night: x.room_nights, adr: Number(x.adr), pendapatan: Number(x.revenue) })) });
        return;
      }
      if (tab === 'hk') {
        const f = from < bd ? from : addDays(bd, -30), t = to > bd ? bd : to;
        const rows = await rpc('report_hk', { p_from: f, p_to: t });
        shell(`<div class="card"><div class="hd"><h3>Produktivitas housekeeping</h3><span class="sub">${fmtDate(f)} – ${fmtDate(t)}</span><span class="sp"><button class="btn sm" id="xl">${icon('dl')}Excel</button></span></div>
          <div class="tw"><table class="t"><thead><tr><th>Staf</th><th class="right">Kamar</th><th class="right">Rata-rata menit</th><th class="right">Target</th><th class="right">Inspeksi</th><th class="right">Lulus</th><th class="right">Rework</th><th class="right">Skor rata-rata</th></tr></thead><tbody>
          ${rows.map((x) => `<tr><td><b>${esc(x.staff)}</b></td><td class="right">${x.tasks}</td><td class="right" style="${Number(x.avg_minutes) > Number(x.target_minutes) ? 'color:var(--st-dirty);font-weight:700' : ''}">${x.avg_minutes ?? '-'}</td>
            <td class="right">${x.target_minutes ?? '-'}</td><td class="right">${x.inspections}</td><td class="right">${pct(x.pass_rate)}</td><td class="right">${x.rework}</td><td class="right">${x.avg_score ?? '-'}</td></tr>`).join('') || `<tr><td colspan="8">${emptyState('Belum ada tugas selesai di periode ini.', 'hk')}</td></tr>`}
          </tbody></table></div><div class="bd muted small">Keadilan beban diukur dari menit (bukan jumlah kamar). Rework tinggi = kebutuhan pelatihan.</div></div>`);
        el.querySelector('#xl').onclick = () => downloadXLSX(`produktivitas-hk-${f}-sd-${t}`, { HK: rows });
      }
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
}
