-- Timesheeter :: full database schema (public + storage buckets)
--
-- Reconstructed from the source project `oozopadfrupwujsagagn` (org "xyi") via
-- catalog introspection. Faithful to tables, columns, defaults, identity,
-- constraints, indexes, functions, triggers, RLS + policies, storage buckets
-- and sequence positions as of the migration date.
--
-- Scope / caveats:
--   * public schema + storage.buckets metadata only.
--   * Storage OBJECTS (23 files in dooh-specs / notes-images) are NOT here --
--     they are binary and must be copied bucket-to-bucket (see MIGRATION.md).
--   * Supabase-managed schemas (auth, storage internals, extensions) are
--     provisioned automatically on any new Supabase project -- not recreated here.
--   * Standard extensions in use (pgcrypto, uuid-ossp for gen_random_uuid) ship
--     enabled on new Supabase projects, so no CREATE EXTENSION is needed.
--
-- Apply to a fresh project BEFORE seed_data.sql.

begin;

-- ---------------------------------------------------------------------------
-- Sequences (standalone; identity-column sequences are created with the tables)
-- ---------------------------------------------------------------------------
create sequence if not exists public.job_number_seq;

-- ---------------------------------------------------------------------------
-- Functions (defined before triggers that reference them)
-- ---------------------------------------------------------------------------
create or replace function public.set_job_number()
 returns trigger
 language plpgsql
as $function$
BEGIN
  IF NEW.job_number IS NULL THEN
    NEW.job_number := 'XY0' || nextval('job_number_seq')::TEXT;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.touch_updated_at()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.campaign_eoc_notes (
  campaign_id text not null,
  content text not null default ''::text,
  updated_at timestamp with time zone default now(),
  department text not null default 'Motion'::text
);

create table public.campaign_links (
  id uuid not null default gen_random_uuid(),
  campaign_id text not null,
  title text not null,
  url text not null,
  created_at timestamp with time zone default now()
);

create table public.campaign_meta (
  campaign_id text not null,
  studio text
);

create table public.canvas_covers (
  id integer not null,
  covers jsonb not null default '{}'::jsonb
);

create table public.canvas_manual_campaigns (
  id text not null,
  title text not null,
  wrike_link text,
  created_at timestamp with time zone default now()
);

create table public.canvas_notes_folders (
  id uuid not null default gen_random_uuid(),
  name text not null,
  parent_id uuid,
  created_at timestamp with time zone default now(),
  owner_wrike_id text,
  department text
);

create table public.canvas_notes_pages (
  id uuid not null default gen_random_uuid(),
  folder_id uuid,
  title text not null default 'Untitled'::text,
  content jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  kind text not null default 'text'::text,
  ydoc text
);

create table public.canvas_pinned_campaigns (
  campaign_id text not null,
  pinned_at timestamp with time zone default now()
);

create table public.canvas_pinned_notes (
  folder_id uuid not null,
  pinned_at timestamp with time zone default now()
);

create table public.clients (
  id bigint generated always as identity not null,
  name text not null,
  created_at timestamp with time zone default now()
);

create table public.dooh_assets (
  id text not null,
  country_id text not null,
  type text not null,
  name text,
  url text not null,
  storage_path text,
  created_at timestamp with time zone default now(),
  folder_id text
);

create table public.dooh_countries (
  id text not null,
  name text not null,
  flag text,
  created_at timestamp with time zone default now(),
  source_path text,
  pinned boolean default false
);

create table public.dooh_folders (
  id text not null,
  country_id text not null,
  parent_id text,
  name text not null,
  created_at timestamp with time zone default now(),
  source_path text
);

create table public.films (
  id bigint generated always as identity not null,
  title text not null,
  created_at timestamp with time zone default now()
);

create table public.job_categories (
  id bigint generated always as identity not null,
  name text not null,
  created_at timestamp with time zone default now()
);

create table public.job_departments (
  id bigint generated always as identity not null,
  name text not null,
  created_at timestamp with time zone default now()
);

create table public.jobs (
  id bigint generated always as identity not null,
  job_number text,
  start_date date,
  client text,
  film_title text,
  office text,
  print_digital text,
  project_description text,
  job_work_category text,
  ordered_by text,
  billed_to text,
  fixed_cost numeric(12,2),
  third_party_cost numeric(12,2),
  estimated_cost numeric(12,2),
  completed_date date,
  job_done boolean default false,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  status text not null default 'Inactive'::text,
  template_slot text
);

create table public.positions (
  id bigint generated always as identity not null,
  title text not null,
  created_at timestamp with time zone default now()
);

create table public.profiles (
  wrike_user_id text not null,
  first_name text,
  last_name text,
  email text,
  avatar_url text,
  updated_at timestamp with time zone default now(),
  position_id bigint,
  department text,
  reports_to text,
  canvas_color text
);

create table public.project_descriptions (
  id bigint generated always as identity not null,
  description text not null,
  created_at timestamp with time zone default now()
);

create table public.tasks (
  id bigint not null,
  job_number text,
  territory text,
  category text,
  notes text,
  day_of_week text,
  date text,
  wrike_timelog_id text,
  created_at timestamp with time zone default now(),
  source text default 'tracker'::text,
  film_title text,
  client text,
  project_description text,
  time_spent text,
  additional_time text,
  client_amends boolean default false,
  is_3d boolean default false,
  task_id text,
  wrike_user_id text
);

create table public.translation_countries (
  id bigint generated always as identity not null,
  name text not null,
  created_at timestamp with time zone default now()
);

create table public.wrike_oauth_tokens (
  wrike_user_id text not null,
  session_token text not null,
  access_token text not null,
  refresh_token text not null,
  api_host text not null default 'www.wrike.com'::text,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.wrike_sync_meta (
  wrike_user_id text not null,
  last_synced_at timestamp with time zone,
  folder_dictionary jsonb,
  contact_dictionary jsonb,
  status_dictionary jsonb,
  film_code_mappings jsonb default '{}'::jsonb
);

create table public.wrike_tasks_cache (
  id text not null,
  wrike_user_id text not null,
  task_data jsonb not null,
  updated_date text
);

create table public.wrike_webhook_config (
  id boolean not null default true,
  webhook_id text not null,
  secret text not null,
  created_at timestamp with time zone not null default now()
);

create table public.wrike_webhook_events (
  id bigint generated always as identity not null,
  task_id text not null,
  event_type text,
  occurred_at timestamp with time zone not null default now()
);

-- ---------------------------------------------------------------------------
-- Primary keys, unique + check constraints
-- ---------------------------------------------------------------------------
alter table public.campaign_eoc_notes add constraint campaign_eoc_notes_pkey primary key (campaign_id, department);
alter table public.campaign_links add constraint campaign_links_pkey primary key (id);
alter table public.campaign_meta add constraint campaign_meta_pkey primary key (campaign_id);
alter table public.canvas_covers add constraint canvas_covers_pkey primary key (id);
alter table public.canvas_manual_campaigns add constraint canvas_manual_campaigns_pkey primary key (id);
alter table public.canvas_notes_folders add constraint canvas_notes_folders_pkey primary key (id);
alter table public.canvas_notes_pages add constraint canvas_notes_pages_pkey primary key (id);
alter table public.canvas_notes_pages add constraint canvas_notes_pages_kind_check check ((kind = ANY (ARRAY['text'::text, 'sketch'::text])));
alter table public.canvas_pinned_campaigns add constraint canvas_pinned_campaigns_pkey primary key (campaign_id);
alter table public.canvas_pinned_notes add constraint canvas_pinned_notes_pkey primary key (folder_id);
alter table public.clients add constraint clients_pkey primary key (id);
alter table public.clients add constraint clients_name_key unique (name);
alter table public.dooh_assets add constraint dooh_assets_pkey primary key (id);
alter table public.dooh_countries add constraint dooh_countries_pkey primary key (id);
alter table public.dooh_folders add constraint dooh_folders_pkey primary key (id);
alter table public.films add constraint films_pkey primary key (id);
alter table public.films add constraint films_title_key unique (title);
alter table public.job_categories add constraint job_categories_pkey primary key (id);
alter table public.job_categories add constraint job_categories_name_key unique (name);
alter table public.job_departments add constraint job_departments_pkey primary key (id);
alter table public.job_departments add constraint job_departments_name_key unique (name);
alter table public.jobs add constraint jobs_pkey primary key (id);
alter table public.jobs add constraint jobs_job_number_key unique (job_number);
alter table public.jobs add constraint jobs_status_check check ((status = ANY (ARRAY['Inactive'::text, 'Active'::text, 'Closed'::text])));
alter table public.positions add constraint positions_pkey primary key (id);
alter table public.positions add constraint positions_title_key unique (title);
alter table public.profiles add constraint profiles_pkey primary key (wrike_user_id);
alter table public.project_descriptions add constraint project_descriptions_pkey primary key (id);
alter table public.project_descriptions add constraint project_descriptions_description_key unique (description);
alter table public.tasks add constraint tasks_pkey primary key (id);
alter table public.translation_countries add constraint translation_countries_pkey primary key (id);
alter table public.translation_countries add constraint translation_countries_name_key unique (name);
alter table public.wrike_oauth_tokens add constraint wrike_oauth_tokens_pkey primary key (session_token);
alter table public.wrike_sync_meta add constraint wrike_sync_meta_pkey primary key (wrike_user_id);
alter table public.wrike_tasks_cache add constraint wrike_tasks_cache_pkey primary key (id);
alter table public.wrike_webhook_config add constraint wrike_webhook_config_pkey primary key (id);
alter table public.wrike_webhook_config add constraint wrike_webhook_config_id_check check (id);
alter table public.wrike_webhook_events add constraint wrike_webhook_events_pkey primary key (id);

-- ---------------------------------------------------------------------------
-- Foreign keys (added after all tables + referenced unique keys exist)
-- ---------------------------------------------------------------------------
alter table public.canvas_notes_folders add constraint canvas_notes_folders_parent_id_fkey foreign key (parent_id) references canvas_notes_folders(id) on delete cascade;
alter table public.canvas_notes_pages add constraint canvas_notes_pages_folder_id_fkey foreign key (folder_id) references canvas_notes_folders(id) on delete cascade;
alter table public.canvas_pinned_notes add constraint canvas_pinned_notes_folder_id_fkey foreign key (folder_id) references canvas_notes_folders(id) on delete cascade;
alter table public.profiles add constraint profiles_position_id_fkey foreign key (position_id) references positions(id) on delete set null;
alter table public.profiles add constraint profiles_reports_to_fkey foreign key (reports_to) references profiles(wrike_user_id) on delete set null;
alter table public.profiles add constraint profiles_department_fkey foreign key (department) references job_departments(name) on update cascade on delete set null;

-- ---------------------------------------------------------------------------
-- Secondary indexes
-- ---------------------------------------------------------------------------
create index jobs_client_idx on public.jobs using btree (client);
create index jobs_job_done_idx on public.jobs using btree (job_done);
create index jobs_start_date_idx on public.jobs using btree (start_date);
create index profiles_position_id_idx on public.profiles using btree (position_id);
create index idx_tasks_wrike_user_id on public.tasks using btree (wrike_user_id);
create index wrike_oauth_tokens_wrike_user_id_idx on public.wrike_oauth_tokens using btree (wrike_user_id);
create index wrike_tasks_cache_updated_date_idx on public.wrike_tasks_cache using btree (updated_date);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger trg_jobs_updated_at before update on public.jobs for each row execute function touch_updated_at();
create trigger trg_set_job_number before insert on public.jobs for each row execute function set_job_number();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.campaign_eoc_notes enable row level security;
alter table public.campaign_links enable row level security;
alter table public.campaign_meta enable row level security;
alter table public.canvas_covers enable row level security;
alter table public.canvas_manual_campaigns enable row level security;
alter table public.canvas_notes_folders enable row level security;
alter table public.canvas_notes_pages enable row level security;
alter table public.canvas_pinned_campaigns enable row level security;
alter table public.canvas_pinned_notes enable row level security;
alter table public.clients enable row level security;
alter table public.dooh_assets enable row level security;
alter table public.dooh_countries enable row level security;
alter table public.dooh_folders enable row level security;
alter table public.films enable row level security;
alter table public.job_categories enable row level security;
alter table public.job_departments enable row level security;
alter table public.jobs enable row level security;
alter table public.positions enable row level security;
alter table public.profiles enable row level security;
alter table public.project_descriptions enable row level security;
alter table public.tasks enable row level security;
alter table public.translation_countries enable row level security;
alter table public.wrike_oauth_tokens enable row level security;
alter table public.wrike_sync_meta enable row level security;
alter table public.wrike_tasks_cache enable row level security;
alter table public.wrike_webhook_config enable row level security;
alter table public.wrike_webhook_events enable row level security;

-- Policies. NOTE: wrike_oauth_tokens and wrike_webhook_config have RLS enabled
-- but NO policies on purpose -- only the service-role key (which bypasses RLS)
-- may touch them. The browser's anon/authenticated keys must never read them.
create policy "anon all" on public.campaign_eoc_notes as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.campaign_links as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.campaign_meta as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.canvas_covers as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.canvas_manual_campaigns as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.canvas_notes_folders as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.canvas_notes_pages as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.canvas_pinned_campaigns as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.canvas_pinned_notes as permissive for all to authenticated using (true) with check (true);
create policy "auth_all" on public.clients as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.dooh_assets as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.dooh_countries as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.dooh_folders as permissive for all to authenticated using (true) with check (true);
create policy "auth_all" on public.films as permissive for all to authenticated using (true) with check (true);
create policy "auth_all" on public.job_categories as permissive for all to authenticated using (true) with check (true);
create policy "auth_all" on public.job_departments as permissive for all to public using (true) with check (true);
create policy "auth_all" on public.jobs as permissive for all to authenticated using (true) with check (true);
create policy "auth_all" on public.positions as permissive for all to authenticated using (true) with check (true);
create policy "profiles_read" on public.profiles as permissive for select to authenticated using (true);
create policy "profiles_write" on public.profiles as permissive for all to authenticated using ((wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)));
create policy "auth_all" on public.project_descriptions as permissive for all to authenticated using (true) with check (true);
create policy "wrike_user_isolation" on public.tasks as permissive for all to public using ((wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text))) with check ((wrike_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'wrike_user_id'::text)));
create policy "auth_all" on public.translation_countries as permissive for all to public using (true) with check (true);
create policy "anon all" on public.wrike_sync_meta as permissive for all to authenticated using (true) with check (true);
create policy "anon all" on public.wrike_tasks_cache as permissive for all to authenticated using (true) with check (true);
create policy "authenticated_read" on public.wrike_webhook_events as permissive for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Storage buckets (objects are copied separately -- see MIGRATION.md)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('dooh-specs', 'dooh-specs', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('notes-images', 'notes-images', true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Sequence positions (preserve id continuity)
-- ---------------------------------------------------------------------------
select setval('public.job_number_seq', 25903, true);
select setval('public.clients_id_seq', 114, true);
select setval('public.films_id_seq', 41, true);
select setval('public.job_categories_id_seq', 130, true);
select setval('public.job_departments_id_seq', 6, true);
select setval('public.jobs_id_seq', 151, true);
select setval('public.positions_id_seq', 36, true);
select setval('public.project_descriptions_id_seq', 857, true);
select setval('public.wrike_webhook_events_id_seq', 19599, true);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
comment on column public.canvas_notes_pages.ydoc is 'Base64 Yjs state (Y.encodeStateAsUpdate). Source of truth for collaborative editing; content holds the plain-JSON projection for list snippets/word counts.';

commit;
