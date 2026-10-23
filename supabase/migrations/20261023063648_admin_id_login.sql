-- Only the Edge Function may read the administrator's login mapping.
-- Passwords are configured separately as salted PBKDF2-SHA256 hashes.
create table public.logger_admin_logins (
  login_id text primary key check (login_id ~ '^[a-z0-9_-]{1,40}$'),
  user_id uuid not null unique references public.logger_admins(user_id) on delete cascade,
  password_salt text not null check (password_salt ~ '^[0-9a-f]{32}$'),
  password_hash text not null check (password_hash ~ '^[0-9a-f]{64}$')
);
alter table public.logger_admin_logins enable row level security;
revoke all on public.logger_admin_logins from public, anon, authenticated;
grant select on public.logger_admin_logins to service_role;
