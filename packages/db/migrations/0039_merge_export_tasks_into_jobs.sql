do $$
begin
  if exists (select 1 from export_tasks where job_id is null) then
    raise exception 'Cannot merge export_tasks rows with null job_id into jobs.result.';
  end if;
end $$;

update jobs
set result = coalesce(jobs.result, '{}'::jsonb)
  || jsonb_strip_nulls(
    jsonb_build_object(
      'exportTaskId', export_tasks.id::text,
      'exportType', export_tasks.export_type,
      'status', export_tasks.status,
      'outputPath', export_tasks.output_path,
      'lineCount', export_tasks.line_count,
      'errorCode', export_tasks.error_code,
      'errorMessage', export_tasks.error_message,
      'metadata', export_tasks.metadata,
      'startedAt', export_tasks.started_at,
      'completedAt', export_tasks.completed_at
    )
  ),
  updated_at = greatest(jobs.updated_at, export_tasks.updated_at)
from export_tasks
where jobs.id = export_tasks.job_id;

drop index if exists idx_export_tasks_type_created_at;
drop table if exists export_tasks;
