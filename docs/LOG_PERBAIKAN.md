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
