-- =====================================================================
-- SPS Hotel ERP - Data demo (1 hotel, 3 lantai, 26 kamar)
-- Aman dijalankan ulang (idempotent). Ubah nama/tarif sesuai hotel klien.
-- =====================================================================
do $$
declare
  v_prop uuid; z1 uuid; z2 uuid; z3 uuid; t_sup uuid; t_dlx uuid; t_ste uuid; i int;
begin
  insert into public.properties (code, name, address, business_date)
  values ('SPS', 'SPS Demo Hotel', 'Jl. Bumiputera IV No. 32, Pulo Gadung, Jakarta Timur',
          (now() at time zone 'Asia/Jakarta')::date)
  on conflict (code) do nothing;
  select id into v_prop from public.properties where code = 'SPS';

  insert into public.hk_zones (property_id, name, sort_order) values
    (v_prop, 'Lantai 1', 1), (v_prop, 'Lantai 2', 2), (v_prop, 'Lantai 3', 3)
  on conflict (property_id, name) do nothing;
  select id into z1 from public.hk_zones where property_id = v_prop and name = 'Lantai 1';
  select id into z2 from public.hk_zones where property_id = v_prop and name = 'Lantai 2';
  select id into z3 from public.hk_zones where property_id = v_prop and name = 'Lantai 3';

  insert into public.room_types (property_id, code, name, capacity, base_rate, floor_rate, standard_clean_minutes, sort_order) values
    (v_prop, 'SUP', 'Superior', 2,  650000,  450000, 25, 1),
    (v_prop, 'DLX', 'Deluxe',   2,  900000,  650000, 30, 2),
    (v_prop, 'STE', 'Suite',    3, 1850000, 1300000, 50, 3)
  on conflict (property_id, code) do nothing;
  select id into t_sup from public.room_types where property_id = v_prop and code = 'SUP';
  select id into t_dlx from public.room_types where property_id = v_prop and code = 'DLX';
  select id into t_ste from public.room_types where property_id = v_prop and code = 'STE';

  for i in 1..10 loop
    insert into public.rooms (property_id, room_type_id, number, floor, zone_id)
    values (v_prop, t_sup, (100 + i)::text, 1, z1) on conflict (property_id, number) do nothing;
    insert into public.rooms (property_id, room_type_id, number, floor, zone_id)
    values (v_prop, t_dlx, (200 + i)::text, 2, z2) on conflict (property_id, number) do nothing;
  end loop;
  for i in 1..6 loop
    insert into public.rooms (property_id, room_type_id, number, floor, zone_id)
    values (v_prop, case when i <= 4 then t_dlx else t_ste end, (300 + i)::text, 3, z3)
    on conflict (property_id, number) do nothing;
  end loop;

  insert into public.rate_plans (property_id, code, name, meal_plan, rate_multiplier, addon_per_night, is_refundable, is_dynamic) values
    (v_prop, 'BAR-RO', 'Best Available - Room Only',  'RO', 1.000,      0, true,  true),
    (v_prop, 'BAR-BB', 'Best Available - Breakfast',  'BB', 1.000, 150000, true,  true),
    (v_prop, 'NRF-RO', 'Non Refundable - Room Only',  'RO', 0.900,      0, false, true),
    (v_prop, 'CORP',   'Korporat (harga tetap)',      'BB', 0.850, 150000, true,  false)
  on conflict (property_id, code) do nothing;

  if not exists (select 1 from public.pricing_rules where property_id = v_prop) then
    insert into public.pricing_rules (property_id, layer, name, date_from, date_to, dow, multiplier, min_los, priority) values
      (v_prop, 'DOW',     'Jumat',              null, null, array[5]::smallint[], 1.10, null, 1),
      (v_prop, 'DOW',     'Sabtu',              null, null, array[6]::smallint[], 1.20, null, 1),
      (v_prop, 'DOW',     'Minggu',             null, null, array[7]::smallint[], 1.05, null, 1),
      (v_prop, 'SEASON',  'Low season Nov',     date '2026-11-01', date '2026-11-30', null, 0.95, null, 1),
      (v_prop, 'SEASON',  'High season Nataru', date '2026-12-18', date '2027-01-04', null, 1.20, null, 2),
      (v_prop, 'HOLIDAY', 'Hari Natal',         date '2026-12-25', date '2026-12-25', null, 1.25, null, 1),
      (v_prop, 'EVENT',   'Malam Tahun Baru',   date '2026-12-31', date '2026-12-31', null, 1.50, 2,    5),
      (v_prop, 'HOLIDAY', 'Tahun Baru 2027',    date '2027-01-01', date '2027-01-01', null, 1.25, null, 1);
  end if;

  insert into public.transaction_codes (property_id, code, name, grp, is_taxable) values
    (v_prop, 'ROOM',       'Room Charge',          'ROOM',       true),
    (v_prop, 'BF',         'Breakfast',            'FB',         true),
    (v_prop, 'FB-FOOD',    'Restoran - Makanan',   'FB',         true),
    (v_prop, 'FB-BEV',     'Restoran - Minuman',   'FB',         true),
    (v_prop, 'LAUNDRY',    'Laundry Tamu',         'LAUNDRY',    true),
    (v_prop, 'MINIBAR',    'Minibar',              'MINIBAR',    true),
    (v_prop, 'FAC-TENNIS', 'Lapangan Tennis',      'FACILITY',   true),
    (v_prop, 'FAC-GYM',    'Gym / Kolam (non-tamu)','FACILITY',  true),
    (v_prop, 'MEET-ROOM',  'Sewa Meeting Room',    'MEETING',    true),
    (v_prop, 'PEN-LATE',   'Late Check-out',       'PENALTY',    true),
    (v_prop, 'PEN-DAMAGE', 'Denda Kerusakan/Kunci','PENALTY',    false),
    (v_prop, 'ADJ',        'Penyesuaian',          'ADJUSTMENT', false),
    (v_prop, 'PAY-CASH',     'Pembayaran Tunai',    'PAYMENT', false),
    (v_prop, 'PAY-CARD',     'Pembayaran Kartu',    'PAYMENT', false),
    (v_prop, 'PAY-QRIS',     'Pembayaran QRIS',     'PAYMENT', false),
    (v_prop, 'PAY-TRANSFER', 'Transfer Bank',       'PAYMENT', false),
    (v_prop, 'PAY-CL',       'City Ledger (Tagih ke Perusahaan)', 'PAYMENT', false)
  on conflict (property_id, code) do nothing;
end $$;

-- Backfill profil untuk akun yang sudah daftar sebelum migration dijalankan.
-- Akun terlama menjadi admin bila belum ada admin; sisanya viewer.
do $$
declare v_prop uuid; u record;
begin
  select id into v_prop from public.properties order by created_at limit 1;
  for u in select id, email, raw_user_meta_data from auth.users
            where id not in (select user_id from public.profiles) order by created_at loop
    insert into public.profiles (user_id, property_id, email, full_name, role)
    values (u.id, v_prop, u.email,
            coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
            case when exists (select 1 from public.profiles where role = 'admin') then 'viewer' else 'admin' end);
  end loop;
end $$;
