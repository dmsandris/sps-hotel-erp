// Outlet / POS ringan: charge-to-room dari restoran, laundry, fasilitas, minibar.
import { sb, q, rpc, esc, rp, toast, fail, state, uid } from '../core.js';
import { onData } from '../main.js';

const PRESETS = {
  'FB-FOOD':    [['Nasi Goreng Spesial', 75000], ['Mie Goreng', 65000], ['Club Sandwich', 85000], ['Sop Buntut', 125000]],
  'FB-BEV':     [['Kopi Tubruk', 30000], ['Es Teh Manis', 20000], ['Jus Alpukat', 40000], ['Air Mineral 600ml', 15000]],
  'LAUNDRY':    [['Kemeja (regular)', 25000], ['Celana (regular)', 30000], ['Jas (dry clean)', 85000], ['Express +50%', 0]],
  'MINIBAR':    [['Air mineral', 15000], ['Soft drink', 25000], ['Snack', 30000]],
  'FAC-TENNIS': [['Lapangan tennis / jam', 150000], ['Sewa raket', 50000]],
  'FAC-GYM':    [['Akses gym harian', 75000], ['Akses kolam harian', 75000]],
  'MEET-ROOM':  [['Meeting room / jam', 350000], ['Coffee break / pax', 55000]],
  'PEN-LATE':   [['Late check-out s/d 18:00', 0]]
};

export async function render(el) {
  const codes = (await q(sb.from('transaction_codes').select('*').eq('is_active', true).order('code')))
    .filter((c) => !['PAYMENT', 'ROOM', 'ADJUSTMENT'].includes(c.grp));
  let lines = [];
  let batch = uid();   // tetap sama saat retry -> tidak double-post
  let code = codes.find((c) => c.code === 'FB-FOOD')?.code || codes[0]?.code;

  async function load() {
    try {
      const inh = await q(sb.from('reservations').select('id, guests(full_name), rooms(number)').eq('status', 'IN_HOUSE'));
      inh.sort((a, b) => (a.rooms?.number || '').localeCompare(b.rooms?.number || ''));
      const cur = codes.find((c) => c.code === code);
      const svc = state.property.service_rate, tax = state.property.tax_rate;
      const net = lines.reduce((s, l) => s + l.q * l.p, 0);
      const gross = cur?.is_taxable ? net * (1 + svc) * (1 + tax) : net;
      el.innerHTML = `<div class="grid g2">
        <div class="card"><div class="hd"><h3>Item</h3></div><div class="bd">
          <div class="tabs">${codes.map((c) => `<button data-c="${esc(c.code)}" class="${c.code === code ? 'on' : ''}">${esc(c.name)}</button>`).join('')}</div>
          <div class="grid g2">${(PRESETS[code] || []).map(([n, p], i) => `<button class="btn" data-p="${i}" style="justify-content:space-between">${esc(n)} <span class="muted">${p ? rp(p) : 'isi'}</span></button>`).join('')}</div>
          <div class="row mt"><label class="f">Item lain<input id="cn" placeholder="Uraian"></label><label class="f" style="max-width:130px">Harga<input id="cp" type="number" min="0" step="500"></label>
            <button class="btn" id="add" style="margin-top:8px">Tambah</button></div>
        </div></div>
        <div class="card"><div class="hd"><h3>Charge ke kamar</h3></div><div class="bd">
          <label class="f">Kamar / tamu in-house<select id="rm"><option value="">— pilih kamar —</option>${inh.map((r) => `<option value="${esc(r.rooms?.number)}">${esc(r.rooms?.number)} · ${esc(r.guests?.full_name)}</option>`).join('')}</select></label>
          <table class="t"><tbody>${lines.map((l, i) => `<tr><td>${esc(l.n)}</td><td><input type="number" min="1" value="${l.q}" data-q="${i}" style="width:60px"></td>
            <td class="right num">${rp(l.q * l.p)}</td><td><button class="btn sm ghost" data-x="${i}">✕</button></td></tr>`).join('') || '<tr><td class="empty">Belum ada item.</td></tr>'}</tbody></table>
          <div class="sum-row mt"><span>Subtotal</span><span>${rp(net)}</span></div>
          <div class="sum-row tot"><span>Total ${cur?.is_taxable ? '(+service & pajak)' : ''}</span><span>${rp(gross)}</span></div>
          <p class="muted" style="font-size:12px">Verifikasi nama tamu & tanda tangan struk sebelum posting (anti salah kamar).</p>
          <button class="btn pri lg" id="post" ${lines.length ? '' : 'disabled'}>Posting ke folio</button>
        </div></div></div>`;

      el.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { if (lines.length && b.dataset.c !== code) { lines = []; batch = uid(); } code = b.dataset.c; load(); });
      el.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
        const [n, p] = PRESETS[code][+b.dataset.p];
        if (!p) { el.querySelector('#cn').value = n; el.querySelector('#cp').focus(); return; }
        const ex = lines.find((l) => l.n === n); if (ex) ex.q++; else lines.push({ n, p, q: 1 }); load();
      });
      el.querySelector('#add').onclick = () => {
        const n = el.querySelector('#cn').value.trim(), p = Number(el.querySelector('#cp').value);
        if (!n || !(p > 0)) return toast('Isi uraian & harga.', 'err');
        lines.push({ n, p, q: 1 }); load();
      };
      el.querySelectorAll('[data-q]').forEach((i) => i.onchange = () => { lines[+i.dataset.q].q = Math.max(1, Number(i.value)); load(); });
      el.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => { lines.splice(+b.dataset.x, 1); load(); });
      el.querySelector('#post').onclick = async (e) => {
        const room = el.querySelector('#rm').value;
        if (!room) return toast('Pilih kamar.', 'err');
        e.target.disabled = true;
        try {
          for (const [i, l] of lines.entries()) {
            await rpc('post_charge_to_room', { p_room_number: room, p_txn_code: code, p_description: l.n, p_quantity: l.q, p_unit_price: l.p, p_idempotency_key: `OUT:${batch}:${i}` });
          }
          toast(`${lines.length} item diposting ke kamar ${room}.`, 'ok'); lines = []; batch = uid(); load();
        } catch (err) { fail(err); e.target.disabled = false; }
      };
    } catch (e) { fail(e); }
  }
  await load();
  return onData(() => {});
}
