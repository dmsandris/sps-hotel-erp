# Log Perbaikan — SPS Hotel ERP

## v0.1.0 — 22 Okt 2026 (rilis awal Fase 1)

**Dibangun**
- Skema Supabase: property, profil/role, zona HK, tipe kamar, kamar, inventori per malam, rate plan, aturan harga, tamu, reservasi, snapshot harga per malam, penugasan kamar, tugas & inspeksi HK, kode transaksi, folio, posting ledger, night audit, audit log.
- RPC: `quote_stay`, `rate_calendar`, `create_hold`, `confirm_reservation`, `extend_hold`, `expire_holds`, `cancel_reservation`, `assign_room`, `check_in`, `check_out`, `room_move`, `post_charge`, `post_charge_to_room`, `post_payment`, `post_refund`, `reverse_posting`, `hk_start`, `hk_complete`, `hk_inspect`, `hk_reassign`, `hk_assign_open`, `set_room_ooo`, `release_room_ooo`, `night_audit`, `fo_dashboard`, `admin_set_profile`, `set_my_duty`.
- Frontend 9 menu (lihat README), tema logo SPS, responsif (HK mobile-first).
- Workflow GitHub Pages + migration manual.

**Diuji (Postgres 16 lokal + PostgREST 12 + Playwright)**
- 20 hold paralel untuk 2 kamar Suite → tepat 2 sukses, 18 `SOLD_OUT`, inventori konsisten.
- Idempotency hold & posting POS (request ulang = hasil sama, tidak dobel).
- Hold kedaluwarsa → `EXPIRED`, inventori kembali; konfirmasi telat ditolak.
- Alur penuh: hold → konfirmasi + deposit → check-in → charge outlet → night audit → check-out (tolak bila belum lunas / kredit belum di-refund) → tugas HK otomatis ke staf zona → FAIL → rework → PASS → READY.
- OOO mengurangi inventori & kembali saat dilepas.
- Akses: viewer tidak bisa transaksi, anon tidak bisa baca/RPC, insert langsung ke ledger ditolak RLS.

**Perbaikan selama build**
- Stayover task yatim saat early check-out → dibatalkan otomatis saat checkout clean dibuat.
- `rate_calendar`: kolom ambigu dengan OUT parameter → alias tabel.
- `addDays` di browser bergeser 1 hari di WIB (pakai `toISOString`) → hitung dari komponen lokal.
- Check-out dengan saldo kredit kini wajib refund atau alasan.
- Diskon faktor permintaan hanya H-7 ke bawah (tanpa booking curve, OTB rendah jauh hari bukan sinyal sepi).
- Format rupiah negatif `-Rp …`, angka tidak terpotong baris.

## v0.2.0 — 22 Okt 2026 (upgrade "maksimal": UI premium + Fase 2–3 + keuangan + laporan)

**Database — `upgrade-04-modul-keuangan-laporan.sql`** (aditif, fungsi lama tidak diubah)
- Tabel baru: companies, reservation_groups, routing_rules, cashier_shifts, ar_invoices, ar_receipts, gl_accounts, journal_entries/lines, facility_resources, facility_bookings (exclusion constraint), event_orders, event_items, laundry_orders, breakfast_redemptions.
- Kolom baru: folios.type/name/company_id, reservations.company_id/group_id, guests (CRM), properties (breakfast_price, phone, email, npwp), transaction_codes.gl_account, folio_postings.shift_id/routed_from_folio_id.
- Trigger `folio_postings`: routing ke master folio, isi shift kasir, validasi & invoice City Ledger, jurnal GL otomatis. Jurnal untuk posting lama di-backfill.
- RPC baru: grup (create_group_booking, confirm_group, set_reservation_guest), CRM (update_guest, guest_profile), keuangan (upsert_company, set_reservation_company, create_folio, house_folio, outlet_cash_sale, set/remove_routing, transfer_posting, settle_folio, ar_receive, open/close_shift, shift_summary), fasilitas (book/cancel/checkin_facility), event (create_event, add/remove_event_item, post_event_items, set_event_status), laundry (create_laundry, set_laundry_status), breakfast (breakfast_list, breakfast_redeem), laporan (report_range, report_daily, report_pickup, report_hk, report_ar_aging, report_trial_balance, report_channel), global_search.
- Seed: 16 akun GL (USALI ringkas), 4 kode transaksi baru, 6 fasilitas demo (2 tennis, gym, kolam, 2 ruang meeting).

**Frontend** — tema v2 (token warna, dark mode), Ctrl+K, sidebar ciut, nav bawah mobile, grafik SVG tanpa library, ekspor Excel; 10 halaman baru (Kalender Kamar, Tamu, Laundry, Fasilitas, Event, Breakfast, Shift, Perusahaan & AR, GL, Laporan); Reservasi/Folio/Outlet/Dasbor diperluas.

**Diuji** — upgrade di DB kosong & DB berisi data (2× berturut-turut), 25 query embed PostgREST setelah relasi baru, semua RPC laporan via HTTP, alur: grup 3 kamar → master folio → routing kamar → City Ledger → invoice AR → pelunasan parsial → aging; shift buka/tutup dengan selisih; tennis bentrok ditolak, di luar jam ditolak, gym penuh ditolak; BEO → posting; laundry express → posting; breakfast termasuk/di luar paket; neraca saldo selalu seimbang (selisih 0). Playwright: 19 menu + interaksi utama + mobile, 0 error JS.
