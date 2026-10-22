import { sb, q, rpc, esc, toast, fail, modal, state, fmtTime } from '../core.js';
import { onData } from '../main.js';
import { statusTag } from './shared.js';

const CHECKLIST = {
  CHECKOUT_CLEAN: ['Ganti linen & handuk', 'Bersihkan kamar mandi', 'Vacuum & pel lantai', 'Isi amenities', 'Cek minibar', 'Cek AC/TV/remote', 'Foto bila ada kerusakan'],
  STAYOVER: ['Rapikan tempat tidur', 'Ganti handuk (bila diminta)', 'Bersihkan kamar mandi', 'Buang sampah', 'Isi amenities'],
  DEEP_CLEAN: ['Cuci gorden', 'Bersihkan AC', 'Bersihkan bawah kasur', 'Poles kaca'],
  TURN_DOWN: ['Buka selimut', 'Lampu tidur', 'Amenities malam']
};
const TYPE_LABEL = { CHECKOUT_CLEAN: 'Checkout clean', STAYOVER: 'Stayover', DEEP_CLEAN: 'Deep clean', TURN_DOWN: 'Turn-down' };

export async function render(el) {
  const me = state.profile;
  let ticker;
  async function load() {
    try {
      const bd = state.property.business_date;
      const prof = await q(sb.from('profiles').select('on_duty').eq('user_id', me.user_id).single());
      me.on_duty = prof.on_duty;
      let qq = sb.from('hk_tasks').select('*, rooms(number, floor, room_types(name))').eq('business_date', bd)
        .in('status', ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REWORK', 'DONE', 'INSPECTED']).order('priority').order('created_at');
      if (me.role === 'room_attendant') qq = qq.eq('assigned_to', me.user_id);
      const tasks = await q(qq);
      const active = tasks.filter((t) => ['ASSIGNED', 'IN_PROGRESS', 'REWORK', 'OPEN'].includes(t.status));
      const doneT = tasks.filter((t) => ['DONE', 'INSPECTED'].includes(t.status));
      const mins = active.reduce((a, t) => a + t.est_minutes, 0);
      const running = active.find((t) => t.status === 'IN_PROGRESS');

      el.innerHTML = `<div style="max-width:640px">
        <div class="card"><div class="bd row">
          <div><b>${esc(me.full_name)}</b><br><span class="muted">${active.length} tugas · ±${mins} menit · ${doneT.length} selesai hari ini</span></div>
          <button class="btn ${me.on_duty ? 'bad' : 'ok'}" id="duty" style="margin-left:auto">${me.on_duty ? 'Akhiri shift' : 'Mulai shift'}</button>
        </div></div>
        ${!me.on_duty ? '<div class="alert mt">Anda belum mulai shift — tugas baru tidak akan otomatis diberikan.</div>' : ''}
        ${running ? `<div class="card mt" style="border-color:var(--purple)"><div class="bd">
            <div class="row"><div><div class="muted">Sedang berjalan</div><div class="display" style="font-size:44px;line-height:1">${esc(running.rooms.number)}</div>
            <span>${TYPE_LABEL[running.task_type]} · target ${running.est_minutes}m</span></div>
            <div style="margin-left:auto" class="right"><div class="timer" id="tm">00:00</div></div></div>
            <button class="btn pri lg mt" data-done="${running.id}">Selesai — minta inspeksi</button></div></div>` : ''}
        <h3 class="mt" style="font-size:14px">Antrian tugas</h3><div class="mt">
        ${active.filter((t) => t !== running).map((t) => `<div class="task ${t.priority === 1 ? 'p1' : ''}">
            <div class="n">${esc(t.rooms.number)}</div>
            <div class="meta"><b>${TYPE_LABEL[t.task_type]}${t.priority === 1 ? ' · <span style="color:var(--magenta)">Prioritas arrival</span>' : ''}</b>
              <small class="muted">${esc(t.rooms.room_types?.name || '')} · lt ${t.rooms.floor} · ±${t.est_minutes}m</small>
              ${t.status === 'REWORK' ? `<div class="alert err" style="margin-top:6px;padding:5px 8px">Rework: ${esc(t.notes || '')}</div>` : ''}</div>
            ${statusTag(t.status)}
            <button class="btn pri" data-start="${t.id}" ${running ? 'disabled' : ''}>Mulai</button></div>`).join('') || '<div class="empty">Tidak ada tugas. 👍</div>'}
        </div>
        ${doneT.length ? `<h3 class="mt" style="font-size:14px">Selesai hari ini</h3><div class="mt">${doneT.map((t) => `<div class="task"><div class="n" style="font-size:24px">${esc(t.rooms.number)}</div>
            <div class="meta"><small class="muted">${TYPE_LABEL[t.task_type]} · selesai ${fmtTime(t.finished_at)}</small></div>${statusTag(t.status === 'DONE' ? 'CLEAN' : 'INSPECTED')}</div>`).join('')}</div>` : ''}
      </div>`;

      el.querySelector('#duty').onclick = async () => {
        try { await rpc('set_my_duty', { p_on_duty: !me.on_duty }); if (!me.on_duty) await rpc('hk_assign_open'); load(); } catch (e) { fail(e); }
      };
      el.querySelectorAll('[data-start]').forEach((b) => b.onclick = async () => {
        try { await rpc('hk_start', { p_task: b.dataset.start }); toast('Mulai dibersihkan.', 'ok'); load(); } catch (e) { fail(e); }
      });
      const db = el.querySelector('[data-done]');
      if (db) db.onclick = () => completeModal(running, load);
      clearInterval(ticker);
      if (running) {
        const tm = el.querySelector('#tm');
        const tick = () => {
          const s = Math.floor((Date.now() - new Date(running.started_at)) / 1000);
          tm.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
          tm.classList.toggle('warn', s > running.est_minutes * 60);
        };
        tick(); ticker = setInterval(tick, 1000);
      }
    } catch (e) { fail(e); }
  }
  await load();
  const off = onData(load);
  return () => { off(); clearInterval(ticker); };
}

function completeModal(t, reload) {
  const items = CHECKLIST[t.task_type] || [];
  modal({
    title: 'Selesai · Kamar ' + t.rooms.number,
    body: `${items.map((x, i) => `<label class="check"><input type="checkbox" data-i="${i}"> ${esc(x)}</label>`).join('')}
      <label class="f mt">Catatan / kerusakan<textarea name="notes" rows="2" placeholder="Opsional — mis. lampu kamar mandi mati"></textarea></label>`,
    actions: [{ label: 'Kirim ke inspeksi', cls: 'pri', run: async (m) => {
      const boxes = [...m.querySelectorAll('[data-i]')];
      if (boxes.some((b) => !b.checked)) { toast('Lengkapi semua checklist dulu.', 'err'); return false; }
      const checklist = Object.fromEntries(items.map((x) => [x, true]));
      await rpc('hk_complete', { p_task: t.id, p_checklist: checklist, p_notes: m.querySelector('[name=notes]').value || null });
      toast('Kamar ' + t.rooms.number + ' menunggu inspeksi.', 'ok'); reload();
    } }]
  });
}
