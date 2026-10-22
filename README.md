# SPS Hotel ERP — Fase 1 (Core PMS)

Hotel ERP All-in-One milik **PT Sirius Parama Sistem**, dibangun dari PRD v1.0 (22 Okt 2026).
Tahap ini **gratis sepenuhnya**: frontend statis di **GitHub Pages**, backend **Supabase** (Postgres + Auth + Realtime, free tier).
Dipakai untuk uji coba, trial, dan mockup klien.

## Arsitektur

```
Browser (GitHub Pages, HTML + JS modul, tanpa build)
   │  supabase-js (anon key)  ── Auth (email/password)
   ▼
Supabase PostgREST ──► RPC (SECURITY DEFINER, cek role)  ──► PostgreSQL
                   └─► SELECT langsung (dibatasi RLS per property)
Realtime: rooms, hk_tasks, reservations → dasbor ter-update otomatis
pg_cron: expire_holds() tiap menit (hold 15 menit)
```

Prinsip PRD yang dipegang di **database**, bukan di kode klien:

| Kebutuhan PRD | Implementasi |
|---|---|
| Anti double-booking tipe kamar (Bab 6.1) | `room_type_inventory` + conditional UPDATE atomik + `CHECK sold+held ≤ kapasitas` |
| Anti double-booking nomor kamar (6.2) | `room_assignments` + **exclusion constraint** `daterange &&` |
| Hold 15 menit + auto-cancel (Bab 7) | `expires_at` di DB, sweeper `expire_holds()` via pg_cron + dipanggil app tiap menit |
| Dynamic pricing (Bab 5) | `quote_price()`: BAR × rate plan × MIN(season × DOW × event, cap) × faktor okupansi, guardrail floor/ceiling |
| Riwayat harga per malam (Bab 8) | `reservation_night_rates` (snapshot + `adjustments` JSON penjelas) |
| HK auto-assign adil per zona (Bab 10) | trigger kamar → DIRTY → `create_hk_task()` → `auto_assign_hk()` (zona terdekat, beban menit terkecil, advisory lock) |
| Bersih → inspeksi → READY (Bab 11–12) | `hk_start/complete/inspect`; FAIL → REWORK ke staf semula |
| Folio terpadu, ledger immutable (Bab 14) | `folio_postings` append-only (UPDATE/DELETE dicabut), void = reversal, idempotency key unik |
| Audit (Bab 16) | `audit_logs` untuk hold, konfirmasi, cancel, check-in/out, override, void, refund, OOO, night audit |

## Modul yang tersedia (v0.2)

| Grup | Menu | Isi |
|---|---|---|
| Front Office | Dasbor | KPI + progress, forecast 14 hari (okupansi & pendapatan), donut status kamar, arrival/departure queue, alert, Night Audit |
| | Kalender Kamar | Tape chart kamar × tanggal (7/14/30 hari), batang per tamu (hold/confirmed/in-house/out/OOO/grup/VIP), sisa per tipe per hari, klik sel kosong = booking di kamar itu, tetapkan kamar ke reservasi belum dapat kamar |
| | Reservasi & Grup | Reservasi individual (quote per malam, hold 15 menit, deposit, perusahaan), **booking grup** multi-kamar + master folio + routing, rooming list, ekspor Excel |
| | Tamu (CRM) | Profil, riwayat menginap, total belanja, VIP, blacklist, preferensi, tag, consent UU PDP, peringatan tamu lama/blacklist saat booking |
| Operasional | Papan Kamar, Tugas HK, Inspeksi | Seperti v0.1 (mobile-first, realtime) |
| | Laundry | Kanban Diterima → Diproses → Siap → Diantar; Express ×1.5; terlambat ditandai; posting ke folio saat diantar |
| Layanan | Fasilitas | Jadwal per jam: tennis/meeting **eksklusif** (database menolak bentrok), gym/kolam **berbasis kapasitas**; tarif tamu vs umum; charge ke kamar atau bayar langsung |
| | Meeting & Event | Event + BEO (item F&B/peralatan/ruang), status Tentative → Definite → Selesai, deposit, posting ke folio event, cetak BEO |
| | Breakfast | Daftar kamar berhak (dari paket semalam), validasi nomor kamar di pintu, porsi untuk dapur, tambahan di-charge ke folio |
| | Outlet / POS | Charge ke kamar **atau** penjualan langsung non-tamu (folio House harian) |
| Keuangan | Folio & Billing | Folio Tamu/Master/Event/House, routing otomatis, pindah posting antar folio, perusahaan penanggung, void, refund, cetak invoice |
| | Shift Kasir | Buka dengan modal awal, rekap per metode, tutup dengan hitung kas fisik & selisih, cetak |
| | Perusahaan & AR | Master korporat (limit kredit, termin), invoice City Ledger otomatis dari pembayaran CL, pelunasan, aging 0/30/60/90+ |
| | Buku Besar (GL) | Jurnal double-entry otomatis dari setiap posting & pelunasan AR, neraca saldo, ekspor Excel |
| Manajemen | Laporan & Analitik | Daily flash (vs minggu lalu), kinerja periode Occ/ADR/RevPAR (aktual + forecast), pickup 7 hari, channel mix, produktivitas HK; Excel & cetak |
| | Harga Dinamis, Pengaturan | Seperti v0.1 + telepon/email/NPWP hotel & harga breakfast |

Lintas aplikasi: **mode gelap**, **pencarian global Ctrl+K** (tamu, reservasi, kamar, folio, perusahaan, menu), menu samping bisa diciutkan, navigasi bawah di HP, skeleton loading, realtime.

## Deploy (sekali saja, ±15 menit)

### 1. Supabase
1. Buat project di <https://supabase.com> (region **Southeast Asia (Singapore)**).
2. **Database → Extensions**: aktifkan `pg_cron` (untuk auto-expire hold).
3. **SQL Editor** → jalankan berurutan isi file:
   1. `supabase/migrations/20261022000001-core-schema.sql`
   2. `supabase/migrations/20261022000002-functions.sql`
   3. `supabase/migrations/20261022000003-seed-demo.sql` (data demo: 26 kamar, 4 rate plan, aturan Nataru)

   Instalasi baru cukup tempel **`supabase/setup-lengkap.sql`** (gabungan semua migration).
   Sudah terpasang v0.1? Tempel **`supabase/upgrade-04-modul-keuangan-laporan.sql`** saja.
   Alternatif: set secret repo `SUPABASE_DB_URL` lalu jalankan workflow **Jalankan migration Supabase** di tab Actions.
4. **Authentication → Sign In / Providers → Email**: untuk mockup, matikan *Confirm email* agar staf bisa langsung masuk.
5. **Authentication → URL Configuration → Site URL**: isi URL GitHub Pages (langkah 2).
6. Catat **Project URL** dan **anon public key** (Project Settings → API).

### 2. GitHub Pages
1. Repo → **Settings → Pages → Source: GitHub Actions**.
2. Repo → **Settings → Secrets and variables → Actions → Variables**: buat `SUPABASE_URL` dan `SUPABASE_ANON_KEY`.
3. Push ke `main` (atau jalankan workflow **Deploy app ke GitHub Pages**). URL: `https://dmsandris.github.io/sps-hotel-erp/`.

### 3. Pakai
1. Buka URL → **Daftar**. Akun pertama otomatis **Administrator**.
2. Staf lain daftar sendiri (role awal Viewer) → admin beri role di **Pengaturan**. Room Attendant beri **zona** (Lantai 1/2/3).
3. Alur uji cepat: Reservasi baru → Tahan → Konfirmasi → Dasbor: Check-in → Outlet: charge F&B → Check-out (bayar/refund) → HK: Mulai → Selesai → Supervisor: Inspeksi → kamar READY.

> Anon key memang publik; keamanan dijaga RLS + RPC yang mengecek role. **Jangan** taruh `service_role` key di frontend.

## Jalankan lokal

```bash
cd app && python3 -m http.server 8080   # buka http://localhost:8080, isi URL & anon key di layar setup
```

## Batasan saat ini

- 1 reservasi = 1 kamar (grup = kumpulan reservasi). 1 user = 1 property.
- Pricing rule-based tanpa booking curve historis; diskon permintaan hanya H-7 ke bawah. ML forecasting: Fase 4.
- Belum ada: channel manager/OTA, payment gateway (pembayaran dicatat manual), AP/procurement/inventori gudang, maintenance work order, door lock, offline-first mobile, self check-in tamu.
- Tarif pajak (PBJT) & service charge default 10% — **verifikasi dengan konsultan pajak / Perda setempat**.

## Struktur

```
app/                      frontend statis (deploy ke Pages)
  index.html, css/app.css, assets/ (logo SPS)
  js/core.js              klien Supabase, helper, pesan error
  js/main.js              login, layout, router, realtime
  js/pages/*.js           tiap menu
supabase/migrations/      skema, RPC, seed (urut nama file)
.github/workflows/        deploy Pages + migration manual
docs/                     LOG_PERBAIKAN, BUGS_AND_LESSONS_LEARNED_ADDENDUM
```
