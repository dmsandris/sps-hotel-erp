// Komponen UI bersama: ikon, grafik SVG (tanpa library), ekspor, tema, skeleton.
import { esc, rp, num, toast } from './core.js';

// ---------------------------------------------------------------- ikon
const P = {
  dash: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  res: 'M7 3v2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2V3h-2v2H9V3zm-2 7h14v9H5z',
  tape: 'M3 4h18v2H3zm0 5h8v3H3zm10 0h8v3h-8zM3 15h12v3H3zm14 0h4v3h-4z',
  room: 'M4 4h16v16H4zm2 2v12h12V6zm2 2h3v3H8zm5 0h3v3h-3zm-5 5h3v3H8zm5 0h3v3h-3z',
  hk: 'M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6zm-1 14-4-4 1.4-1.4L11 13.2l4.6-4.6L17 10z',
  insp: 'M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  folio: 'M6 2h9l5 5v15H6zm8 1.5V8h4.5zM8 12h8v2H8zm0 4h8v2H8z',
  pos: 'M3 3h18v4H3zm2 6h14v12H5zm3 3v2h8v-2z',
  price: 'M3 17l6-6 4 4 8-8v4h2V3h-8v2h4l-6 6-4-4-8 8z',
  set: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1L11 21h4l.4-2.9a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  guest: 'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5z',
  fac: 'M7 3a4 4 0 0 0-1 7.9V21h2V10.9A4 4 0 0 0 7 3zm10 0-4 8h3v10h2V11h3z',
  event: 'M4 5h16v3H4zm0 5h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm4 3v2h8v-2z',
  laundry: 'M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm2 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm5 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  bf: 'M4 9h13v4a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6zm13 1h1a3 3 0 0 1 0 6h-1.2M7 3c0 2 2 2 2 4M11 3c0 2 2 2 2 4',
  company: 'M3 21V5l9-3 9 3v16h-7v-5h-4v5zm4-13v2h2V8zm4 0v2h2V8zm4 0v2h2V8zm-8 4v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2z',
  gl: 'M4 3h16v18H4zm3 4v2h10V7zm0 4v2h10v-2zm0 4v2h6v-2z',
  shift: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.4l3.6 2.1-1 1.7L11 13.6V7z',
  report: 'M4 20V10h3v10zm6.5 0V4h3v16zM17 20v-7h3v7z',
  search: 'M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  moon: 'M21 14.5A9 9 0 0 1 9.5 3a9 9 0 1 0 11.5 11.5z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 2.8l2.1 2.1-1.4 1.4-2.1-2.1zm14.9 14.9 2.1 2.1-1.4 1.4-2.1-2.1zM2.8 19.8l2.1-2.1 1.4 1.4-2.1 2.1zM17.7 4.9l2.1-2.1 1.4 1.4-2.1 2.1z',
  menu: 'M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z',
  side: 'M3 4h18v16H3zm2 2v12h4V6z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  dl: 'M11 3h2v10l3.5-3.5 1.4 1.4L12 16.8l-5.9-5.9 1.4-1.4L11 13zM4 19h16v2H4z',
  print: 'M6 3h12v5H6zm-3 6h18v8h-3v4H6v-4H3zm5 6v4h8v-4z',
  bed: 'M3 7h2v6h14a2 2 0 0 1 2 2v5h-2v-2H5v2H3zm5 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm4 1h7a2 2 0 0 1 2 2v2h-9z',
  in: 'M10 17l1.4-1.4-2.6-2.6H20v-2H8.8l2.6-2.6L10 7l-5 5zM3 3h2v18H3z',
  out: 'M14 7l-1.4 1.4 2.6 2.6H4v2h11.2l-2.6 2.6L14 17l5-5zM19 3h2v18h-2z',
  money: 'M2 6h20v12H2zm10 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 9v6h1.5V9z',
  spark: 'M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z',
  warn: 'M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'
};
export const icon = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${P[k] || P.info}"/></svg>`;

export const emptyState = (text, ic = 'info') => `<div class="empty">${icon(ic)}${esc(text)}</div>`;
export const skeleton = (h = 120, n = 1) => Array.from({ length: n }, () => `<div class="skel" style="height:${h}px;margin-bottom:12px"></div>`).join('');

// ---------------------------------------------------------------- tema
export function getTheme() {
  try { return localStorage.getItem('sps.theme') || ''; } catch (e) { return ''; }
}
export function applyTheme(t) {
  const dark = t === 'dark' || (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  return dark;
}
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('sps.theme', next); } catch (e) { /* abaikan */ }
  applyTheme(next);
  window.dispatchEvent(new Event('sps-theme'));
  return next;
}

// ---------------------------------------------------------------- tooltip
let tipEl;
function tip(html, ev) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'chart-tip'; document.body.appendChild(tipEl); }
  if (!html) { tipEl.hidden = true; return; }
  tipEl.hidden = false; tipEl.innerHTML = html;
  const x = Math.min(ev.clientX + 12, innerWidth - tipEl.offsetWidth - 8);
  tipEl.style.left = x + 'px'; tipEl.style.top = (ev.clientY - 36) + 'px';
}
export function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach((n) => {
    n.addEventListener('mousemove', (e) => tip(n.dataset.tip, e));
    n.addEventListener('mouseleave', () => tip(null));
  });
}

// ---------------------------------------------------------------- grafik
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const short = (v) => Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1).replace('.0', '') + 'M' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + 'jt' : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + 'rb' : String(Math.round(v));

/**
 * Grafik kombinasi batang + garis.
 * opt: { labels[], bars:[{name, values[], color?, fmt?}], lines:[{name, values[], color?, axis:'right', fmt?}], height, yFmt, y2Fmt, y2Max }
 */
export function comboChart(opt) {
  const W = 760, H = opt.height || 240, L = 46, R = opt.lines?.some((l) => l.axis === 'right') ? 42 : 14, T = 12, B = 30;
  const n = opt.labels.length, iw = W - L - R, ih = H - T - B, bw = iw / Math.max(n, 1);
  const bars = opt.bars || [], lines = opt.lines || [];
  const leftVals = [...bars.flatMap((b) => b.values), ...lines.filter((l) => l.axis !== 'right').flatMap((l) => l.values)].map(Number).filter((v) => !isNaN(v));
  const yMax = niceMax(Math.max(0, ...leftVals));
  const y2Max = opt.y2Max || niceMax(Math.max(0, ...lines.filter((l) => l.axis === 'right').flatMap((l) => l.values).map(Number)));
  const y = (v) => T + ih - (v / yMax) * ih, y2 = (v) => T + ih - (v / y2Max) * ih;
  const yFmt = opt.yFmt || short, y2Fmt = opt.y2Fmt || ((v) => v + '%');
  let g = '<g class="grid">';
  for (let i = 0; i <= 4; i++) {
    const yy = T + (ih * i) / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end">${yFmt(yMax * (1 - i / 4))}</text>`;
    if (R > 20) g += `<text x="${W - R + 6}" y="${yy + 3}">${y2Fmt(Math.round(y2Max * (1 - i / 4)))}</text>`;
  }
  g += '</g>';
  const step = Math.ceil(n / 14);
  let xl = '';
  opt.labels.forEach((lb, i) => { if (i % step === 0) xl += `<text x="${L + bw * i + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(lb)}</text>`; });
  let bs = '';
  const gw = (bw * 0.7) / Math.max(bars.length, 1);
  bars.forEach((b, bi) => b.values.forEach((v, i) => {
    const val = Number(v) || 0, x = L + bw * i + bw * 0.15 + gw * bi, yy = y(Math.max(val, 0));
    const t = `${esc(opt.labels[i])} · ${esc(b.name)}: ${(b.fmt || num)(val)}`;
    bs += `<rect x="${x}" y="${yy}" width="${Math.max(gw - 2, 2)}" height="${T + ih - yy}" rx="4" fill="${b.color || COLORS[bi]}" opacity="${opt.dim?.[i] ? .45 : .9}" data-tip="${t}"/>`;
  }));
  let ls = '';
  lines.forEach((l, li) => {
    const sy = l.axis === 'right' ? y2 : y;
    const pts = l.values.map((v, i) => `${L + bw * i + bw / 2},${sy(Number(v) || 0)}`);
    const c = l.color || COLORS[(bars.length + li) % COLORS.length];
    ls += `<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (n <= 45) l.values.forEach((v, i) => { ls += `<circle cx="${L + bw * i + bw / 2}" cy="${sy(Number(v) || 0)}" r="3.5" fill="var(--card)" stroke="${c}" stroke-width="2" data-tip="${esc(opt.labels[i])} · ${esc(l.name)}: ${(l.fmt || num)(v)}"/>`; });
  });
  const legend = [...bars.map((b, i) => [b.name, b.color || COLORS[i]]), ...lines.map((l, i) => [l.name, l.color || COLORS[(bars.length + i) % COLORS.length]])]
    .map(([nm, c]) => `<span><i style="background:${c}"></i>${esc(nm)}</span>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="max-height:${Math.round(H * 1.25)}px">${g}<line class="axis" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>${bs}${ls}${xl}</svg><div class="chart-legend">${legend}</div>`;
}

export function donut(items, opt = {}) {
  const total = items.reduce((s, x) => s + Math.max(0, Number(x.value) || 0), 0);
  const R = 52, C = 2 * Math.PI * R;
  let off = 0, arcs = '';
  items.forEach((x, i) => {
    const v = Math.max(0, Number(x.value) || 0); if (!v) return;
    const len = (v / total) * C;
    arcs += `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${x.color || COLORS[i % COLORS.length]}" stroke-width="18" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)" data-tip="${esc(x.label)}: ${(opt.fmt || num)(v)} (${Math.round((v / total) * 100)}%)"/>`;
    off += len;
  });
  const legend = items.map((x, i) => `<div class="sum-row" style="gap:18px"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;background:${x.color || COLORS[i % COLORS.length]}"></i>${esc(x.label)}</span><b class="num">${(opt.fmt || num)(x.value)}</b></div>`).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" width="140" height="140"><circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--line-2)" stroke-width="18"/>${arcs}
    <text x="70" y="66" text-anchor="middle" style="font-size:11px;fill:var(--ink-3)">${esc(opt.center || 'Total')}</text>
    <text x="70" y="84" text-anchor="middle" style="font-size:15px;font-weight:800;fill:var(--ink)">${esc(opt.centerValue ?? (opt.fmt || num)(total))}</text></svg>
    <div style="flex:1;min-width:160px">${legend || '<span class="muted">Belum ada data</span>'}</div></div>`;
}

export function spark(values, color = 'var(--c1)') {
  const v = values.map(Number), max = Math.max(1, ...v), w = 120, h = 32;
  const pts = v.map((x, i) => `${(i / Math.max(v.length - 1, 1)) * w},${h - (x / max) * (h - 4) - 2}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

export const pct = (v) => (v == null || isNaN(v) ? '-' : Number(v).toFixed(1).replace('.0', '') + '%');
export const rpShort = (v) => 'Rp ' + short(Number(v) || 0);

// ---------------------------------------------------------------- ekspor
export function downloadCSV(name, rows) {
  if (!rows.length) return toast('Tidak ada data untuk diekspor.', 'err');
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => { const v = r[c] ?? ''; const s = String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','))].join('\n');
  saveBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}
let xlsxLib;
export async function downloadXLSX(name, sheets) {
  try {
    if (!xlsxLib) xlsxLib = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = xlsxLib.utils.book_new();
    Object.entries(sheets).forEach(([sn, rows]) => xlsxLib.utils.book_append_sheet(wb, xlsxLib.utils.json_to_sheet(rows.length ? rows : [{ info: 'kosong' }]), sn.slice(0, 31)));
    xlsxLib.writeFile(wb, name + '.xlsx');
  } catch (e) {
    toast('Excel gagal dimuat, diunduh sebagai CSV.', 'err');
    const first = Object.values(sheets)[0] || [];
    downloadCSV(name, first);
  }
}
function saveBlob(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// tanggal & jam lokal (WIB) untuk input datetime
export const localDT = (date, time) => new Date(`${date}T${time}:00`).toISOString();
export const hhmm = (d) => new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
export const initials = (s) => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
