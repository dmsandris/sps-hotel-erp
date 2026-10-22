import { sb, q, rpc, esc, toast, fail, modal, state, fmtTime } from '../core.js';
import { onData } from '../main.js';
import { statusTag } from './shared.js';

const ITEMS = [['Tempat tidur & linen', 20, true], ['Kamar mandi', 25, true], ['Lantai & karpet', 15, false],
  ['AC / TV / remote', 10, false], ['Aroma & amenities', 15, false], ['Minibar & perlengkapan', 15, false]];

export async function render(el) {
  let tab = 'queue';
  async function load() {
    try {
      const bd = state.property.business_date;
      const [tasks, staff, arrivals] = await Promise.all([
        q(sb.from('hk_tasks').select('*, rooms(id, number, floor, room_types(name)), profiles(full_name)').eq('business_date', bd).neq('status', 'CANCELLED').order('priority').order('created_at')),
        q(sb.from('profiles').select('*, hk_zones(name)').eq('role', 'room_attendant').order('full_name')),
        q(sb.from('reservations').select('room_id').eq('status', 'CONFIRMED').eq('check_in', bd))
      ]);
      const arrRooms = new Set(arrivals.map((a) => a.room_id));
      const queue = tasks.filter((t) => t.status === 'DONE')
        .sort((a, b) => (arrRooms.has(b.room_id) - arrRooms.has(a.room_id)) || a.priority - b.priority || new Date(a.finished_at) - new Date(b.finished_at));
      const open = tasks.filter((t) => ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REWORK'].includes(t.status));
      const loadOf = (u) => tasks.filter((t) => t.assigned_to === u && t.status !== 'CANCELLED').reduce((a, t) => a + t.est_minutes, 0);
      const insp = tasks.filter((t) => t.status === 'INSPECTED').length;

      el.innerHTML = `<div class="kpis">
          <div class="kpi"><div class="l">Tunggu inspeksi</div><div class="v">${queue.length}</div></div>
          <div class="kpi"><div class="l">Sedang/antri bersih</div><div class="v">${open.length}</div></div>
          <div class="kpi"><div class="l">Belum ada petugas</div><div class="v">${open.filter((t) => t.status === 'OPEN').length}</div></div>
          <div class="kpi"><div class="l">Lulus hari ini</div><div class="v">${insp}</div></div>
          <div class="kpi"><div class="l">Staf on-duty</div><div class="v">${staff.filter((s) => s.on_duty).length}</div><div class="s">dari ${staff.length}</div></div>
          <div class="kpi"><div class="l">Rework</div><div class="v">${tasks.filter((t) => t.rework_count > 0).length}</div></div></div>
        <div class="tabs"><button data-t="queue" class="${tab === 'queue' ? 'on' : ''}">Antrian inspeksi</button><button data-t="team" class="${tab === 'team' ? 'on' : ''}">Tim & penugasan</button></div>
        ${tab === 'queue' ? `<div class="card"><div class="tw"><table class="t"><thead><tr><th>Kamar</th><th>Tugas</th><th>Petugas</th><th>Selesai</th><th></th></tr></thead><tbody>
          ${queue.map((t) => `<tr><td><b class="display" style="font-size:22px">${esc(t.rooms.number)}</b> ${arrRooms.has(t.room_id) ? '<span class="tag VIP">Arrival</span>' : ''}</td>
            <td>${esc(t.task_type)}<br><small class="muted">${t.started_at ? Math.round((new Date(t.finished_at) - new Date(t.started_at)) / 60000) + ' mnt / target ' + t.est_minutes : ''}</small></td>
            <td>${esc(t.profiles?.full_name || '-')}</td><td>${fmtTime(t.finished_at)}</td>
            <td class="right"><button class="btn pri sm" data-i="${t.id}">Inspeksi</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Tidak ada kamar menunggu inspeksi.</td></tr>'}
          </tbody></table></div></div>` : `
          <div class="grid g2"><div class="card"><div class="hd"><h3>Beban staf hari ini</h3><span class="sp"><button class="btn sm" id="auto">Assign otomatis</button></span></div>
            <div class="tw"><table class="t"><thead><tr><th>Staf</th><th>Zona</th><th class="right">Beban</th><th>Status</th></tr></thead><tbody>
            ${staff.map((s) => { const m = loadOf(s.user_id); return `<tr><td>${esc(s.full_name)}</td><td>${esc(s.hk_zones?.name || '-')}</td>
              <td class="right num">${m} / ${s.max_minutes} m</td><td>${s.on_duty ? '<span class="tag READY">On duty</span>' : '<span class="tag OOO">Off</span>'}</td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">Belum ada Room Attendant. Atur di Pengaturan.</td></tr>'}
            </tbody></table></div></div>
          <div class="card"><div class="hd"><h3>Tugas aktif</h3></div><div class="tw"><table class="t"><thead><tr><th>Kamar</th><th>Status</th><th>Petugas</th></tr></thead><tbody>
            ${open.map((t) => `<tr><td><b>${esc(t.rooms.number)}</b> <small class="muted">${esc(t.task_type)}</small></td><td>${statusTag(t.status)}</td>
              <td>${t.status === 'IN_PROGRESS' ? esc(t.profiles?.full_name || '-') : `<select data-re="${t.id}"><option value="">— pilih —</option>${staff.filter((s) => s.on_duty).map((s) => `<option value="${s.user_id}" ${s.user_id === t.assigned_to ? 'selected' : ''}>${esc(s.full_name)}</option>`).join('')}</select>`}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Tidak ada.</td></tr>'}
            </tbody></table></div></div></div>`}`;

      el.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { tab = b.dataset.t; load(); });
      el.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => inspectModal(queue.find((t) => t.id === b.dataset.i), load));
      el.querySelectorAll('[data-re]').forEach((s) => s.onchange = async () => {
        if (!s.value) return;
        try { await rpc('hk_reassign', { p_task: s.dataset.re, p_user: s.value }); toast('Tugas dipindahkan.', 'ok'); load(); } catch (e) { fail(e); }
      });
      const au = el.querySelector('#auto');
      if (au) au.onclick = async () => { try { const n = await rpc('hk_assign_open'); toast(n + ' tugas ditugaskan.', 'ok'); load(); } catch (e) { fail(e); } };
    } catch (e) { fail(e); }
  }
  await load();
  return onData(load);
}

function inspectModal(t, reload) {
  modal({
    title: 'Inspeksi kamar ' + t.rooms.number,
    body: `<p class="muted">Petugas: ${esc(t.profiles?.full_name || '-')}. Item bertanda ★ kritis: gagal = otomatis tidak lulus.</p>
      ${ITEMS.map(([n, w, c], i) => `<div class="check" style="justify-content:space-between"><span>${c ? '★ ' : ''}${esc(n)}</span>
        <span><label><input type="radio" name="i${i}" value="ok" checked> OK</label> &nbsp; <label><input type="radio" name="i${i}" value="x"> Gagal</label></span></div>`).join('')}
      <div class="sum-row tot"><span>Skor</span><span id="sc">100</span></div>
      <label class="f">Catatan (wajib bila gagal)<textarea name="notes" rows="2"></textarea></label>`,
    onMount: (m) => {
      const calc = () => {
        let s = 100, crit = false;
        ITEMS.forEach(([, w, c], i) => { if (m.querySelector(`[name=i${i}]:checked`).value === 'x') { s -= w; if (c) crit = true; } });
        m.querySelector('#sc').textContent = s + (crit || s < 90 ? ' — TIDAK LULUS' : ' — LULUS');
        return { s, pass: !crit && s >= 90 };
      };
      m.addEventListener('change', calc); m._calc = calc;
    },
    actions: [{ label: 'Simpan hasil', cls: 'pri', run: async (m) => {
      const { s, pass } = m._calc();
      const notes = m.querySelector('[name=notes]').value.trim();
      if (!pass && !notes) { toast('Tulis catatan rework untuk petugas.', 'err'); return false; }
      const checklist = Object.fromEntries(ITEMS.map(([n], i) => [n, m.querySelector(`[name=i${i}]:checked`).value === 'ok']));
      await rpc('hk_inspect', { p_task: t.id, p_result: pass ? 'PASS' : 'FAIL', p_score: s, p_checklist: checklist, p_notes: notes || null });
      toast(pass ? `Kamar ${t.rooms.number} READY — siap dijual.` : `Kamar ${t.rooms.number} dikembalikan untuk rework.`, pass ? 'ok' : 'err');
      reload();
    } }]
  });
}
