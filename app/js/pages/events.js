// Meeting & Event: booking ruang + Banquet Event Order (BEO) + folio event.
import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, can, state, addDays } from '../core.js';
import { onData } from '../main.js';
import { statusTag, payModal } from './shared.js';
import { icon, emptyState, hhmm } from '../ui.js';

const hashParam = (k) => new URLSearchParams(location.hash.split('?')[1] || '').get(k);
const LAYOUT = ['Theater', 'Classroom', 'U-shape', 'Boardroom', 'Round table', 'Cocktail'];
const STATUS_FLOW = { INQUIRY: ['TENTATIVE', 'CANCELLED'], TENTATIVE: ['DEFINITE', 'CANCELLED'], DEFINITE: ['COMPLETED', 'CANCELLED'] };
const ST_LABEL = { TENTATIVE: 'Tentative', DEFINITE: 'Definite (pasti)', COMPLETED: 'Selesai & posting', CANCELLED: 'Batalkan' };

export async function render(el) {
  let from = addDays(state.property.business_date, -7), show = 'upcoming';
  const [rooms, companies, codes] = await Promise.all([
    q(sb.from('facility_resources').select('*').eq('kind', 'MEETING').eq('is_active', true).order('sort_order')),
    q(sb.from('companies').select('id, name').order('name')),
    q(sb.from('transaction_codes').select('code, name, grp').in('grp', ['MEETING', 'FB']).eq('is_active', true))
  ]);
  async function load() {
    try {
      let qq = sb.from('event_orders').select('*, companies(name), facility_resources(name), folios(balance, folio_no)').order('start_at');
      if (show === 'upcoming') qq = qq.gte('start_at', new Date(from + 'T00:00:00').toISOString()).in('status', ['INQUIRY', 'TENTATIVE', 'DEFINITE']);
      const evs = await q(qq.limit(300));
      const pipe = { TENTATIVE: 0, DEFINITE: 0 }; let value = 0;
      evs.forEach((e) => { if (pipe[e.status] != null) pipe[e.status]++; });
      el.innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Tentative</div><div class="v">${pipe.TENTATIVE}</div></div>
          <div class="kpi"><div class="l">Definite</div><div class="v">${pipe.DEFINITE}</div></div>
          <div class="kpi"><div class="l">Ruang meeting</div><div class="v">${rooms.length}</div></div></div>
        <div class="card"><div class="hd"><h3>Event & meeting</h3>
          <span class="sp"><div class="seg"><button data-s="upcoming" class="${show === 'upcoming' ? 'on' : ''}">Mendatang</button><button data-s="all" class="${show === 'all' ? 'on' : ''}">Semua</button></div>
          ${can('fo') ? `<button class="btn pri" id="ne">${icon('plus')}Event baru</button>` : ''}</span></div>
          <div class="tw"><table class="t"><thead><tr><th>Event</th><th>Waktu</th><th>Ruang</th><th class="center">Pax</th><th class="right">Folio</th><th>Status</th></tr></thead><tbody>
          ${evs.map((e) => `<tr class="click" data-e="${e.id}"><td><b>${esc(e.name)}</b><br><small class="muted">${esc(e.event_no)} · ${esc(e.companies?.name || e.contact_name || '-')}</small></td>
            <td class="nowrap">${fmtDate(e.start_at)}<br><small class="muted">${hhmm(e.start_at)}–${hhmm(e.end_at)}</small></td><td>${esc(e.facility_resources?.name || '-')}<br><small class="muted">${esc(e.layout || '')}</small></td>
            <td class="center">${e.pax}</td><td class="right num">${rp(e.folios?.balance)}</td><td>${statusTag(e.status)}</td></tr>`).join('') || `<tr><td colspan="6">${emptyState('Belum ada event.', 'event')}</td></tr>`}
          </tbody></table></div></div>`;
      el.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => { show = b.dataset.s; load(); });
      el.querySelectorAll('[data-e]').forEach((t) => t.onclick = () => beo(t.dataset.e, codes, load));
      const ne = el.querySelector('#ne'); if (ne) ne.onclick = () => newEvent(rooms, companies, codes, load);
    } catch (e) { fail(e); el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  }
  await load();
  const id = hashParam('id'); if (id) beo(id, codes, load);
  return onData(load);
}

function newEvent(rooms, companies, codes, reload) {
  const bd = state.property.business_date;
  modal({
    title: 'Event baru (BEO)', wide: true,
    body: `<div class="row"><label class="f">Nama event<input name="name" required placeholder="Rapat Tahunan PT …"></label>
        <label class="f">Perusahaan<select name="comp"><option value="">—</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">PIC<input name="pic"></label><label class="f">HP PIC<input name="phone"></label></div>
      <div class="row"><label class="f">Ruang<select name="room">${rooms.map((r) => `<option value="${r.id}">${esc(r.name)} — ${rp(r.rate_public)}/jam</option>`).join('')}</select></label>
        <label class="f">Layout<select name="layout">${LAYOUT.map((l) => `<option>${l}</option>`).join('')}</select></label></div>
      <div class="row"><label class="f">Tanggal<input type="date" name="d" value="${addDays(bd, 1)}" min="${bd}"></label><label class="f">Mulai<input type="time" name="s" value="09:00"></label>
        <label class="f">Selesai<input type="time" name="e" value="16:00"></label><label class="f">Pax<input type="number" name="pax" value="30" min="1"></label></div>
      <label class="f">Catatan (dekorasi, AV, menu khusus)<textarea name="notes" rows="2"></textarea></label>
      <p class="muted small">Ruang langsung terkunci di jadwal (database menolak jadwal bentrok, termasuk waktu setup). Sewa ruang otomatis masuk BEO.</p>`,
    actions: [{ label: 'Buat event', cls: 'pri', run: async (m) => {
      const v = form(m);
      if (!v.name.trim()) { toast('Nama event wajib.', 'err'); return false; }
      const id = await rpc('create_event', { p_name: v.name, p_company: v.comp || null, p_contact: v.pic || null, p_phone: v.phone || null, p_resource: v.room,
        p_start: new Date(`${v.d}T${v.s}:00`).toISOString(), p_end: new Date(`${v.d}T${v.e}:00`).toISOString(), p_pax: Number(v.pax), p_layout: v.layout, p_notes: v.notes || null });
      toast('Event dibuat. Tambahkan item BEO.', 'ok'); reload(); beo(id, codes, reload);
    } }]
  });
}

async function beo(id, codes, reload) {
  let e, items, folio;
  try {
    e = await q(sb.from('event_orders').select('*, companies(name), facility_resources(name)').eq('id', id).single());
    [items, folio] = await Promise.all([
      q(sb.from('event_items').select('*').eq('event_id', id).order('created_at')),
      q(sb.from('folios').select('*').eq('id', e.folio_id).single())
    ]);
  } catch (err) { return fail(err); }
  const open = !['COMPLETED', 'CANCELLED'].includes(e.status);
  const total = items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
  const svc = state.property.service_rate, tax = state.property.tax_rate;
  const next = STATUS_FLOW[e.status] || [];
  modal({
    title: `${e.event_no} · ${e.name}`, xwide: true,
    body: `<div class="row mb">${statusTag(e.status)}<span class="pill">${fmtDate(e.start_at)} ${hhmm(e.start_at)}–${hhmm(e.end_at)}</span><span class="pill">${esc(e.facility_resources?.name)} · ${esc(e.layout || '')}</span>
        <span class="pill">${e.pax} pax</span>${e.companies?.name || e.contact_name ? `<span class="pill">${esc(e.companies?.name || e.contact_name)}</span>` : ''}
        <a class="btn sm" href="#/folio?id=${e.folio_id}">Folio ${esc(folio.folio_no)} · ${rp(folio.balance)}</a></div>
      ${e.notes ? `<div class="alert info mb">${esc(e.notes)}</div>` : ''}
      <div class="tw"><table class="t"><thead><tr><th>Jenis</th><th>Uraian</th><th class="right">Qty</th><th class="right">Harga</th><th class="right">Subtotal</th><th>Kode</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr><td>${esc(i.kind)}</td><td>${esc(i.description)}</td><td class="right">${Number(i.quantity)}</td><td class="right num">${rp(i.unit_price)}</td>
        <td class="right num">${rp(i.quantity * i.unit_price)}</td><td><small>${esc(i.txn_code)}</small></td>
        <td>${i.posting_id ? '<span class="tag PAID">Diposting</span>' : open && can('fo') ? `<button class="btn sm ghost" data-rm="${i.id}">Hapus</button>` : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="4">Estimasi (net)</td><td class="right num">${rp(total)}</td><td colspan="2" class="small muted">≈ ${rp(total * (1 + svc) * (1 + tax))} incl. service & pajak</td></tr></tfoot></table></div>
      ${open && can('fo') ? `<div class="row mt" id="add"><label class="f" style="max-width:130px">Jenis<select name="kind"><option value="FB">F&B</option><option value="EQUIPMENT">Peralatan</option><option value="ROOM">Ruang</option><option value="OTHER">Lain</option></select></label>
        <label class="f">Uraian<input name="desc" placeholder="Coffee break pagi / Lunch buffet / LCD projector"></label>
        <label class="f" style="max-width:90px">Qty<input type="number" name="qty" value="${e.pax}" min="0.5" step="0.5"></label>
        <label class="f" style="max-width:140px">Harga<input type="number" name="price" min="0" step="1000"></label>
        <label class="f" style="max-width:170px">Kode<select name="code">${codes.map((c) => `<option value="${c.code}" ${c.code === 'MEET-FB' ? 'selected' : ''}>${esc(c.code)}</option>`).join('')}</select></label>
        <button class="btn" id="addb" style="margin-top:8px">${icon('plus')}Tambah</button></div>` : ''}`,
    actions: [
      { label: 'Cetak BEO', run: () => { printBEO(e, items); return false; } },
      ...(open ? [{ label: 'Deposit', run: () => { payModal(folio, Math.round(total * (1 + svc) * (1 + tax) * 0.5), () => beo(id, codes, reload)); } },
        { label: 'Posting item ke folio', run: async () => { const n = await rpc('post_event_items', { p_event: id }); toast(n + ' item diposting.', 'ok'); reload(); beo(id, codes, reload); } }] : []),
      ...next.map((s) => ({ label: ST_LABEL[s], cls: s === 'CANCELLED' ? 'bad' : 'pri', run: async () => {
        if (s === 'CANCELLED' && !confirm('Batalkan event & lepas jadwal ruang?')) return false;
        await rpc('set_event_status', { p_event: id, p_status: s }); toast('Status event: ' + s, 'ok'); reload(); beo(id, codes, reload);
      } }))
    ],
    onMount: (m, close) => {
      const ab = m.querySelector('#addb');
      if (ab) ab.onclick = async () => {
        const v = form(m.querySelector('#add'));
        if (!v.desc || !v.price) return toast('Isi uraian & harga.', 'err');
        try { await rpc('add_event_item', { p_event: id, p_kind: v.kind, p_description: v.desc, p_quantity: Number(v.qty), p_unit_price: Number(v.price), p_txn_code: v.code }); close(); beo(id, codes, reload); }
        catch (err) { fail(err); }
      };
      m.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => { try { await rpc('remove_event_item', { p_item: b.dataset.rm }); close(); beo(id, codes, reload); } catch (err) { fail(err); } });
    }
  });
}

function printBEO(e, items) {
  const w = window.open('', '_blank'); if (!w) return toast('Izinkan pop-up untuk mencetak.', 'err');
  const p = state.property, base = location.origin + location.pathname.replace(/[^/]*$/, '');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(e.event_no)}</title><style>
    body{font-family:system-ui,sans-serif;font-size:12px;margin:32px;color:#111}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{padding:6px;border:1px solid #ccc;text-align:left}td.r{text-align:right}.g{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-top:14px}.hd{display:flex;justify-content:space-between}</style></head><body>
    <div class="hd"><div><img src="${base}assets/logo-sps.png" style="height:64px"><h1>${esc(p.name)}</h1></div><div style="text-align:right"><h1>BANQUET EVENT ORDER</h1><div>${esc(e.event_no)}</div><div>Status: ${esc(e.status)}</div></div></div>
    <div class="g"><div><b>Event:</b> ${esc(e.name)}</div><div><b>Klien:</b> ${esc(e.companies?.name || '-')}</div><div><b>PIC:</b> ${esc(e.contact_name || '-')} ${esc(e.phone || '')}</div>
      <div><b>Tanggal:</b> ${fmtDate(e.start_at)} ${hhmm(e.start_at)}–${hhmm(e.end_at)}</div><div><b>Ruang:</b> ${esc(e.facility_resources?.name)}</div><div><b>Layout / Pax:</b> ${esc(e.layout || '-')} / ${e.pax}</div></div>
    ${e.notes ? `<p><b>Catatan:</b> ${esc(e.notes)}</p>` : ''}
    <table><thead><tr><th>Jenis</th><th>Uraian</th><th>Qty</th><th>Harga</th><th>Subtotal</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${esc(i.kind)}</td><td>${esc(i.description)}</td><td class="r">${Number(i.quantity)}</td><td class="r">${rp(i.unit_price)}</td><td class="r">${rp(i.quantity * i.unit_price)}</td></tr>`).join('')}
    </tbody></table><p style="margin-top:40px">Disetujui klien: ____________________ &nbsp;&nbsp; Sales/Event: ____________________</p><script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}
