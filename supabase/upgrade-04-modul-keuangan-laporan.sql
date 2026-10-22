-- =====================================================================
-- SPS Hotel ERP - Upgrade 04: Modul Fase 2-3, Keuangan, Laporan
-- Jalankan SETELAH setup-lengkap.sql. Aman dijalankan ulang.
-- Prinsip: fungsi transaksi lama TIDAK diubah; fitur baru dipasang lewat
-- tabel + RPC baru + trigger pada folio_postings (routing, shift, GL, AR).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Kolom tambahan pada tabel lama (aditif)
-- ---------------------------------------------------------------------
alter table public.properties add column if not exists breakfast_price numeric(14,2) not null default 125000;
alter table public.properties add column if not exists phone text;
alter table public.properties add column if not exists email text;
alter table public.properties add column if not exists npwp text;

create table if not exists public.companies (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  name               text not null,
  npwp               text,
  address            text,
  contact_name       text,
  phone              text,
  email              text,
  credit_limit       numeric(14,2) not null default 0,
  payment_terms_days int not null default 30,
  negotiated_plan_id uuid references public.rate_plans(id),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);

alter table public.guests add column if not exists nationality text;
alter table public.guests add column if not exists birth_date date;
alter table public.guests add column if not exists address text;
alter table public.guests add column if not exists company_id uuid references public.companies(id);
alter table public.guests add column if not exists preferences text;
alter table public.guests add column if not exists tags text[] not null default '{}';
alter table public.guests add column if not exists marketing_consent boolean not null default false;

create table if not exists public.reservation_groups (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  code          text not null unique,
  name          text not null,
  company_id    uuid references public.companies(id),
  contact_name  text,
  phone         text,
  master_folio_id uuid,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
alter table public.reservations add column if not exists company_id uuid references public.companies(id);
alter table public.reservations add column if not exists group_id uuid references public.reservation_groups(id);

alter table public.folios add column if not exists type text not null default 'GUEST';
alter table public.folios add column if not exists name text;
alter table public.folios add column if not exists company_id uuid references public.companies(id);
do $$ begin
  alter table public.folios add constraint ck_folio_type check (type in ('GUEST','MASTER','EVENT','HOUSE'));
exception when duplicate_object then null; end $$;

alter table public.transaction_codes add column if not exists gl_account text;

-- ---------------------------------------------------------------------
-- 1. Keuangan: routing, shift kasir, city ledger (AR), GL
-- ---------------------------------------------------------------------
create table if not exists public.routing_rules (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  reservation_id  uuid not null references public.reservations(id) on delete cascade,
  to_folio_id     uuid not null references public.folios(id),
  grps            text[] not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (reservation_id, to_folio_id)
);

create table if not exists public.cashier_shifts (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  user_id           uuid not null references public.profiles(user_id),
  business_date     date not null,
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  opening_float     numeric(14,2) not null default 0,
  expected_cash     numeric(14,2),
  counted_cash      numeric(14,2),
  variance          numeric(14,2),
  summary           jsonb,
  notes             text,
  status            text not null default 'OPEN' check (status in ('OPEN','CLOSED'))
);
create unique index if not exists uq_shift_open on public.cashier_shifts (user_id) where status = 'OPEN';

alter table public.folio_postings add column if not exists shift_id uuid references public.cashier_shifts(id);
alter table public.folio_postings add column if not exists routed_from_folio_id uuid references public.folios(id);

create sequence if not exists public.seq_ar_invoice;
create table if not exists public.ar_invoices (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  invoice_no    text not null unique,
  company_id    uuid not null references public.companies(id),
  folio_id      uuid not null references public.folios(id),
  posting_id    uuid unique references public.folio_postings(id),
  amount        numeric(14,2) not null,
  paid_amount   numeric(14,2) not null default 0,
  issued_date   date not null,
  due_date      date not null,
  status        text not null default 'OPEN' check (status in ('OPEN','PARTIAL','PAID','VOID')),
  created_at    timestamptz not null default now()
);
create table if not exists public.ar_receipts (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  ar_invoice_id uuid not null references public.ar_invoices(id),
  amount        numeric(14,2) not null check (amount > 0),
  method        text not null,
  reference     text,
  received_date date not null,
  idempotency_key text unique,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create table if not exists public.gl_accounts (
  property_id  uuid not null references public.properties(id) on delete cascade,
  code         text not null,
  name         text not null,
  type         text not null check (type in ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  primary key (property_id, code)
);
create table if not exists public.journal_entries (
  id            bigserial primary key,
  property_id   uuid not null references public.properties(id) on delete cascade,
  business_date date not null,
  source        text not null,
  source_id     uuid,
  memo          text,
  created_at    timestamptz not null default now()
);
create index if not exists ix_je_date on public.journal_entries (property_id, business_date);
create table if not exists public.journal_lines (
  id            bigserial primary key,
  entry_id      bigint not null references public.journal_entries(id) on delete cascade,
  account_code  text not null,
  debit         numeric(16,2) not null default 0,
  credit        numeric(16,2) not null default 0,
  constraint ck_jl_side check ((debit = 0) <> (credit = 0) or (debit = 0 and credit = 0))
);
create index if not exists ix_jl_entry on public.journal_lines (entry_id);

-- ---------------------------------------------------------------------
-- 2. Modul: fasilitas, event/BEO, laundry, breakfast
-- ---------------------------------------------------------------------
create table if not exists public.facility_resources (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  code           text not null,
  name           text not null,
  kind           text not null check (kind in ('TENNIS','GYM','POOL','MEETING','SPA','OTHER')),
  mode           text not null check (mode in ('EXCLUSIVE','CAPACITY')),
  capacity       int not null default 1,
  open_time      time not null default '06:00',
  close_time     time not null default '22:00',
  slot_minutes   int not null default 60,
  buffer_minutes int not null default 0,
  rate_guest     numeric(14,2) not null default 0,     -- per jam (EXCLUSIVE) / per orang (CAPACITY)
  rate_public    numeric(14,2) not null default 0,
  txn_code       text not null,
  is_active      boolean not null default true,
  sort_order     int not null default 0,
  unique (property_id, code)
);

create sequence if not exists public.seq_event;
create table if not exists public.event_orders (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  event_no      text not null unique,
  name          text not null,
  company_id    uuid references public.companies(id),
  contact_name  text,
  phone         text,
  resource_id   uuid references public.facility_resources(id),
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  pax           int not null default 1,
  layout        text,
  status        text not null default 'TENTATIVE' check (status in ('INQUIRY','TENTATIVE','DEFINITE','COMPLETED','CANCELLED')),
  folio_id      uuid references public.folios(id),
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint ck_event_time check (end_at > start_at)
);

create table if not exists public.facility_bookings (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  resource_id   uuid not null references public.facility_resources(id) on delete cascade,
  time_range    tstzrange not null,
  exclusive     boolean not null default false,
  pax           int not null default 1,
  status        text not null default 'CONFIRMED' check (status in ('CONFIRMED','CHECKED_IN','CANCELLED','NO_SHOW')),
  guest_name    text not null,
  reservation_id uuid references public.reservations(id),
  event_id      uuid references public.event_orders(id) on delete cascade,
  amount        numeric(14,2) not null default 0,
  posting_id    uuid references public.folio_postings(id),
  paid_method   text,
  notes         text,
  idempotency_key text unique,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint no_facility_overlap exclude using gist (resource_id with =, time_range with &&)
    where (exclusive and status in ('CONFIRMED','CHECKED_IN'))
);
create index if not exists ix_fb_res_time on public.facility_bookings using gist (resource_id, time_range);

create table if not exists public.event_items (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.event_orders(id) on delete cascade,
  kind          text not null default 'FB' check (kind in ('ROOM','FB','EQUIPMENT','OTHER')),
  description   text not null,
  quantity      numeric(12,2) not null default 1,
  unit_price    numeric(14,2) not null default 0,
  txn_code      text not null,
  posting_id    uuid references public.folio_postings(id),
  created_at    timestamptz not null default now()
);

create sequence if not exists public.seq_laundry;
create table if not exists public.laundry_orders (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  order_no       text not null unique,
  reservation_id uuid not null references public.reservations(id),
  room_number    text not null,
  guest_name     text not null,
  service        text not null default 'REGULAR' check (service in ('REGULAR','EXPRESS')),
  status         text not null default 'RECEIVED' check (status in ('RECEIVED','PROCESSING','READY','DELIVERED','CANCELLED')),
  items          jsonb not null default '[]',
  total          numeric(14,2) not null default 0,
  notes          text,
  posting_id     uuid references public.folio_postings(id),
  received_at    timestamptz not null default now(),
  due_at         timestamptz,
  delivered_at   timestamptz,
  created_by     uuid
);

create table if not exists public.breakfast_redemptions (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  business_date  date not null,
  reservation_id uuid not null references public.reservations(id),
  room_number    text not null,
  pax            int not null check (pax > 0),
  charged        boolean not null default false,
  posting_id     uuid references public.folio_postings(id),
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists ix_bf_date on public.breakfast_redemptions (property_id, business_date);

-- ---------------------------------------------------------------------
-- 3. RLS tabel baru: baca anggota property; tulis via RPC
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['companies','reservation_groups','routing_rules','cashier_shifts','ar_invoices',
    'ar_receipts','gl_accounts','journal_entries','facility_resources','event_orders','facility_bookings',
    'laundry_orders','breakfast_redemptions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_%s_read on public.%I', t, t);
    execute format('create policy p_%s_read on public.%I for select to authenticated using (property_id = public.fn_my_property())', t, t);
  end loop;
  -- master fasilitas: admin boleh tulis langsung
  drop policy if exists p_facility_resources_admin on public.facility_resources;
  create policy p_facility_resources_admin on public.facility_resources for all to authenticated
    using (property_id = public.fn_my_property() and public.fn_my_role() = 'admin')
    with check (property_id = public.fn_my_property() and public.fn_my_role() = 'admin');
end $$;
alter table public.event_items enable row level security;
drop policy if exists p_event_items_read on public.event_items;
create policy p_event_items_read on public.event_items for select to authenticated
  using (exists (select 1 from public.event_orders e where e.id = event_id and e.property_id = public.fn_my_property()));
alter table public.journal_lines enable row level security;
drop policy if exists p_journal_lines_read on public.journal_lines;
create policy p_journal_lines_read on public.journal_lines for select to authenticated
  using (exists (select 1 from public.journal_entries e where e.id = entry_id and e.property_id = public.fn_my_property()));
revoke insert, update, delete on public.journal_entries, public.journal_lines, public.ar_invoices, public.ar_receipts
  from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Seed master: chart of accounts, kode transaksi baru, fasilitas
-- ---------------------------------------------------------------------
create or replace function public.seed_upgrade04(p_property uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.gl_accounts (property_id, code, name, type) values
    (p_property, '1100', 'Kas Front Office',            'ASSET'),
    (p_property, '1110', 'Bank - Settlement Kartu/EDC', 'ASSET'),
    (p_property, '1120', 'Bank - Clearing QRIS',        'ASSET'),
    (p_property, '1130', 'Bank - Transfer',             'ASSET'),
    (p_property, '1200', 'Guest Ledger (Piutang Tamu In-house)', 'ASSET'),
    (p_property, '1210', 'City Ledger (Piutang Perusahaan)',     'ASSET'),
    (p_property, '2100', 'Utang Pajak PBJT',            'LIABILITY'),
    (p_property, '2200', 'Utang Service Charge',        'LIABILITY'),
    (p_property, '4000', 'Pendapatan Kamar',            'REVENUE'),
    (p_property, '4100', 'Pendapatan F&B',              'REVENUE'),
    (p_property, '4150', 'Pendapatan Minibar',          'REVENUE'),
    (p_property, '4200', 'Pendapatan Laundry',          'REVENUE'),
    (p_property, '4300', 'Pendapatan Fasilitas',        'REVENUE'),
    (p_property, '4400', 'Pendapatan Meeting & Event',  'REVENUE'),
    (p_property, '4900', 'Pendapatan Lain / Denda',     'REVENUE'),
    (p_property, '4990', 'Penyesuaian / Allowance',     'REVENUE')
  on conflict do nothing;

  insert into public.transaction_codes (property_id, code, name, grp, is_taxable) values
    (p_property, 'FAC-POOL',   'Kolam Renang (non-tamu)', 'FACILITY', true),
    (p_property, 'FAC-RENT',   'Sewa Peralatan',          'FACILITY', true),
    (p_property, 'MEET-FB',    'Meeting - F&B / Paket',   'MEETING',  true),
    (p_property, 'MEET-EQUIP', 'Meeting - Peralatan',     'MEETING',  true)
  on conflict (property_id, code) do nothing;

  update public.transaction_codes set gl_account = case
      when code = 'PAY-CASH' then '1100' when code = 'PAY-CARD' then '1110' when code = 'PAY-QRIS' then '1120'
      when code = 'PAY-TRANSFER' then '1130' when code = 'PAY-CL' then '1210'
      when grp = 'ROOM' then '4000' when code = 'MINIBAR' or grp = 'MINIBAR' then '4150' when grp = 'FB' then '4100'
      when grp = 'LAUNDRY' then '4200' when grp = 'FACILITY' then '4300' when grp = 'MEETING' then '4400'
      when grp = 'ADJUSTMENT' then '4990' else '4900' end
   where property_id = p_property and gl_account is null;

  insert into public.facility_resources (property_id, code, name, kind, mode, capacity, open_time, close_time,
    slot_minutes, buffer_minutes, rate_guest, rate_public, txn_code, sort_order) values
    (p_property, 'TEN-1', 'Lapangan Tennis 1', 'TENNIS',  'EXCLUSIVE', 4,  '06:00', '22:00', 60, 0,  100000, 150000, 'FAC-TENNIS', 1),
    (p_property, 'TEN-2', 'Lapangan Tennis 2', 'TENNIS',  'EXCLUSIVE', 4,  '06:00', '22:00', 60, 0,  100000, 150000, 'FAC-TENNIS', 2),
    (p_property, 'GYM',   'Fitness Center',    'GYM',     'CAPACITY',  20, '05:00', '22:00', 60, 0,       0,  75000, 'FAC-GYM',    3),
    (p_property, 'POOL',  'Kolam Renang',      'POOL',    'CAPACITY',  40, '06:00', '20:00', 60, 0,       0,  75000, 'FAC-POOL',   4),
    (p_property, 'MR-A',  'Meeting Room Anggrek (30 pax)', 'MEETING', 'EXCLUSIVE', 30, '07:00', '23:00', 60, 30, 350000, 350000, 'MEET-ROOM', 5),
    (p_property, 'BALL',  'Ballroom Melati (200 pax)',     'MEETING', 'EXCLUSIVE', 200,'07:00', '23:59', 60, 60, 2500000, 2500000, 'MEET-ROOM', 6)
  on conflict (property_id, code) do nothing;
end $$;
do $$ declare p record; begin
  for p in select id from public.properties loop perform public.seed_upgrade04(p.id); end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. Trigger posting: routing -> shift -> validasi City Ledger (BEFORE)
--                     GL jurnal + invoice AR (AFTER)
-- ---------------------------------------------------------------------
create or replace function public.trg_posting_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare tc public.transaction_codes; f public.folios; v_to uuid; v_company uuid;
begin
  select * into tc from public.transaction_codes where id = new.txn_code_id;
  -- routing charge (bukan pembayaran/koreksi) ke master folio
  if tc.grp not in ('PAYMENT') and new.source_module not in ('REVERSAL','TRANSFER','REFUND') then
    select rr.to_folio_id into v_to
      from public.folios src join public.routing_rules rr on rr.reservation_id = src.reservation_id
      join public.folios dst on dst.id = rr.to_folio_id and dst.status = 'OPEN'
     where src.id = new.folio_id and tc.grp = any(rr.grps) and rr.to_folio_id <> new.folio_id
     order by rr.created_at limit 1;
    if v_to is not null then
      new.routed_from_folio_id := new.folio_id;
      new.folio_id := v_to;
    end if;
  end if;
  -- shift kasir aktif milik user
  if new.shift_id is null and auth.uid() is not null then
    select id into new.shift_id from public.cashier_shifts where user_id = auth.uid() and status = 'OPEN';
  end if;
  -- City Ledger wajib punya perusahaan
  if tc.code = 'PAY-CL' and new.net_amount < 0 then
    select * into f from public.folios where id = new.folio_id;
    v_company := f.company_id;
    if v_company is null then
      select coalesce(r.company_id, g.company_id) into v_company
        from public.reservations r left join public.reservation_groups g on g.id = r.group_id
       where r.id = f.reservation_id;
    end if;
    if v_company is null then raise exception 'CL_REQUIRES_COMPANY'; end if;
  end if;
  return new;
end $$;
drop trigger if exists posting_before on public.folio_postings;
create trigger posting_before before insert on public.folio_postings
  for each row execute function public.trg_posting_before();

create or replace function public.gl_post(p_property uuid, p_date date, p_source text, p_source_id uuid,
  p_memo text, p_lines jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; l jsonb; d numeric := 0; c numeric := 0;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    d := d + coalesce((l->>'d')::numeric, 0); c := c + coalesce((l->>'c')::numeric, 0);
  end loop;
  if round(d, 2) <> round(c, 2) then raise exception 'GL_UNBALANCED % <> %', d, c; end if;
  if d = 0 then return null; end if;
  insert into public.journal_entries (property_id, business_date, source, source_id, memo)
  values (p_property, p_date, p_source, p_source_id, p_memo) returning id into v_id;
  insert into public.journal_lines (entry_id, account_code, debit, credit)
  select v_id, x->>'a', coalesce((x->>'d')::numeric, 0), coalesce((x->>'c')::numeric, 0)
    from jsonb_array_elements(p_lines) x
   where coalesce((x->>'d')::numeric, 0) <> 0 or coalesce((x->>'c')::numeric, 0) <> 0;
  return v_id;
end $$;

create or replace function public.trg_posting_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare tc public.transaction_codes; f public.folios; v_company uuid; v_terms int; s int;
        amt numeric; lines jsonb; v_rev text; pr public.properties; orig public.folio_postings;
begin
  select * into tc from public.transaction_codes where id = new.txn_code_id;
  select * into pr from public.properties where id = new.property_id;
  v_rev := coalesce(tc.gl_account, '4900');

  if tc.grp = 'PAYMENT' then
    -- pembayaran: net negatif = uang masuk. Dr kas/bank/AR, Cr Guest Ledger (dibalik bila refund/void)
    amt := -new.net_amount;
    if amt >= 0 then
      lines := jsonb_build_array(jsonb_build_object('a', v_rev, 'd', amt), jsonb_build_object('a', '1200', 'c', amt));
    else
      lines := jsonb_build_array(jsonb_build_object('a', '1200', 'd', -amt), jsonb_build_object('a', v_rev, 'c', -amt));
    end if;
  else
    -- charge: Dr Guest Ledger gross, Cr pendapatan/service/pajak (dibalik bila negatif)
    s := case when new.gross_amount >= 0 then 1 else -1 end;
    lines := jsonb_build_array(
      jsonb_build_object('a', '1200', case when s = 1 then 'd' else 'c' end, abs(new.gross_amount)),
      jsonb_build_object('a', v_rev,  case when s = 1 then 'c' else 'd' end, abs(new.net_amount)),
      jsonb_build_object('a', '2200', case when s = 1 then 'c' else 'd' end, abs(new.service_amount)),
      jsonb_build_object('a', '2100', case when s = 1 then 'c' else 'd' end, abs(new.tax_amount)));
  end if;
  perform public.gl_post(new.property_id, new.business_date, 'FOLIO', new.id, tc.code || ' ' || new.description, lines);

  -- City Ledger: invoice AR saat pembayaran CL; void bila CL di-reversal
  if tc.code = 'PAY-CL' then
    if new.net_amount < 0 then
      select * into f from public.folios where id = new.folio_id;
      v_company := f.company_id;
      if v_company is null then
        select coalesce(r.company_id, g.company_id) into v_company
          from public.reservations r left join public.reservation_groups g on g.id = r.group_id where r.id = f.reservation_id;
      end if;
      select payment_terms_days into v_terms from public.companies where id = v_company;
      insert into public.ar_invoices (property_id, invoice_no, company_id, folio_id, posting_id, amount, issued_date, due_date)
      values (new.property_id, 'AR' || pr.code || '-' || to_char(new.business_date, 'YYMM') || '-' || lpad(nextval('public.seq_ar_invoice')::text, 4, '0'),
              v_company, new.folio_id, new.id, -new.net_amount, new.business_date, new.business_date + coalesce(v_terms, 30));
    elsif new.reverses_posting_id is not null then
      update public.ar_invoices set status = 'VOID' where posting_id = new.reverses_posting_id and paid_amount = 0;
      if not found and exists (select 1 from public.ar_invoices where posting_id = new.reverses_posting_id) then
        raise exception 'AR_ALREADY_PAID';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists posting_after on public.folio_postings;
create trigger posting_after after insert on public.folio_postings
  for each row execute function public.trg_posting_after();

-- Jurnal untuk posting lama (sebelum upgrade) agar neraca saldo utuh
do $$ declare p record; tc public.transaction_codes; amt numeric; s int; lines jsonb; v_rev text;
begin
  for p in select fp.* from public.folio_postings fp
            where not exists (select 1 from public.journal_entries je where je.source = 'FOLIO' and je.source_id = fp.id) loop
    select * into tc from public.transaction_codes where id = p.txn_code_id;
    v_rev := coalesce(tc.gl_account, '4900');
    if tc.grp = 'PAYMENT' then
      amt := -p.net_amount;
      lines := case when amt >= 0 then jsonb_build_array(jsonb_build_object('a', v_rev, 'd', amt), jsonb_build_object('a', '1200', 'c', amt))
                    else jsonb_build_array(jsonb_build_object('a', '1200', 'd', -amt), jsonb_build_object('a', v_rev, 'c', -amt)) end;
    else
      s := case when p.gross_amount >= 0 then 1 else -1 end;
      lines := jsonb_build_array(
        jsonb_build_object('a', '1200', case when s = 1 then 'd' else 'c' end, abs(p.gross_amount)),
        jsonb_build_object('a', v_rev,  case when s = 1 then 'c' else 'd' end, abs(p.net_amount)),
        jsonb_build_object('a', '2200', case when s = 1 then 'c' else 'd' end, abs(p.service_amount)),
        jsonb_build_object('a', '2100', case when s = 1 then 'c' else 'd' end, abs(p.tax_amount)));
    end if;
    perform public.gl_post(p.property_id, p.business_date, 'FOLIO', p.id, tc.code || ' ' || p.description, lines);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. RPC Keuangan
-- ---------------------------------------------------------------------
create or replace function public.upsert_company(p_id uuid, p_data jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_id uuid := p_id;
begin
  perform public.fn_require(v_prop, array['fo','finance']);
  if coalesce(trim(p_data->>'name'), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  if v_id is null then
    insert into public.companies (property_id, name) values (v_prop, p_data->>'name') returning id into v_id;
  end if;
  update public.companies set
    name = p_data->>'name', npwp = nullif(p_data->>'npwp', ''), address = nullif(p_data->>'address', ''),
    contact_name = nullif(p_data->>'contact_name', ''), phone = nullif(p_data->>'phone', ''), email = nullif(p_data->>'email', ''),
    credit_limit = coalesce(nullif(p_data->>'credit_limit', '')::numeric, 0),
    payment_terms_days = coalesce(nullif(p_data->>'payment_terms_days', '')::int, 30),
    is_active = coalesce((p_data->>'is_active')::boolean, true)
  where id = v_id and property_id = v_prop;
  perform public.log_audit(v_prop, 'UPSERT_COMPANY', 'companies', v_id::text, p_data);
  return v_id;
end $$;

create or replace function public.create_folio(p_type text, p_name text, p_company uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); pr public.properties; v_id uuid;
begin
  perform public.fn_require(v_prop, array['fo','cashier','finance']);
  if p_type not in ('MASTER','EVENT','HOUSE') then raise exception 'INVALID_FOLIO_TYPE'; end if;
  select * into pr from public.properties where id = v_prop;
  insert into public.folios (property_id, folio_no, type, name, company_id, opened_business_date)
  values (v_prop, 'F' || pr.code || '-' || lpad(nextval('public.seq_folio')::text, 6, '0'), p_type,
          coalesce(nullif(p_name, ''), p_type), p_company, pr.business_date)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.house_folio() returns uuid
language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_bd date; v_id uuid; pr public.properties;
begin
  select * into pr from public.properties where id = v_prop;
  v_bd := pr.business_date;
  select id into v_id from public.folios where property_id = v_prop and type = 'HOUSE' and status = 'OPEN'
     and opened_business_date = v_bd limit 1;
  if v_id is null then
    insert into public.folios (property_id, folio_no, type, name, opened_business_date)
    values (v_prop, 'F' || pr.code || '-' || lpad(nextval('public.seq_folio')::text, 6, '0'), 'HOUSE',
            'Penjualan langsung ' || to_char(v_bd, 'DD-MM-YYYY'), v_bd)
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Penjualan tunai non-tamu (outlet/fasilitas): charge + bayar ke folio HOUSE harian
create or replace function public.outlet_cash_sale(p_txn_code text, p_description text, p_quantity numeric,
  p_unit_price numeric, p_method text, p_reference text, p_idempotency_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_f uuid; v_post uuid; v_gross numeric;
begin
  v_f := public.house_folio();
  v_post := public.post_charge(v_f, p_txn_code, p_description, p_quantity, p_unit_price, 'SALE:' || p_idempotency_key, 'OUTLET');
  select gross_amount into v_gross from public.folio_postings where id = v_post;
  perform public.post_payment(v_f, p_method, v_gross, coalesce(p_reference, p_description), 'SALEPAY:' || p_idempotency_key);
  return v_post;
end $$;

create or replace function public.set_routing(p_reservation uuid, p_to_folio uuid, p_grps text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.reservations; f public.folios; v_id uuid;
begin
  select * into r from public.reservations where id = p_reservation;
  perform public.fn_require(r.property_id, array['fo','finance']);
  select * into f from public.folios where id = p_to_folio and property_id = r.property_id;
  if f.id is null or f.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  if f.reservation_id = r.id then raise exception 'CANNOT_ROUTE_TO_SELF'; end if;
  insert into public.routing_rules (property_id, reservation_id, to_folio_id, grps, created_by)
  values (r.property_id, r.id, p_to_folio, p_grps, auth.uid())
  on conflict (reservation_id, to_folio_id) do update set grps = excluded.grps
  returning id into v_id;
  perform public.log_audit(r.property_id, 'SET_ROUTING', 'reservations', r.id::text, jsonb_build_object('to', p_to_folio, 'grps', p_grps));
  return v_id;
end $$;

create or replace function public.remove_routing(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from public.routing_rules where id = p_id;
  perform public.fn_require(v_prop, array['fo','finance']);
  delete from public.routing_rules where id = p_id;
end $$;

-- Pindah posting antar folio = reversal di asal + posting baru di tujuan
create or replace function public.transfer_posting(p_posting uuid, p_to_folio uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare p public.folio_postings; t public.folios; s public.folios; v_id uuid;
begin
  select * into p from public.folio_postings where id = p_posting;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(p.property_id, array['fo','cashier','finance']);
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  select * into s from public.folios where id = p.folio_id;
  select * into t from public.folios where id = p_to_folio and property_id = p.property_id;
  if s.status <> 'OPEN' or t.id is null or t.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  if t.id = s.id then raise exception 'SAME_FOLIO'; end if;
  if p.reverses_posting_id is not null or exists (select 1 from public.folio_postings x where x.reverses_posting_id = p.id) then
    raise exception 'ALREADY_REVERSED';
  end if;
  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module, source_ref,
    description, quantity, unit_price, net_amount, service_amount, tax_amount, reverses_posting_id, reason, posted_by, idempotency_key)
  values (p.property_id, p.folio_id, public.business_date(p.property_id), p.txn_code_id, 'TRANSFER', p.id::text,
    'Pindah ke ' || t.folio_no || ': ' || p.description, p.quantity, p.unit_price, -p.net_amount, -p.service_amount, -p.tax_amount,
    p.id, p_reason, auth.uid(), 'TRFOUT:' || p.id);
  insert into public.folio_postings (property_id, folio_id, business_date, txn_code_id, source_module, source_ref,
    description, quantity, unit_price, net_amount, service_amount, tax_amount, reason, posted_by, idempotency_key)
  values (p.property_id, t.id, public.business_date(p.property_id), p.txn_code_id, 'TRANSFER', p.id::text,
    p.description || ' (dari ' || s.folio_no || ')', p.quantity, p.unit_price, p.net_amount, p.service_amount, p.tax_amount,
    p_reason, auth.uid(), 'TRFIN:' || p.id)
  returning id into v_id;
  perform public.log_audit(p.property_id, 'TRANSFER_POSTING', 'folio_postings', p.id::text,
    jsonb_build_object('from', s.folio_no, 'to', t.folio_no, 'reason', p_reason));
  return v_id;
end $$;

-- Tutup folio non-tamu (master/event/house) bila saldo nol
create or replace function public.settle_folio(p_folio uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f public.folios;
begin
  select * into f from public.folios where id = p_folio for update;
  perform public.fn_require(f.property_id, array['fo','cashier','finance']);
  if f.type = 'GUEST' and f.reservation_id is not null then raise exception 'USE_CHECKOUT'; end if;
  if f.status <> 'OPEN' then raise exception 'FOLIO_CLOSED'; end if;
  if f.balance <> 0 then raise exception 'FOLIO_UNSETTLED_%', f.balance; end if;
  update public.folios set status = 'CLOSED', closed_at = now() where id = f.id;
end $$;

create or replace function public.ar_receive(p_invoice uuid, p_amount numeric, p_method text, p_reference text,
  p_idempotency_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare i public.ar_invoices; v_id uuid; v_acct text; v_bd date;
begin
  select * into i from public.ar_invoices where id = p_invoice for update;
  if i.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(i.property_id, array['finance']);
  if i.status in ('PAID','VOID') then raise exception 'AR_CLOSED'; end if;
  if coalesce(p_amount, 0) <= 0 or p_amount > i.amount - i.paid_amount then raise exception 'INVALID_AMOUNT'; end if;
  select gl_account into v_acct from public.transaction_codes where property_id = i.property_id and code = 'PAY-' || upper(p_method);
  if v_acct is null or v_acct = '1210' then raise exception 'PAYMENT_METHOD_NOT_FOUND_%', p_method; end if;
  v_bd := public.business_date(i.property_id);
  insert into public.ar_receipts (property_id, ar_invoice_id, amount, method, reference, received_date, idempotency_key, created_by)
  values (i.property_id, i.id, p_amount, upper(p_method), p_reference, v_bd, p_idempotency_key, auth.uid())
  on conflict (idempotency_key) do nothing returning id into v_id;
  if v_id is null then return null; end if;
  update public.ar_invoices set paid_amount = paid_amount + p_amount,
         status = case when paid_amount + p_amount >= amount then 'PAID' else 'PARTIAL' end where id = i.id;
  perform public.gl_post(i.property_id, v_bd, 'AR', v_id, 'Pelunasan ' || i.invoice_no,
    jsonb_build_array(jsonb_build_object('a', v_acct, 'd', p_amount), jsonb_build_object('a', '1210', 'c', p_amount)));
  perform public.log_audit(i.property_id, 'AR_RECEIVE', 'ar_invoices', i.id::text, jsonb_build_object('amount', p_amount, 'method', p_method));
  return v_id;
end $$;

create or replace function public.open_shift(p_float numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_id uuid;
begin
  perform public.fn_require(v_prop, array['fo','cashier','finance']);
  insert into public.cashier_shifts (property_id, user_id, business_date, opening_float)
  values (v_prop, auth.uid(), public.business_date(v_prop), coalesce(p_float, 0)) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'SHIFT_ALREADY_OPEN';
end $$;

create or replace function public.shift_summary(p_shift uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payments', coalesce((select jsonb_object_agg(code, amt) from (
        select tc.code, sum(-fp.net_amount) amt from public.folio_postings fp join public.transaction_codes tc on tc.id = fp.txn_code_id
         where fp.shift_id = p_shift and tc.grp = 'PAYMENT' group by tc.code) x), '{}'::jsonb),
    'charges', coalesce((select sum(fp.gross_amount) from public.folio_postings fp join public.transaction_codes tc on tc.id = fp.txn_code_id
         where fp.shift_id = p_shift and tc.grp <> 'PAYMENT'), 0),
    'voids', (select count(*) from public.folio_postings fp where fp.shift_id = p_shift and fp.source_module = 'REVERSAL'),
    'cash_in', coalesce((select sum(-fp.net_amount) from public.folio_postings fp join public.transaction_codes tc on tc.id = fp.txn_code_id
         where fp.shift_id = p_shift and tc.code = 'PAY-CASH'), 0),
    'postings', (select count(*) from public.folio_postings fp where fp.shift_id = p_shift))
$$;

create or replace function public.close_shift(p_counted numeric, p_notes text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.cashier_shifts; v_sum jsonb; v_exp numeric;
begin
  select * into s from public.cashier_shifts where user_id = auth.uid() and status = 'OPEN' for update;
  if s.id is null then raise exception 'NO_OPEN_SHIFT'; end if;
  v_sum := public.shift_summary(s.id);
  v_exp := s.opening_float + (v_sum->>'cash_in')::numeric;
  update public.cashier_shifts set status = 'CLOSED', closed_at = now(), expected_cash = v_exp,
         counted_cash = p_counted, variance = coalesce(p_counted, 0) - v_exp, summary = v_sum, notes = p_notes
   where id = s.id;
  perform public.log_audit(s.property_id, 'CLOSE_SHIFT', 'cashier_shifts', s.id::text,
    v_sum || jsonb_build_object('expected', v_exp, 'counted', p_counted));
  return v_sum || jsonb_build_object('expected_cash', v_exp, 'counted_cash', p_counted, 'variance', coalesce(p_counted, 0) - v_exp);
end $$;

-- ---------------------------------------------------------------------
-- 7. RPC Grup & CRM
-- ---------------------------------------------------------------------
create or replace function public.create_group_booking(p_name text, p_company uuid, p_contact text, p_phone text,
  p_room_type uuid, p_rate_plan uuid, p_check_in date, p_check_out date, p_rooms int, p_adults int,
  p_channel text, p_master_folio boolean, p_route_grps text[], p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prop uuid; pr public.properties; v_gid uuid; h jsonb; ids uuid[] := '{}'; v_total numeric := 0;
        v_folio uuid; v_exp timestamptz; i int;
begin
  select property_id into v_prop from public.room_types where id = p_room_type;
  perform public.fn_require(v_prop, array['fo']);
  if coalesce(p_rooms, 0) < 1 or p_rooms > 100 then raise exception 'INVALID_ROOM_COUNT'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  select id into v_gid from public.reservation_groups where code = p_idempotency_key;
  if v_gid is not null then
    return jsonb_build_object('group_id', v_gid, 'replayed', true);
  end if;
  select * into pr from public.properties where id = v_prop;
  insert into public.reservation_groups (property_id, code, name, company_id, contact_name, phone, created_by)
  values (v_prop, p_idempotency_key, p_name, p_company, p_contact, p_phone, auth.uid()) returning id into v_gid;

  for i in 1..p_rooms loop
    h := public.create_hold(p_room_type, p_rate_plan, p_check_in, p_check_out,
           p_name || ' - Kamar ' || i, null, null, coalesce(p_adults, 2), coalesce(p_channel, 'CORPORATE'),
           'Grup ' || p_name, p_idempotency_key || ':' || i);
    ids := ids || (h->>'id')::uuid;
    v_total := v_total + (h->>'total')::numeric;
    v_exp := (h->>'expires_at')::timestamptz;
  end loop;
  update public.reservations set group_id = v_gid, company_id = p_company where id = any(ids);

  if p_master_folio then
    insert into public.folios (property_id, folio_no, type, name, company_id, opened_business_date)
    values (v_prop, 'F' || pr.code || '-' || lpad(nextval('public.seq_folio')::text, 6, '0'), 'MASTER',
            'Master ' || p_name, p_company, pr.business_date) returning id into v_folio;
    update public.reservation_groups set master_folio_id = v_folio where id = v_gid;
  end if;
  perform public.log_audit(v_prop, 'GROUP_HOLD', 'reservation_groups', v_gid::text,
    jsonb_build_object('rooms', p_rooms, 'total', v_total));
  return jsonb_build_object('group_id', v_gid, 'reservations', to_jsonb(ids), 'total', v_total,
    'expires_at', v_exp, 'master_folio_id', v_folio, 'route_grps', to_jsonb(coalesce(p_route_grps, array['ROOM'])), 'replayed', false);
end $$;

create or replace function public.confirm_group(p_group uuid, p_payment_method text, p_amount numeric,
  p_route_grps text[] default array['ROOM'])
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.reservation_groups; r record; n int := 0; v_first_folio uuid; v_f uuid;
begin
  select * into g from public.reservation_groups where id = p_group;
  if g.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(g.property_id, array['fo','cashier']);
  for r in select id from public.reservations where group_id = g.id and status = 'PENDING_PAYMENT' order by confirmation_no loop
    v_f := (public.confirm_reservation(r.id, null, 0, null)->>'folio_id')::uuid;
    v_first_folio := coalesce(v_first_folio, v_f);
    if g.master_folio_id is not null and coalesce(array_length(p_route_grps, 1), 0) > 0 then
      insert into public.routing_rules (property_id, reservation_id, to_folio_id, grps, created_by)
      values (g.property_id, r.id, g.master_folio_id, p_route_grps, auth.uid())
      on conflict (reservation_id, to_folio_id) do update set grps = excluded.grps;
    end if;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'HOLD_EXPIRED_OR_INVALID'; end if;
  if coalesce(p_amount, 0) > 0 then
    perform public.post_payment(coalesce(g.master_folio_id, v_first_folio), coalesce(p_payment_method, 'TRANSFER'),
      p_amount, 'Deposit grup ' || g.name, 'GDEP:' || g.id);
  end if;
  return jsonb_build_object('confirmed', n, 'master_folio_id', g.master_folio_id);
end $$;

-- Rooming list: ganti nama tamu per reservasi
create or replace function public.set_reservation_guest(p_reservation uuid, p_name text, p_phone text, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.reservations; v_g uuid;
begin
  select * into r from public.reservations where id = p_reservation for update;
  perform public.fn_require(r.property_id, array['fo']);
  if coalesce(trim(p_name), '') = '' then raise exception 'GUEST_NAME_REQUIRED'; end if;
  if nullif(p_phone, '') is not null then
    select id into v_g from public.guests where property_id = r.property_id and phone = p_phone limit 1;
  end if;
  if v_g is null then
    insert into public.guests (property_id, full_name, phone, email) values (r.property_id, trim(p_name), nullif(p_phone, ''), nullif(p_email, ''))
    returning id into v_g;
  end if;
  update public.reservations set guest_id = v_g, version = version + 1 where id = r.id;
  update public.folios set guest_id = v_g where reservation_id = r.id;
  return v_g;
end $$;

create or replace function public.set_reservation_company(p_reservation uuid, p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation for update;
  perform public.fn_require(r.property_id, array['fo','finance']);
  if p_company is not null and not exists (select 1 from public.companies where id = p_company and property_id = r.property_id) then
    raise exception 'NOT_FOUND';
  end if;
  update public.reservations set company_id = p_company, version = version + 1 where id = r.id;
  update public.folios set company_id = p_company where reservation_id = r.id;
end $$;

create or replace function public.update_guest(p_id uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare g public.guests;
begin
  select * into g from public.guests where id = p_id;
  if g.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(g.property_id, array['fo']);
  update public.guests set
    full_name = coalesce(nullif(trim(p_data->>'full_name'), ''), full_name),
    phone = nullif(p_data->>'phone', ''), email = nullif(p_data->>'email', ''),
    id_number = nullif(p_data->>'id_number', ''), nationality = nullif(p_data->>'nationality', ''),
    birth_date = nullif(p_data->>'birth_date', '')::date, address = nullif(p_data->>'address', ''),
    vip_level = coalesce(nullif(p_data->>'vip_level', '')::smallint, 0),
    is_blacklisted = coalesce((p_data->>'is_blacklisted')::boolean, false),
    notes = nullif(p_data->>'notes', ''), preferences = nullif(p_data->>'preferences', ''),
    company_id = nullif(p_data->>'company_id', '')::uuid,
    marketing_consent = coalesce((p_data->>'marketing_consent')::boolean, false),
    tags = coalesce((select array_agg(trim(x)) from unnest(string_to_array(p_data->>'tags', ',')) x where trim(x) <> ''), '{}')
  where id = p_id;
  perform public.log_audit(g.property_id, 'UPDATE_GUEST', 'guests', p_id::text, p_data);
end $$;

create or replace function public.guest_profile(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g public.guests; v jsonb;
begin
  select * into g from public.guests where id = p_id;
  perform public.fn_require(g.property_id);
  select jsonb_build_object(
    'guest', to_jsonb(g),
    'company', (select name from public.companies where id = g.company_id),
    'stays', coalesce((select jsonb_agg(x order by x->>'check_in' desc) from (
        select jsonb_build_object('id', r.id, 'confirmation_no', r.confirmation_no, 'status', r.status,
               'check_in', r.check_in, 'check_out', r.check_out, 'room', rm.number, 'room_type', rt.name,
               'total', r.total_amount, 'channel', r.channel) x
          from public.reservations r left join public.rooms rm on rm.id = r.room_id join public.room_types rt on rt.id = r.room_type_id
         where r.guest_id = g.id) s), '[]'::jsonb),
    'nights', coalesce((select sum(r.check_out - r.check_in) from public.reservations r where r.guest_id = g.id and r.status in ('CHECKED_OUT','IN_HOUSE')), 0),
    'visits', (select count(*) from public.reservations r where r.guest_id = g.id and r.status in ('CHECKED_OUT','IN_HOUSE')),
    'revenue', coalesce((select sum(fp.gross_amount) from public.folio_postings fp join public.folios f on f.id = fp.folio_id
                          join public.transaction_codes tc on tc.id = fp.txn_code_id
                         where f.guest_id = g.id and tc.grp <> 'PAYMENT'), 0),
    'cancellations', (select count(*) from public.reservations r where r.guest_id = g.id and r.status in ('CANCELLED','NO_SHOW'))
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 8. RPC Fasilitas, Event/BEO, Laundry, Breakfast
-- ---------------------------------------------------------------------
create or replace function public.inhouse_folio_by_room(p_room_number text) returns table (reservation_id uuid, folio_id uuid, guest_name text)
language sql stable security definer set search_path = public as $$
  select r.id, f.id, g.full_name from public.reservations r
    join public.rooms rm on rm.id = r.room_id join public.folios f on f.reservation_id = r.id join public.guests g on g.id = r.guest_id
   where r.property_id = public.fn_my_property() and rm.number = p_room_number and r.status = 'IN_HOUSE' and f.status = 'OPEN'
   limit 1
$$;

create or replace function public.book_facility(p_resource uuid, p_start timestamptz, p_end timestamptz, p_pax int,
  p_guest_name text, p_room_number text, p_payment_method text, p_notes text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare fr public.facility_resources; pr public.properties; v_id uuid; v_used int; v_res uuid; v_folio uuid; v_gname text;
        v_rate numeric; v_qty numeric; v_amt numeric; v_post uuid; v_range tstzrange; v_desc text;
begin
  select * into fr from public.facility_resources where id = p_resource and is_active;
  if fr.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(fr.property_id, array['fo','cashier']);
  select * into pr from public.properties where id = fr.property_id;
  if p_idempotency_key is not null then
    select id into v_id from public.facility_bookings where idempotency_key = p_idempotency_key;
    if v_id is not null then return jsonb_build_object('id', v_id, 'replayed', true); end if;
  end if;
  if p_end <= p_start then raise exception 'INVALID_TIME'; end if;
  if (p_start at time zone pr.timezone)::time < fr.open_time or (p_end at time zone pr.timezone)::time > fr.close_time
     or (p_start at time zone pr.timezone)::date <> ((p_end - interval '1 second') at time zone pr.timezone)::date then
    raise exception 'OUTSIDE_OPENING_HOURS';
  end if;
  if coalesce(p_pax, 0) < 1 then raise exception 'INVALID_PAX'; end if;

  if nullif(p_room_number, '') is not null then
    select x.reservation_id, x.folio_id, x.guest_name into v_res, v_folio, v_gname from public.inhouse_folio_by_room(p_room_number) x;
    if v_res is null then raise exception 'NO_INHOUSE_GUEST_IN_ROOM'; end if;
  end if;
  v_gname := coalesce(nullif(trim(p_guest_name), ''), v_gname);
  if v_gname is null then raise exception 'GUEST_NAME_REQUIRED'; end if;

  v_range := tstzrange(p_start, p_end + make_interval(mins => fr.buffer_minutes), '[)');
  if fr.mode = 'CAPACITY' then
    perform 1 from public.facility_resources where id = fr.id for update;   -- serialisasi per resource
    select coalesce(sum(pax), 0) into v_used from public.facility_bookings
     where resource_id = fr.id and status in ('CONFIRMED','CHECKED_IN') and time_range && v_range;
    if v_used + p_pax > fr.capacity then raise exception 'FACILITY_FULL_%', fr.capacity - v_used; end if;
  elsif p_pax > fr.capacity then raise exception 'OVER_CAPACITY_%', fr.capacity;
  end if;

  v_rate := case when v_res is not null then fr.rate_guest else fr.rate_public end;
  v_qty := case when fr.mode = 'EXCLUSIVE' then round(extract(epoch from (p_end - p_start)) / 3600.0, 2) else p_pax end;
  v_amt := v_rate * v_qty;

  begin
    insert into public.facility_bookings (property_id, resource_id, time_range, exclusive, pax, guest_name, reservation_id,
      amount, paid_method, notes, idempotency_key, created_by)
    values (fr.property_id, fr.id, v_range, fr.mode = 'EXCLUSIVE', p_pax, v_gname, v_res, v_amt,
      case when v_res is not null and v_amt > 0 then 'ROOM' else upper(nullif(p_payment_method, '')) end, p_notes, p_idempotency_key, auth.uid())
    returning id into v_id;
  exception when exclusion_violation then raise exception 'FACILITY_CONFLICT';
  end;

  v_desc := fr.name || ' ' || to_char(p_start at time zone pr.timezone, 'DD/MM HH24:MI') || '-' || to_char(p_end at time zone pr.timezone, 'HH24:MI');
  if v_amt > 0 then
    if v_folio is not null then
      v_post := public.post_charge(v_folio, fr.txn_code, v_desc, v_qty, v_rate, 'FAC:' || v_id, 'FACILITY');
    elsif nullif(p_payment_method, '') is not null then
      v_post := public.outlet_cash_sale(fr.txn_code, v_desc || ' - ' || v_gname, v_qty, v_rate, p_payment_method, null, 'FAC:' || v_id);
    end if;
    update public.facility_bookings set posting_id = v_post where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'amount', v_amt, 'posted', v_post is not null, 'replayed', false);
end $$;

create or replace function public.cancel_facility_booking(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.facility_bookings; f public.folios;
begin
  select * into b from public.facility_bookings where id = p_id for update;
  if b.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(b.property_id, array['fo','cashier']);
  if b.status not in ('CONFIRMED') then raise exception 'INVALID_STATUS_%', b.status; end if;
  update public.facility_bookings set status = 'CANCELLED', notes = coalesce(notes || ' | ', '') || 'Batal: ' || coalesce(p_reason, '-') where id = b.id;
  if b.posting_id is not null then
    select f2.* into f from public.folio_postings fp join public.folios f2 on f2.id = fp.folio_id where fp.id = b.posting_id;
    if f.status = 'OPEN' and f.type <> 'HOUSE' then
      perform public.reverse_posting(b.posting_id, 'Batal booking fasilitas: ' || coalesce(p_reason, '-'));
    end if;
  end if;
end $$;

create or replace function public.checkin_facility(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b public.facility_bookings;
begin
  select * into b from public.facility_bookings where id = p_id for update;
  perform public.fn_require(b.property_id, array['fo','cashier']);
  if b.status <> 'CONFIRMED' then raise exception 'INVALID_STATUS_%', b.status; end if;
  update public.facility_bookings set status = 'CHECKED_IN' where id = p_id;
end $$;

create or replace function public.create_event(p_name text, p_company uuid, p_contact text, p_phone text,
  p_resource uuid, p_start timestamptz, p_end timestamptz, p_pax int, p_layout text, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); pr public.properties; fr public.facility_resources; v_id uuid; v_folio uuid;
begin
  perform public.fn_require(v_prop, array['fo']);
  select * into pr from public.properties where id = v_prop;
  select * into fr from public.facility_resources where id = p_resource and property_id = v_prop and kind = 'MEETING';
  if fr.id is null then raise exception 'MEETING_ROOM_REQUIRED'; end if;
  if p_end <= p_start then raise exception 'INVALID_TIME'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  insert into public.folios (property_id, folio_no, type, name, company_id, opened_business_date)
  values (v_prop, 'F' || pr.code || '-' || lpad(nextval('public.seq_folio')::text, 6, '0'), 'EVENT', 'Event ' || p_name, p_company, pr.business_date)
  returning id into v_folio;
  insert into public.event_orders (property_id, event_no, name, company_id, contact_name, phone, resource_id, start_at, end_at,
    pax, layout, notes, folio_id, created_by)
  values (v_prop, 'BEO' || to_char(now() at time zone pr.timezone, 'YYMM') || '-' || lpad(nextval('public.seq_event')::text, 4, '0'),
    p_name, p_company, p_contact, p_phone, fr.id, p_start, p_end, coalesce(p_pax, 1), p_layout, p_notes, v_folio, auth.uid())
  returning id into v_id;
  begin
    insert into public.facility_bookings (property_id, resource_id, time_range, exclusive, pax, guest_name, event_id, amount, notes, created_by)
    values (v_prop, fr.id, tstzrange(p_start, p_end + make_interval(mins => fr.buffer_minutes), '[)'), true, coalesce(p_pax, 1),
      p_name, v_id, 0, 'BEO', auth.uid());
  exception when exclusion_violation then raise exception 'FACILITY_CONFLICT';
  end;
  -- sewa ruang otomatis sebagai item BEO pertama
  insert into public.event_items (event_id, kind, description, quantity, unit_price, txn_code)
  values (v_id, 'ROOM', 'Sewa ' || fr.name, round(extract(epoch from (p_end - p_start)) / 3600.0, 2), fr.rate_public, fr.txn_code);
  perform public.log_audit(v_prop, 'CREATE_EVENT', 'event_orders', v_id::text, jsonb_build_object('name', p_name, 'room', fr.name));
  return v_id;
end $$;

create or replace function public.add_event_item(p_event uuid, p_kind text, p_description text, p_quantity numeric,
  p_unit_price numeric, p_txn_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare e public.event_orders; v_id uuid;
begin
  select * into e from public.event_orders where id = p_event;
  perform public.fn_require(e.property_id, array['fo']);
  if e.status in ('COMPLETED','CANCELLED') then raise exception 'EVENT_CLOSED'; end if;
  if not exists (select 1 from public.transaction_codes where property_id = e.property_id and code = p_txn_code and grp <> 'PAYMENT') then
    raise exception 'TXN_CODE_NOT_FOUND_%', p_txn_code;
  end if;
  insert into public.event_items (event_id, kind, description, quantity, unit_price, txn_code)
  values (e.id, coalesce(p_kind, 'FB'), p_description, p_quantity, p_unit_price, p_txn_code) returning id into v_id;
  return v_id;
end $$;

create or replace function public.remove_event_item(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare it public.event_items; e public.event_orders;
begin
  select * into it from public.event_items where id = p_item;
  select * into e from public.event_orders where id = it.event_id;
  perform public.fn_require(e.property_id, array['fo']);
  if it.posting_id is not null then raise exception 'ITEM_ALREADY_POSTED'; end if;
  delete from public.event_items where id = p_item;
end $$;

create or replace function public.post_event_items(p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
declare e public.event_orders; it record; n int := 0; v_post uuid;
begin
  select * into e from public.event_orders where id = p_event;
  perform public.fn_require(e.property_id, array['fo','cashier','finance']);
  for it in select * from public.event_items where event_id = e.id and posting_id is null and quantity > 0 and unit_price > 0 loop
    v_post := public.post_charge(e.folio_id, it.txn_code, it.description || ' (' || e.event_no || ')', it.quantity, it.unit_price, 'BEO:' || it.id, 'EVENT');
    update public.event_items set posting_id = v_post where id = it.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.set_event_status(p_event uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.event_orders;
begin
  select * into e from public.event_orders where id = p_event for update;
  perform public.fn_require(e.property_id, array['fo']);
  if e.status in ('COMPLETED','CANCELLED') then raise exception 'EVENT_CLOSED'; end if;
  if p_status not in ('INQUIRY','TENTATIVE','DEFINITE','COMPLETED','CANCELLED') then raise exception 'INVALID_STATUS_%', p_status; end if;
  if p_status = 'CANCELLED' then
    update public.facility_bookings set status = 'CANCELLED' where event_id = e.id and status = 'CONFIRMED';
  elsif p_status = 'COMPLETED' then
    perform public.post_event_items(e.id);
    update public.facility_bookings set status = 'CHECKED_IN' where event_id = e.id and status = 'CONFIRMED';
  end if;
  update public.event_orders set status = p_status where id = e.id;
  perform public.log_audit(e.property_id, 'EVENT_STATUS', 'event_orders', e.id::text, jsonb_build_object('status', p_status));
end $$;

create or replace function public.create_laundry(p_room_number text, p_service text, p_items jsonb, p_notes text, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_res uuid; v_folio uuid; v_gname text; v_prop uuid := public.fn_my_property(); v_total numeric; v_id uuid; pr public.properties;
begin
  perform public.fn_require(v_prop, array['fo','cashier','hk_supervisor','room_attendant']);
  select id into v_id from public.laundry_orders where order_no = p_idempotency_key;
  if v_id is not null then return v_id; end if;
  select x.reservation_id, x.folio_id, x.guest_name into v_res, v_folio, v_gname from public.inhouse_folio_by_room(p_room_number) x;
  if v_res is null then raise exception 'NO_INHOUSE_GUEST_IN_ROOM'; end if;
  select coalesce(sum((i->>'qty')::numeric * (i->>'price')::numeric), 0) into v_total from jsonb_array_elements(p_items) i;
  if v_total <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_service = 'EXPRESS' then v_total := round(v_total * 1.5, 0); end if;
  select * into pr from public.properties where id = v_prop;
  insert into public.laundry_orders (property_id, order_no, reservation_id, room_number, guest_name, service, items, total, notes, due_at, created_by)
  values (v_prop, coalesce(p_idempotency_key, 'LND' || lpad(nextval('public.seq_laundry')::text, 5, '0')), v_res, p_room_number, v_gname,
          coalesce(p_service, 'REGULAR'), p_items, v_total, p_notes,
          now() + case when p_service = 'EXPRESS' then interval '4 hours' else interval '24 hours' end, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.set_laundry_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.laundry_orders; v_folio uuid; v_post uuid;
begin
  select * into o from public.laundry_orders where id = p_id for update;
  if o.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.fn_require(o.property_id, array['fo','cashier','hk_supervisor','room_attendant']);
  if o.status in ('DELIVERED','CANCELLED') then raise exception 'INVALID_STATUS_%', o.status; end if;
  if p_status not in ('PROCESSING','READY','DELIVERED','CANCELLED') then raise exception 'INVALID_STATUS_%', p_status; end if;
  if p_status = 'DELIVERED' then
    select id into v_folio from public.folios where reservation_id = o.reservation_id and status = 'OPEN';
    if v_folio is null then raise exception 'FOLIO_CLOSED'; end if;
    v_post := public.post_charge(v_folio, 'LAUNDRY', 'Laundry ' || o.order_no || case when o.service = 'EXPRESS' then ' (Express)' else '' end,
                1, o.total, 'LND:' || o.id, 'LAUNDRY');
    update public.laundry_orders set status = 'DELIVERED', delivered_at = now(), posting_id = v_post where id = o.id;
  else
    update public.laundry_orders set status = p_status where id = o.id;
  end if;
end $$;

-- Daftar tamu berhak sarapan pagi ini: menginap semalam (check_in < hari ini <= check_out) dengan add-on BF semalam
create or replace function public.breakfast_list(p_date date default null)
returns table (reservation_id uuid, room_number text, guest_name text, pax int, entitled boolean, redeemed int, status text)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_d date;
begin
  perform public.fn_require(v_prop);
  v_d := coalesce(p_date, public.business_date(v_prop));
  return query
  select r.id, rm.number, g.full_name, (r.adults + r.children)::int,
         exists (select 1 from public.reservation_night_rates n where n.reservation_id = r.id and n.stay_date = v_d - 1
                  and n.superseded_at is null and n.addon_amount > 0),
         coalesce((select sum(b.pax) from public.breakfast_redemptions b where b.reservation_id = r.id and b.business_date = v_d and not b.charged), 0)::int,
         r.status
    from public.reservations r join public.rooms rm on rm.id = r.room_id join public.guests g on g.id = r.guest_id
   where r.property_id = v_prop and r.status in ('IN_HOUSE','CHECKED_OUT')
     and r.check_in < v_d and r.check_out >= v_d
     and (r.status = 'IN_HOUSE' or r.checked_out_at >= now() - interval '18 hours')
   order by rm.number, (r.status = 'IN_HOUSE') desc;
end $$;

create or replace function public.breakfast_redeem(p_room_number text, p_pax int, p_charge_extra boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_bd date; b record; v_free int; v_paid int; v_folio uuid; v_post uuid; pr public.properties;
begin
  perform public.fn_require(v_prop, array['fo','cashier']);
  select * into pr from public.properties where id = v_prop;
  v_bd := pr.business_date;
  select * into b from public.breakfast_list(v_bd) x where x.room_number = p_room_number limit 1;
  if b.reservation_id is null then raise exception 'NO_INHOUSE_GUEST_IN_ROOM'; end if;
  if coalesce(p_pax, 0) < 1 then raise exception 'INVALID_PAX'; end if;
  v_free := case when b.entitled then greatest(b.pax - b.redeemed, 0) else 0 end;
  v_paid := greatest(p_pax - v_free, 0);
  if v_paid > 0 and not p_charge_extra then raise exception 'BREAKFAST_NOT_ENTITLED_%', v_paid; end if;
  if least(p_pax, v_free) > 0 then
    insert into public.breakfast_redemptions (property_id, business_date, reservation_id, room_number, pax, created_by)
    values (v_prop, v_bd, b.reservation_id, p_room_number, least(p_pax, v_free), auth.uid());
  end if;
  if v_paid > 0 then
    select id into v_folio from public.folios where reservation_id = b.reservation_id and status = 'OPEN';
    if v_folio is null then raise exception 'FOLIO_CLOSED'; end if;
    v_post := public.post_charge(v_folio, 'BF', 'Breakfast tambahan ' || v_paid || ' pax', v_paid, pr.breakfast_price,
                'BFX:' || b.reservation_id || ':' || v_bd || ':' || gen_random_uuid(), 'BREAKFAST');
    insert into public.breakfast_redemptions (property_id, business_date, reservation_id, room_number, pax, charged, posting_id, created_by)
    values (v_prop, v_bd, b.reservation_id, p_room_number, v_paid, true, v_post, auth.uid());
  end if;
  return jsonb_build_object('free', least(p_pax, v_free), 'charged', v_paid, 'guest', b.guest_name);
end $$;

-- ---------------------------------------------------------------------
-- 9. Laporan
-- ---------------------------------------------------------------------
-- Kinerja per hari: aktual (posting) untuk hari lewat, on-the-books (night rate) untuk hari depan
create or replace function public.report_range(p_from date, p_to date)
returns table (d date, available int, sold int, occ numeric, room_revenue numeric, adr numeric, revpar numeric,
               other_revenue numeric, is_actual boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_bd date; v_rooms int;
begin
  perform public.fn_require(v_prop);
  if p_to < p_from or p_to - p_from > 370 then raise exception 'INVALID_DATES'; end if;
  v_bd := public.business_date(v_prop);
  select count(*) into v_rooms from public.rooms where property_id = v_prop and is_sellable;
  return query
  with days as (select g::date as d from generate_series(p_from, p_to, interval '1 day') g),
  inv as (select i.stay_date, sum(i.total_rooms - i.out_of_order)::int av, sum(i.sold)::int so
            from public.room_type_inventory i where i.property_id = v_prop and i.stay_date between p_from and p_to group by i.stay_date),
  act as (select fp.business_date bdt, sum(fp.net_amount) filter (where tc.grp = 'ROOM') rr,
                 sum(fp.net_amount) filter (where tc.grp not in ('ROOM','PAYMENT')) oth
            from public.folio_postings fp join public.transaction_codes tc on tc.id = fp.txn_code_id
           where fp.property_id = v_prop and fp.business_date between p_from and p_to group by fp.business_date),
  otb as (select n.stay_date sd, sum(n.net_rate) rr from public.reservation_night_rates n join public.reservations r on r.id = n.reservation_id
           where r.property_id = v_prop and n.superseded_at is null and n.stay_date between p_from and p_to
             and r.status in ('CONFIRMED','IN_HOUSE') group by n.stay_date)
  select days.d, coalesce(inv.av, v_rooms), coalesce(inv.so, 0),
         round(coalesce(inv.so, 0)::numeric / nullif(coalesce(inv.av, v_rooms), 0) * 100, 1),
         case when days.d < v_bd then coalesce(act.rr, 0) else coalesce(otb.rr, 0) end,
         round(case when days.d < v_bd then coalesce(act.rr, 0) else coalesce(otb.rr, 0) end / nullif(coalesce(inv.so, 0), 0), 0),
         round(case when days.d < v_bd then coalesce(act.rr, 0) else coalesce(otb.rr, 0) end / nullif(coalesce(inv.av, v_rooms), 0), 0),
         case when days.d < v_bd then coalesce(act.oth, 0) else 0 end,
         days.d < v_bd
    from days left join inv on inv.stay_date = days.d left join act on act.bdt = days.d left join otb on otb.sd = days.d
   order by days.d;
end $$;

create or replace function public.report_daily(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v jsonb; k record;
begin
  perform public.fn_require(v_prop);
  select * into k from public.report_range(p_date, p_date);
  select jsonb_build_object(
    'date', p_date, 'available', k.available, 'sold', k.sold, 'occ', k.occ, 'room_revenue', k.room_revenue,
    'adr', k.adr, 'revpar', k.revpar, 'is_actual', k.is_actual,
    'arrivals', (select count(*) from reservations where property_id = v_prop and check_in = p_date and status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')),
    'departures', (select count(*) from reservations where property_id = v_prop and check_out = p_date and status in ('IN_HOUSE','CHECKED_OUT')),
    'no_show', (select count(*) from reservations where property_id = v_prop and check_in = p_date and status = 'NO_SHOW'),
    'cancelled', (select count(*) from reservations where property_id = v_prop and status = 'CANCELLED' and (created_at at time zone 'Asia/Jakarta')::date = p_date),
    'new_bookings', (select count(*) from reservations where property_id = v_prop and status not in ('EXPIRED') and (created_at at time zone 'Asia/Jakarta')::date = p_date),
    'pax_inhouse', (select coalesce(sum(adults + children), 0) from reservations where property_id = v_prop and check_in <= p_date and check_out > p_date and status in ('IN_HOUSE','CHECKED_OUT')),
    'revenue_by_grp', coalesce((select jsonb_object_agg(grp, amt) from (
        select tc.grp, sum(fp.net_amount) amt from folio_postings fp join transaction_codes tc on tc.id = fp.txn_code_id
         where fp.property_id = v_prop and fp.business_date = p_date and tc.grp <> 'PAYMENT' group by tc.grp) x), '{}'::jsonb),
    'service', (select coalesce(sum(fp.service_amount), 0) from folio_postings fp where fp.property_id = v_prop and fp.business_date = p_date),
    'tax', (select coalesce(sum(fp.tax_amount), 0) from folio_postings fp where fp.property_id = v_prop and fp.business_date = p_date),
    'payments', coalesce((select jsonb_object_agg(name, amt) from (
        select tc.name, sum(-fp.net_amount) amt from folio_postings fp join transaction_codes tc on tc.id = fp.txn_code_id
         where fp.property_id = v_prop and fp.business_date = p_date and tc.grp = 'PAYMENT' group by tc.name) x), '{}'::jsonb),
    'voids', (select count(*) from folio_postings fp where fp.property_id = v_prop and fp.business_date = p_date and fp.source_module = 'REVERSAL'),
    'channel_mix', coalesce((select jsonb_object_agg(channel, n) from (
        select r.channel, count(*) n from reservation_night_rates nr join reservations r on r.id = nr.reservation_id
         where r.property_id = v_prop and nr.stay_date = p_date and nr.superseded_at is null and r.status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')
         group by r.channel) x), '{}'::jsonb)
  ) into v;
  return v;
end $$;

-- Pickup: OTB per tanggal menginap + berapa yang dipesan N hari terakhir
create or replace function public.report_pickup(p_from date, p_days int, p_window int default 7)
returns table (stay_date date, otb int, pickup int, revenue numeric, available int)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property();
begin
  perform public.fn_require(v_prop);
  return query
  with days as (select g::date d from generate_series(p_from, p_from + p_days - 1, interval '1 day') g)
  select days.d,
    (select count(*)::int from reservation_night_rates n join reservations r on r.id = n.reservation_id
      where r.property_id = v_prop and n.stay_date = days.d and n.superseded_at is null and r.status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')),
    (select count(*)::int from reservation_night_rates n join reservations r on r.id = n.reservation_id
      where r.property_id = v_prop and n.stay_date = days.d and n.superseded_at is null and r.status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')
        and r.created_at >= now() - make_interval(days => p_window)),
    (select coalesce(sum(n.net_rate), 0) from reservation_night_rates n join reservations r on r.id = n.reservation_id
      where r.property_id = v_prop and n.stay_date = days.d and n.superseded_at is null and r.status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')),
    (select coalesce(sum(i.total_rooms - i.out_of_order), (select count(*) from rooms where property_id = v_prop and is_sellable))::int
       from room_type_inventory i where i.property_id = v_prop and i.stay_date = days.d)
  from days order by days.d;
end $$;

create or replace function public.report_hk(p_from date, p_to date)
returns table (user_id uuid, staff text, tasks int, avg_minutes numeric, target_minutes numeric, inspections int,
               pass_rate numeric, rework int, avg_score numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property();
begin
  perform public.fn_require(v_prop);
  return query
  select p.user_id, coalesce(p.full_name, p.email),
    count(distinct t.id)::int,
    round(avg(extract(epoch from (t.finished_at - t.started_at)) / 60) filter (where t.finished_at is not null and t.started_at is not null), 1),
    round(avg(t.est_minutes), 1),
    count(i.id)::int,
    round(100.0 * count(i.id) filter (where i.result = 'PASS') / nullif(count(i.id), 0), 1),
    coalesce(sum(t.rework_count), 0)::int,
    round(avg(i.score), 1)
  from public.profiles p
  join public.hk_tasks t on t.assigned_to = p.user_id and t.business_date between p_from and p_to and t.status in ('DONE','INSPECTED','REWORK')
  left join public.hk_inspections i on i.task_id = t.id
  where p.property_id = v_prop
  group by p.user_id, p.full_name, p.email
  order by 3 desc;
end $$;

create or replace function public.report_ar_aging() returns table (company_id uuid, company text, current_amt numeric,
  d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, total numeric, credit_limit numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); v_bd date;
begin
  perform public.fn_require(v_prop);
  v_bd := public.business_date(v_prop);
  return query
  select c.id, c.name,
    coalesce(sum(i.amount - i.paid_amount) filter (where v_bd <= i.due_date), 0),
    coalesce(sum(i.amount - i.paid_amount) filter (where v_bd - i.due_date between 1 and 30), 0),
    coalesce(sum(i.amount - i.paid_amount) filter (where v_bd - i.due_date between 31 and 60), 0),
    coalesce(sum(i.amount - i.paid_amount) filter (where v_bd - i.due_date between 61 and 90), 0),
    coalesce(sum(i.amount - i.paid_amount) filter (where v_bd - i.due_date > 90), 0),
    coalesce(sum(i.amount - i.paid_amount), 0), c.credit_limit
  from public.companies c join public.ar_invoices i on i.company_id = c.id and i.status in ('OPEN','PARTIAL')
  where c.property_id = v_prop group by c.id, c.name, c.credit_limit order by 8 desc;
end $$;

create or replace function public.report_trial_balance(p_from date, p_to date)
returns table (code text, name text, type text, debit numeric, credit numeric, balance numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property();
begin
  perform public.fn_require(v_prop, array['finance','fo','cashier']);
  return query
  select a.code, a.name, a.type, coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0),
         case when a.type in ('ASSET','EXPENSE') then coalesce(sum(l.debit - l.credit), 0) else coalesce(sum(l.credit - l.debit), 0) end
    from public.gl_accounts a
    left join public.journal_lines l on l.account_code = a.code
     and l.entry_id in (select e.id from public.journal_entries e where e.property_id = v_prop and e.business_date between p_from and p_to)
   where a.property_id = v_prop
   group by a.code, a.name, a.type order by a.code;
end $$;

create or replace function public.report_channel(p_from date, p_to date)
returns table (channel text, room_nights int, revenue numeric, adr numeric, bookings int)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property();
begin
  perform public.fn_require(v_prop);
  return query
  select r.channel, count(n.id)::int, coalesce(sum(n.net_rate), 0), round(avg(n.net_rate), 0), count(distinct r.id)::int
    from public.reservation_night_rates n join public.reservations r on r.id = n.reservation_id
   where r.property_id = v_prop and n.superseded_at is null and n.stay_date between p_from and p_to
     and r.status in ('CONFIRMED','IN_HOUSE','CHECKED_OUT')
   group by r.channel order by 3 desc;
end $$;

-- Pencarian global (Ctrl+K)
create or replace function public.global_search(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid := public.fn_my_property(); s text := '%' || lower(trim(p_q)) || '%';
begin
  perform public.fn_require(v_prop);
  if length(trim(coalesce(p_q, ''))) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(x) from (
    (select 'reservation' kind, r.id, r.confirmation_no || ' · ' || g.full_name label,
            r.status || ' · ' || to_char(r.check_in, 'DD Mon') || '–' || to_char(r.check_out, 'DD Mon') || coalesce(' · kamar ' || rm.number, '') sub
       from reservations r join guests g on g.id = r.guest_id left join rooms rm on rm.id = r.room_id
      where r.property_id = v_prop and (lower(r.confirmation_no) like s or lower(g.full_name) like s or g.phone like s or rm.number = trim(p_q))
      order by r.check_in desc limit 8)
    union all
    (select 'guest', g.id, g.full_name, coalesce(g.phone, '') || coalesce(' · ' || g.email, '')
       from guests g where g.property_id = v_prop and (lower(g.full_name) like s or g.phone like s or lower(coalesce(g.email, '')) like s) limit 5)
    union all
    (select 'room', rm.id, 'Kamar ' || rm.number, rt.name || ' · ' || rm.fo_status || '/' || rm.hk_status
       from rooms rm join room_types rt on rt.id = rm.room_type_id where rm.property_id = v_prop and rm.number like trim(p_q) || '%' limit 5)
    union all
    (select 'folio', f.id, f.folio_no || coalesce(' · ' || f.name, ''), f.type || ' · ' || f.status
       from folios f where f.property_id = v_prop and (lower(f.folio_no) like s or lower(coalesce(f.name, '')) like s) limit 5)
    union all
    (select 'company', c.id, c.name, coalesce(c.contact_name, '') from companies c where c.property_id = v_prop and lower(c.name) like s limit 5)
  ) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 10. Hak eksekusi & realtime
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
revoke execute on function public.gl_post(uuid, date, text, uuid, text, jsonb) from authenticated;
revoke execute on function public.seed_upgrade04(uuid) from authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.facility_bookings; exception when others then null; end;
    begin alter publication supabase_realtime add table public.laundry_orders; exception when others then null; end;
    begin alter publication supabase_realtime add table public.event_orders; exception when others then null; end;
  end if;
end $$;
