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
