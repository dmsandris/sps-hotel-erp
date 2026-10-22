import { sb, q, rpc, esc, rp, fmtDate, fmtDay, toast, fail, modal, form, can, state, addDays, confirmBox } from '../core.js';

const LAYER = { SEASON: 'Season', DOW: 'Hari (DOW)', HOLIDAY: 'Libur', EVENT: 'Event' };
const DOWS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

export async function render(el) {
  const plans = await q(sb.from('rate_plans').select('*').order('code'));
  let plan = plans[0]?.id, from = state.property.business_date, days = 14;

  async function load() {
    try {
      const [cal, rules, types] = await Promise.all([
        rpc('rate_calendar', { p_rate_plan: plan, p_from: from, p_days: days }),
        q(sb.from('pricing_rules').select('*').order('layer').order('date_from', { nullsFirst: true })),
        q(sb.from('room_types').select('*').order('sort_order'))
      ]);
      const dates = [...new Set(cal.map((c) => c.stay_date))];
      const byType = {}; cal.forEach((c) => { (byType[c.room_type_id] = byType[c.room_type_id] || {})[c.stay_date] = c; });
      el.innerHTML = `<div class="card"><div class="hd"><h3>Kalender harga</h3><span class="sp">
          <select id="pl">${plans.map((p) => `<option value="${p.id}" ${p.id === plan ? 'selected' : ''}>${esc(p.code)}</option>`).join('')}</select>
          <input type="date" id="fr" value="${from}"><select id="dy">${[7, 14, 30].map((d) => `<option ${d === days ? 'selected' : ''}>${d}</option>`).join('')}</select></span></div>
        <div class="tw"><table class="t cal"><thead><tr><th>Tipe</th>${dates.map((d) => `<th class="right">${fmtDay(d)}</th>`).join('')}</tr></thead><tbody>
        ${types.map((t) => `<tr><td><b>${esc(t.name)}</b><br><small class="muted">BAR ${rp(t.base_rate)}</small></td>
          ${dates.map((d) => { const c = byType[t.id]?.[d]; if (!c) return '<td></td>'; const x = c.detail;
            const cls = x.event_name ? 'ev' : Number(x.calendar) > 1.05 || Number(x.demand) > 1.05 ? 'hi' : '';
            return `<td class="p ${cls}" data-t="${t.id}" data-d="${d}" style="cursor:pointer">${rp(c.price).replace('Rp ', '')}<br><small class="muted">sisa ${c.available}</small></td>`; }).join('')}</tr>`).join('')}
        </tbody></table></div>
        <div class="bd legend"><span><i style="background:#fbf0ff"></i>Faktor kalender/permintaan naik</span><span><i style="background:#fde7f6"></i>Libur / event</span>
          <span class="muted">Klik sel untuk melihat cara harga dihitung.</span></div></div>

        <div class="card mt"><div class="hd"><h3>Aturan harga</h3><span class="sp">${can() ? '<button class="btn sm pri" id="nr">+ Aturan</button>' : ''}</span></div>
          <div class="tw"><table class="t"><thead><tr><th>Layer</th><th>Nama</th><th>Berlaku</th><th class="right">Faktor</th><th>Min LOS</th><th>Prioritas</th><th>Aktif</th><th></th></tr></thead><tbody>
          ${rules.map((r) => `<tr><td>${LAYER[r.layer]}</td><td>${esc(r.name)}</td>
            <td>${r.layer === 'DOW' ? (r.dow || []).map((d) => DOWS[d - 1]).join(', ') : fmtDate(r.date_from) + ' – ' + fmtDate(r.date_to)}</td>
            <td class="right num">×${Number(r.multiplier).toFixed(2)}</td><td>${r.min_los || '-'}</td><td>${r.priority}</td><td>${r.is_active ? '✓' : '—'}</td>
            <td class="right">${can() ? `<button class="btn sm ghost" data-e="${r.id}">Ubah</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="bd muted" style="font-size:12.5px">Rumus: BAR × faktor rate plan × MIN(season × hari × event, ${state.property.calendar_cap}) × faktor okupansi, lalu dibatasi floor/ceiling tipe kamar dan dibulatkan Rp1.000.
            Harga di-snapshot per malam saat booking — perubahan aturan tidak mengubah reservasi yang sudah ada.</div></div>`;

      el.querySelector('#pl').onchange = (e) => { plan = e.target.value; load(); };
      el.querySelector('#fr').onchange = (e) => { from = e.target.value; load(); };
      el.querySelector('#dy').onchange = (e) => { days = Number(e.target.value); load(); };
      el.querySelectorAll('[data-d]').forEach((c) => c.onclick = () => explain(byType[c.dataset.t][c.dataset.d], types.find((t) => t.id === c.dataset.t)));
      const nr = el.querySelector('#nr'); if (nr) nr.onclick = () => ruleModal(null, load);
      el.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => ruleModal(rules.find((r) => r.id === b.dataset.e), load));
    } catch (e) { fail(e); }
  }
  await load();
}

function explain(c, t) {
  const x = c.detail;
  const row = (l, v) => `<div class="sum-row"><span class="muted">${l}</span><span class="num">${v}</span></div>`;
  modal({ title: `${t.name} · ${fmtDate(c.stay_date)}`, body:
    row('BAR', rp(x.base)) + row('Faktor rate plan', '×' + x.rate_plan) + row('Season', '×' + x.season) + row('Hari', '×' + x.dow) +
    row('Libur/event' + (x.event_name ? ' (' + esc(x.event_name) + ')' : ''), '×' + x.event) + row('Gabungan kalender (cap)', '×' + x.calendar) +
    row('Okupansi on-the-books', Math.round(x.occ * 100) + '%') + row('Faktor permintaan', '×' + x.demand) + row('Lead time (' + x.lead_days + ' hari)', '×' + x.lead_mod) +
    row('Floor / ceiling', rp(x.floor) + ' / ' + rp(x.ceil)) + (x.min_los ? row('Min LOS', x.min_los + ' malam') : '') +
    `<div class="sum-row tot"><span>Harga</span><span>${rp(x.price)}</span></div>` + (x.addon > 0 ? `<p class="muted">+ add-on ${rp(x.addon)}/malam</p>` : '') });
}

function ruleModal(r, reload) {
  const v = r || { layer: 'EVENT', name: '', multiplier: 1.2, priority: 1, is_active: true, dow: [] };
  modal({
    title: r ? 'Ubah aturan' : 'Aturan baru',
    body: `<div class="row"><label class="f">Layer<select name="layer">${Object.entries(LAYER).map(([k, l]) => `<option value="${k}" ${k === v.layer ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">Nama<input name="name" value="${esc(v.name)}" required></label></div>
      <div class="row"><label class="f">Dari<input type="date" name="date_from" value="${v.date_from || ''}"></label><label class="f">Sampai<input type="date" name="date_to" value="${v.date_to || ''}"></label></div>
      <div class="row" style="margin-bottom:10px">${DOWS.map((d, i) => `<label><input type="checkbox" name="dow${i + 1}" ${(v.dow || []).includes(i + 1) ? 'checked' : ''}> ${d}</label>`).join('')} <small class="muted">(untuk layer Hari)</small></div>
      <div class="row"><label class="f">Faktor (×)<input type="number" step="0.01" min="0.5" max="3" name="multiplier" value="${v.multiplier}"></label>
        <label class="f">Min LOS<input type="number" min="1" name="min_los" value="${v.min_los || ''}"></label>
        <label class="f">Prioritas<input type="number" name="priority" value="${v.priority}"></label></div>
      <label><input type="checkbox" name="is_active" ${v.is_active ? 'checked' : ''}> Aktif</label>`,
    actions: [
      ...(r ? [{ label: 'Hapus', cls: 'bad', run: async () => { if (!await confirmBox('Hapus aturan', 'Hapus aturan ' + esc(r.name) + '?', 'Hapus', 'bad')) return false; await q(sb.from('pricing_rules').delete().eq('id', r.id)); toast('Dihapus.', 'ok'); reload(); } }] : []),
      { label: 'Simpan', cls: 'pri', run: async (m) => {
        const f = form(m);
        const row = { property_id: state.property.id, layer: f.layer, name: f.name, multiplier: Number(f.multiplier), priority: Number(f.priority || 0),
          is_active: f.is_active, min_los: f.min_los ? Number(f.min_los) : null,
          date_from: f.layer === 'DOW' ? null : f.date_from || null, date_to: f.layer === 'DOW' ? null : f.date_to || null,
          dow: f.layer === 'DOW' ? [1, 2, 3, 4, 5, 6, 7].filter((d) => f['dow' + d]) : null };
        if (!row.name) { toast('Nama wajib.', 'err'); return false; }
        if (row.layer !== 'DOW' && (!row.date_from || !row.date_to)) { toast('Isi rentang tanggal.', 'err'); return false; }
        if (row.layer === 'DOW' && !row.dow.length) { toast('Pilih minimal satu hari.', 'err'); return false; }
        if (r) await q(sb.from('pricing_rules').update(row).eq('id', r.id)); else await q(sb.from('pricing_rules').insert(row));
        toast('Aturan tersimpan. Berlaku untuk booking baru.', 'ok'); reload();
      } }]
  });
}
