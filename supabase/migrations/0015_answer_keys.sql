-- CAS-1536: the "From your email" view in Alerts writes notifications.answer = the key of the last Watch On /
-- Watched button tapped (the app's own film-card buttons, no invented wording). Migration 0014 (CAS-1535)
-- allowed only the dropped values 'cinema' | 'home' | 'notfor', so those writes would be rejected.
--
-- Apply this in the Supabase dashboard SQL editor AFTER 0014 and BEFORE the release that carries CAS-1536 is
-- promoted. Safe to re-run. NOT applied by the worker - Lee-gated.
alter table public.notifications drop constraint if exists notifications_answer_check;
alter table public.notifications add constraint notifications_answer_check
  check (answer is null or answer in ('in_cinema', 'premium', 'rent', 'stream', 'never', 'wow', 'liked', 'enjoyed', 'soso', 'disliked'));

insert into public.schema_migrations (version) values ('0015') on conflict do nothing;
