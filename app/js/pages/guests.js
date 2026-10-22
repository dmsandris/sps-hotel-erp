// CRM tamu: profil, riwayat menginap, nilai belanja, VIP & blacklist.
import { sb, q, rpc, esc, rp, fmtDate, toast, fail, modal, form, can } from '../core.js';
import { statusTag, openReservation } from './shared.js';
import { icon, emptyState, downloadXLSX, initials } from '../ui.js';

const hashParam = (k) => new URLSearchParams(location.hash.split('?')[1] || '').get(k);

export async function render(el) {
  let s = '', flt = '';
  let list = [];
  const companies = await q(sb.from('companies').select('id, name').order('name')).catch(() => []);

  async function load() {
    try {
      let qq = sb.from('guests').select('*, reservations!reservations_guest_id_fkey(id, status, check_in)').order('created_at', { ascending: false }).limit(300);
      if (s) qq = qq.or(`full_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
      if (flt === 'vip') qq = qq.gt('vip_level', 0);
      if (flt === 'bl') qq = qq.eq('is_blacklisted', true);
      list = await q(qq);
      const vis = (g) => g.reservations.filter((r) => ['CHECKED_OUT', 'IN_HOUSE'].includes(r.status)).length;
      el.querySelector('#gl').innerHTML = list.map((g) => {
        const last = g.reservations.map((r) => r.check_in).sort().slice(-1)[0];
        const inh = g.reservations.some((r) => r.status === 'IN_HOUSE');
        return `<tr class="click" data-g="${g.id}"><td><div class="row" style="flex-wrap:nowrap"><span class="av" style="width:32px;height:32px;border-radius:50%;background:var(--grad);color:#fff;display:grid;place-items:center;font-weight:700;font-size:12px;flex:none">${esc(initials(g.full_name))}</span>
          <div><b>${esc(g.full_name)}</b> ${g.vip_level > 0 ? `<span class="tag VIP">VIP ${g.vip_level}</span>` : ''} ${g.is_blacklisted ? '<span class="tag BLACKLIST">Blacklist</span>' : ''} ${inh ? '<span class="tag IN_HOUSE">In-house</span>' : ''}
          <br><small class="muted">${esc(g.phone || '-')} ${g.email ? '· ' + esc(g.email) : ''}</small></div></div></td>
          <td class="center">${vis(g)}</td><td>${last ? fmtDate(last) : '-'}</td><td>${(g.tags || []).map((t) => `<span class="pill" style="font-size:11px">${esc(t)}</span>`).join(' ')}</td></tr>`;
      }).join('') || `<tr><td colspan="4">${emptyState('Tidak ada tamu.', 'guest')}</td></tr>`;
      el.querySelectorAll('[data-g]').forEach((t) => t.onclick = () => profile(t.dataset.g, companies, load));
    } catch (e) { fail(e); }
  }

  el.innerHTML = `<div class="card"><div class="hd"><h3>Database tamu</h3>
      <span class="sp"><div class="seg" id="seg"><button data-f="" class="on">Semua</button><button data-f="vip">VIP</button><button data-f="bl">Blacklist</button></div>
      <button class="btn sm" id="xl">${icon('dl')}Excel</button></span></div>
    <div class="bd"><input id="s" placeholder="Cari nama, HP, atau email…" style="width:100%"></div>
    <div class="tw"><table class="t"><thead><tr><th>Tamu</th><th class="center">Kunjungan</th><th>Terakhir datang</th><th>Tag</th></tr></thead><tbody id="gl"></tbody></table></div></div>`;
  let t;
  el.querySelector('#s').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { s = e.target.value.trim().replace(/[%,()]/g, ''); load(); }, 250); };
  el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { flt = b.dataset.f; el.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); load(); });
  el.querySelector('#xl').onclick = () => downloadXLSX('database-tamu', { Tamu: list.map((g) => ({ nama: g.full_name, hp: g.phone, email: g.email, vip: g.vip_level,
    blacklist: g.is_blacklisted, kebangsaan: g.nationality, kunjungan: g.reservations.length, tag: (g.tags || []).join(', '), consent_marketing: g.marketing_consent })) });
  await load();
  const pid = hashParam('id'); if (pid) profile(pid, companies, load);
}

export async function profile(id, companies, reload = () => {}) {
  let p;
  try { p = await rpc('guest_profile', { p_id: id }); } catch (e) { return fail(e); }
  const g = p.guest;
  const ed = can('fo');
  modal({
    title: g.full_name, xwide: true,
    body: `<div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        <div class="kpi"><div class="l">Kunjungan</div><div class="v">${p.visits}</div></div>
        <div class="kpi"><div class="l">Room night</div><div class="v">${p.nights}</div></div>
        <div class="kpi"><div class="l">Total belanja</div><div class="v" style="font-size:26px">${rp(p.revenue)}</div></div>
        <div class="kpi"><div class="l">Batal / no-show</div><div class="v">${p.cancellations}</div></div></div>
      <div class="grid g2"><div id="pf">
        <div class="row"><label class="f">Nama<input name="full_name" value="${esc(g.full_name)}" ${ed ? '' : 'disabled'}></label><label class="f">HP<input name="phone" value="${esc(g.phone || '')}"></label></div>
        <div class="row"><label class="f">Email<input name="email" value="${esc(g.email || '')}"></label><label class="f">No. KTP/Paspor<input name="id_number" value="${esc(g.id_number || '')}"></label></div>
        <div class="row"><label class="f">Kebangsaan<input name="nationality" value="${esc(g.nationality || '')}" placeholder="ID"></label><label class="f">Tgl lahir<input type="date" name="birth_date" value="${g.birth_date || ''}"></label>
          <label class="f">Level VIP<select name="vip_level">${[0, 1, 2, 3].map((v) => `<option value="${v}" ${v === g.vip_level ? 'selected' : ''}>${v ? 'VIP ' + v : 'Reguler'}</option>`).join('')}</select></label></div>
        <label class="f">Alamat<input name="address" value="${esc(g.address || '')}"></label>
        <label class="f">Perusahaan<select name="company_id"><option value="">—</option>${(companies || []).map((c) => `<option value="${c.id}" ${c.id === g.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="f">Preferensi<input name="preferences" value="${esc(g.preferences || '')}" placeholder="Lantai tinggi, bantal ekstra, non-smoking…"></label>
        <label class="f">Tag (pisah koma)<input name="tags" value="${esc((g.tags || []).join(', '))}" placeholder="korporat, repeater, honeymoon"></label>
        <label class="f">Catatan internal<textarea name="notes" rows="2">${esc(g.notes || '')}</textarea></label>
        <div class="row small"><label><input type="checkbox" name="marketing_consent" ${g.marketing_consent ? 'checked' : ''}> Setuju menerima promosi (UU PDP)</label>
          <label style="color:var(--st-dirty)"><input type="checkbox" name="is_blacklisted" ${g.is_blacklisted ? 'checked' : ''}> Blacklist</label></div>
      </div><div>
        <h4 class="mb">Riwayat menginap</h4>
        <div class="tw" style="max-height:440px"><table class="t"><thead><tr><th>Tanggal</th><th>Kamar</th><th class="right">Nilai</th><th>Status</th></tr></thead><tbody>
        ${p.stays.map((x) => `<tr class="click" data-r="${x.id}"><td class="nowrap">${fmtDate(x.check_in)} → ${fmtDate(x.check_out)}<br><small class="muted">${esc(x.confirmation_no)} · ${esc(x.channel)}</small></td>
          <td>${esc(x.room_type)} ${x.room ? '<b>' + esc(x.room) + '</b>' : ''}</td><td class="right num">${rp(x.total)}</td><td>${statusTag(x.status)}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('Belum ada riwayat.')}</td></tr>`}
        </tbody></table></div></div></div>`,
    actions: ed ? [{ label: 'Simpan profil', cls: 'pri', run: async (m) => {
      const d = form(m.querySelector('#pf'));
      await rpc('update_guest', { p_id: g.id, p_data: d });
      toast('Profil tamu disimpan.', 'ok'); reload();
    } }] : [],
    onMount: (m, close) => m.querySelectorAll('[data-r]').forEach((r) => r.onclick = () => { close(); openReservation(r.dataset.r, reload); })
  });
}
