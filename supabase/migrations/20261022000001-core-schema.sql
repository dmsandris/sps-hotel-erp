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
