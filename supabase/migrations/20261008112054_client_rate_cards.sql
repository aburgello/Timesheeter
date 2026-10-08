-- Rates move from the position to the client. Each client has a rate card: an
-- hourly rate per rate-card position (the short list a client is quoted in:
-- Designer, Senior Designer, Uploading…), in that client's currency. An XYi
-- position says which rate-card position it bills as, and an item category can
-- name one to bill at instead of the logger's.
--
-- positions.hourly_rate and job_categories.rate_position_id are left in place:
-- the app deployed before this still reads them.

create table public.rate_roles (
  id bigint generated always as identity primary key,
  name text not null unique,
  sort_order integer not null default 100,
  created_at timestamp with time zone default now()
);

create table public.client_rates (
  client_id bigint not null references public.clients(id) on delete cascade,
  rate_role_id bigint not null references public.rate_roles(id) on delete cascade,
  hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
  primary key (client_id, rate_role_id)
);

alter table public.clients
  add column currency text not null default 'USD' check (currency in ('USD', 'GBP', 'EUR', 'AUD'));
alter table public.positions
  add column rate_role_id bigint references public.rate_roles(id) on delete set null;
alter table public.job_categories
  add column rate_role_id bigint references public.rate_roles(id) on delete set null;

alter table public.rate_roles enable row level security;
alter table public.client_rates enable row level security;
create policy "auth_all" on public.rate_roles as permissive for all to authenticated using (true) with check (true);
create policy "auth_all" on public.client_rates as permissive for all to authenticated using (true) with check (true);

insert into public.rate_roles (name, sort_order) values
  ('Creative Director', 10),
  ('Art Director', 20),
  ('Creative QC', 30),
  ('Project Manager', 40),
  ('Senior Designer', 50),
  ('Proof Reader', 60),
  ('Designer', 70),
  ('Junior Designer', 80),
  ('Content Management', 90),
  ('Watermarking', 100),
  ('Uploading', 110);

-- A first guess at "bills as" from the job titles, for an administrator to
-- correct. Titles that fit no rule (directors and managers) are left unset.
-- The first matching rule wins.
update public.positions p
set rate_role_id = (select id from public.rate_roles r where r.name = g.role)
from (
  select id,
    case
      when title ilike '%asset manager%' then 'Content Management'
      when title ilike '%creative director%' then 'Creative Director'
      when title ilike '%art director%' then 'Art Director'
      when title ilike '%project manager%' then 'Project Manager'
      when title ilike '%proofreader%' then 'Proof Reader'
      when title ilike '%qc controller%' then 'Creative QC'
      when title ~* '(designer|artworker|retoucher)' and title ~* '(senior|lead)' then 'Senior Designer'
      when title ~* '(designer|artworker|retoucher)' and title ilike '%junior%' then 'Junior Designer'
      when title ~* '(designer|artworker|retoucher)' then 'Designer'
    end as role
  from public.positions
) g
where g.id = p.id and g.role is not null;

-- An override that named a position now names what that position bills as.
update public.job_categories c
set rate_role_id = p.rate_role_id
from public.positions p
where p.id = c.rate_position_id;

-- The upload categories pointed at Junior Asset Manager only to borrow its
-- rate. Rate cards have a line for the work itself.
update public.job_categories
set rate_role_id = (select id from public.rate_roles where name = 'Uploading')
where name ilike '%upload%' and rate_position_id is not null;
