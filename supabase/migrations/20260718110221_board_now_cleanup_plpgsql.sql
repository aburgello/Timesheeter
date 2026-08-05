-- Convert cleanup_board_now to plpgsql so it's order-independent (a plpgsql
-- body isn't validated against the catalog until execution). This lets
-- schema.sql define it up in the Functions section, before the tables it
-- references exist -- a LANGUAGE SQL body would fail that forward reference.
create or replace function public.cleanup_board_now()
returns void
language plpgsql
as $$
begin
  delete from public.board_now b
  where b.updated_at < now() - interval '3 days'
     or exists (
       select 1 from public.wrike_tasks_cache c
       where c.id = b.task_id
         and coalesce(c.task_data->>'status', '') <> 'Active'
     );
end;
$$;
