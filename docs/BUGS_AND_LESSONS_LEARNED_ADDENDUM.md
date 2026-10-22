# Bugs & Lessons Learned — SPS Hotel ERP (Supabase + GitHub Pages)

1. **plpgsql OUT parameter vs nama kolom.** Fungsi `RETURNS TABLE (room_type_id …)` membuat `room_type_id` jadi variabel; query di dalamnya wajib pakai alias tabel (`i.room_type_id`).
2. **Tanggal di browser WIB.** `new Date('YYYY-MM-DD').toISOString()` mundur 1 hari (UTC+7). Selalu bentuk string tanggal dari `getFullYear/getMonth/getDate`, atau biarkan DB yang menghitung (`business_date`).
3. **Business date ≠ tanggal kalender.** Semua posting & validasi check-in memakai `properties.business_date`, hanya maju lewat Night Audit.
4. **Task HK & early check-out.** Stayover yang dibuat night audit harus dibatalkan saat kamar jadi DIRTY karena checkout, kalau tidak petugas menerima 2 tugas untuk kamar yang sama.
5. **Unique index parsial untuk idempotensi tugas** harus memasukkan status `REWORK`; kalau tidak, inspeksi FAIL (kamar → DIRTY) memicu trigger membuat tugas duplikat.
6. **Exclusion constraint butuh `btree_gist`.** Tangkap `exclusion_violation` → ubah jadi kode domain `ROOM_CONFLICT`.
7. **Kunci baris urut tanggal** (`ORDER BY stay_date FOR UPDATE`) sebelum UPDATE inventori multi-malam untuk menghindari deadlock.
8. **pg_cron bisa belum aktif** di project baru → blok `DO … EXCEPTION` agar migration tidak gagal; app juga memanggil `expire_holds()` saat dibuka & tiap 60 detik sebagai jaring pengaman.
9. **Ledger append-only**: `REVOKE UPDATE, DELETE` dari `authenticated`; void = posting pembalik dengan `reverses_posting_id UNIQUE` (tidak bisa void 2×).
10. **Idempotency key klien harus stabil saat retry** (outlet: satu batch id sampai sukses) — kalau dibuat ulang tiap klik, retry jadi double-post.
11. **Supabase CLI migration butuh nama `<versi>_<nama>.sql`** (underscore). Repo ini pakai tanda hubung sesuai standar penamaan file → jalankan via SQL Editor / workflow psql, bukan `supabase db push`.
12. **Push dari sesi Claude** butuh Claude GitHub App terpasang di akun pemilik repo.
13. **Relasi baru bisa membuat embed PostgREST ambigu** (mis. `folios` ↔ `reservations` via `routing_rules`, `guests` ↔ `reservations` via `folios`). Uji ulang semua `select=…(embed)` setiap menambah tabel junction; pakai hint FK (`reservations!reservations_guest_id_fkey`) bila perlu.
14. **Fitur lintas modul lewat trigger, bukan mengubah fungsi lama**: routing, shift, City Ledger, dan GL dipasang sebagai BEFORE/AFTER trigger di `folio_postings`, jadi semua jalur posting (lama & baru) otomatis ikut.
15. **GL harus seimbang per jurnal**: `gl_post()` menolak jurnal tidak seimbang; void/transfer membalik sisi debit/kredit berdasarkan tanda nilai.
16. **Kapasitas (gym/kolam) tidak bisa pakai exclusion constraint** → kunci baris resource (`FOR UPDATE`) lalu jumlahkan pax yang overlap.
17. **SVG `preserveAspectRatio="none"` merusak teks & titik** pada grafik lebar — pakai viewBox proporsional.
18. **Pastikan service uji benar-benar hidup**: `pgrep -f postgrest` bisa cocok dengan perintah pencarinya sendiri; cek kode HTTP, bukan sekadar "tidak ada error di body".
19. **State form di halaman yang re-render** (outlet): simpan pilihan (kamar, metode) di variabel modul, kalau tidak pilihan hilang setiap tambah item.
