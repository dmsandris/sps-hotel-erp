// Shift kasir: buka dengan modal awal, semua pembayaran tercatat ke shift, tutup dengan hitung kas fisik.
import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, state, confirmBox } from '../core.js';
import { icon, emptyState } from '../ui.js';

const METHOD = { 'PAY-CASH': 'Tunai', 'PAY-CARD': 'Kartu', 'PAY-QRIS': 'QRIS', 'PAY-TRANSFER': 'Transfer', 'PAY-CL': 'City Ledger' };

export async function render(el) {
  async function load() {
    try {
      const me = state.profile.user_id;
      const [open, hist] = await Promise.all([
        q(sb.from('cashier_shifts').select('*').eq('user_id', me).eq('status', 'OPEN').maybeSingle()),
        q(sb.from('cashier_shifts').select('*, profiles(full_name)').order('opened_at', { ascending: false }).limit(40))
      ]);
      let sum = null;
      if (open) sum = await rpc('shift_summary', { p_shift: open.id });
      el.innerHTML = `<div class="grid g2">
        <div class="card"><div class="hd"><h3>Shift saya</h3>${open ? '<span class="tag READY">Terbuka</span>' : '<span class="tag CLOSED">Tidak ada shift</span>'}</div><div class="bd">
          ${open ? `<div class="sum-row"><span class="muted">Dibuka</span><b>${new Date(open.opened_at).toLocaleString('id-ID')}</b></div>
            <div class="sum-row"><span class="muted">Modal awal (float)</span><b>${rp(open.opening_float)}</b></div>
            <h4 class="mt mb">Penerimaan per metode</h4>
            ${Object.entries(sum.payments).map(([k, v]) => `<div class="sum-row"><span>${METHOD[k] || k}</span><b class="num">${rp(v)}</b></div>`).join('') || '<p class="muted">Belum ada pembayaran.</p>'}
            <div class="sum-row tot"><span>Kas yang harus ada di laci</span><span class="num">${rp(Number(open.opening_float) + Number(sum.cash_in))}</span></div>
            <p class="muted small">${sum.postings} transaksi · ${sum.voids} void di shift ini.</p>
            <button class="btn pri lg mt" id="close">${icon('shift')}Tutup shift</button>`
          : `<p class="muted">Buka shift sebelum menerima pembayaran agar setoran kas bisa direkonsiliasi per kasir.</p>
            <label class="f">Modal awal di laci (float)<input type="number" id="fl" value="500000" min="0" step="50000"></label>
            <button class="btn pri lg" id="open">${icon('shift')}Buka shift</button>`}
        </div></div>
        <div class="card"><div class="hd"><h3>Riwayat shift</h3></div><div class="tw"><table class="t"><thead><tr><th>Kasir</th><th>Waktu</th><th class="right">Seharusnya</th><th class="right">Dihitung</th><th class="right">Selisih</th></tr></thead><tbody>
          ${hist.filter((h) => h.status === 'CLOSED').map((h) => `<tr class="click" data-h="${h.id}"><td>${esc(h.profiles?.full_name || '-')}<br><small class="muted">${fmtDate(h.business_date)}</small></td>
            <td class="small">${new Date(h.opened_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}–${new Date(h.closed_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</td>
            <td class="right num">${rp(h.expected_cash)}</td><td class="right num">${rp(h.counted_cash)}</td>
            <td class="right num" style="color:${Number(h.variance) === 0 ? 'var(--st-ready)' : 'var(--st-dirty)'};font-weight:700">${rp(h.variance)}</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('Belum ada shift ditutup.', 'shift')}</td></tr>`}
        </tbody></table></div></div></div>`;
      const ob = el.querySelector('#open');
      if (ob) ob.onclick = async () => { try { await rpc('open_shift', { p_float: Number(el.querySelector('#fl').value || 0) }); toast('Shift dibuka.', 'ok'); load(); } catch (e) { fail(e); } };
      const cb = el.querySelector('#close');
      if (cb) cb.onclick = () => modal({ title: 'Tutup shift',
        body: `<p>Hitung uang tunai fisik di laci (termasuk modal awal).</p><label class="f">Kas dihitung<input type="number" name="c" min="0" value="${Math.round(Number(open.opening_float) + Number(sum.cash_in))}"></label><label class="f">Catatan<input name="n"></label>`,
        actions: [{ label: 'Tutup & cetak', cls: 'pri', run: async (m) => {
          const v = form(m);
          const r = await rpc('close_shift', { p_counted: Number(v.c), p_notes: v.n || null });
          toast(`Shift ditutup. Selisih ${rp(r.variance)}.`, Number(r.variance) === 0 ? 'ok' : 'err');
          printShift(r); load();
        } }] });
      el.querySelectorAll('[data-h]').forEach((t) => t.onclick = () => {
        const h = hist.find((x) => x.id === t.dataset.h);
        modal({ title: 'Shift ' + (h.profiles?.full_name || ''), body: `${Object.entries(h.summary?.payments || {}).map(([k, v]) => `<div class="sum-row"><span>${METHOD[k] || k}</span><b>${rp(v)}</b></div>`).join('')}
          <div class="sum-row tot"><span>Selisih kas</span><span>${rp(h.variance)}</span></div>${h.notes ? `<p class="muted">${esc(h.notes)}</p>` : ''}`,
          actions: [{ label: 'Cetak', run: () => { printShift({ ...h.summary, expected_cash: h.expected_cash, counted_cash: h.counted_cash, variance: h.variance }); return false; } }] });
      });
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
}

function printShift(r) {
  const w = window.open('', '_blank'); if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Laporan shift</title><style>body{font-family:system-ui;font-size:12px;margin:28px}td{padding:5px 8px;border-bottom:1px solid #ddd}td.r{text-align:right}</style></head><body>
    <h2>${esc(state.property.name)} — Laporan Shift Kasir</h2><p>${esc(state.profile.full_name || '')} · ${new Date().toLocaleString('id-ID')}</p><table>
    ${Object.entries(r.payments || {}).map(([k, v]) => `<tr><td>${METHOD[k] || k}</td><td class="r">${rp(v)}</td></tr>`).join('')}
    <tr><td><b>Kas seharusnya</b></td><td class="r"><b>${rp(r.expected_cash)}</b></td></tr><tr><td>Kas dihitung</td><td class="r">${rp(r.counted_cash)}</td></tr>
    <tr><td><b>Selisih</b></td><td class="r"><b>${rp(r.variance)}</b></td></tr></table><p style="margin-top:40px">Kasir: ________________ &nbsp; Supervisor: ________________</p>
    <script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}
