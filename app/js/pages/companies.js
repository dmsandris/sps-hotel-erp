// Perusahaan (korporat) & City Ledger: limit kredit, invoice AR otomatis dari pembayaran CL, pelunasan, aging.
import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, can, state, uid } from '../core.js';
import { statusTag, PAY_METHODS } from './shared.js';
import { icon, emptyState, downloadXLSX } from '../ui.js';

const hashId = () => new URLSearchParams(location.hash.split('?')[1] || '').get('id');

export async function render(el) {
  let tab = 'ar';
  async function load() {
    try {
      const [cos, inv, aging] = await Promise.all([
        q(sb.from('companies').select('*').order('name')),
        q(sb.from('ar_invoices').select('*, companies(name), folios(folio_no, name)').order('issued_date', { ascending: false }).limit(400)),
        rpc('report_ar_aging')
      ]);
      const bd = state.property.business_date;
      const outstanding = inv.filter((i) => ['OPEN', 'PARTIAL'].includes(i.status));
      const totOut = outstanding.reduce((a, i) => a + Number(i.amount) - Number(i.paid_amount), 0);
      const overdue = outstanding.filter((i) => i.due_date < bd).reduce((a, i) => a + Number(i.amount) - Number(i.paid_amount), 0);
      const agingSum = (k) => aging.reduce((a, x) => a + Number(x[k]), 0);
      el.innerHTML = `<div class="kpis">
          <div class="kpi"><div class="l">${icon('company')}Perusahaan</div><div class="v">${cos.filter((c) => c.is_active).length}</div></div>
          <div class="kpi"><div class="l">Piutang berjalan</div><div class="v" style="font-size:28px">${rp(totOut)}</div><div class="s">${outstanding.length} invoice</div></div>
          <div class="kpi"><div class="l">Lewat jatuh tempo</div><div class="v" style="font-size:28px;color:${overdue ? 'var(--st-dirty)' : 'inherit'}">${rp(overdue)}</div></div>
          <div class="kpi"><div class="l">> 60 hari</div><div class="v" style="font-size:28px">${rp(agingSum('d61_90') + agingSum('d90_plus'))}</div></div></div>
        <div class="tabs">${[['ar', 'Invoice City Ledger'], ['aging', 'Aging piutang'], ['co', 'Daftar perusahaan']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${tab === 'ar' ? `<div class="card"><div class="hd"><h3>Invoice</h3><span class="sp"><button class="btn sm" id="xl">${icon('dl')}Excel</button></span></div><div class="tw"><table class="t"><thead><tr><th>Invoice</th><th>Perusahaan</th><th>Folio</th><th>Terbit</th><th>Jatuh tempo</th><th class="right">Nilai</th><th class="right">Sisa</th><th>Status</th><th></th></tr></thead><tbody>
          ${inv.map((i) => { const late = ['OPEN', 'PARTIAL'].includes(i.status) && i.due_date < bd; return `<tr><td><b>${esc(i.invoice_no)}</b></td><td>${esc(i.companies?.name)}</td>
            <td><a href="#/folio?id=${i.folio_id}">${esc(i.folios?.folio_no)}</a></td><td>${fmtDate(i.issued_date)}</td><td style="${late ? 'color:var(--st-dirty);font-weight:700' : ''}">${fmtDate(i.due_date)}</td>
            <td class="right num">${rp(i.amount)}</td><td class="right num">${rp(i.amount - i.paid_amount)}</td><td>${statusTag(late ? 'OVERDUE' : i.status)}</td>
            <td>${['OPEN', 'PARTIAL'].includes(i.status) && can('finance') ? `<button class="btn sm pri" data-pay="${i.id}">Terima</button>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="9">${emptyState('Belum ada invoice. Invoice terbit otomatis saat folio dibayar dengan metode City Ledger.', 'company')}</td></tr>`}
          </tbody></table></div></div>` : ''}
        ${tab === 'aging' ? `<div class="card"><div class="hd"><h3>Aging per ${fmtDate(bd)}</h3></div><div class="tw"><table class="t"><thead><tr><th>Perusahaan</th><th class="right">Belum jatuh tempo</th><th class="right">1–30</th><th class="right">31–60</th><th class="right">61–90</th><th class="right">> 90</th><th class="right">Total</th><th class="right">Limit</th></tr></thead><tbody>
          ${aging.map((a) => `<tr><td><b>${esc(a.company)}</b></td>${['current_amt', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) => `<td class="right num">${rp(a[k])}</td>`).join('')}
            <td class="right num"><b>${rp(a.total)}</b></td><td class="right num" style="${Number(a.credit_limit) > 0 && Number(a.total) > Number(a.credit_limit) ? 'color:var(--st-dirty);font-weight:700' : ''}">${rp(a.credit_limit)}</td></tr>`).join('') || `<tr><td colspan="8">${emptyState('Tidak ada piutang.')}</td></tr>`}
          </tbody>${aging.length ? `<tfoot><tr><td>Total</td>${['current_amt', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'total'].map((k) => `<td class="right num">${rp(agingSum(k))}</td>`).join('')}<td></td></tr></tfoot>` : ''}</table></div></div>` : ''}
        ${tab === 'co' ? `<div class="card"><div class="hd"><h3>Perusahaan</h3><span class="sp">${can('fo', 'finance') ? `<button class="btn pri" id="nc">${icon('plus')}Perusahaan</button>` : ''}</span></div><div class="tw"><table class="t"><thead><tr><th>Nama</th><th>NPWP</th><th>PIC</th><th class="right">Limit kredit</th><th class="center">Termin</th><th>Status</th></tr></thead><tbody>
          ${cos.map((c) => `<tr class="click" data-c="${c.id}"><td><b>${esc(c.name)}</b><br><small class="muted">${esc(c.email || '')}</small></td><td>${esc(c.npwp || '-')}</td><td>${esc(c.contact_name || '-')}<br><small class="muted">${esc(c.phone || '')}</small></td>
            <td class="right num">${rp(c.credit_limit)}</td><td class="center">${c.payment_terms_days} hari</td><td>${c.is_active ? '<span class="tag READY">Aktif</span>' : '<span class="tag CLOSED">Nonaktif</span>'}</td></tr>`).join('') || `<tr><td colspan="6">${emptyState('Belum ada perusahaan.', 'company')}</td></tr>`}
          </tbody></table></div></div>` : ''}`;
      el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; load(); });
      const nc = el.querySelector('#nc'); if (nc) nc.onclick = () => companyModal(null, load);
      el.querySelectorAll('[data-c]').forEach((t) => t.onclick = () => companyModal(cos.find((c) => c.id === t.dataset.c), load));
      el.querySelectorAll('[data-pay]').forEach((b) => b.onclick = () => payAR(inv.find((i) => i.id === b.dataset.pay), load));
      const xl = el.querySelector('#xl'); if (xl) xl.onclick = () => downloadXLSX('city-ledger-' + bd, { Invoice: inv.map((i) => ({ invoice: i.invoice_no, perusahaan: i.companies?.name, folio: i.folios?.folio_no,
        terbit: i.issued_date, jatuh_tempo: i.due_date, nilai: Number(i.amount), dibayar: Number(i.paid_amount), sisa: i.amount - i.paid_amount, status: i.status })), Aging: aging });
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  if (hashId()) tab = 'co';
  await load();
  const id = hashId(); if (id) { const c = (await q(sb.from('companies').select('*').eq('id', id))).at(0); if (c) companyModal(c, load); }
}

function companyModal(c, reload) {
  const v = c || { payment_terms_days: 30, credit_limit: 0, is_active: true };
  modal({ title: c ? c.name : 'Perusahaan baru', wide: true,
    body: `<div class="row"><label class="f">Nama perusahaan<input name="name" value="${esc(v.name || '')}" required></label><label class="f">NPWP<input name="npwp" value="${esc(v.npwp || '')}"></label></div>
      <label class="f">Alamat penagihan<input name="address" value="${esc(v.address || '')}"></label>
      <div class="row"><label class="f">PIC<input name="contact_name" value="${esc(v.contact_name || '')}"></label><label class="f">HP<input name="phone" value="${esc(v.phone || '')}"></label><label class="f">Email tagihan<input name="email" value="${esc(v.email || '')}"></label></div>
      <div class="row"><label class="f">Limit kredit (Rp)<input type="number" name="credit_limit" value="${v.credit_limit}" min="0" step="1000000"></label>
        <label class="f">Termin (hari)<input type="number" name="payment_terms_days" value="${v.payment_terms_days}" min="0"></label>
        <label class="f">Status<select name="is_active"><option value="true" ${v.is_active ? 'selected' : ''}>Aktif</option><option value="false" ${!v.is_active ? 'selected' : ''}>Nonaktif</option></select></label></div>`,
    actions: can('fo', 'finance') ? [{ label: 'Simpan', cls: 'pri', run: async (m) => {
      const d = form(m); if (!d.name.trim()) { toast('Nama wajib.', 'err'); return false; }
      await rpc('upsert_company', { p_id: c?.id || null, p_data: d }); toast('Perusahaan disimpan.', 'ok'); reload();
    } }] : [] });
}

function payAR(i, reload) {
  const idem = 'AR-' + uid();
  modal({ title: 'Pelunasan ' + i.invoice_no,
    body: `<p>${esc(i.companies?.name)} · sisa <b>${rp(i.amount - i.paid_amount)}</b></p>
      <div class="row"><label class="f">Metode<select name="m">${PAY_METHODS.filter(([k]) => k !== 'CL').map(([k, l]) => `<option value="${k}" ${k === 'TRANSFER' ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">Jumlah<input type="number" name="a" value="${Math.round(i.amount - i.paid_amount)}" min="1"></label></div><label class="f">Referensi (no. bukti transfer)<input name="r"></label>`,
    actions: [{ label: 'Catat pelunasan', cls: 'pri', run: async (m) => {
      const v = form(m); await rpc('ar_receive', { p_invoice: i.id, p_amount: Number(v.a), p_method: v.m, p_reference: v.r || null, p_idempotency_key: idem });
      toast('Pelunasan tercatat & dijurnal.', 'ok'); reload();
    } }] });
}
