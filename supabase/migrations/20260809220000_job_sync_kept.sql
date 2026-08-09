-- The Job Book's Wrike scan ("Scan Wrike for job numbers") flags book rows that
-- disagree with Wrike's folder tree and offers to rewrite them to match. It is
-- all-or-nothing per scan: fixing one disagreement fixed every one, and the
-- ones you disagreed with got re-flagged on the next run. A "Keep" on a
-- disagreement records the code here, and future scans skip corrections for it
-- — the book row stands until someone edits it or Wrike genuinely changes.
--
-- Keyed by the XY code, not the job row: the scan's whole correction machinery
-- works in codes (jobs_job_code_key is the same identity), and a keep is a
-- code-level statement, so it survives the row being merged or rewritten.
-- Team-wide, not per-user — one keep stops the nag for everyone.

create table public.job_sync_kept (
  code text not null,
  created_at timestamp with time zone not null default now()
);

alter table public.job_sync_kept add constraint job_sync_kept_pkey primary key (code);

alter table public.job_sync_kept enable row level security;
create policy "auth_all" on public.job_sync_kept
  as permissive for all to authenticated using (true) with check (true);

comment on table public.job_sync_kept is
  'XY codes whose book rows the Wrike scan should stop asking about. A "Keep" on
  a scan disagreement records the code here; future scans skip corrections for
  it. The book row stands until someone edits it or Wrike genuinely changes.';
