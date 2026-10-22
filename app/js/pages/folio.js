import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, can, state, uid } from '../core.js';
import { statusTag, payModal, refundModal } from './shared.js';

const hashId = () => new URLSearchParams(location.hash.split('?')[1] || '').get('id');

export async function render(el) {
  let selected = hashId();
  let showClosed = false;
  const codes = await q(sb.from('transaction_codes').select('*').eq('is_active', true).order('grp').order('code'));
  const chargeCodes = codes.filter((c) => c.grp !== 'PAYMENT');

  async function load() {
    try {
      let qq = sb.from('folios').select('*, guests(full_name), reservations(confirmation_no, status, check_in, check_out, rooms(number))').order('created_at', { ascending: false }).limit(200);
      if (!showClosed) qq = qq.eq('status', 'OPEN');
      const folios = await q(qq);
      if (!selected && folios.length) selected = folios[0].id;
      el.innerHTML = `<div class="grid" style="grid-template-columns: 320px 1fr">
        <div class="card"><div class="hd"><h3>Folio</h3><span class="sp"><label style="font-size:12px"><input type="checkbox" id="sc" ${showClosed ? 'checked' : ''}> Tampilkan tertutup</label></span></div>
          <div class="bd" style="padding:8px"><input id="fs" placeholder="Cari nama / kamar / folio" style="width:100%"></div>
          <div class="tw" style="max-height:70vh;overflow:auto"><table class="t"><tbody id="fl">
          ${folios.map((f) => `<tr class="click" data-f="${f.id}" style="${f.id === selected ? 'background:#f5edff' : ''}" data-s="${esc((f.guests?.full_name + ' ' + (f.reservations?.rooms?.number || '') + ' ' + f.folio_no).toLowerCase())}">
            <td><b>${esc(f.guests?.full_name || '-')}</b><br><small class="muted">${esc(f.folio_no)} · kmr ${esc(f.reservations?.rooms?.number || '-')}</small></td>
            <td class="right num">${rp(f.balance)}<br>${statusTag(f.status)}</td></tr>`).join('') || '<tr><td class="empty">Belum ada folio.</td></tr>'}
          </tbody></table></div></div>
        <div id="fd"><div class="card"><div class="bd empty">Pilih folio.</div></div></div></div>`;
      el.querySelector('#sc').onchange = (e) => { showClosed = e.target.checked; load(); };
      el.querySelector('#fs').oninput = (e) => { const s = e.target.value.toLowerCase(); el.querySelectorAll('#fl tr[data-s]').forEach((r) => r.hidden = !r.dataset.s.includes(s)); };
      el.querySelectorAll('[data-f]').forEach((r) => r.onclick = () => { selected = r.dataset.f; load(); });
      if (selected) detail(el.querySelector('#fd'), selected);
    } catch (e) { fail(e); }
  }

  async function detail(box, id) {
    const [f, posts] = await Promise.all([
      q(sb.from('folios').select('*, guests(full_name, phone, email), reservations(confirmation_no, check_in, check_out, status, rooms(number), room_types(name))').eq('id', id).single()),
      q(sb.from('folio_postings').select('*, transaction_codes(code, name, grp)').eq('folio_id', id).order('business_date').order('posted_at'))
    ]);
    const reversed = new Set(posts.filter((p) => p.reverses_posting_id).map((p) => p.reverses_posting_id));
    const visible = posts.filter((p) => !p.reverses_posting_id && !reversed.has(p.id));
    const charges = visible.filter((p) => p.transaction_codes.grp !== 'PAYMENT');
    const pays = visible.filter((p) => p.transaction_codes.grp === 'PAYMENT');
    const sum = (a, k) => a.reduce((s, p) => s + Number(p[k]), 0);
    const byGrp = {}; charges.forEach((p) => { byGrp[p.transaction_codes.grp] = (byGrp[p.transaction_codes.grp] || 0) + Number(p.gross_amount); });
    const open = f.status === 'OPEN';
    const r = f.reservations || {};

    box.innerHTML = `<div class="card" id="inv"><div class="hd"><div><h3>${esc(f.folio_no)} · ${esc(f.guests?.full_name)}</h3>
        <small class="muted">${esc(r.confirmation_no || '')} · ${esc(r.room_types?.name || '')} ${esc(r.rooms?.number || '')} · ${fmtDate(r.check_in)} → ${fmtDate(r.check_out)}</small></div>
        <span class="sp">${open && can('fo', 'cashier', 'finance') ? '<button class="btn sm" id="ch">+ Charge</button>' + (Number(f.balance) < 0 ? '<button class="btn sm" id="rf">Refund</button>' : '') + '<button class="btn sm pri" id="py">Terima bayar</button>' : ''}<button class="btn sm" id="pr">Cetak</button></span></div>
      <div class="tw"><table class="t"><thead><tr><th>Tanggal</th><th>Kode</th><th>Uraian</th><th class="right">Net</th><th class="right">Service</th><th class="right">Pajak</th><th class="right">Total</th><th></th></tr></thead><tbody>
        ${visible.map((p) => `<tr><td>${fmtDate(p.business_date)}</td><td><small>${esc(p.transaction_codes.code)}</small></td><td>${esc(p.description)}${p.quantity != 1 ? ` <small class="muted">×${Number(p.quantity)}</small>` : ''}</td>
          <td class="right num">${rp(p.net_amount)}</td><td class="right num">${rp(p.service_amount)}</td><td class="right num">${rp(p.tax_amount)}</td><td class="right num"><b>${rp(p.gross_amount)}</b></td>
          <td>${open && can('finance', 'cashier', 'fo') ? `<button class="btn sm ghost" data-v="${p.id}" title="Void">Void</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Belum ada transaksi.</td></tr>'}
      </tbody></table></div>
      <div class="bd grid g2"><div>${Object.entries(byGrp).map(([g, v]) => `<div class="sum-row"><span class="muted">${esc(g)}</span><span>${rp(v)}</span></div>`).join('')}
        ${reversed.size ? `<p class="muted" style="font-size:12px">${reversed.size} posting di-void (tercatat di audit, disembunyikan dari tagihan).</p>` : ''}</div>
        <div><div class="sum-row"><span>Total tagihan</span><span>${rp(sum(charges, 'gross_amount'))}</span></div>
        <div class="sum-row"><span>Pembayaran / deposit</span><span>${rp(-sum(pays, 'gross_amount'))}</span></div>
        <div class="sum-row tot"><span>Saldo</span><span>${rp(f.balance)}</span></div></div></div></div>`;

    const reloadD = () => load();
    const pr = box.querySelector('#pr'); pr.onclick = () => printInvoice(f, visible, charges, pays);
    const ch = box.querySelector('#ch'); if (ch) ch.onclick = () => chargeModal(f, chargeCodes, reloadD);
    const rf = box.querySelector('#rf'); if (rf) rf.onclick = () => refundModal(f, reloadD, false);
    const py = box.querySelector('#py'); if (py) py.onclick = () => payModal(f, Number(f.balance), reloadD);
    box.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
      modal({ title: 'Void posting', body: '<p class="muted">Void membuat posting pembalik (reversal). Data asli tetap tersimpan untuk audit.</p><label class="f">Alasan<input name="r" required></label>',
        actions: [{ label: 'Void', cls: 'bad', run: async (m) => { const v = form(m); if (!v.r) { toast('Alasan wajib.', 'err'); return false; }
          await rpc('reverse_posting', { p_posting: b.dataset.v, p_reason: v.r }); toast('Posting di-void.', 'ok'); reloadD(); } }] });
    });
  }

  await load();
}

function chargeModal(f, codes, reload) {
  modal({
    title: 'Tambah charge · ' + f.folio_no,
    body: `<label class="f">Kode transaksi<select name="c">${codes.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} — ${esc(c.name)}${c.is_taxable ? '' : ' (non-pajak)'}</option>`).join('')}</select></label>
      <label class="f">Uraian<input name="d" required></label>
      <div class="row"><label class="f">Qty<input name="q" type="number" min="0.001" step="any" value="1"></label><label class="f">Harga satuan (net)<input name="p" type="number" min="0" step="500" required></label></div>
      <p class="muted" style="font-size:12px">Service ${Math.round(state.property.service_rate * 100)}% & pajak ${Math.round(state.property.tax_rate * 100)}% dihitung otomatis untuk kode kena pajak.</p>`,
    actions: [{ label: 'Posting', cls: 'pri', run: async (m) => {
      const v = form(m);
      if (!v.d || !v.p) { toast('Uraian & harga wajib.', 'err'); return false; }
      await rpc('post_charge', { p_folio: f.id, p_txn_code: v.c, p_description: v.d, p_quantity: Number(v.q), p_unit_price: Number(v.p), p_idempotency_key: 'MAN:' + uid(), p_source: 'FRONTDESK' });
      toast('Charge diposting.', 'ok'); reload();
    } }]
  });
}

function printInvoice(f, rows, charges, pays) {
  const w = window.open('', '_blank');
  if (!w) return toast('Izinkan pop-up untuk mencetak.', 'err');
  const sum = (a) => a.reduce((s, p) => s + Number(p.gross_amount), 0);
  const p = state.property;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(f.folio_no)}</title>
    <style>body{font-family:system-ui,sans-serif;font-size:12px;margin:32px;color:#111}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:14px}
    th,td{padding:6px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right}.tot td{font-weight:700;border-top:2px solid #111}.hd{display:flex;justify-content:space-between;align-items:flex-start}</style></head>
    <body><div class="hd"><div><img src="${location.origin + location.pathname.replace(/[^/]*$/, '')}assets/logo-sps.png" style="height:70px"><h1>${esc(p.name)}</h1><div>${esc(p.address || '')}</div></div>
    <div style="text-align:right"><h1>INVOICE / FOLIO</h1><div>${esc(f.folio_no)}</div><div>${new Date().toLocaleString('id-ID')}</div></div></div>
    <p><b>${esc(f.guests?.full_name || '')}</b><br>${esc(f.reservations?.confirmation_no || '')} · Kamar ${esc(f.reservations?.rooms?.number || '-')} · ${fmtDate(f.reservations?.check_in)} – ${fmtDate(f.reservations?.check_out)}</p>
    <table><thead><tr><th>Tanggal</th><th>Uraian</th><th class="r">Net</th><th class="r">Service</th><th class="r">Pajak</th><th class="r">Jumlah</th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${fmtDate(x.business_date)}</td><td>${esc(x.description)}</td><td class="r">${rp(x.net_amount)}</td><td class="r">${rp(x.service_amount)}</td><td class="r">${rp(x.tax_amount)}</td><td class="r">${rp(x.gross_amount)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="5">Total tagihan</td><td class="r">${rp(sum(charges))}</td></tr>
    <tr><td colspan="5">Pembayaran</td><td class="r">${rp(-sum(pays))}</td></tr>
    <tr class="tot"><td colspan="5">Saldo</td><td class="r">${rp(f.balance)}</td></tr></tbody></table>
    <p style="margin-top:40px">Tanda tangan tamu: ______________________</p><script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}
