# Catalogue sizing — TMDB discover total_results (CAS-354, CAS-522)

Measured 2026-11-19 by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) where the TMDB key exists.

## Current scope (pipeline-identical: with_release_type=2|3, region=AU, 2023-11-20..2026-11-19, sort_by=popularity.desc)

- total_results: 1976
- total_pages: 99

## Widened scope, unbounded (everything watchable in AU across all of film history: watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, no release_type restriction, no date bound)

- total_results: 20001
- total_pages: 1001

## Widened scope, 3yr-bounded (same AU-watchable query as above, but bounded to the same 2023-11-20..2026-11-19 window as current-scope — extra non-cinema-release titles within the 3 years we already cover)

- total_results: 17172
- total_pages: 859

## Quality-gated pool (AU-watchable, watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, sort_by=popularity.desc — CAS-548)

| # | Window | vote_average.gte | vote_count.gte | total_results | total_pages |
| --- | --- | --- | --- | --- | --- |
| 1 | in-window (2023-11-20..2026-11-19) | 5.9 | 0 | 9230 | 462 |
| 2 | in-window (2023-11-20..2026-11-19) | 5.9 | 50 | 5121 | 257 |
| 3 | in-window (2023-11-20..2026-11-19) | 5.9 | 250 | 3474 | 174 |
| 4 | pre-window (release_date.lte=2023-11-19, no lower bound) | 5.9 | 50 | 14999 | 750 |

