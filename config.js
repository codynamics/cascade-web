// Cascade Web — front-end config (CAS-317, per-environment CAS-1521).
//
// Anon/public keys only — Row-Level Security (confirmed ON, 2026-08-05) is what makes them
// safe to ship client-side. The service_role key must NEVER appear here; it stays a
// GitHub Actions secret used server-side by the scheduled workflows.
//
// Two environments, one file. The environment is picked at load:
//   1. location.hostname is cascademovies.com / www.cascademovies.com -> production
//   2. else window.CASCADE_ENV ("production" | "staging"), set by the iOS build's www/env.js
//   3. else -> staging (pages.dev previews, localhost, Playwright)
// The choice is exposed as window.CASCADE_CONFIG.ENV.
//
// If this file is ever absent, the site still loads fine in guest mode (localStorage only) —
// it just shows a "connect your account" note in the account panel.

(function () {
  var ENVIRONMENTS = {
    production: {
      SUPABASE_URL: "https://ypccfyatejejslzlfrbf.supabase.co",
      SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwY2NmeWF0ZWplanNsemxmcmJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNjY4ODEsImV4cCI6MjA5OTc0Mjg4MX0.P32M3PTqMKOu5DVEkIdaFAxiSOoXxqNbA6YIklgwrE4",
    },
    staging: {
      SUPABASE_URL: "https://oenvezqluwqdwlzfhisc.supabase.co",
      SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9lbnZlenFsdXdxZHdsemZoaXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzNzU2NTMsImV4cCI6MjExMDk1MTY1M30.-jybYspikvEm5cEgb9N_bD1XQvJOQsZtHaoHffYqGLw",
    },
  };
  var host = (typeof location !== "undefined" && location.hostname) || "";
  var name;
  if (host === "cascademovies.com" || host === "www.cascademovies.com") name = "production";
  else if (window.CASCADE_ENV === "production" || window.CASCADE_ENV === "staging") name = window.CASCADE_ENV;
  else name = "staging";
  window.CASCADE_CONFIG = {
    ENV: name,
    SUPABASE_URL: ENVIRONMENTS[name].SUPABASE_URL,
    SUPABASE_ANON_KEY: ENVIRONMENTS[name].SUPABASE_ANON_KEY,
  };
})();
