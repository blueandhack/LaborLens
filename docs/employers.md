# Employer profiles and discovery

`/employers` is a searchable directory. `/employers/<name>--<id>` is a stable profile for an exact reported employer name, case-insensitive. Each profile separates H-1B, PERM, and PWD applications, with calendar-year history, reported wage ranges by original pay period, common jobs, employer addresses, primary worksites, recent cases, and DOL source links.

## Identity and interpretation

The identity key is the existing lowercase employer-name search field. Its SHA-256 prefix creates a stable 24-character ID; a readable slug accompanies the ID. Punctuation and whitespace variants are not automatically merged, nor are subsidiaries or renamed businesses. Identical reported names can still identify different legal entities. Profiles explicitly describe reported-name grouping and link similar spellings separately; they do not verify corporate identity or ownership.

Directory name suggestions normalize punctuation for discovery, but selecting a suggestion submits `employer=<exact key>`. Editing the employer input clears that exact selection and restores the existing punctuation-tolerant prefix search. The autocomplete is debounced, cancellable, keyboard-accessible, limited to eight suggestions ranked by filing volume within a bounded set of thirty-two indexed prefix candidates, and remains optional when suggestions cannot load.

Counts describe imported applications, not workers, visa approvals, current vacancies, or sponsorship commitments. H-1B calendar-year history uses the last recorded action, which can be a later withdrawal. Wage minima/maxima are reported ranges rather than typical salaries; pay periods remain separate. A missing date, location, or wage is not inferred. Profiles show snapshot dates and coverage limitations.

## Data preparation and refresh

`backend/scripts/refresh-employers.js` uses three independently selectable phases:

```sh
node scripts/refresh-employers.js --directory --profiles
node scripts/refresh-employers.js --worksites
```

The directory groups covered employer-name index metadata, then reads one projected example per name. This avoids loading every full disclosure into the application. Each completed program generation retires stale directory entries only after that entire program scan succeeds. Directory refreshes retain stable profile IDs and other programs while processing a program.

Profile summaries are materialized separately, using a narrow projection before bounded MongoDB facets. A refresh warms up to twenty initial profiles, including Synthropic where reported, plus requested profiles. Initial featured selection uses imported H-1B volume; it is not a recommendation or ranking of employers. Additional profiles build on demand, with one active computation per API process, per-query deadlines, retries after failures, and an explicit preparation state. Pending profiles remain noindex. Existing snapshots remain readable with their timestamp while a refresh runs.

The daily `laborlens-employer-refresh` CronJob runs on skycat with a 512 MiB Node heap, a one-core CPU limit, and a 768 MiB memory limit. A renewable database lease also prevents manual and scheduled refreshes from overlapping. Administrative program clearing removes corresponding directory counts and profile caches.

## Separate employer and worksite searches

`location` continues to mean the employer's business address. `worksite` searches the reported primary worksite city/state. They can be combined, including with exact employer selection, job title, case number, and dates. Additional worksites and alternate disclosures remain available in the original case details; this filter does not claim to search every secondary worksite.

The importer derives `_WORKSITE_CITY_LOWER`, `_WORKSITE_STATE_LOWER`, and `_DISCOVERY_VERSION` from reported canonical fields and known archive aliases. Worksite metadata never falls back to the employer's address. The resumable migration reads small batches, uses the same Unicode case-folding as the importer, groups equal derived locations into writes, and preserves source values and timestamps. Concurrent new imports with fresh metadata win over a migration batch.

Each program gains a normalization-progress index and three partial covering worksite indexes (city, state, recent date). There are twelve indexes per program collection after migration, including the original unique case-number index. The bounded recent-index trial preserves fast first pages for common worksite filters; incomplete trials fall back without truncating older matches. City/state overlaps are deduplicated for results, counts, and insights. No existing indexes are pruned in this release.

Worksite search is enabled per program only after normalization and all required indexes finish. `GET /api/employers/status` exposes readiness. During preparation the worksite control is disabled; employer search remains available. The daily refresh catches any older unnormalized records.

## Public rendering and deployment

Employer directory and profile requests are routed by the ingress to Express. The backend image includes the frontend's production React server bundle, template, and pruned runtime dependencies. It renders the same components used by the browser, with escaped JSON bootstrap data, unique metadata, canonical URLs, real 404s, and canonical-slug redirects. The frontend serves the matching hashed assets. CI builds the backend from the repository root; `deploy.sh` uses the same context.

Completed featured profiles appear in `/employers/sitemap.xml`; robots.txt advertises that sitemap. Directory and case-result links provide crawlable profile discovery. Unknown profiles have real HTTP 404 responses; pending summaries remain noindex. No ranking outcome is promised.

## Verification

MongoDB integration tests compare exact names, worksite/employer filters, overlapping branches, pagination, separate counts and insights. Profiler assertions check that normal worksite selections/counts use covered metadata and fetch only displayed disclosures. Tests also verify stable IDs, distinct punctuation variants, wage-period separation, history, source provenance, HTTP contracts, redirects, and missing pages.

Browser verification uses a separate local database and real APIs/SSR. It exercises directory and search autocomplete, keyboard selection, exact-name browsing, employer/worksite combinations, profile-to-case return navigation, responsive layouts from 320 to 3440 pixels, both themes, JavaScript-disabled profile content, and real 404s. Production verification should repeat representative public flows after the initial refresh completes.
