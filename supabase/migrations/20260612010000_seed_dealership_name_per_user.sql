-- Fix: bootstrapped dealerships were all named 'My Dealership' with
-- identical demo content, making distinct tenants look like shared data.
-- Re-create seed_demo_data() deriving the name from the user's email.

create or replace function public.seed_demo_data()
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_dealer uuid;
  v_name   text;
  c_james uuid; c_priya uuid; c_tom uuid; c_sarah uuid;
  c_marcus uuid; c_jennifer uuid; c_david uuid; c_robert uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select dealership_id into v_dealer
  from dealership_members where user_id = v_uid
  order by created_at limit 1;

  if v_dealer is null then
    -- Name the workspace after the user so tenants are visibly distinct
    v_name := initcap(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1));
    if coalesce(v_name, '') = '' then v_name := 'My'; end if;
    insert into dealerships (name, created_by)
    values (v_name || '''s Dealership', v_uid)
    returning id into v_dealer;
    insert into dealership_members (dealership_id, user_id, role)
    values (v_dealer, v_uid, 'owner');
  end if;

  if exists (select 1 from customers where dealer_id = v_dealer) then
    return v_dealer;  -- already seeded
  end if;

  -- Customers ---------------------------------------------------
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'James','Wilson','(555) 100-2049','james.wilson@example.com','Cars.com','booked', now() - interval '2 days')
  returning id into c_james;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'Priya','Patel','(555) 234-7710','priya.patel@example.com','AutoTrader','booked', now() - interval '3 days')
  returning id into c_priya;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'Tom','Reeves','(555) 887-3312','tom.reeves@example.com','Direct call','engaged', now() - interval '1 day')
  returning id into c_tom;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'Sarah','Chen','(555) 441-9988','sarah.chen@example.com','Cars.com','new', now() - interval '1 day')
  returning id into c_sarah;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'Marcus','Brown','(555) 772-1234','marcus.brown@example.com','Facebook','engaged', now() - interval '6 hours')
  returning id into c_marcus;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'Jennifer','Park','(555) 330-5599','jennifer.park@example.com','Google','booked', now() - interval '11 days')
  returning id into c_jennifer;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'David','Kim','(555) 614-2077','david.kim@example.com','Google','engaged', now() - interval '1 day')
  returning id into c_david;
  insert into customers (dealer_id, first_name, last_name, phone, email, lead_source, status, created_at)
  values (v_dealer,'Robert','Chang','(555) 119-4400','robert.chang@example.com','Cars.com','sold', now() - interval '5 days')
  returning id into c_robert;

  -- Call logs ----------------------------------------------------
  insert into call_logs (dealer_id, customer_name, customer_phone, call_type, call_status, duration_seconds, transcript, created_at) values
   (v_dealer,'James Wilson','(555) 100-2049','inbound','answered',290,'Asked if the 2020 Camry was still available. Confirmed 10am test drive.', now() - interval '3 hours'),
   (v_dealer,'Marcus Brown','(555) 772-1234','inbound','answered',244,'Trade-in inquiry — 2021 model, ~38K miles. Inspection suggested.', now() - interval '2 hours'),
   (v_dealer,'Priya Patel','(555) 234-7710','inbound','answered',180,'Confirmed 1pm CR-V test drive. Reminder requested.', now() - interval '5 hours'),
   (v_dealer,'Tom Reeves','(555) 887-3312','inbound','recovered',95,'Missed at first ring — assistant called back within a minute. Ranger pricing.', now() - interval '4 hours'),
   (v_dealer,'David Kim','(555) 614-2077','after_hours','escalated',150,'BMW 3 Series interest. Asked to speak to a person — flagged for callback.', now() - interval '1 day 2 hours'),
   (v_dealer,'Sarah Chen','(555) 441-9988','after_hours','recovered',130,'11:22 PM inquiry — Camry under $18K. Qualified and follow-up scheduled.', now() - interval '1 day 4 hours'),
   (v_dealer,'Jennifer Park','(555) 330-5599','outbound','answered',88,'Price-drop follow-up on the Accord. Interested in Saturday.', now() - interval '1 day 6 hours'),
   (v_dealer,'Raj Patel','(555) 909-1188','inbound','recovered',112,'Silverado interest from AutoTrader. Test drive offered.', now() - interval '2 days'),
   (v_dealer,'Tanya Rogers','(555) 277-3344','after_hours','recovered',101,'11:58 PM Civic inquiry from Facebook Marketplace. Price confirmed.', now() - interval '3 days'),
   (v_dealer,'Robert Chang','(555) 119-4400','inbound','answered',305,'Final questions before purchase. Tucson sold.', now() - interval '5 days'),
   (v_dealer,'Unknown caller','(555) 808-2210','inbound','missed',0,null, now() - interval '6 days'),
   (v_dealer,'Anita Sharma','(555) 515-7821','after_hours','recovered',76,'Tucson availability question, captured overnight.', now() - interval '6 days');

  -- Appointments ---------------------------------------------------
  insert into appointments (dealer_id, customer_id, appointment_type, vehicle, scheduled_at, status, created_at) values
   (v_dealer, c_james,  'test_drive','2020 Toyota Camry · $17,500',  date_trunc('day', now()) + interval '10 hours', 'confirmed', now() - interval '1 day'),
   (v_dealer, c_priya,  'test_drive','2021 Honda CR-V · $24,900',    date_trunc('day', now()) + interval '13 hours', 'confirmed', now() - interval '2 days'),
   (v_dealer, c_tom,    'test_drive','2019 Ford Ranger · $21,500',   date_trunc('day', now()) + interval '15 hours 30 minutes', 'pending', now() - interval '4 hours'),
   (v_dealer, c_sarah,  'test_drive','2022 Hyundai Tucson · $27,000',date_trunc('day', now()) + interval '17 hours', 'requested', now() - interval '3 hours'),
   (v_dealer, c_marcus, 'trade_in_inspection','Trade-in inquiry',    date_trunc('day', now()) + interval '1 day 11 hours', 'pending', now() - interval '2 hours'),
   (v_dealer, c_robert, 'test_drive','2022 Hyundai Tucson · $27,000',now() - interval '3 days', 'completed', now() - interval '5 days');

  -- Tasks (Action Center) -----------------------------------------
  insert into tasks (dealer_id, customer_id, task_type, priority, status, title, description, due_at, created_at) values
   (v_dealer, c_david,  'escalation','urgent','open','David Kim — urgent callback','3 missed calls. BMW 3 Series pricing. Asked for a person, not the assistant — call NOW.', now() + interval '1 hour', now() - interval '2 hours'),
   (v_dealer, c_marcus, 'hot_lead','high','open','Marcus Brown — trade-in estimate','2021 model, ~38K miles. Wants a number today. Inspection slot suggested.', now() + interval '3 hours', now() - interval '2 hours'),
   (v_dealer, c_sarah,  'hot_lead','normal','open','Sarah Chen — Camry under $18K','After-hours lead. Warm — likely to book if sunroof question is answered.', now() + interval '5 hours', now() - interval '1 day'),
   (v_dealer, c_sarah,  'follow_up','normal','open','Sarah Chen — sunroof question','Asked if the 2020 Camry has a sunroof. Assistant could not confirm from the listing.', now() + interval '4 hours', now() - interval '1 day'),
   (v_dealer, c_jennifer,'follow_up','normal','open','Jennifer Park — price drop reply','Re-engaged after Accord price-drop SMS. Replied "maybe Saturday?" — propose 2pm.', now() + interval '6 hours', now() - interval '1 day'),
   (v_dealer, c_tom,    'confirmation','normal','open','Tom Reeves — confirm 3:30 PM','Ranger test drive today. Assistant chasing via SMS, no reply yet.', date_trunc('day', now()) + interval '15 hours', now() - interval '4 hours'),
   (v_dealer, c_sarah,  'confirmation','normal','open','Sarah Chen — confirm 5:00 PM','Tucson test drive requested for today. Waiting on confirmation.', date_trunc('day', now()) + interval '16 hours 30 minutes', now() - interval '3 hours'),
   (v_dealer, c_james,  'confirmation','low','done','James Wilson — confirm 10:00 AM','Camry test drive auto-booked at 11:48 PM. SMS confirmation sent.', date_trunc('day', now()) + interval '9 hours', now() - interval '1 day');

  -- Metrics --------------------------------------------------------
  insert into dealership_metrics (dealer_id, calls_answered, appointments_booked, missed_calls_recovered, revenue_protected)
  values (v_dealer, 134, 47, 18, 25380)
  on conflict (dealer_id) do nothing;

  return v_dealer;
end;
$$;

revoke execute on function public.seed_demo_data() from public, anon;
grant execute on function public.seed_demo_data() to authenticated;

