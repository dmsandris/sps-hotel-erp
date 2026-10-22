import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, can, state, uid } from '../core.js';
import { statusTag, payModal, refundModal, PAY_METHODS } from './shared.js';
import { icon, emptyState } from '../ui.js';

const hashId = () => new URLSearchParams(location.hash.split('?')[1] || '').get('id');
const TYPE_LABEL = { GUEST: 'Tamu', MASTER: 'Master', EVENT: 'Event', HOUSE: 'House' };

export async function render(el) {
  let selected = hashId();
  let showClosed = false, type = '';
  const [codes, companies] = await Promise.all([
    q(sb.from('transaction_codes').select('*').eq('is_active', true).order('grp').order('code')),
    q(sb.from('companies').select('id, name').order('name')).catch(() => [])
  ]);
  const chargeCodes = codes.filter((c) => c.grp !== 'PAYMENT');

  async function load() {
    try {
      let qq = sb.from('folios').select('*, guests(full_name), companies(name), reservations(confirmation_no, status, check_in, check_out, rooms(number))').order('created_at', { ascending: false }).limit(300);
      if (!showClosed) qq = qq.eq('status', 'OPEN');
      if (type) qq = qq.eq('type', type);
      const folios = await q(qq);
      if (!selected && folios.length) selected = folios[0].id;
      const label = (f) => f.guests?.full_name || f.name || f.companies?.name || f.folio_no;
      el.innerHTML = `<div class="grid" style="grid-template-columns: minmax(280px, 340px) minmax(0, 1fr)">
        <div class="card"><div class="hd"><h3>Folio</h3><span class="sp">${can('fo', 'cashier', 'finance') ? `<button class="btn sm" id="nf">${icon('plus')}Folio</button>` : ''}</span></div>
          <div class="bd" style="padding:8px 10px">
            <div class="seg" style="width:100%;margin-bottom:8px">${['', 'GUEST', 'MASTER', 'EVENT', 'HOUSE'].map((t) => `<button data-t="${t}" class="${type === t ? 'on' : ''}" style="flex:1">${t ? TYPE_LABEL[t] : 'Semua'}</button>`).join('')}</div>
            <input id="fs" placeholder="Cari nama / kamar / folio" style="width:100%">
            <label class="small" style="display:block;margin-top:6px"><input type="checkbox" id="sc" ${showClosed ? 'checked' : ''}> Tampilkan yang tertutup</label></div>
          <div class="tw" style="max-height:68vh;overflow:auto"><table class="t"><tbody id="fl">
          ${folios.map((f) => `<tr class="click" data-f="${f.id}" style="${f.id === selected ? 'background:var(--hover)' : ''}" data-s="${esc((label(f) + ' ' + (f.reservations?.rooms?.number || '') + ' ' + f.folio_no).toLowerCase())}">
            <td><b>${esc(label(f))}</b> ${f.type !== 'GUEST' ? `<span class="tag ${f.type}">${TYPE_LABEL[f.type]}</span>` : ''}<br><small class="muted">${esc(f.folio_no)}${f.reservations?.rooms?.number ? ' · kmr ' + esc(f.reservations.rooms.number) : ''}</small></td>
            <td class="right num">${rp(f.balance)}<br>${statusTag(f.status)}</td></tr>`).join('') || `<tr><td>${emptyState('Belum ada folio.', 'folio')}</td></tr>`}
          </tbody></table></div></div>
        <div id="fd"><div class="card"><div class="bd">${emptyState('Pilih folio di kiri.', 'folio')}</div></div></div></div>`;
      el.querySelector('#sc').onchange = (e) => { showClosed = e.target.checked; load(); };
      el.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { type = b.dataset.t; selected = null; load(); });
      el.querySelector('#fs').oninput = (e) => { const s = e.target.value.toLowerCase(); el.querySelectorAll('#fl tr[data-s]').forEach((r) => r.hidden = !r.dataset.s.includes(s)); };
      el.querySelectorAll('[data-f]').forEach((r) => r.onclick = () => { selected = r.dataset.f; load(); });
      const nf = el.querySelector('#nf'); if (nf) nf.onclick = () => newFolio(companies, (id) => { selected = id; load(); });
      if (selected) detail(el.querySelector('#fd'), selected).catch(fail);
    } catch (e) { fail(e); }
  }

  async function detail(box, id) {
    const [f, posts] = await Promise.all([
      q(sb.from('folios').select('*, guests(full_name, phone, email), companies(name), reservations(id, confirmation_no, check_in, check_out, status, company_id, rooms(number), room_types(name))').eq('id', id).single()),
      q(sb.from('folio_postings').select('*, transaction_codes(code, name, grp)').eq('folio_id', id).order('business_date').order('posted_at'))
    ]);
    const rts = f.reservations?.id ? await q(sb.from('routing_rules').select('*, folios!routing_rules_to_folio_id_fkey(folio_no, name)').eq('reservation_id', f.reservations.id)).catch(() => []) : [];
    const reversed = new Set(posts.filter((p) => p.reverses_posting_id).map((p) => p.reverses_posting_id));
    const visible = posts.filter((p) => !p.reverses_posting_id && !reversed.has(p.id));
    const charges = visible.filter((p) => p.transaction_codes.grp !== 'PAYMENT');
    const pays = visible.filter((p) => p.transaction_codes.grp === 'PAYMENT');
    const sum = (a, k) => a.reduce((s, p) => s + Number(p[k]), 0);
    const byGrp = {}; charges.forEach((p) => { byGrp[p.transaction_codes.grp] = (byGrp[p.transaction_codes.grp] || 0) + Number(p.gross_amount); });
    const open = f.status === 'OPEN';
    const r = f.reservations || {};
    const title = f.guests?.full_name || f.name || f.folio_no;
    const ed = open && can('fo', 'cashier', 'finance');

    box.innerHTML = `<div class="card" id="inv"><div class="hd"><div><h3>${esc(f.folio_no)} · ${esc(title)} ${f.type !== 'GUEST' ? `<span class="tag ${f.type}">${TYPE_LABEL[f.type]}</span>` : ''}</h3>
        <small class="muted">${r.confirmation_no ? `${esc(r.confirmation_no)} · ${esc(r.room_types?.name || '')} ${esc(r.rooms?.number || '')} · ${fmtDate(r.check_in)} → ${fmtDate(r.check_out)}` : 'Dibuka ' + fmtDate(f.opened_business_date)}
        ${f.companies?.name ? ' · ' + icon('company') + ' ' + esc(f.companies.name) : ''}</small></div>
        <span class="sp">${ed ? `<button class="btn sm" id="ch">${icon('plus')}Charge</button>${Number(f.balance) < 0 ? '<button class="btn sm" id="rf">Refund</button>' : ''}<button class="btn sm pri" id="py">${icon('money')}Terima bayar</button>` : ''}
          ${ed && f.type === 'GUEST' && r.id ? `<button class="btn sm" id="rt">Routing</button>` : ''}
          ${ed && r.id && can('fo', 'finance') ? `<button class="btn sm" id="cp">Perusahaan</button>` : ''}
          ${open && f.type !== 'GUEST' && Number(f.balance) === 0 && can('fo', 'cashier', 'finance') ? `<button class="btn sm" id="st">Tutup folio</button>` : ''}
          <button class="btn sm" id="pr">${icon('print')}Cetak</button></span></div>
      ${rts.length ? `<div class="bd" style="padding-bottom:0">${rts.map((x) => `<div class="alert info small">Routing: ${x.grps.map(esc).join(', ')} → ${esc(x.folios?.folio_no)} ${esc(x.folios?.name || '')}
        ${ed ? `<button class="btn sm ghost" data-rr="${x.id}" style="margin-left:auto">Hapus</button>` : ''}</div>`).join('')}</div>` : ''}
      <div class="tw"><table class="t"><thead><tr><th>Tanggal</th><th>Kode</th><th>Uraian</th><th class="right">Net</th><th class="right">Service</th><th class="right">Pajak</th><th class="right">Total</th><th></th></tr></thead><tbody>
        ${visible.map((p) => `<tr><td class="nowrap">${fmtDate(p.business_date)}</td><td><small>${esc(p.transaction_codes.code)}</small></td><td>${esc(p.description)}${p.quantity != 1 ? ` <small class="muted">×${Number(p.quantity)}</small>` : ''}${p.routed_from_folio_id ? ' <small class="pill" style="font-size:10px">di-routing</small>' : ''}</td>
          <td class="right num">${rp(p.net_amount)}</td><td class="right num">${rp(p.service_amount)}</td><td class="right num">${rp(p.tax_amount)}</td><td class="right num"><b>${rp(p.gross_amount)}</b></td>
          <td class="nowrap">${ed ? `${p.transaction_codes.grp !== 'PAYMENT' ? `<button class="btn sm ghost" data-tr="${p.id}" title="Pindah ke folio lain">Pindah</button>` : ''}<button class="btn sm ghost" data-v="${p.id}" title="Void">Void</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="8">${emptyState('Belum ada transaksi.')}</td></tr>`}
      </tbody></table></div>
      <div class="bd grid g2"><div>${Object.entries(byGrp).map(([g, v]) => `<div class="sum-row"><span class="muted">${esc(g)}</span><span class="num">${rp(v)}</span></div>`).join('')}
        ${reversed.size ? `<p class="muted small">${reversed.size} posting di-void / dipindah (tercatat di audit, disembunyikan dari tagihan).</p>` : ''}</div>
        <div><div class="sum-row"><span>Total tagihan</span><span class="num">${rp(sum(charges, 'gross_amount'))}</span></div>
        <div class="sum-row"><span>Pembayaran / deposit</span><span class="num">${rp(-sum(pays, 'gross_amount'))}</span></div>
        <div class="sum-row tot"><span>Saldo</span><span class="num">${rp(f.balance)}</span></div></div></div></div>`;

    const reloadD = () => load();
    box.querySelector('#pr').onclick = () => printInvoice(f, visible, charges, pays);
    const ch = box.querySelector('#ch'); if (ch) ch.onclick = () => chargeModal(f, chargeCodes, reloadD);
    const rf = box.querySelector('#rf'); if (rf) rf.onclick = () => refundModal(f, reloadD, false);
    const py = box.querySelector('#py'); if (py) py.onclick = () => payModal(f, Number(f.balance), reloadD);
    const st = box.querySelector('#st'); if (st) st.onclick = async () => { try { await rpc('settle_folio', { p_folio: f.id }); toast('Folio ditutup.', 'ok'); reloadD(); } catch (e) { fail(e); } };
    const rt = box.querySelector('#rt'); if (rt) rt.onclick = () => routingModal(f, reloadD);
    const cp = box.querySelector('#cp'); if (cp) cp.onclick = () => modal({ title: 'Perusahaan penanggung', body: `<label class="f">Perusahaan (untuk City Ledger)<select name="c"><option value="">—</option>${companies.map((c) => `<option value="${c.id}" ${c.id === r.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`,
      actions: [{ label: 'Simpan', cls: 'pri', run: async (m) => { await rpc('set_reservation_company', { p_reservation: r.id, p_company: form(m).c || null }); toast('Perusahaan diset.', 'ok'); reloadD(); } }] });
    box.querySelectorAll('[data-rr]').forEach((b) => b.onclick = async () => { try { await rpc('remove_routing', { p_id: b.dataset.rr }); reloadD(); } catch (e) { fail(e); } });
    box.querySelectorAll('[data-tr]').forEach((b) => b.onclick = () => transferModal(b.dataset.tr, f.id, reloadD));
    box.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
      modal({ title: 'Void posting', body: '<p class="muted">Void membuat posting pembalik (reversal). Data asli tetap tersimpan untuk audit.</p><label class="f">Alasan<input name="r" required></label>',
        actions: [{ label: 'Void', cls: 'bad', run: async (m) => { const v = form(m); if (!v.r) { toast('Alasan wajib.', 'err'); return false; }
          await rpc('reverse_posting', { p_posting: b.dataset.v, p_reason: v.r }); toast('Posting di-void.', 'ok'); reloadD(); } }] });
    });
  }

  await load();
}

async function openFolios(exclude) {
  return (await q(sb.from('folios').select('id, folio_no, name, type, guests(full_name), reservations(rooms(number))').eq('status', 'OPEN').order('created_at', { ascending: false }).limit(300)))
    .filter((x) => x.id !== exclude);
}
const folioLabel = (x) => `${x.folio_no} · ${x.guests?.full_name || x.name || '-'}${x.reservations?.rooms?.number ? ' (kmr ' + x.reservations.rooms.number + ')' : ''} [${TYPE_LABEL[x.type]}]`;

async function transferModal(postingId, fromId, reload) {
  const list = await openFolios(fromId);
  modal({ title: 'Pindah posting ke folio lain',
    body: `<label class="f">Folio tujuan<select name="t">${list.map((x) => `<option value="${x.id}">${esc(folioLabel(x))}</option>`).join('')}</select></label><label class="f">Alasan<input name="r" required placeholder="mis. ditagih ke master grup"></label>`,
    actions: [{ label: 'Pindahkan', cls: 'pri', run: async (m) => { const v = form(m); if (!v.r) { toast('Alasan wajib.', 'err'); return false; }
      await rpc('transfer_posting', { p_posting: postingId, p_to_folio: v.t, p_reason: v.r }); toast('Posting dipindahkan.', 'ok'); reload(); } }] });
}

async function routingModal(f, reload) {
  const list = await openFolios(f.id);
  const G = ['ROOM', 'FB', 'LAUNDRY', 'FACILITY', 'MEETING', 'MINIBAR', 'PENALTY'];
  modal({ title: 'Routing tagihan otomatis',
    body: `<p class="muted small">Charge baru dari reservasi ini dengan grup terpilih otomatis masuk ke folio tujuan (mis. kamar ditagih perusahaan, F&B ditanggung tamu).</p>
      <label class="f">Folio tujuan<select name="t">${list.map((x) => `<option value="${x.id}">${esc(folioLabel(x))}</option>`).join('')}</select></label>
      <div class="row">${G.map((g) => `<label><input type="checkbox" name="g_${g}" ${g === 'ROOM' ? 'checked' : ''}> ${g}</label>`).join('')}</div>`,
    actions: [{ label: 'Simpan routing', cls: 'pri', run: async (m) => {
      const v = form(m); const grps = G.filter((g) => v['g_' + g]);
      if (!grps.length) { toast('Pilih minimal satu grup.', 'err'); return false; }
      await rpc('set_routing', { p_reservation: f.reservations.id, p_to_folio: v.t, p_grps: grps }); toast('Routing aktif untuk charge berikutnya.', 'ok'); reload();
    } }] });
}

function newFolio(companies, done) {
  modal({ title: 'Folio baru',
    body: `<label class="f">Jenis<select name="t"><option value="MASTER">Master (grup/korporat)</option><option value="HOUSE">House (penjualan non-tamu)</option></select></label>
      <label class="f">Nama<input name="n" placeholder="mis. Master PT Maju Jaya"></label>
      <label class="f">Perusahaan<select name="c"><option value="">—</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <p class="muted small">Folio event dibuat otomatis dari menu Meeting & Event.</p>`,
    actions: [{ label: 'Buat', cls: 'pri', run: async (m) => { const v = form(m); const id = await rpc('create_folio', { p_type: v.t, p_name: v.n, p_company: v.c || null }); toast('Folio dibuat.', 'ok'); done(id); } }] });
}

function chargeModal(f, codes, reload) {
  modal({
    title: 'Tambah charge · ' + f.folio_no,
    body: `<label class="f">Kode transaksi<select name="c">${codes.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} — ${esc(c.name)}${c.is_taxable ? '' : ' (non-pajak)'}</option>`).join('')}</select></label>
      <label class="f">Uraian<input name="d" required></label>
      <div class="row"><label class="f">Qty<input name="q" type="number" min="0.001" step="any" value="1"></label><label class="f">Harga satuan (net)<input name="p" type="number" min="0" step="500" required></label></div>
      <p class="muted small">Service ${Math.round(state.property.service_rate * 100)}% & pajak ${Math.round(state.property.tax_rate * 100)}% dihitung otomatis untuk kode kena pajak. Routing berlaku otomatis.</p>`,
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
  const svc = rows.reduce((s, x) => s + Number(x.service_amount), 0), tax = rows.reduce((s, x) => s + Number(x.tax_amount), 0);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(f.folio_no)}</title>
    <style>body{font-family:system-ui,sans-serif;font-size:12px;margin:32px;color:#111}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:14px}
    th,td{padding:6px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right}.tot td{font-weight:700;border-top:2px solid #111}.hd{display:flex;justify-content:space-between;align-items:flex-start}</style></head>
    <body><div class="hd"><div><img src="${location.origin + location.pathname.replace(/[^/]*$/, '')}assets/logo-sps.png" style="height:70px"><h1>${esc(p.name)}</h1><div>${esc(p.address || '')}</div>${p.npwp ? `<div>NPWP ${esc(p.npwp)}</div>` : ''}</div>
    <div style="text-align:right"><h1>INVOICE / FOLIO</h1><div>${esc(f.folio_no)}</div><div>${new Date().toLocaleString('id-ID')}</div></div></div>
    <p><b>${esc(f.guests?.full_name || f.name || '')}</b>${f.companies?.name ? '<br>' + esc(f.companies.name) : ''}<br>${f.reservations ? `${esc(f.reservations.confirmation_no || '')} · Kamar ${esc(f.reservations.rooms?.number || '-')} · ${fmtDate(f.reservations.check_in)} – ${fmtDate(f.reservations.check_out)}` : ''}</p>
    <table><thead><tr><th>Tanggal</th><th>Uraian</th><th class="r">Net</th><th class="r">Service</th><th class="r">Pajak</th><th class="r">Jumlah</th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${fmtDate(x.business_date)}</td><td>${esc(x.description)}</td><td class="r">${rp(x.net_amount)}</td><td class="r">${rp(x.service_amount)}</td><td class="r">${rp(x.tax_amount)}</td><td class="r">${rp(x.gross_amount)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="5">Total tagihan (termasuk service ${rp(svc)} & pajak ${rp(tax)})</td><td class="r">${rp(sum(charges))}</td></tr>
    <tr><td colspan="5">Pembayaran</td><td class="r">${rp(-sum(pays))}</td></tr>
    <tr class="tot"><td colspan="5">Saldo</td><td class="r">${rp(f.balance)}</td></tr></tbody></table>
    <p style="margin-top:40px">Tanda tangan tamu: ______________________</p><script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}
