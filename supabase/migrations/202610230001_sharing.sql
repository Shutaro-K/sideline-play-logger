-- One active shared table per administrator. No sign mapping or drafts are stored here.
create table public.logger_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.logger_games (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id),
  viewer_user_id uuid references auth.users(id) on delete set null,
  viewer_login text unique,
  viewer_email text,
  active boolean not null default true,
  writer_id uuid not null,
  writer_revision bigint not null default 0,
  version bigint not null default 1,
  records jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(records) = 'array')
);
alter table public.logger_admins enable row level security;
alter table public.logger_games enable row level security;
revoke all on public.logger_admins, public.logger_games from public, anon, authenticated;
grant select on public.logger_admins, public.logger_games to authenticated;
grant all on public.logger_admins, public.logger_games to service_role;
create policy logger_admin_self on public.logger_admins for select to authenticated using (user_id = (select auth.uid()));
create policy logger_game_read on public.logger_games for select to authenticated using (
  (owner_id = (select auth.uid()) and exists (select 1 from public.logger_admins where user_id = (select auth.uid())))
  or (active and viewer_user_id = (select auth.uid()))
);

-- Membership is checked by the database for every snapshot fetch. Broadcasts only
-- announce a version; they never contain plays, notes, credentials or CSV data.
create policy logger_receive on realtime.messages for select to authenticated using (
  exists (select 1 from public.logger_games g where realtime.topic() = 'logger:' || g.id::text)
);
create function public.logger_notify() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('version',new.version), 'changed', 'logger:' || new.id::text, true);
  return new;
end $$;
revoke all on function public.logger_notify() from public, anon, authenticated;
create trigger logger_game_changed after insert or update of version on public.logger_games
  for each row execute function public.logger_notify();

-- Only the trusted Edge Function may create/rotate viewer accounts and writer leases.
create function public.logger_configure(p_owner uuid, p_writer uuid, p_login text, p_viewer uuid, p_email text, p_takeover boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.logger_games; same_writer boolean;
begin
  if not exists (select 1 from public.logger_admins where user_id=p_owner) then raise insufficient_privilege; end if;
  if p_login !~ '^[a-z0-9_-]{4,40}$' or p_viewer is null or p_email is null or p_writer is null then
    raise exception 'invalid settings';
  end if;
  -- Serialize first setup as well as rotations for a single owner.
  perform 1 from public.logger_admins where user_id=p_owner for update;
  select * into g from public.logger_games where owner_id=p_owner for update;
  if found then
    same_writer := g.writer_id=p_writer;
    if not same_writer and not p_takeover then raise exception 'writer_conflict'; end if;
    update public.logger_games set viewer_user_id=p_viewer,viewer_login=p_login,viewer_email=p_email,active=true,
      writer_id=p_writer,writer_revision=case when same_writer then writer_revision else 0 end,
      records=case when same_writer then records else '[]'::jsonb end,version=version+1,updated_at=now()
      where id=g.id returning * into g;
  else
    insert into public.logger_games(owner_id,viewer_user_id,viewer_login,viewer_email,writer_id)
      values(p_owner,p_viewer,p_login,p_email,p_writer) returning * into g;
  end if;
  return jsonb_build_object('id',g.id,'writer_id',g.writer_id,'writer_revision',g.writer_revision,'viewer_login',g.viewer_login,'active',g.active);
end $$;
revoke all on function public.logger_configure(uuid,uuid,text,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.logger_configure(uuid,uuid,text,uuid,text,boolean) to service_role;

create function public.logger_stop(p_owner uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.logger_admins where user_id=p_owner) then raise insufficient_privilege; end if;
  update public.logger_games set active=false,viewer_user_id=null,viewer_login=null,viewer_email=null,
    version=version+1,updated_at=now() where owner_id=p_owner;
end $$;
revoke all on function public.logger_stop(uuid) from public, anon, authenticated;
grant execute on function public.logger_stop(uuid) to service_role;

-- A full, ordered snapshot is small for one game. A revision/lease check prevents
-- retries, older edits and delayed pre-reset requests from resurrecting old rows.
create function public.logger_publish(p_game uuid, p_writer uuid, p_revision bigint, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.logger_games; item jsonb; k text;
begin
  if not exists (select 1 from public.logger_admins where user_id=auth.uid()) then raise insufficient_privilege; end if;
  select * into g from public.logger_games where id=p_game and owner_id=auth.uid() for update;
  if not found or not g.active or g.writer_id<>p_writer then raise insufficient_privilege; end if;
  if p_revision is null or p_revision<1 or p_records is null or jsonb_typeof(p_records)<>'array'
    or jsonb_array_length(p_records)>2000 or octet_length(p_records::text)>4194304 then raise exception 'invalid snapshot'; end if;
  for item in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'id') is distinct from 'number'
      or (item->>'id') !~ '^[1-9][0-9]*$' then raise exception 'invalid play'; end if;
    for k in select jsonb_object_keys(item) loop
      if k not in ('id','time','recordedAt','updatedAt','down','distance','strSide','sign','branch','formation','play','remark',
        'inside','outside','coverage','q','series','ending','lookupStatus','resolvedSign','parentSign','cwmBranch','protection','lookupSourceSign')
        or (k not in ('id','series') and jsonb_typeof(item->k)<>'string')
        or (k='series' and (jsonb_typeof(item->k)<>'number' or (item->>k) !~ '^[1-9][0-9]*$')) then raise exception 'invalid play field'; end if;
    end loop;
  end loop;
  if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_records)) then raise exception 'duplicate play'; end if;
  if p_revision=g.writer_revision and p_records<>g.records then raise exception 'revision_conflict'; end if;
  if p_revision>g.writer_revision then
    update public.logger_games set records=p_records,writer_revision=p_revision,version=version+1,updated_at=now()
      where id=g.id returning * into g;
  end if;
  return jsonb_build_object('writer_revision',g.writer_revision,'version',g.version,'updated_at',g.updated_at);
end $$;
revoke all on function public.logger_publish(uuid,uuid,bigint,jsonb) from public, anon;
grant execute on function public.logger_publish(uuid,uuid,bigint,jsonb) to authenticated;
