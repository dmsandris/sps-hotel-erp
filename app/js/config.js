// Konfigurasi Supabase. Anon key aman dipublikasikan (akses dibatasi RLS + RPC).
// Saat deploy via GitHub Actions, file ini ditimpa dari repo Variables
// SUPABASE_URL dan SUPABASE_ANON_KEY. Bila kosong, aplikasi menampilkan layar setup.
window.SPS_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
