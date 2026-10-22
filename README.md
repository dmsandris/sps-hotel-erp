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

## Modul yang tersedia

| Menu | Role | Isi |
|---|---|---|
| Dasbor Front Desk | fo, cashier, finance, viewer | KPI, arrival queue + status kesiapan kamar, departure + saldo folio, papan kamar, alert, Night Audit |
| Reservasi | fo, cashier | Cari/filter, reservasi baru dengan quote per malam, hold 15 menit + hitung mundur, konfirmasi + deposit, tetapkan kamar, check-in/out, batal |
| Papan Kamar | semua | Status warna per lantai, riwayat status, set/lepas Out-of-Order |
| Tugas Saya (HK) | room_attendant | Mobile-first: mulai/akhiri shift, antrian tugas, timer, checklist, kirim ke inspeksi |
| Inspeksi & Tim HK | hk_supervisor | Antrian inspeksi berprioritas arrival, form berbobot (item kritis), beban staf, reassign |
| Folio & Billing | fo, cashier, finance | Statement, charge manual, pembayaran multi-metode, refund, void (reversal), cetak invoice |
| Outlet / Charge | fo, cashier | POS ringan charge-to-room: F&B, laundry, minibar, tennis, gym, meeting room |
| Harga Dinamis | fo, finance (ubah aturan: admin) | Kalender harga 7/14/30 hari, penjelasan faktor per sel, CRUD aturan season/DOW/libur/event |
| Pengaturan | admin | Role & zona staf, pajak/service, hold, tipe kamar & tarif, audit log |

## Deploy (sekali saja, ±15 menit)

### 1. Supabase
1. Buat project di <https://supabase.com> (region **Southeast Asia (Singapore)**).
2. **Database → Extensions**: aktifkan `pg_cron` (untuk auto-expire hold).
3. **SQL Editor** → jalankan berurutan isi file:
   1. `supabase/migrations/20261022000001-core-schema.sql`
   2. `supabase/migrations/20261022000002-functions.sql`
   3. `supabase/migrations/20261022000003-seed-demo.sql` (data demo: 26 kamar, 4 rate plan, aturan Nataru)

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

## Batasan Fase 1 (sengaja, sesuai roadmap PRD)

- 1 reservasi = 1 kamar (grup/multi-kamar: Fase 2). 1 user = 1 property.
- Pricing rule-based tanpa booking curve historis; diskon permintaan hanya H-7 ke bawah. ML forecasting: Fase 4.
- Belum ada: GL/AR/AP, channel manager/OTA, payment gateway (pembayaran dicatat manual), booking fasilitas berjadwal (tennis/meeting slot), BEO, laundry tracking, master folio/routing, offline-first mobile.
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
