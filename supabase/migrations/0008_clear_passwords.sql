-- CAS-1228: Cascade signs people in with an emailed one-time code and nothing else, except the
-- App Store / Play review account (appreview@codynamics.com.au, CAS-1073), which Apple and Google
-- need to sign in without receiving our email. Every account's auth.users row nonetheless carries
-- a non-empty encrypted_password: from 5 Aug to about 21 Sep 2026 the app derived a password from
-- the email client-side (CAS-387, replaced by CAS-1056), so those accounts may still accept that
-- derived password; where the rest came from is not known. This clears encrypted_password to the
-- empty string on every row except the review account, data only, no schema change.
--
-- Data only; safe to re-run. Do NOT apply this to production from this commit — the build chat
-- applies it on Lee's go, after the admin site (outside this repo) has moved to code sign-in.

update auth.users
set encrypted_password = ''
where lower(email) <> 'appreview@codynamics.com.au';

insert into public.schema_migrations (version) values ('0008') on conflict do nothing;
