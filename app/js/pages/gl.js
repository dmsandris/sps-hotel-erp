// Buku besar: neraca saldo & jurnal otomatis dari posting folio dan pelunasan AR (double-entry, selalu seimbang).
import { sb, q, rpc, esc, rp, fmtDate, fail, state, addDays } from '../core.js';
import { icon, emptyState, downloadXLSX } from '../ui.js';

const TYPE = { ASSET: 'Aset', LIABILITY: 'Kewajiban', EQUITY: 'Ekuitas', REVENUE: 'Pendapatan', EXPENSE: 'Beban' };

export async function render(el) {
  const bd = state.property.business_date;
  let from = bd.slice(0, 8) + '01', to = bd, tab = 'tb';
  async function load() {
    try {
      const tb = await rpc('report_trial_balance', { p_from: from, p_to: to });
      let je = [];
      if (tab === 'je') {
        const entries = await q(sb.from('journal_entries').select('*, journal_lines(account_code, debit, credit)').gte('business_date', from).lte('business_date', to).order('id', { ascending: false }).limit(300));
        je = entries;
      }
      const td = tb.reduce((a, x) => a + Number(x.debit), 0), tc = tb.reduce((a, x) => a + Number(x.credit), 0);
      const names = Object.fromEntries(tb.map((x) => [x.code, x.name]));
      const rev = tb.filter((x) => x.type === 'REVENUE').reduce((a, x) => a + Number(x.balance), 0);
      el.innerHTML = `<div class="card mb"><div class="bd row" style="justify-content:space-between">
          <div class="row"><label class="f" style="margin:0">Dari<input type="date" id="f" value="${from}"></label><label class="f" style="margin:0">Sampai<input type="date" id="t" value="${to}"></label>
            <div class="seg"><button data-tab="tb" class="${tab === 'tb' ? 'on' : ''}">Neraca saldo</button><button data-tab="je" class="${tab === 'je' ? 'on' : ''}">Jurnal</button></div></div>
          <div class="row"><span class="pill">${Math.abs(td - tc) < 0.5 ? '✓ Seimbang' : '⚠ Tidak seimbang'}</span><button class="btn sm" id="xl">${icon('dl')}Excel</button></div></div></div>
        ${tab === 'tb' ? `<div class="kpis"><div class="kpi"><div class="l">Pendapatan periode</div><div class="v" style="font-size:28px">${rp(rev)}</div></div>
            <div class="kpi"><div class="l">Pajak terutang</div><div class="v" style="font-size:28px">${rp(tb.find((x) => x.code === '2100')?.balance)}</div></div>
            <div class="kpi"><div class="l">Service terutang</div><div class="v" style="font-size:28px">${rp(tb.find((x) => x.code === '2200')?.balance)}</div></div>
            <div class="kpi"><div class="l">Guest ledger</div><div class="v" style="font-size:28px">${rp(tb.find((x) => x.code === '1200')?.balance)}</div></div></div>
          <div class="card"><div class="tw"><table class="t"><thead><tr><th>Akun</th><th>Nama</th><th>Jenis</th><th class="right">Debit</th><th class="right">Kredit</th><th class="right">Saldo</th></tr></thead><tbody>
          ${tb.map((x) => `<tr><td><b>${esc(x.code)}</b></td><td>${esc(x.name)}</td><td><small class="muted">${TYPE[x.type]}</small></td><td class="right num">${rp(x.debit)}</td><td class="right num">${rp(x.credit)}</td><td class="right num"><b>${rp(x.balance)}</b></td></tr>`).join('')}
          </tbody><tfoot><tr><td colspan="3">Total</td><td class="right num">${rp(td)}</td><td class="right num">${rp(tc)}</td><td></td></tr></tfoot></table></div>
          <div class="bd muted small">Jurnal otomatis: charge → Dr Guest Ledger / Cr Pendapatan + Service + Pajak; pembayaran → Dr Kas/Bank/City Ledger / Cr Guest Ledger; pelunasan AR → Dr Bank / Cr City Ledger. Void & transfer membalik jurnal.</div></div>`
        : `<div class="card"><div class="tw"><table class="t"><thead><tr><th>#</th><th>Tanggal</th><th>Sumber</th><th>Keterangan</th><th>Akun</th><th class="right">Debit</th><th class="right">Kredit</th></tr></thead><tbody>
          ${je.map((e) => e.journal_lines.map((l, i) => `<tr${i === 0 ? ' style="border-top:2px solid var(--line)"' : ''}><td>${i === 0 ? e.id : ''}</td><td>${i === 0 ? fmtDate(e.business_date) : ''}</td><td>${i === 0 ? esc(e.source) : ''}</td>
            <td>${i === 0 ? esc(e.memo || '') : ''}</td><td>${esc(l.account_code)} <small class="muted">${esc(names[l.account_code] || '')}</small></td><td class="right num">${Number(l.debit) ? rp(l.debit) : ''}</td><td class="right num">${Number(l.credit) ? rp(l.credit) : ''}</td></tr>`).join('')).join('')
            || `<tr><td colspan="7">${emptyState('Tidak ada jurnal di periode ini.', 'gl')}</td></tr>`}</tbody></table></div></div>`}`;
      el.querySelector('#f').onchange = (e) => { from = e.target.value; load(); };
      el.querySelector('#t').onchange = (e) => { to = e.target.value; load(); };
      el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; load(); });
      el.querySelector('#xl').onclick = async () => {
        const entries = await q(sb.from('journal_entries').select('*, journal_lines(account_code, debit, credit)').gte('business_date', from).lte('business_date', to).order('id').limit(5000));
        downloadXLSX(`buku-besar-${from}-sd-${to}`, { 'Neraca saldo': tb.map((x) => ({ akun: x.code, nama: x.name, jenis: TYPE[x.type], debit: Number(x.debit), kredit: Number(x.credit), saldo: Number(x.balance) })),
          Jurnal: entries.flatMap((e) => e.journal_lines.map((l) => ({ no: e.id, tanggal: e.business_date, sumber: e.source, keterangan: e.memo, akun: l.account_code, debit: Number(l.debit), kredit: Number(l.credit) }))) });
      };
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
}
