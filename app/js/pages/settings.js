import { sb, q, rpc, esc, rp, toast, fail, modal, form, state, ROLE_LABEL } from '../core.js';
import { refreshProperty } from '../main.js';

export async function render(el) {
  let tab = 'users';
  async function load() {
    try {
      const [users, zones, types, plans, audit] = await Promise.all([
        q(sb.from('profiles').select('*').order('created_at')),
        q(sb.from('hk_zones').select('*').order('sort_order')),
        q(sb.from('room_types').select('*').order('sort_order')),
        q(sb.from('rate_plans').select('*').order('code')),
        q(sb.from('audit_logs').select('*').order('at', { ascending: false }).limit(60))
      ]);
      const names = Object.fromEntries(users.map((u) => [u.user_id, u.full_name || u.email]));
      const p = state.property;
      const tabs = [['users', 'Pengguna & role'], ['hotel', 'Hotel & pajak'], ['rooms', 'Tipe kamar & rate plan'], ['audit', 'Audit log']];
      let body = '';
      if (tab === 'users') body = `<div class="card"><div class="tw"><table class="t"><thead><tr><th>Nama</th><th>Email</th><th>Role</th><th>Zona HK</th><th>On duty</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr data-u="${u.user_id}"><td><input name="full_name" value="${esc(u.full_name || '')}"></td><td>${esc(u.email || '')}</td>
          <td><select name="role">${Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></td>
          <td><select name="zone"><option value="">—</option>${zones.map((z) => `<option value="${z.id}" ${z.id === u.zone_id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></td>
          <td><input type="checkbox" name="on_duty" ${u.on_duty ? 'checked' : ''}></td>
          <td><button class="btn sm pri" data-save="${u.user_id}">Simpan</button></td></tr>`).join('')}
        </tbody></table></div><div class="bd muted" style="font-size:12.5px">Staf baru mendaftar sendiri dari halaman login (role awal: Viewer), lalu admin memberi role di sini.
          Room Attendant butuh zona agar penugasan otomatis memilih lantai terdekat.</div></div>`;
      if (tab === 'hotel') body = `<div class="card" style="max-width:640px"><div class="bd" id="hf">
        <label class="f">Nama hotel<input name="name" value="${esc(p.name)}"></label>
        <label class="f">Alamat<input name="address" value="${esc(p.address || '')}"></label>
        <div class="row"><label class="f">Telepon<input name="phone" value="${esc(p.phone || '')}"></label><label class="f">Email<input name="email" value="${esc(p.email || '')}"></label><label class="f">NPWP<input name="npwp" value="${esc(p.npwp || '')}"></label></div>
        <label class="f">Harga breakfast tambahan / pax<input type="number" name="breakfast_price" value="${p.breakfast_price ?? 125000}" min="0" step="5000"></label>
        <div class="row"><label class="f">Service charge (%)<input type="number" step="0.5" name="service" value="${p.service_rate * 100}"></label>
          <label class="f">Pajak PBJT (%)<input type="number" step="0.5" name="tax" value="${p.tax_rate * 100}"></label></div>
        <div class="row"><label class="f">Hold booking (menit)<input type="number" min="5" max="60" name="hold_minutes" value="${p.hold_minutes}"></label>
          <label class="f">Cap faktor kalender (×)<input type="number" step="0.05" name="calendar_cap" value="${p.calendar_cap}"></label></div>
        <div class="row"><label class="f">Jam check-in<input type="time" name="checkin_time" value="${String(p.checkin_time).slice(0, 5)}"></label>
          <label class="f">Jam check-out<input type="time" name="checkout_time" value="${String(p.checkout_time).slice(0, 5)}"></label></div>
        <p class="muted" style="font-size:12.5px">Tarif pajak & service berbeda per daerah — verifikasi dengan konsultan pajak / Perda setempat.</p>
        <button class="btn pri" id="hs">Simpan</button></div></div>`;
      if (tab === 'rooms') body = `<div class="grid g2"><div class="card"><div class="hd"><h3>Tipe kamar</h3></div><div class="tw"><table class="t"><thead><tr><th>Tipe</th><th class="right">BAR</th><th class="right">Floor</th><th class="right">Ceil ×</th><th class="right">Menit bersih</th><th></th></tr></thead><tbody>
        ${types.map((t) => `<tr data-t="${t.id}"><td>${esc(t.name)}</td><td><input type="number" name="base_rate" value="${t.base_rate}" style="width:110px"></td><td><input type="number" name="floor_rate" value="${t.floor_rate}" style="width:110px"></td>
          <td><input type="number" step="0.1" name="ceil_multiplier" value="${t.ceil_multiplier}" style="width:64px"></td><td><input type="number" name="standard_clean_minutes" value="${t.standard_clean_minutes}" style="width:64px"></td>
          <td><button class="btn sm pri" data-ts="${t.id}">Simpan</button></td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><div class="hd"><h3>Rate plan</h3></div><div class="tw"><table class="t"><thead><tr><th>Kode</th><th>Nama</th><th class="right">Faktor</th><th class="right">Add-on</th><th>Dinamis</th></tr></thead><tbody>
        ${plans.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="right">×${r.rate_multiplier}</td><td class="right">${rp(r.addon_per_night)}</td><td>${r.is_dynamic ? '✓' : 'Tetap'}</td></tr>`).join('')}</tbody></table></div>
        <div class="bd muted" style="font-size:12.5px">Tambah kamar/rate plan baru: Supabase Table Editor (tabel <code>rooms</code>, <code>rate_plans</code>). Inventori menyesuaikan otomatis.</div></div></div>`;
      if (tab === 'audit') body = `<div class="card"><div class="tw"><table class="t"><thead><tr><th>Waktu</th><th>Oleh</th><th>Aksi</th><th>Data</th></tr></thead><tbody>
        ${audit.map((a) => `<tr><td>${new Date(a.at).toLocaleString('id-ID')}</td><td>${esc(names[a.actor] || '-')}</td><td><b>${esc(a.action)}</b><br><small class="muted">${esc(a.entity)}</small></td>
          <td><small class="muted" style="word-break:break-all">${esc(JSON.stringify(a.data))}</small></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Belum ada.</td></tr>'}</tbody></table></div></div>`;

      el.innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>${body}`;
      el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; load(); });
      el.querySelectorAll('[data-save]').forEach((b) => b.onclick = async () => {
        const row = el.querySelector(`tr[data-u="${b.dataset.save}"]`); const f = form(row);
        try { await rpc('admin_set_profile', { p_user: b.dataset.save, p_role: f.role, p_zone: f.zone || null, p_on_duty: f.on_duty, p_full_name: f.full_name || null }); toast('Profil disimpan.', 'ok'); }
        catch (e) { fail(e); }
      });
      el.querySelectorAll('[data-ts]').forEach((b) => b.onclick = async () => {
        const f = form(el.querySelector(`tr[data-t="${b.dataset.ts}"]`));
        try { await q(sb.from('room_types').update({ base_rate: Number(f.base_rate), floor_rate: Number(f.floor_rate), ceil_multiplier: Number(f.ceil_multiplier), standard_clean_minutes: Number(f.standard_clean_minutes) }).eq('id', b.dataset.ts)); toast('Tipe kamar disimpan.', 'ok'); }
        catch (e) { fail(e); }
      });
      const hs = el.querySelector('#hs');
      if (hs) hs.onclick = async () => {
        const f = form(el.querySelector('#hf'));
        try {
          const extra = p.breakfast_price !== undefined ? { phone: f.phone || null, email: f.email || null, npwp: f.npwp || null, breakfast_price: Number(f.breakfast_price || 0) } : {};
          await q(sb.from('properties').update({ ...extra, name: f.name, address: f.address, service_rate: Number(f.service) / 100, tax_rate: Number(f.tax) / 100,
            hold_minutes: Number(f.hold_minutes), calendar_cap: Number(f.calendar_cap), checkin_time: f.checkin_time, checkout_time: f.checkout_time }).eq('id', p.id));
          await refreshProperty(); toast('Pengaturan hotel disimpan.', 'ok');
        } catch (e) { fail(e); }
      };
    } catch (e) { fail(e); }
  }
  await load();
}
