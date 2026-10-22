// Laundry tamu: terima → proses → siap → antar (posting otomatis ke folio saat diantar).
import { sb, q, rpc, esc, rp, toast, fail, modal, form, state, uid } from '../core.js';
import { onData } from '../main.js';
import { icon, emptyState, hhmm } from '../ui.js';

const PRICE = [['Kemeja', 25000], ['Kaos', 20000], ['Celana panjang', 30000], ['Celana pendek', 20000], ['Rok / dress', 40000],
  ['Jas (dry clean)', 85000], ['Pakaian dalam', 10000], ['Kaos kaki (pasang)', 8000], ['Piyama', 30000], ['Jaket', 50000]];
const COLS = [['RECEIVED', 'Diterima'], ['PROCESSING', 'Diproses'], ['READY', 'Siap antar'], ['DELIVERED', 'Diantar hari ini']];
const NEXT = { RECEIVED: 'PROCESSING', PROCESSING: 'READY', READY: 'DELIVERED' };

export async function render(el) {
  async function load() {
    try {
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const rows = await q(sb.from('laundry_orders').select('*').or(`status.in.(RECEIVED,PROCESSING,READY),delivered_at.gte.${since.toISOString()}`).order('due_at'));
      const now = Date.now();
      el.innerHTML = `<div class="card mb"><div class="bd row" style="justify-content:space-between"><span class="muted">Express ×1.5, selesai 4 jam · Regular 24 jam. Tagihan masuk folio saat status <b>Diantar</b>.</span>
          <button class="btn pri" id="nl">${icon('plus')}Order laundry</button></div></div>
        <div class="kanban">${COLS.map(([k, l]) => {
          const list = rows.filter((r) => r.status === k);
          return `<div class="kcol"><h4>${l}<span>${list.length}</span></h4>${list.map((r) => {
            const late = k !== 'DELIVERED' && new Date(r.due_at).getTime() < now;
            return `<div class="kcard ${late ? 'late' : ''}"><div class="sum-row"><b>Kamar ${esc(r.room_number)}</b>${r.service === 'EXPRESS' ? '<span class="tag VIP">Express</span>' : ''}</div>
              <div class="small">${esc(r.guest_name)} · ${esc(r.order_no)}</div>
              <div class="small muted">${(r.items || []).map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
              <div class="sum-row small"><span class="${late ? '' : 'muted'}" style="${late ? 'color:var(--st-dirty);font-weight:700' : ''}">${k === 'DELIVERED' ? 'Diantar ' + hhmm(r.delivered_at) : 'Target ' + hhmm(r.due_at)}</span><b>${rp(r.total)}</b></div>
              ${NEXT[k] ? `<div class="row mt" style="gap:6px"><button class="btn sm pri" data-n="${r.id}" data-s="${NEXT[k]}">${COLS.find((c) => c[0] === NEXT[k])[1]} →</button>
                <button class="btn sm ghost" data-n="${r.id}" data-s="CANCELLED">Batal</button></div>` : ''}</div>`;
          }).join('') || emptyState('Kosong', 'laundry')}</div>`;
        }).join('')}</div>`;
      el.querySelector('#nl').onclick = () => newOrder(load);
      el.querySelectorAll('[data-n]').forEach((b) => b.onclick = async () => {
        if (b.dataset.s === 'CANCELLED' && !confirm('Batalkan order laundry?')) return;
        try { await rpc('set_laundry_status', { p_id: b.dataset.n, p_status: b.dataset.s }); toast(b.dataset.s === 'DELIVERED' ? 'Diantar & tagihan diposting ke folio.' : 'Status diperbarui.', 'ok'); load(); }
        catch (e) { fail(e); }
      });
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
  return onData(load);
}

async function newOrder(reload) {
  const inh = await q(sb.from('reservations').select('rooms(number), guests(full_name)').eq('status', 'IN_HOUSE'));
  const rooms = inh.filter((r) => r.rooms).sort((a, b) => a.rooms.number.localeCompare(b.rooms.number));
  const idem = 'LND-' + uid().slice(0, 8).toUpperCase();
  modal({
    title: 'Order laundry', wide: true,
    body: `<div class="row"><label class="f">Kamar<select name="room">${rooms.map((r) => `<option value="${esc(r.rooms.number)}">${esc(r.rooms.number)} · ${esc(r.guests?.full_name)}</option>`).join('')}</select></label>
        <label class="f">Layanan<select name="svc"><option value="REGULAR">Regular (24 jam)</option><option value="EXPRESS">Express (4 jam, ×1.5)</option></select></label></div>
      <div class="tw"><table class="t"><thead><tr><th>Item</th><th class="right">Harga</th><th style="width:110px">Qty</th></tr></thead><tbody>
      ${PRICE.map(([n, p], i) => `<tr><td>${esc(n)}</td><td class="right num">${rp(p)}</td><td><input type="number" min="0" value="0" data-i="${i}" style="width:90px"></td></tr>`).join('')}</tbody></table></div>
      <label class="f mt">Catatan<input name="notes" placeholder="Noda di kerah, jangan disetrika, dll."></label>
      <div class="sum-row tot"><span>Total</span><span id="tt">Rp 0</span></div>`,
    onMount: (m) => {
      const calc = () => {
        let t = 0; m.querySelectorAll('[data-i]').forEach((i) => { t += Number(i.value || 0) * PRICE[+i.dataset.i][1]; });
        if (m.querySelector('[name=svc]').value === 'EXPRESS') t *= 1.5;
        m.querySelector('#tt').textContent = rp(t);
      };
      m.addEventListener('input', calc);
    },
    actions: [{ label: 'Simpan order', cls: 'pri', run: async (m) => {
      const v = form(m);
      const items = [...m.querySelectorAll('[data-i]')].filter((i) => Number(i.value) > 0).map((i) => ({ name: PRICE[+i.dataset.i][0], qty: Number(i.value), price: PRICE[+i.dataset.i][1] }));
      if (!items.length) { toast('Isi minimal 1 item.', 'err'); return false; }
      if (!v.room) { toast('Tidak ada tamu in-house.', 'err'); return false; }
      await rpc('create_laundry', { p_room_number: v.room, p_service: v.svc, p_items: items, p_notes: v.notes || null, p_idempotency_key: idem });
      toast('Order laundry ' + idem + ' tercatat.', 'ok'); reload();
    } }]
  });
}
