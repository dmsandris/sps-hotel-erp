-- SPS Hotel ERP - setup lengkap (gabungan 3 migration, urut). Tempel di Supabase SQL Editor lalu Run.
-- Aman dijalankan ulang.

-- ===== migrations/20261022000001-core-schema.sql =====
-- =====================================================================
-- SPS Hotel ERP - Fase 1 (Core PMS) - Skema inti
-- Target: Supabase (PostgreSQL 15+/16). Jalankan berurutan:
--   1) 20261022000001-core-schema.sql   (tabel, constraint, RLS)
--   2) 20261022000002-functions.sql     (RPC bisnis)
--   3) 20261022000003-seed-demo.sql     (data demo, opsional)
-- Prinsip PRD: konsistensi dijaga DATABASE (constraint + atomic update),
-- harga per malam di-snapshot, ledger folio append-only.
-- =====================================================================

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. PROPERTY & IAM
-- ---------------------------------------------------------------------
create table if not exists public.properties (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  address          text,
  timezone         text not null default 'Asia/Jakarta',
  business_date    date not null default current_date,  -- hanya maju lewat Night Audit
  checkin_time     time not null default '14:00',
  checkout_time    time not null default '12:00',
  service_rate     numeric(5,4) not null default 0.10,  -- service charge (konfigurasi)
  tax_rate         numeric(5,4) not null default 0.10,  -- PBJT; verifikasi Perda setempat
  hold_minutes     int not null default 15,
  calendar_cap     numeric(5,3) not null default 1.80,  -- batas gabungan faktor kalender
  created_at       timestamptz not null default now()
);

create table if not exists public.hk_zones (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  name         text not null,
  sort_order   int not null default 0,
  unique (property_id, name)
);

-- Profil user (1 user = 1 property pada MVP). Role menentukan hak RPC.
create table if not exists public.profiles (
  user_id      uuid primary key,                       -- = auth.users.id
  property_id  uuid references public.properties(id),
  email        text,
  full_name    text,
  role         text not null default 'viewer'
               check (role in ('admin','fo','hk_supervisor','room_attendant','cashier','finance','viewer')),
  zone_id      uuid references public.hk_zones(id),
  on_duty      boolean not null default false,
  max_minutes  int not null default 420,
  created_at   timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id           bigserial primary key,
  property_id  uuid,
  actor        uuid,
  action       text not null,
  entity       text not null,
  entity_id    text,
  data         jsonb,
  at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. KAMAR & INVENTORI
-- ---------------------------------------------------------------------
create table if not exists public.room_types (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references public.properties(id) on delete cascade,
  code                    text not null,
  name                    text not null,
  capacity                smallint not null default 2,
  base_rate               numeric(14,2) not null,          -- BAR
  floor_rate              numeric(14,2) not null,          -- guardrail bawah
  ceil_multiplier         numeric(5,3) not null default 2.2,-- guardrail atas = BAR x ini
  standard_clean_minutes  int not null default 30,
  sort_order              int not null default 0,
  unique (property_id, code)
);

create table if not exists public.rooms (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  room_type_id  uuid not null references public.room_types(id),
  number        text not null,
  floor         smallint not null,
  zone_id       uuid references public.hk_zones(id),
  fo_status     text not null default 'VACANT' check (fo_status in ('VACANT','OCCUPIED')),
  hk_status     text not null default 'INSPECTED'
                check (hk_status in ('DIRTY','CLEANING','CLEAN','INSPECTED','OOO')),
  is_sellable   boolean not null default true,
  version       bigint not null default 0,
  updated_at    timestamptz not null default now(),
  unique (property_id, number)
);

create table if not exists public.room_status_history (
  id          bigserial primary key,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  from_status text,
  to_status   text,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);

-- Model A (PRD 6.1): counter atomik per tipe kamar per malam
create table if not exists public.room_type_inventory (
  property_id   uuid not null references public.properties(id) on delete cascade,
  room_type_id  uuid not null references public.room_types(id) on delete cascade,
  stay_date     date not null,
  total_rooms   int not null,
  out_of_order  int not null default 0,
  overbook_cap  int not null default 0,
  sold          int not null default 0,
  held          int not null default 0,
  version       bigint not null default 0,
  primary key (property_id, room_type_id, stay_date),
  constraint ck_inv_nonneg check (sold >= 0 and held >= 0 and out_of_order >= 0),
  constraint ck_inv_capacity check (sold + held <= total_rooms - out_of_order + overbook_cap)
);

-- ---------------------------------------------------------------------
-- 3. RATE & DYNAMIC PRICING
-- ---------------------------------------------------------------------
create table if not exists public.rate_plans (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references public.properties(id) on delete cascade,
  code             text not null,
  name             text not null,
  meal_plan        text not null default 'RO' check (meal_plan in ('RO','BB','HB','FB')),
  rate_multiplier  numeric(6,3) not null default 1.000,
  addon_per_night  numeric(14,2) not null default 0,  -- mis. breakfast per kamar
  is_refundable    boolean not null default true,
  is_dynamic       boolean not null default true,     -- false = harga tetap (korporat)
  is_active        boolean not null default true,
  unique (property_id, code)
);

create table if not exists public.pricing_rules (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  layer        text not null check (layer in ('SEASON','DOW','HOLIDAY','EVENT')),
  name         text not null,
  date_from    date,
  date_to      date,
  dow          smallint[],           -- 1=Senin .. 7=Minggu (ISO)
  multiplier   numeric(6,3) not null,
  min_los      smallint,
  priority     int not null default 0,
  is_active    boolean not null default true,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. TAMU & RESERVASI
-- ---------------------------------------------------------------------
create table if not exists public.guests (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  full_name    text not null,
  phone        text,
  email        text,
  id_number    text,
  vip_level    smallint not null default 0,
  is_blacklisted boolean not null default false,
  notes        text,
  created_at   timestamptz not null default now()
);
create index if not exists ix_guests_phone on public.guests (property_id, phone);

create sequence if not exists public.seq_confirmation;
create sequence if not exists public.seq_folio;

create table if not exists public.reservations (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references public.properties(id) on delete cascade,
  confirmation_no  text not null unique,
  guest_id         uuid not null references public.guests(id),
  room_type_id     uuid not null references public.room_types(id),
  rate_plan_id     uuid not null references public.rate_plans(id),
  room_id          uuid references public.rooms(id),
  adults           smallint not null default 1,
  children         smallint not null default 0,
  channel          text not null default 'DIRECT'
                   check (channel in ('DIRECT','WALK_IN','PHONE','OTA','CORPORATE')),
  status           text not null
                   check (status in ('PENDING_PAYMENT','CONFIRMED','IN_HOUSE','CHECKED_OUT','CANCELLED','NO_SHOW','EXPIRED')),
  check_in         date not null,
  check_out        date not null,
  expires_at       timestamptz,
  total_amount     numeric(14,2) not null default 0,
  special_requests text,
  idempotency_key  text unique,
  checked_in_at    timestamptz,
  checked_out_at   timestamptz,
  cancelled_reason text,
  version          bigint not null default 0,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint ck_res_dates check (check_out > check_in)
);
create index if not exists ix_res_status_ci on public.reservations (property_id, status, check_in);
create index if not exists ix_res_expiry on public.reservations (expires_at) where status = 'PENDING_PAYMENT';

-- Riwayat harga dinamis per malam (snapshot, PRD 8)
create table if not exists public.reservation_night_rates (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null references public.reservations(id) on delete cascade,
  stay_date       date not null,
  base_rate       numeric(14,2) not null,
  adjustments     jsonb not null,
  net_rate        numeric(14,2) not null,
  addon_amount    numeric(14,2) not null default 0,
  service_amount  numeric(14,2) not null default 0,
  tax_amount      numeric(14,2) not null default 0,
  rate_source     text not null default 'DYNAMIC'
                  check (rate_source in ('DYNAMIC','NEGOTIATED','MANUAL_OVERRIDE','PROMO','PACKAGE')),
  override_reason text,
  override_by     uuid,
  superseded_at   timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_night_rate_active
  on public.reservation_night_rates (reservation_id, stay_date) where superseded_at is null;

-- Model B (PRD 6.2): penugasan nomor kamar, mustahil bertumpuk
create table if not exists public.room_assignments (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  room_id         uuid not null references public.rooms(id) on delete cascade,
  reservation_id  uuid references public.reservations(id) on delete cascade,
  stay_range      daterange not null,            -- [check_in, check_out)
  kind            text not null default 'STAY' check (kind in ('STAY','OOO','HOUSE_USE')),
  reason          text,
  is_active       boolean not null default true,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint no_overlap exclude using gist (room_id with =, stay_range with &&) where (is_active)
);

-- ---------------------------------------------------------------------
-- 5. HOUSEKEEPING
-- ---------------------------------------------------------------------
create table if not exists public.hk_tasks (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  room_id        uuid not null references public.rooms(id) on delete cascade,
  task_type      text not null check (task_type in ('CHECKOUT_CLEAN','STAYOVER','DEEP_CLEAN','TURN_DOWN')),
  priority       smallint not null default 3,     -- 1 = arrival/VIP hari ini
  est_minutes    int not null default 30,
  status         text not null default 'OPEN'
                 check (status in ('OPEN','ASSIGNED','IN_PROGRESS','DONE','INSPECTED','REWORK','CANCELLED')),
  assigned_to    uuid references public.profiles(user_id),
  business_date  date not null,
  checklist      jsonb,
  notes          text,
  rework_count   int not null default 0,
  created_at     timestamptz not null default now(),
  assigned_at    timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz
);
-- Idempotensi: 1 tugas aktif per kamar/tipe/hari
create unique index if not exists uq_hk_open_task on public.hk_tasks (room_id, task_type, business_date)
  where status in ('OPEN','ASSIGNED','IN_PROGRESS','REWORK');
create index if not exists ix_hk_assignee on public.hk_tasks (assigned_to, status);

create table if not exists public.hk_inspections (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  task_id     uuid not null references public.hk_tasks(id) on delete cascade,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  inspector   uuid,
  result      text not null check (result in ('PASS','FAIL')),
  score       smallint check (score between 0 and 100),
  checklist   jsonb,
  notes       text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 6. FOLIO & BILLING (ledger append-only)
-- ---------------------------------------------------------------------
create table if not exists public.transaction_codes (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  code         text not null,
  name         text not null,
  grp          text not null check (grp in ('ROOM','FB','LAUNDRY','FACILITY','MEETING','MINIBAR','PENALTY','PAYMENT','ADJUSTMENT')),
  is_taxable   boolean not null default true,
  is_active    boolean not null default true,
  unique (property_id, code)
);

create table if not exists public.folios (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  folio_no              text not null unique,
  reservation_id        uuid unique references public.reservations(id),
  guest_id              uuid references public.guests(id),
  status                text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  opened_business_date  date not null,
  closed_at             timestamptz,
  balance               numeric(14,2) not null default 0,  -- cache; kebenaran = SUM(postings)
  created_at            timestamptz not null default now()
);

create table if not exists public.folio_postings (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  folio_id            uuid not null references public.folios(id),
  business_date       date not null,
  posted_at           timestamptz not null default now(),
  txn_code_id         uuid not null references public.transaction_codes(id),
  source_module       text not null,
  source_ref          text,
  description         text not null,
  quantity            numeric(12,3) not null default 1,
  unit_price          numeric(14,2),
  net_amount          numeric(14,2) not null,        -- charge (+) / pembayaran (-)
  service_amount      numeric(14,2) not null default 0,
  tax_amount          numeric(14,2) not null default 0,
  gross_amount        numeric(14,2) generated always as (net_amount + service_amount + tax_amount) stored,
  reverses_posting_id uuid unique references public.folio_postings(id),
  reason              text,
  posted_by           uuid,
  idempotency_key     text not null,
  unique (property_id, idempotency_key)               -- anti double-post
);
create index if not exists ix_postings_folio on public.folio_postings (folio_id, business_date);

create table if not exists public.night_audit_runs (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  business_date  date not null,
  run_by         uuid,
  result         jsonb,
  run_at         timestamptz not null default now(),
  unique (property_id, business_date)
);

-- =====================================================================
-- 7. HELPER AKSES (dipakai RLS & RPC)
-- =====================================================================
create or replace function public.fn_my_property() returns uuid
language sql stable security definer set search_path = public as $$
  select property_id from public.profiles where user_id = auth.uid()
$$;

create or replace function public.fn_my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where user_id = auth.uid()), 'anon')
$$;

-- =====================================================================
-- 8. ROW LEVEL SECURITY
--    Baca: anggota property. Tulis master data: admin. Transaksi: hanya via RPC.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['properties','hk_zones','profiles','audit_logs','room_types','rooms',
    'room_status_history','room_type_inventory','rate_plans','pricing_rules','guests','reservations',
    'reservation_night_rates','room_assignments','hk_tasks','hk_inspections','transaction_codes',
    'folios','folio_postings','night_audit_runs']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- properties
drop policy if exists p_properties_read on public.properties;
create policy p_properties_read on public.properties for select to authenticated
  using (id = public.fn_my_property());
drop policy if exists p_properties_admin on public.properties;
create policy p_properties_admin on public.properties for update to authenticated
  using (id = public.fn_my_property() and public.fn_my_role() = 'admin')
  with check (id = public.fn_my_property());

-- profiles: lihat rekan satu property
drop policy if exists p_profiles_read on public.profiles;
create policy p_profiles_read on public.profiles for select to authenticated
  using (user_id = auth.uid() or property_id = public.fn_my_property());

-- tabel ber-property_id: baca anggota
do $$
declare t text;
begin
  foreach t in array array['hk_zones','audit_logs','room_types','rooms','room_type_inventory','rate_plans',
    'pricing_rules','guests','reservations','room_assignments','hk_tasks','hk_inspections',
    'transaction_codes','folios','folio_postings','night_audit_runs']
  loop
    execute format('drop policy if exists p_%s_read on public.%I', t, t);
    execute format('create policy p_%s_read on public.%I for select to authenticated using (property_id = public.fn_my_property())', t, t);
  end loop;
  -- master data: admin boleh tulis langsung
  foreach t in array array['hk_zones','room_types','rooms','rate_plans','pricing_rules','transaction_codes']
  loop
    execute format('drop policy if exists p_%s_admin on public.%I', t, t);
    execute format('create policy p_%s_admin on public.%I for all to authenticated using (property_id = public.fn_my_property() and public.fn_my_role() = ''admin'') with check (property_id = public.fn_my_property() and public.fn_my_role() = ''admin'')', t, t);
  end loop;
end $$;

-- tabel anak tanpa property_id
drop policy if exists p_night_rates_read on public.reservation_night_rates;
create policy p_night_rates_read on public.reservation_night_rates for select to authenticated
  using (exists (select 1 from public.reservations r where r.id = reservation_id and r.property_id = public.fn_my_property()));
drop policy if exists p_room_hist_read on public.room_status_history;
create policy p_room_hist_read on public.room_status_history for select to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id and r.property_id = public.fn_my_property()));

-- Ledger: tidak ada UPDATE/DELETE untuk aplikasi
revoke update, delete, truncate on public.folio_postings from anon, authenticated;
revoke all on public.audit_logs from anon;

-- ===== migrations/20261022000002-functions.sql =====
-- =====================================================================
-- SPS Hotel ERP - Fase 1 - Fungsi bisnis (RPC)
-- Semua fungsi tulis = SECURITY DEFINER + cek anggota/role di dalamnya.
-- Klien memanggil via supabase.rpc('nama_fungsi', {...}).
-- Kode error dikirim sebagai pesan exception: SOLD_OUT, ROOM_CONFLICT, dst.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Utilitas
-- ---------------------------------------------------------------------
create or replace function public.business_date(p_property uuid) returns date
language sql stable security definer set search_path = public as $$
  select business_date from public.properties where id = p_property
$$;

create or replace function public.fn_require(p_property uuid, p_roles text[] default null)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_prop uuid;
begin
  select role, property_id into v_role, v_prop from public.profiles where user_id = auth.uid();
  if v_prop is null or v_prop <> p_property then
    raise exception 'FORBIDDEN: bukan anggota property' using errcode = '42501';
  end if;
  if p_roles is not null and not (v_role = any(p_roles) or v_role = 'admin') then
    raise exception 'FORBIDDEN: role % tidak diizinkan', v_role using errcode = '42501';
  end if;
end $$;

create or replace function public.log_audit(p_property uuid, p_action text, p_entity text, p_id text, p_data jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs (property_id, actor, action, entity, entity_id, data)
  values (p_property, auth.uid(), p_action, p_entity, p_id, p_data)
$$;

-- ---------------------------------------------------------------------
-- 1. Profil otomatis saat user sign-up (user pertama = admin)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; v_has_admin boolean;
begin
  select id into v_prop from public.properties order by created_at limit 1;
  select exists (select 1 from public.profiles where role = 'admin') into v_has_admin;
  insert into public.profiles (user_id, property_id, email, full_name, role)
  values (new.id, v_prop, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          case when v_has_admin then 'viewer' else 'admin' end)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin mengatur role / zona / jadwal staf
create or replace function public.admin_set_profile(p_user uuid, p_role text, p_zone uuid,
  p_on_duty boolean, p_full_name text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property();
begin
  perform public.fn_require(v_prop, array['admin']);
  update public.profiles
     set role = p_role, zone_id = p_zone, on_duty = p_on_duty,
         full_name = coalesce(p_full_name, full_name)
   where user_id = p_user and property_id = v_prop;
  perform public.log_audit(v_prop, 'SET_PROFILE', 'profiles', p_user::text,
    jsonb_build_object('role', p_role, 'zone', p_zone, 'on_duty', p_on_duty));
end $$;

-- Staf HK mulai/akhiri shift sendiri
create or replace function public.set_my_duty(p_on_duty boolean) returns void
language sql security definer set search_path = public as $$
  update public.profiles set on_duty = p_on_duty where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------
-- 2. Inventori
-- ---------------------------------------------------------------------
-- Buat baris inventori yang belum ada untuk rentang [p_from, p_to)
create or replace function public.ensure_inventory(p_property uuid, p_room_type uuid, p_from date, p_to date)
returns void language sql security definer set search_path = public as $$
  insert into public.room_type_inventory (property_id, room_type_id, stay_date, total_rooms, out_of_order)
  select p_property, p_room_type, d::date,
         (select count(*) from public.rooms r where r.room_type_id = p_room_type and r.is_sellable),
         (select count(*) from public.room_assignments a join public.rooms r on r.id = a.room_id
           where r.room_type_id = p_room_type and a.is_active and a.kind in ('OOO','HOUSE_USE')
             and a.stay_range @> d::date)
    from generate_series(p_from, p_to - 1, interval '1 day') d
  on conflict do nothing
$$;

-- Total kamar ikut berubah bila master kamar berubah
create or replace function public.trg_rooms_inventory() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_type uuid;
begin
  for v_type in select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.room_type_id end,
      case when tg_op <> 'DELETE' then new.room_type_id end]) x where x is not null
  loop
    update public.room_type_inventory i
       set total_rooms = (select count(*) from public.rooms r where r.room_type_id = v_type and r.is_sellable),
           version = version + 1
     where i.room_type_id = v_type and i.stay_date >= current_date - 1;
  end loop;
  return null;
end $$;
drop trigger if exists rooms_inventory on public.rooms;
create trigger rooms_inventory after insert or delete or update of room_type_id, is_sellable on public.rooms
  for each row execute function public.trg_rooms_inventory();

-- Ubah sold/held untuk rentang malam, terkunci urut tanggal ASC (anti-deadlock)
create or replace function public.inv_adjust(p_property uuid, p_room_type uuid, p_from date, p_to date,
  p_d_sold int, p_d_held int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_to <= p_from then return; end if;
  perform 1 from public.room_type_inventory
   where property_id = p_property and room_type_id = p_room_type
     and stay_date >= p_from and stay_date < p_to
   order by stay_date for update;
  update public.room_type_inventory
     set sold = sold + p_d_sold, held = held + p_d_held, version = version + 1
   where property_id = p_property and room_type_id = p_room_type
     and stay_date >= p_from and stay_date < p_to;
end $$;

-- ---------------------------------------------------------------------
-- 3. Dynamic pricing (PRD Bab 5, versi rule-based MVP)
--    Price = CLAMP(BAR x rp x MIN(season x dow x event, cap) x demand, FLOOR, CEIL)
-- ---------------------------------------------------------------------
create or replace function public.demand_factor(p_occ numeric) returns numeric
language plpgsql immutable as $$
declare
  xs numeric[] := array[0.30, 0.40, 0.60, 0.75, 0.85, 0.92, 0.98];
  ys numeric[] := array[0.88, 0.95, 1.00, 1.10, 1.22, 1.38, 1.55];
  i int;
begin
  if p_occ <= xs[1] then return ys[1]; end if;
  if p_occ >= xs[7] then return ys[7]; end if;
  for i in 1..6 loop
    if p_occ <= xs[i+1] then
      return ys[i] + (ys[i+1] - ys[i]) * (p_occ - xs[i]) / (xs[i+1] - xs[i]);
    end if;
  end loop;
  return 1;
end $$;

create or replace function public.quote_price(p_room_type uuid, p_rate_plan uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  rt public.room_types; rp public.rate_plans; pr public.properties;
  f_season numeric := 1; f_dow numeric := 1; f_event numeric := 1; f_cal numeric;
  occ_rt numeric := 0; occ_prop numeric := 0; blend numeric; f_dem numeric := 1; f_lead numeric := 1;
  lead int; v_price numeric; v_ceil numeric; v_min_los smallint; v_event_name text;
begin
  select * into rt from public.room_types where id = p_room_type;
  select * into rp from public.rate_plans where id = p_rate_plan;
  select * into pr from public.properties where id = rt.property_id;
  if rt.id is null or rp.id is null then raise exception 'INVALID_RATE'; end if;

  lead := p_date - pr.business_date;

  if rp.is_dynamic then
    select multiplier into f_season from public.pricing_rules
     where property_id = rt.property_id and is_active and layer = 'SEASON'
       and p_date between date_from and date_to order by priority desc limit 1;
    select multiplier into f_dow from public.pricing_rules
     where property_id = rt.property_id and is_active and layer = 'DOW'
       and extract(isodow from p_date)::smallint = any(dow) order by priority desc limit 1;
    -- event lebih spesifik menggantikan holiday biasa (ambil prioritas tertinggi)
    select multiplier, name, min_los into f_event, v_event_name, v_min_los from public.pricing_rules
     where property_id = rt.property_id and is_active and layer in ('HOLIDAY','EVENT')
       and p_date between date_from and date_to
     order by (layer = 'EVENT') desc, priority desc limit 1;
    f_season := coalesce(f_season, 1); f_dow := coalesce(f_dow, 1); f_event := coalesce(f_event, 1);
    f_cal := least(f_season * f_dow * f_event, pr.calendar_cap);

    -- okupansi on-the-books (sold + hold aktif) tipe & property, bobot 60/40
    select coalesce((sold + held)::numeric / nullif(total_rooms - out_of_order, 0), 0)
      into occ_rt from public.room_type_inventory
     where room_type_id = p_room_type and stay_date = p_date;
    select coalesce(sum(sold + held)::numeric / nullif(sum(total_rooms - out_of_order), 0), 0)
      into occ_prop from public.room_type_inventory
     where property_id = rt.property_id and stay_date = p_date;
    blend := 0.6 * coalesce(occ_rt, 0) + 0.4 * coalesce(occ_prop, 0);

    f_dem := public.demand_factor(blend);
    -- Belum ada booking curve historis: diskon demand (<1) hanya untuk H-7 ke bawah
    -- (OTB rendah jauh hari bukan sinyal permintaan rendah). Lead > 60 hari dibatasi 1.10.
    if lead > 7 then f_dem := greatest(f_dem, 1.0); end if;
    if lead > 60 then f_dem := least(f_dem, 1.10); end if;
    if lead between 0 and 3 and blend < 0.5 then f_lead := 0.93;
    elsif lead between 0 and 3 and blend > 0.85 then f_lead := 1.10; end if;
  else
    f_cal := 1;
  end if;

  v_ceil := rt.base_rate * rt.ceil_multiplier;
  v_price := rt.base_rate * rp.rate_multiplier * f_cal * f_dem * f_lead;
  v_price := greatest(rt.floor_rate, least(v_price, v_ceil));
  v_price := round(v_price / 1000) * 1000;                  -- kelipatan Rp1.000

  return jsonb_build_object(
    'date', p_date, 'price', v_price, 'addon', rp.addon_per_night,
    'base', rt.base_rate, 'rate_plan', rp.rate_multiplier,
    'season', f_season, 'dow', f_dow, 'event', f_event, 'event_name', v_event_name,
    'calendar', round(f_cal, 3), 'occ', round(coalesce(blend, 0), 3),
    'demand', round(f_dem, 3), 'lead_mod', f_lead, 'lead_days', lead,
    'min_los', v_min_los, 'floor', rt.floor_rate, 'ceil', v_ceil, 'algo', 'rule-v1');
end $$;

-- Quote seluruh masa inap + ketersediaan
create or replace function public.quote_stay(p_room_type uuid, p_rate_plan uuid, p_check_in date, p_check_out date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop uuid; pr public.properties; d date; q jsonb; nights jsonb := '[]'::jsonb;
  v_net numeric := 0; v_svc numeric := 0; v_tax numeric := 0; n_net numeric; n_svc numeric;
  v_avail int; v_minlos int := 1;
begin
  select property_id into v_prop from public.room_types where id = p_room_type;
  perform public.fn_require(v_prop);
  select * into pr from public.properties where id = v_prop;
  if p_check_out <= p_check_in then raise exception 'INVALID_DATES'; end if;
  perform public.ensure_inventory(v_prop, p_room_type, p_check_in, p_check_out);

  select min(total_rooms - out_of_order + overbook_cap - sold - held) into v_avail
    from public.room_type_inventory
   where room_type_id = p_room_type and stay_date >= p_check_in and stay_date < p_check_out;

  d := p_check_in;
  while d < p_check_out loop
    q := public.quote_price(p_room_type, p_rate_plan, d);
    n_net := (q->>'price')::numeric + (q->>'addon')::numeric;
    n_svc := round(n_net * pr.service_rate, 0);
    v_net := v_net + n_net; v_svc := v_svc + n_svc;
    v_tax := v_tax + round((n_net + n_svc) * pr.tax_rate, 0);
    v_minlos := greatest(v_minlos, coalesce((q->>'min_los')::int, 1));
    nights := nights || q;
    d := d + 1;
  end loop;

  return jsonb_build_object('available', greatest(coalesce(v_avail, 0), 0), 'nights', nights,
    'net', v_net, 'service', v_svc, 'tax', v_tax, 'total', v_net + v_svc + v_tax,
    'min_los', v_minlos, 'los', p_check_out - p_check_in);
end $$;

-- Kalender harga N hari (untuk layar Revenue)
create or replace function public.rate_calendar(p_rate_plan uuid, p_from date, p_days int default 14)
returns table (room_type_id uuid, room_type text, stay_date date, price numeric, available int, detail jsonb)
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; r record; d date;
begin
  select property_id into v_prop from public.rate_plans where id = p_rate_plan;
  perform public.fn_require(v_prop);
  for r in select * from public.room_types where property_id = v_prop order by sort_order, code loop
    perform public.ensure_inventory(v_prop, r.id, p_from, p_from + p_days);
    for d in select g::date from generate_series(p_from, p_from + p_days - 1, interval '1 day') g loop
      room_type_id := r.id; room_type := r.name; stay_date := d;
      detail := public.quote_price(r.id, p_rate_plan, d);
      price := (detail->>'price')::numeric;
      select greatest(i.total_rooms - i.out_of_order + i.overbook_cap - i.sold - i.held, 0) into available
        from public.room_type_inventory i where i.room_type_id = r.id and i.stay_date = d;
      return next;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Reservasi: hold 15 menit -> confirm -> (expire)
-- ---------------------------------------------------------------------
create or replace function public.create_hold(
  p_room_type uuid, p_rate_plan uuid, p_check_in date, p_check_out date,
  p_guest_name text, p_guest_phone text default null, p_guest_email text default null,
  p_adults int default 1, p_channel text default 'DIRECT', p_requests text default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop uuid; pr public.properties; v_nights int; v_rows int; v_guest uuid; v_res public.reservations;
  q jsonb; d date; n_net numeric; n_svc numeric; n_tax numeric; v_total numeric := 0; v_minlos int := 1;
begin
  select property_id into v_prop from public.room_types where id = p_room_type;
  perform public.fn_require(v_prop, array['fo','cashier']);
  select * into pr from public.properties where id = v_prop;

  -- Idempotency: request ulang mengembalikan hasil pertama
  if p_idempotency_key is not null then
    select * into v_res from public.reservations where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('id', v_res.id, 'confirmation_no', v_res.confirmation_no,
        'status', v_res.status, 'expires_at', v_res.expires_at, 'total', v_res.total_amount, 'replayed', true);
    end if;
  end if;

  v_nights := p_check_out - p_check_in;
  if v_nights < 1 or v_nights > 30 then raise exception 'INVALID_DATES'; end if;
  if p_check_in < pr.business_date then raise exception 'CHECKIN_IN_PAST'; end if;
  if coalesce(trim(p_guest_name), '') = '' then raise exception 'GUEST_NAME_REQUIRED'; end if;

  perform public.ensure_inventory(v_prop, p_room_type, p_check_in, p_check_out);

  -- Kunci baris urut tanggal, lalu conditional update atomik (PRD 6.1)
  perform 1 from public.room_type_inventory
   where property_id = v_prop and room_type_id = p_room_type
     and stay_date >= p_check_in and stay_date < p_check_out
   order by stay_date for update;
  update public.room_type_inventory
     set held = held + 1, version = version + 1
   where property_id = v_prop and room_type_id = p_room_type
     and stay_date >= p_check_in and stay_date < p_check_out
     and sold + held + 1 <= total_rooms - out_of_order + overbook_cap;
  get diagnostics v_rows = row_count;
  if v_rows < v_nights then
    raise exception 'SOLD_OUT' using errcode = 'P0001';   -- seluruh transaksi di-rollback
  end if;

  -- Tamu: pakai yang ada bila no. HP sama
  if p_guest_phone is not null and p_guest_phone <> '' then
    select id into v_guest from public.guests where property_id = v_prop and phone = p_guest_phone limit 1;
  end if;
  if v_guest is null then
    insert into public.guests (property_id, full_name, phone, email)
    values (v_prop, trim(p_guest_name), nullif(p_guest_phone, ''), nullif(p_guest_email, ''))
    returning id into v_guest;
  end if;

  insert into public.reservations (property_id, confirmation_no, guest_id, room_type_id, rate_plan_id,
    adults, channel, status, check_in, check_out, expires_at, special_requests, idempotency_key, created_by)
  values (v_prop, pr.code || to_char(now() at time zone pr.timezone, 'YYMMDD') || '-' ||
            lpad(nextval('public.seq_confirmation')::text, 5, '0'),
          v_guest, p_room_type, p_rate_plan, p_adults, p_channel, 'PENDING_PAYMENT',
          p_check_in, p_check_out, now() + make_interval(mins => pr.hold_minutes),
          p_requests, p_idempotency_key, auth.uid())
  returning * into v_res;

  -- Snapshot harga per malam (immutable)
  d := p_check_in;
  while d < p_check_out loop
    q := public.quote_price(p_room_type, p_rate_plan, d);
    n_net := (q->>'price')::numeric;
    n_svc := round((n_net + (q->>'addon')::numeric) * pr.service_rate, 0);
    n_tax := round((n_net + (q->>'addon')::numeric + n_svc) * pr.tax_rate, 0);
    v_minlos := greatest(v_minlos, coalesce((q->>'min_los')::int, 1));
    insert into public.reservation_night_rates (reservation_id, stay_date, base_rate, adjustments,
      net_rate, addon_amount, service_amount, tax_amount, rate_source)
    values (v_res.id, d, (q->>'base')::numeric, q, n_net, (q->>'addon')::numeric, n_svc, n_tax, 'DYNAMIC');
    v_total := v_total + n_net + (q->>'addon')::numeric + n_svc + n_tax;
    d := d + 1;
  end loop;
  if v_nights < v_minlos then raise exception 'MIN_LOS_%', v_minlos; end if;

  update public.reservations set total_amount = v_total where id = v_res.id;
  perform public.log_audit(v_prop, 'HOLD', 'reservations', v_res.id::text,
    jsonb_build_object('room_type', p_room_type, 'check_in', p_check_in, 'check_out', p_check_out, 'total', v_total));

  return jsonb_build_object('id', v_res.id, 'confirmation_no', v_res.confirmation_no,
    'status', v_res.status, 'expires_at', v_res.expires_at, 'total', v_total, 'replayed', false);
end $$;

create or replace function public.ensure_folio(p_reservation uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; r public.reservations; pr public.properties;
begin
  select id into v_id from public.folios where reservation_id = p_reservation;
  if v_id is not null then return v_id; end if;
  select * into r from public.reservations where id = p_reservation;
  select * into pr from public.properties where id = r.property_id;
  insert into public.folios (property_id, folio_no, reservation_id, guest_id, opened_business_date)
  values (r.property_id, 'F' || pr.code || '-' || lpad(nextval('public.seq_folio')::text, 6, '0'),
          r.id, r.guest_id, pr.business_date)
  on conflict (reservation_id) do nothing
  returning id into v_id;
  if v_id is null then select id into v_id from public.folios where reservation_id = p_reservation; end if;
  return v_id;
end $$;

-- Konfirmasi (setelah bayar / garansi). Gagal bila hold sudah kedaluwarsa.
create or replace function public.confirm_reservation(p_reservation uuid, p_payment_method text default null,
  p_amount numeric default 0, p_payment_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.reservations; v_folio uuid;
begin
  select * into r from public.reservations where id = p_reservation;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(r.property_id, array['fo','cashier']);

  update public.reservations set status = 'CONFIRMED', expires_at = null, version = version + 1
   where id = p_reservation and status = 'PENDING_PAYMENT' and expires_at > now()
  returning * into r;
  if r.id is null then raise exception 'HOLD_EXPIRED_OR_INVALID'; end if;

  perform public.inv_adjust(r.property_id, r.room_type_id, r.check_in, r.check_out, 1, -1);
  v_folio := public.ensure_folio(r.id);
  if coalesce(p_amount, 0) > 0 then
    perform public.post_payment(v_folio, coalesce(p_payment_method, 'CASH'), p_amount,
      coalesce(p_payment_ref, 'Deposit'), 'DEP:' || r.id);
  end if;
  perform public.log_audit(r.property_id, 'CONFIRM', 'reservations', r.id::text,
    jsonb_build_object('method', p_payment_method, 'amount', p_amount));
  return jsonb_build_object('id', r.id, 'status', r.status, 'folio_id', v_folio);
end $$;

-- Sweeper kedaluwarsa (dipanggil pg_cron tiap menit + saat app dibuka). Idempotent.
create or replace function public.expire_holds() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from public.reservations
            where status = 'PENDING_PAYMENT' and expires_at <= now()
            order by expires_at limit 500 for update skip locked
  loop
    update public.reservations set status = 'EXPIRED', version = version + 1
     where id = r.id and status = 'PENDING_PAYMENT' and expires_at <= now();
    if found then
      perform public.inv_adjust(x.property_id, x.room_type_id, x.check_in, x.check_out, 0, -1)
        from public.reservations x where x.id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.extend_hold(p_reservation uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation;
  perform public.fn_require(r.property_id, array['fo','cashier']);
  update public.reservations
     set expires_at = expires_at + interval '5 minutes', version = version + 1
   where id = p_reservation and status = 'PENDING_PAYMENT' and expires_at > now()
     and expires_at < created_at + interval '20 minutes'       -- maks 1x perpanjangan
  returning * into r;
  if r.id is null then raise exception 'CANNOT_EXTEND'; end if;
  return r.expires_at;
end $$;

create or replace function public.cancel_reservation(p_reservation uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(r.property_id, array['fo']);
  if r.status = 'PENDING_PAYMENT' then
    perform public.inv_adjust(r.property_id, r.room_type_id, r.check_in, r.check_out, 0, -1);
  elsif r.status = 'CONFIRMED' then
    perform public.inv_adjust(r.property_id, r.room_type_id, r.check_in, r.check_out, -1, 0);
  else
    raise exception 'CANNOT_CANCEL_STATUS_%', r.status;
  end if;
  update public.room_assignments set is_active = false where reservation_id = r.id and is_active;
  update public.reservations set status = 'CANCELLED', cancelled_reason = p_reason,
         room_id = null, version = version + 1 where id = r.id;
  perform public.log_audit(r.property_id, 'CANCEL', 'reservations', r.id::text, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- 5. Penugasan nomor kamar (Model B)
-- ---------------------------------------------------------------------
create or replace function public.assign_room(p_reservation uuid, p_room uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.reservations; v_room uuid; v_type uuid;
begin
  select * into r from public.reservations where id = p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(r.property_id, array['fo']);
  if r.status not in ('CONFIRMED','IN_HOUSE') then raise exception 'INVALID_STATUS_%', r.status; end if;
  if r.status = 'IN_HOUSE' then raise exception 'USE_ROOM_MOVE'; end if;

  update public.room_assignments set is_active = false where reservation_id = r.id and is_active;

  if p_room is null then
    -- kamar kosong pada rentang; prioritaskan yang sudah READY, aman dari race (SKIP LOCKED)
    select rm.id into v_room from public.rooms rm
     where rm.room_type_id = r.room_type_id and rm.is_sellable and rm.hk_status <> 'OOO'
       and not exists (select 1 from public.room_assignments a
                        where a.room_id = rm.id and a.is_active
                          and a.stay_range && daterange(r.check_in, r.check_out, '[)'))
     order by (rm.hk_status = 'INSPECTED' and rm.fo_status = 'VACANT') desc, rm.floor, rm.number
     for update of rm skip locked limit 1;
    if v_room is null then raise exception 'NO_ROOM_AVAILABLE'; end if;
  else
    select room_type_id into v_type from public.rooms where id = p_room and property_id = r.property_id;
    if v_type is null then raise exception 'ROOM_NOT_FOUND'; end if;
    if v_type <> r.room_type_id then raise exception 'ROOM_TYPE_MISMATCH'; end if;
    v_room := p_room;
  end if;

  begin
    insert into public.room_assignments (property_id, room_id, reservation_id, stay_range, kind, created_by)
    values (r.property_id, v_room, r.id, daterange(r.check_in, r.check_out, '[)'), 'STAY', auth.uid());
  exception when exclusion_violation then
    raise exception 'ROOM_CONFLICT';
  end;
  update public.reservations set room_id = v_room, version = version + 1 where id = r.id;
  return v_room;
end $$;

-- ---------------------------------------------------------------------
-- 6. Folio (Posting Engine satu pintu)
-- ---------------------------------------------------------------------
create or replace function public.trg_posting_balance() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.folios set balance = balance + new.gross_amount where id = new.folio_id;
  return new;
end $$;
drop trigger if exists posting_balance on public.folio_postings;
create trigger posting_balance after insert on public.folio_postings
  for each row execute function public.trg_posting_balance();

create or replace function public.post_charge(p_folio uuid, p_txn_code text, p_description text,
  p_quantity numeric, p_unit_price numeric, p_idempotency_key text, p_source text default 'MANUAL')
returns uuid language plpgsql security definer set search_path = public as $$
declare f public.folios; tc public.transaction_codes; pr public.properties;
        v_net numeric; v_svc numeric := 0; v_tax numeric := 0; v_id uuid;
begin
  select * into f from public.folios where id = p_folio;
  if f.id is null then raise exception 'FOLIO_NOT_FOUND'; end if;
  perform public.fn_require(f.property_id, array['fo','cashier','finance','room_attendant','hk_supervisor']);
  if f.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  select * into tc from public.transaction_codes where property_id = f.property_id and code = p_txn_code and is_active;
  if tc.id is null then raise exception 'TXN_CODE_NOT_FOUND_%', p_txn_code; end if;
  if tc.grp in ('PAYMENT') then raise exception 'USE_POST_PAYMENT'; end if;
  if coalesce(p_quantity, 0) <= 0 or p_unit_price is null then raise exception 'INVALID_AMOUNT'; end if;
  select * into pr from public.properties where id = f.property_id;

  v_net := round(p_quantity * p_unit_price, 2);
  if tc.is_taxable then
    v_svc := round(v_net * pr.service_rate, 0);
    v_tax := round((v_net + v_svc) * pr.tax_rate, 0);
  end if;

  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module,
    description, quantity, unit_price, net_amount, service_amount, tax_amount, posted_by, idempotency_key)
  values (f.property_id, f.id, pr.business_date, tc.id, p_source, p_description, p_quantity, p_unit_price,
    v_net, v_svc, v_tax, auth.uid(), p_idempotency_key)
  on conflict (property_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.folio_postings where property_id = f.property_id and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;

-- Charge-to-room dari outlet (F&B, laundry, fasilitas) via nomor kamar
create or replace function public.post_charge_to_room(p_room_number text, p_txn_code text, p_description text,
  p_quantity numeric, p_unit_price numeric, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_folio uuid; v_prop uuid := public.fn_my_property();
begin
  select f.id into v_folio from public.reservations r
    join public.rooms rm on rm.id = r.room_id
    join public.folios f on f.reservation_id = r.id
   where r.property_id = v_prop and rm.number = p_room_number and r.status = 'IN_HOUSE' and f.status = 'OPEN'
   limit 1;
  if v_folio is null then raise exception 'NO_INHOUSE_GUEST_IN_ROOM'; end if;
  return public.post_charge(v_folio, p_txn_code, p_description, p_quantity, p_unit_price, p_idempotency_key, 'OUTLET');
end $$;

create or replace function public.post_payment(p_folio uuid, p_method text, p_amount numeric,
  p_reference text, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare f public.folios; tc public.transaction_codes; v_id uuid;
begin
  select * into f from public.folios where id = p_folio;
  if f.id is null then raise exception 'FOLIO_NOT_FOUND'; end if;
  perform public.fn_require(f.property_id, array['fo','cashier','finance']);
  if f.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  select * into tc from public.transaction_codes
   where property_id = f.property_id and code = 'PAY-' || upper(p_method) and grp = 'PAYMENT';
  if tc.id is null then raise exception 'PAYMENT_METHOD_NOT_FOUND_%', p_method; end if;

  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module,
    source_ref, description, quantity, unit_price, net_amount, posted_by, idempotency_key)
  values (f.property_id, f.id, public.business_date(f.property_id), tc.id, 'PAYMENT', p_reference,
    tc.name || coalesce(' - ' || nullif(p_reference, ''), ''), 1, -p_amount, -p_amount, auth.uid(), p_idempotency_key)
  on conflict (property_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.folio_postings where property_id = f.property_id and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;

-- Refund ke tamu (saldo kredit, mis. deposit lebih / early check-out)
create or replace function public.post_refund(p_folio uuid, p_method text, p_amount numeric,
  p_reason text, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare f public.folios; tc public.transaction_codes; v_id uuid;
begin
  select * into f from public.folios where id = p_folio for update;
  if f.id is null then raise exception 'FOLIO_NOT_FOUND'; end if;
  perform public.fn_require(f.property_id, array['fo','cashier','finance']);
  if f.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_amount > -f.balance then raise exception 'REFUND_EXCEEDS_CREDIT'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  select * into tc from public.transaction_codes
   where property_id = f.property_id and code = 'PAY-' || upper(p_method) and grp = 'PAYMENT';
  if tc.id is null then raise exception 'PAYMENT_METHOD_NOT_FOUND_%', p_method; end if;
  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module,
    source_ref, description, quantity, unit_price, net_amount, reason, posted_by, idempotency_key)
  values (f.property_id, f.id, public.business_date(f.property_id), tc.id, 'REFUND', p_reason,
    'Refund ' || tc.name, 1, p_amount, p_amount, p_reason, auth.uid(), p_idempotency_key)
  on conflict (property_id, idempotency_key) do nothing
  returning id into v_id;
  perform public.log_audit(f.property_id, 'REFUND', 'folios', f.id::text, jsonb_build_object('amount', p_amount, 'reason', p_reason));
  return v_id;
end $$;

-- Koreksi = reversal (posting baru bernilai negatif), bukan UPDATE/DELETE
create or replace function public.reverse_posting(p_posting uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare p public.folio_postings; f public.folios; v_id uuid;
begin
  select * into p from public.folio_postings where id = p_posting;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(p.property_id, array['finance','cashier','fo']);
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  if p.reverses_posting_id is not null then raise exception 'CANNOT_REVERSE_A_REVERSAL'; end if;
  select * into f from public.folios where id = p.folio_id;
  if f.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module,
    source_ref, description, quantity, unit_price, net_amount, service_amount, tax_amount,
    reverses_posting_id, reason, posted_by, idempotency_key)
  values (p.property_id, p.folio_id, public.business_date(p.property_id), p.txn_code_id, 'REVERSAL',
    p.id::text, 'VOID: ' || p.description, p.quantity, p.unit_price, -p.net_amount, -p.service_amount,
    -p.tax_amount, p.id, p_reason, auth.uid(), 'REV:' || p.id)
  returning id into v_id;
  perform public.log_audit(p.property_id, 'REVERSE', 'folio_postings', p.id::text,
    jsonb_build_object('reason', p_reason, 'gross', p.gross_amount));
  return v_id;
exception when unique_violation then
  raise exception 'ALREADY_REVERSED';
end $$;

-- Posting kamar satu malam (dipakai Night Audit & check-out). Idempotent per (reservasi, tanggal).
create or replace function public.post_room_night(p_reservation uuid, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations; n public.reservation_night_rates; v_folio uuid; v_room text;
        tc_room uuid; tc_bf uuid; pr public.properties; v_addon_svc numeric; v_addon_tax numeric;
begin
  select * into r from public.reservations where id = p_reservation;
  select * into n from public.reservation_night_rates
   where reservation_id = p_reservation and stay_date = p_date and superseded_at is null;
  if n.id is null then return; end if;
  select * into pr from public.properties where id = r.property_id;
  v_folio := public.ensure_folio(r.id);
  select number into v_room from public.rooms where id = r.room_id;
  select id into tc_room from public.transaction_codes where property_id = r.property_id and code = 'ROOM';
  select id into tc_bf   from public.transaction_codes where property_id = r.property_id and code = 'BF';

  -- pisahkan service/tax kamar vs add-on secara proporsional
  v_addon_svc := round(n.addon_amount * pr.service_rate, 0);
  v_addon_tax := round((n.addon_amount + v_addon_svc) * pr.tax_rate, 0);

  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module,
    source_ref, description, quantity, unit_price, net_amount, service_amount, tax_amount, posted_by, idempotency_key)
  values (r.property_id, v_folio, p_date, tc_room, 'ROOM', n.id::text,
    'Kamar ' || coalesce(v_room, '-') || ' malam ' || to_char(p_date, 'DD-Mon-YYYY'),
    1, n.net_rate, n.net_rate,
    n.service_amount - case when n.addon_amount > 0 then v_addon_svc else 0 end,
    n.tax_amount - case when n.addon_amount > 0 then v_addon_tax else 0 end,
    auth.uid(), 'ROOM:' || r.id || ':' || p_date)
  on conflict (property_id, idempotency_key) do nothing;

  if n.addon_amount > 0 and tc_bf is not null then
    insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module,
      source_ref, description, quantity, unit_price, net_amount, service_amount, tax_amount, posted_by, idempotency_key)
    values (r.property_id, v_folio, p_date, tc_bf, 'ROOM', n.id::text,
      'Breakfast ' || to_char(p_date, 'DD-Mon-YYYY'), 1, n.addon_amount, n.addon_amount,
      v_addon_svc, v_addon_tax, auth.uid(), 'BF:' || r.id || ':' || p_date)
    on conflict (property_id, idempotency_key) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. Front Desk: check-in / check-out / room move
-- ---------------------------------------------------------------------
create or replace function public.check_in(p_reservation uuid, p_room uuid default null,
  p_override_reason text default null, p_id_number text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.reservations; rm public.rooms; v_bd date; v_folio uuid;
begin
  select * into r from public.reservations where id = p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(r.property_id, array['fo']);
  if r.status <> 'CONFIRMED' then raise exception 'INVALID_STATUS_%', r.status; end if;
  v_bd := public.business_date(r.property_id);
  if r.check_in > v_bd then raise exception 'EARLY_ARRIVAL_DATE'; end if;

  if p_room is not null and p_room is distinct from r.room_id then
    perform public.assign_room(r.id, p_room);
  elsif r.room_id is null then
    perform public.assign_room(r.id, null);
  end if;
  select * into r from public.reservations where id = p_reservation;
  select * into rm from public.rooms where id = r.room_id for update;

  if rm.fo_status <> 'VACANT' then raise exception 'ROOM_OCCUPIED'; end if;
  if rm.hk_status <> 'INSPECTED' then
    if p_override_reason is null or public.fn_my_role() not in ('admin','hk_supervisor') then
      raise exception 'ROOM_NOT_READY_%', rm.hk_status;
    end if;
    perform public.log_audit(r.property_id, 'CHECKIN_OVERRIDE', 'rooms', rm.id::text,
      jsonb_build_object('hk_status', rm.hk_status, 'reason', p_override_reason));
  end if;

  update public.rooms set fo_status = 'OCCUPIED', version = version + 1, updated_at = now() where id = rm.id;
  update public.reservations set status = 'IN_HOUSE', checked_in_at = now(), version = version + 1 where id = r.id;
  if p_id_number is not null then update public.guests set id_number = p_id_number where id = r.guest_id; end if;
  v_folio := public.ensure_folio(r.id);
  perform public.log_audit(r.property_id, 'CHECKIN', 'reservations', r.id::text, jsonb_build_object('room', rm.number));
  return jsonb_build_object('room', rm.number, 'folio_id', v_folio);
end $$;

create or replace function public.check_out(p_reservation uuid, p_force_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.reservations; v_bd date; d date; v_folio uuid; v_bal numeric;
begin
  select * into r from public.reservations where id = p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(r.property_id, array['fo','cashier']);
  if r.status <> 'IN_HOUSE' then raise exception 'INVALID_STATUS_%', r.status; end if;
  v_bd := public.business_date(r.property_id);

  -- Night-audit-lite: posting malam yang belum ter-posting s/d malam sebelum business date
  d := r.check_in;
  while d < least(v_bd, r.check_out) loop
    perform public.post_room_night(r.id, d);
    d := d + 1;
  end loop;

  v_folio := public.ensure_folio(r.id);
  select balance into v_bal from public.folios where id = v_folio for update;
  if v_bal > 0 and (p_force_reason is null or public.fn_my_role() not in ('admin','finance')) then
    raise exception 'FOLIO_UNSETTLED_%', v_bal;
  end if;
  if v_bal < 0 and p_force_reason is null then
    raise exception 'FOLIO_CREDIT_%', -v_bal;          -- ada kelebihan bayar: refund dulu / konfirmasi
  end if;

  -- Early check-out: kembalikan inventori malam yang tidak terpakai
  if v_bd < r.check_out then
    perform public.inv_adjust(r.property_id, r.room_type_id, greatest(v_bd, r.check_in), r.check_out, -1, 0);
  end if;

  update public.folios set status = 'CLOSED', closed_at = now() where id = v_folio;
  update public.room_assignments set is_active = false where reservation_id = r.id and is_active;
  update public.reservations set status = 'CHECKED_OUT', checked_out_at = now(), version = version + 1 where id = r.id;
  -- kamar jadi DIRTY -> trigger membuat & menugaskan tugas HK
  update public.rooms set fo_status = 'VACANT', hk_status = 'DIRTY', version = version + 1, updated_at = now()
   where id = r.room_id;
  perform public.log_audit(r.property_id, 'CHECKOUT', 'reservations', r.id::text,
    jsonb_build_object('balance', v_bal, 'force', p_force_reason));
  return jsonb_build_object('folio_id', v_folio, 'balance', v_bal);
end $$;

create or replace function public.room_move(p_reservation uuid, p_new_room uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.reservations; v_bd date; v_type uuid; v_old uuid; nr public.rooms;
begin
  select * into r from public.reservations where id = p_reservation for update;
  perform public.fn_require(r.property_id, array['fo']);
  if r.status <> 'IN_HOUSE' then raise exception 'INVALID_STATUS_%', r.status; end if;
  select * into nr from public.rooms where id = p_new_room for update;
  if nr.room_type_id <> r.room_type_id then raise exception 'ROOM_TYPE_MISMATCH'; end if;
  if nr.fo_status <> 'VACANT' or nr.hk_status <> 'INSPECTED' then raise exception 'ROOM_NOT_READY'; end if;
  v_bd := public.business_date(r.property_id);
  v_old := r.room_id;
  update public.room_assignments set is_active = false where reservation_id = r.id and is_active;
  begin
    insert into public.room_assignments (property_id, room_id, reservation_id, stay_range, kind, reason, created_by)
    values (r.property_id, p_new_room, r.id, daterange(greatest(v_bd, r.check_in), r.check_out, '[)'),
            'STAY', p_reason, auth.uid());
  exception when exclusion_violation then raise exception 'ROOM_CONFLICT';
  end;
  update public.rooms set fo_status = 'OCCUPIED', version = version + 1 where id = p_new_room;
  update public.reservations set room_id = p_new_room, version = version + 1 where id = r.id;
  update public.rooms set fo_status = 'VACANT', hk_status = 'DIRTY', version = version + 1 where id = v_old;
  perform public.log_audit(r.property_id, 'ROOM_MOVE', 'reservations', r.id::text,
    jsonb_build_object('from', v_old, 'to', p_new_room, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- 8. Housekeeping: tugas otomatis + assignment adil per zona (PRD Bab 10)
-- ---------------------------------------------------------------------
create or replace function public.auto_assign_hk(p_task uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare t record; v_user uuid;
begin
  select k.id, k.property_id, k.est_minutes, k.business_date, rm.zone_id
    into t from public.hk_tasks k join public.rooms rm on rm.id = k.room_id
   where k.id = p_task and k.status = 'OPEN' for update of k;
  if t.id is null then return null; end if;
  perform pg_advisory_xact_lock(hashtext(t.property_id::text));

  with load as (
    select p.user_id, p.zone_id, p.max_minutes,
           coalesce(sum(k.est_minutes) filter (where k.status in ('ASSIGNED','IN_PROGRESS','DONE','INSPECTED','REWORK')), 0) as minutes_load,
           count(k.id) filter (where k.status in ('ASSIGNED','IN_PROGRESS','DONE','INSPECTED','REWORK')) as rooms_count,
           max(k.assigned_at) as last_assigned
      from public.profiles p
      left join public.hk_tasks k on k.assigned_to = p.user_id and k.business_date = t.business_date
     where p.property_id = t.property_id and p.role = 'room_attendant' and p.on_duty
     group by p.user_id, p.zone_id, p.max_minutes)
  select l.user_id into v_user
    from load l
    left join public.hk_zones zs on zs.id = l.zone_id
    left join public.hk_zones zt on zt.id = t.zone_id
   where l.minutes_load + t.est_minutes <= l.max_minutes
   order by abs(coalesce(zs.sort_order, 99) - coalesce(zt.sort_order, 0)),   -- zona sendiri dulu
            l.minutes_load, l.rooms_count, l.last_assigned nulls first,
            hashtext(l.user_id::text || p_task::text)
   limit 1;

  if v_user is not null then
    update public.hk_tasks set assigned_to = v_user, status = 'ASSIGNED', assigned_at = now()
     where id = p_task and status = 'OPEN';
  end if;
  return v_user;
end $$;

create or replace function public.create_hk_task(p_room uuid, p_type text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rm public.rooms; v_bd date; v_min int; v_prio smallint := 3; v_id uuid;
begin
  select * into rm from public.rooms where id = p_room;
  v_bd := public.business_date(rm.property_id);
  select standard_clean_minutes into v_min from public.room_types where id = rm.room_type_id;
  if p_type = 'STAYOVER' then v_min := greatest(10, v_min / 2); end if;
  if exists (select 1 from public.reservations x where x.room_id = rm.id and x.status = 'CONFIRMED' and x.check_in = v_bd) then
    v_prio := 1;
  end if;
  -- checkout clean menggantikan stayover yang belum dikerjakan (mis. early check-out)
  if p_type = 'CHECKOUT_CLEAN' then
    update public.hk_tasks set status = 'CANCELLED', notes = 'Diganti checkout clean'
     where room_id = rm.id and task_type = 'STAYOVER' and status in ('OPEN','ASSIGNED');
  end if;
  insert into public.hk_tasks (property_id, room_id, task_type, priority, est_minutes, status, business_date)
  values (rm.property_id, rm.id, p_type, v_prio, v_min, 'OPEN', v_bd)
  on conflict (room_id, task_type, business_date) where status in ('OPEN','ASSIGNED','IN_PROGRESS','REWORK') do nothing
  returning id into v_id;
  if v_id is not null then perform public.auto_assign_hk(v_id); end if;
  return v_id;
end $$;

create or replace function public.trg_room_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.hk_status is distinct from old.hk_status then
    insert into public.room_status_history (room_id, from_status, to_status, changed_by)
    values (new.id, old.hk_status, new.hk_status, auth.uid());
    if new.hk_status = 'DIRTY' then
      perform public.create_hk_task(new.id, 'CHECKOUT_CLEAN');
    end if;
  end if;
  return null;
end $$;
drop trigger if exists rooms_status on public.rooms;
create trigger rooms_status after update of hk_status on public.rooms
  for each row execute function public.trg_room_status();

-- Re-assign tugas yang masih OPEN (dipanggil saat staf mulai shift / tombol supervisor)
create or replace function public.hk_assign_open() returns int
language plpgsql security definer set search_path = public as $$
declare t record; n int := 0; v_prop uuid := public.fn_my_property();
begin
  perform public.fn_require(v_prop);
  for t in select id from public.hk_tasks where property_id = v_prop and status = 'OPEN'
            and business_date = public.business_date(v_prop) order by priority, created_at loop
    if public.auto_assign_hk(t.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function public.hk_reassign(p_task uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k public.hk_tasks;
begin
  select * into k from public.hk_tasks where id = p_task for update;
  perform public.fn_require(k.property_id, array['hk_supervisor']);
  if k.status not in ('OPEN','ASSIGNED','REWORK') then raise exception 'INVALID_STATUS_%', k.status; end if;
  update public.hk_tasks set assigned_to = p_user, assigned_at = now(),
         status = case when status = 'REWORK' then 'REWORK' else 'ASSIGNED' end where id = p_task;
  perform public.log_audit(k.property_id, 'HK_REASSIGN', 'hk_tasks', p_task::text, jsonb_build_object('to', p_user));
end $$;

create or replace function public.hk_start(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k public.hk_tasks;
begin
  select * into k from public.hk_tasks where id = p_task for update;
  if k.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(k.property_id, array['room_attendant','hk_supervisor']);
  if k.status not in ('OPEN','ASSIGNED','REWORK') then raise exception 'INVALID_STATUS_%', k.status; end if;
  if k.assigned_to is not null and k.assigned_to <> auth.uid() and public.fn_my_role() = 'room_attendant' then
    raise exception 'NOT_YOUR_TASK';
  end if;
  update public.hk_tasks set status = 'IN_PROGRESS', started_at = now(),
         assigned_to = coalesce(assigned_to, auth.uid()), assigned_at = coalesce(assigned_at, now())
   where id = p_task;
  update public.rooms set hk_status = 'CLEANING', version = version + 1, updated_at = now()
   where id = k.room_id and hk_status <> 'OOO';
end $$;

create or replace function public.hk_complete(p_task uuid, p_checklist jsonb default null, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare k public.hk_tasks;
begin
  select * into k from public.hk_tasks where id = p_task for update;
  if k.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(k.property_id, array['room_attendant','hk_supervisor']);
  if k.status <> 'IN_PROGRESS' then raise exception 'INVALID_STATUS_%', k.status; end if;
  update public.hk_tasks set status = 'DONE', finished_at = now(), checklist = p_checklist, notes = p_notes
   where id = p_task;
  update public.rooms set hk_status = 'CLEAN', version = version + 1, updated_at = now()
   where id = k.room_id and hk_status <> 'OOO';
end $$;

create or replace function public.hk_inspect(p_task uuid, p_result text, p_score int,
  p_checklist jsonb default null, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare k public.hk_tasks;
begin
  select * into k from public.hk_tasks where id = p_task for update;
  if k.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(k.property_id, array['hk_supervisor']);
  if k.status <> 'DONE' then raise exception 'INVALID_STATUS_%', k.status; end if;
  if p_result not in ('PASS','FAIL') then raise exception 'INVALID_RESULT'; end if;
  if p_result = 'FAIL' and coalesce(trim(p_notes), '') = '' then raise exception 'NOTES_REQUIRED_ON_FAIL'; end if;

  insert into public.hk_inspections (property_id, task_id, room_id, inspector, result, score, checklist, notes)
  values (k.property_id, k.id, k.room_id, auth.uid(), p_result, p_score, p_checklist, p_notes);

  if p_result = 'PASS' then
    update public.hk_tasks set status = 'INSPECTED' where id = k.id;
    update public.rooms set hk_status = 'INSPECTED', version = version + 1, updated_at = now() where id = k.room_id;
  else
    -- rework ke staf semula; status kamar kembali DIRTY (tugas aktif sudah ada -> trigger tidak duplikasi)
    update public.hk_tasks set status = 'REWORK', rework_count = rework_count + 1, priority = 1,
           notes = p_notes, started_at = null, finished_at = null where id = k.id;
    update public.rooms set hk_status = 'DIRTY', version = version + 1, updated_at = now() where id = k.room_id;
  end if;
end $$;

-- Blok kamar Out-of-Order (rentang tanggal). Mengurangi inventori jual.
create or replace function public.set_room_ooo(p_room uuid, p_from date, p_to date, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare rm public.rooms; v_id uuid;
begin
  select * into rm from public.rooms where id = p_room for update;
  perform public.fn_require(rm.property_id, array['hk_supervisor']);
  if p_to <= p_from then raise exception 'INVALID_DATES'; end if;
  perform public.ensure_inventory(rm.property_id, rm.room_type_id, p_from, p_to);
  begin
    insert into public.room_assignments (property_id, room_id, stay_range, kind, reason, created_by)
    values (rm.property_id, rm.id, daterange(p_from, p_to, '[)'), 'OOO', p_reason, auth.uid())
    returning id into v_id;
  exception when exclusion_violation then raise exception 'ROOM_HAS_BOOKING_IN_RANGE';
  end;
  update public.room_type_inventory set out_of_order = out_of_order + 1, version = version + 1
   where room_type_id = rm.room_type_id and stay_date >= p_from and stay_date < p_to;   -- CHECK kapasitas menjaga
  if p_from <= public.business_date(rm.property_id) then
    update public.rooms set hk_status = 'OOO', version = version + 1 where id = rm.id;
  end if;
  perform public.log_audit(rm.property_id, 'ROOM_OOO', 'rooms', rm.id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'reason', p_reason));
  return v_id;
exception when check_violation then
  raise exception 'CANNOT_OOO_INVENTORY_FULL';
end $$;

create or replace function public.release_room_ooo(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rm public.rooms; a record;
begin
  select * into rm from public.rooms where id = p_room for update;
  perform public.fn_require(rm.property_id, array['hk_supervisor']);
  for a in select * from public.room_assignments where room_id = p_room and kind = 'OOO' and is_active loop
    update public.room_type_inventory set out_of_order = greatest(out_of_order - 1, 0), version = version + 1
     where room_type_id = rm.room_type_id and stay_range_contains(a.stay_range, stay_date);
    update public.room_assignments set is_active = false where id = a.id;
  end loop;
  if rm.hk_status = 'OOO' then
    update public.rooms set hk_status = 'DIRTY', version = version + 1 where id = rm.id;
  end if;
end $$;

create or replace function public.stay_range_contains(r daterange, d date) returns boolean
language sql immutable as $$ select r @> d $$;

-- ---------------------------------------------------------------------
-- 9. Night Audit: posting kamar, no-show, stayover task, majukan business date
-- ---------------------------------------------------------------------
create or replace function public.night_audit() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_bd date; r record;
        n_posted int := 0; n_noshow int := 0; n_expired int; n_stay int := 0; v_res jsonb;
begin
  perform public.fn_require(v_prop, array['fo']);
  select business_date into v_bd from public.properties where id = v_prop for update;

  n_expired := public.expire_holds();

  for r in select id from public.reservations
            where property_id = v_prop and status = 'IN_HOUSE' and check_in <= v_bd and check_out > v_bd loop
    perform public.post_room_night(r.id, v_bd);
    n_posted := n_posted + 1;
  end loop;

  for r in select * from public.reservations
            where property_id = v_prop and status = 'CONFIRMED' and check_in <= v_bd loop
    perform public.inv_adjust(v_prop, r.room_type_id, r.check_in, r.check_out, -1, 0);
    update public.room_assignments set is_active = false where reservation_id = r.id and is_active;
    update public.reservations set status = 'NO_SHOW', version = version + 1 where id = r.id;
    n_noshow := n_noshow + 1;
  end loop;

  update public.properties set business_date = v_bd + 1 where id = v_prop;

  -- stayover clean untuk kamar terisi yang masih menginap besok
  for r in select x.room_id from public.reservations x
            where x.property_id = v_prop and x.status = 'IN_HOUSE' and x.check_out > v_bd + 1 and x.room_id is not null loop
    if public.create_hk_task(r.room_id, 'STAYOVER') is not null then n_stay := n_stay + 1; end if;
  end loop;

  v_res := jsonb_build_object('business_date_closed', v_bd, 'new_business_date', v_bd + 1,
    'room_nights_posted', n_posted, 'no_show', n_noshow, 'holds_expired', n_expired, 'stayover_tasks', n_stay);
  insert into public.night_audit_runs (property_id, business_date, run_by, result)
  values (v_prop, v_bd, auth.uid(), v_res);
  perform public.log_audit(v_prop, 'NIGHT_AUDIT', 'properties', v_prop::text, v_res);
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 10. Dasbor Front Desk (satu panggilan)
-- ---------------------------------------------------------------------
create or replace function public.fo_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_bd date; v jsonb;
begin
  perform public.fn_require(v_prop);
  v_bd := public.business_date(v_prop);
  select jsonb_build_object(
    'business_date', v_bd,
    'arrivals',       (select count(*) from reservations where property_id = v_prop and check_in = v_bd and status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')),
    'arrivals_done',  (select count(*) from reservations where property_id = v_prop and check_in = v_bd and status in ('IN_HOUSE','CHECKED_OUT')),
    'departures',     (select count(*) from reservations where property_id = v_prop and check_out = v_bd and status in ('IN_HOUSE','CHECKED_OUT')),
    'departures_done',(select count(*) from reservations where property_id = v_prop and check_out = v_bd and status = 'CHECKED_OUT'),
    'in_house',       (select count(*) from reservations where property_id = v_prop and status = 'IN_HOUSE'),
    'rooms_total',    (select count(*) from rooms where property_id = v_prop and is_sellable),
    'occupied',       (select count(*) from rooms where property_id = v_prop and fo_status = 'OCCUPIED'),
    'otb_tonight',    (select coalesce(sum(sold + held), 0) from room_type_inventory where property_id = v_prop and stay_date = v_bd),
    'ready',          (select count(*) from rooms where property_id = v_prop and fo_status = 'VACANT' and hk_status = 'INSPECTED'),
    'pending_inspection', (select count(*) from rooms where property_id = v_prop and hk_status = 'CLEAN'),
    'dirty',          (select count(*) from rooms where property_id = v_prop and hk_status in ('DIRTY','CLEANING')),
    'ooo',            (select count(*) from rooms where property_id = v_prop and hk_status = 'OOO'),
    'holds_active',   (select count(*) from reservations where property_id = v_prop and status = 'PENDING_PAYMENT' and expires_at > now()),
    'holds_expiring', (select count(*) from reservations where property_id = v_prop and status = 'PENDING_PAYMENT' and expires_at between now() and now() + interval '5 minutes'),
    'dirty_over_45',  (select count(*) from hk_tasks where property_id = v_prop and status in ('OPEN','ASSIGNED') and created_at < now() - interval '45 minutes'),
    'unassigned_tasks',(select count(*) from hk_tasks where property_id = v_prop and status = 'OPEN'),
    'adr_tonight',    (select round(avg(n.net_rate)) from reservation_night_rates n join reservations r on r.id = n.reservation_id
                        where r.property_id = v_prop and n.stay_date = v_bd and n.superseded_at is null and r.status in ('CONFIRMED','IN_HOUSE')),
    'room_rev_tonight',(select coalesce(sum(n.net_rate), 0) from reservation_night_rates n join reservations r on r.id = n.reservation_id
                        where r.property_id = v_prop and n.stay_date = v_bd and n.superseded_at is null and r.status in ('CONFIRMED','IN_HOUSE')),
    'unsettled_departures', (select count(*) from reservations r join folios f on f.reservation_id = r.id
                        where r.property_id = v_prop and r.status = 'IN_HOUSE' and r.check_out <= v_bd and f.balance > 0)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 11. Hak eksekusi: hanya user login. Fungsi internal tidak diekspos.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.ensure_inventory(uuid, uuid, date, date) from authenticated;
revoke execute on function public.inv_adjust(uuid, uuid, date, date, int, int) from authenticated;
revoke execute on function public.post_room_night(uuid, date) from authenticated;
revoke execute on function public.auto_assign_hk(uuid) from authenticated;
revoke execute on function public.create_hk_task(uuid, text) from authenticated;
revoke execute on function public.ensure_folio(uuid) from authenticated;
revoke execute on function public.log_audit(uuid, text, text, text, jsonb) from authenticated;

-- ---------------------------------------------------------------------
-- 12. Realtime + pg_cron (dibungkus agar tidak gagal bila belum aktif)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.rooms; exception when others then null; end;
    begin alter publication supabase_realtime add table public.hk_tasks; exception when others then null; end;
    begin alter publication supabase_realtime add table public.reservations; exception when others then null; end;
  end if;
end $$;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'sps-expire-holds';
  perform cron.schedule('sps-expire-holds', '* * * * *', 'select public.expire_holds()');
exception when others then
  raise notice 'pg_cron tidak tersedia: aktifkan di Database > Extensions lalu jalankan ulang blok ini. (%)', sqlerrm;
end $$;

-- ===== migrations/20261022000003-seed-demo.sql =====
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
