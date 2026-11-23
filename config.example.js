// Cascade Web — front-end config (TEMPLATE)
//
// Copy this file to `config.js` (same folder) and fill in your Supabase project's
// URL and **anon** key. `config.js` is git-ignored, so your values never get committed.
//
//   cp config.example.js config.js   # then edit config.js
//
// Where to find these: Supabase dashboard → Project Settings → API.
//   • Project URL   → SUPABASE_URL
//   • anon / public → SUPABASE_ANON_KEY   (public-safe: row-level security protects the data)
//
// ⚠️ Only ever put the **anon** key here. The service_role key is a server-side secret
//    (GitHub Actions) and must NEVER appear in the front-end.
//
// If `config.js` is absent the site still loads fine in guest mode (localStorage only) —
// it just shows a "connect your account" note in the account panel. That's what lets CI /
// the dry-run build work with no keys.

// Two environments (CAS-1521): the tracked `config.js` carries a production and a staging Supabase
// project and picks one at load — cascademovies.com => production; otherwise window.CASCADE_ENV
// (written to www/env.js by ios-testflight.yml's `environment` input); otherwise staging. The choice
// is exposed as window.CASCADE_CONFIG.ENV. This template is for a single-project local setup.

window.CASCADE_CONFIG = {
  ENV: "staging",
  SUPABASE_URL: "https://YOUR-PROJECT-ref.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",
};
