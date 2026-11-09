# Employer profiles and discovery

`/employers` is a searchable directory of employer identities. `/employers/<name>--<id>` is a stable profile for one identity: every reported filing name that the identity rules below combine. Each profile separates H-1B, PERM, and PWD applications, with calendar-year history, reported wage ranges by original pay period, common jobs, employer addresses, primary worksites, recent cases, and DOL source links.

## Identity and interpretation

DOL disclosures record the employer name as typed on each application, and programs disagree: Cognizant files H-1B LCAs as `COGNIZANT TECHNOLOGY SOLUTIONS US CORP` and `... U.S. CORPORATION`, but PERM applications as `... US CORPORATION`. An exact-name profile therefore showed zero PERM cases. Profiles and directory rows now describe an *employer identity*, built from three kinds of evidence (`backend/services/employerIdentity.js`):

1. **Normalized spelling.** Names that are identical after case folding, removing punctuation, spacing, accents and apostrophes, joining single letters (`U.S.A.` → `usa`, `L.L.C.` → `llc`), `&` → `and`, dropping a leading `the`, and abbreviating corporate words (`corporation`/`corp`, `incorporated`/`inc`, `company`/`co`, `limited`/`ltd`, `private`/`pvt`, `international`/`intl`). The legal form must agree, so `ACME LLC` never merges with `ACME, INC.`; names that add or remove words (`Infosys BPM Limited`) stay separate.
2. **Employer FEIN.** Recent PERM and PWD disclosures report the employer's FEIN (H-1B LCAs do not). Two normalized names link when the same valid FEIN accounts for at least 60% of each name's FEIN-bearing filings, and they also share a 5-digit business ZIP code. (Production review showed unrelated employers in different states reporting one FEIN, so volume alone never links.) A FEIN claimed by more than six names is treated as an umbrella (for example a university system) and links nothing. An identity joins at most twelve normalized names through FEIN links, strongest links first. This catches renames such as Facebook, Inc. → Meta Platforms, Inc. (FEIN ending 5019, ZIP 94025).
3. **Reviewed links** in `backend/services/employerGroups.js`, for documented history that predates FEIN disclosure (Infosys Technologies Limited → Infosys Limited). Each reviewed key also brings its normalized spelling variants. Additions require source evidence.

The canonical name is the member with the most imported filings (or the reviewed group's name), so its existing slug stays the profile URL; every other member's URL and ID redirects or resolves to it. Profiles list each source name with its own counts and exact-name case links, the evidence used (FEIN endings, ZIP codes, example cases), and the policy that related companies with different names, such as subsidiaries, are not included. Identical or normalized names can still belong to different legal entities; profiles say so.

Directory name suggestions normalize punctuation for discovery. Selecting a combined identity submits `employerGroup=<identity ID>`; a single-name identity submits `employer=<exact key>`. A member's ID is accepted as `employerGroup` too, so links stay valid when the canonical member changes. Typing a complete reviewed name still resolves to its identity. Explicit exact-name filters retain their original meaning. The autocomplete is debounced, cancellable, keyboard-accessible, limited to eight identities ranked by filing volume within two hundred indexed prefix candidates, and remains optional when suggestions cannot load.

Counts describe imported applications, not workers, visa approvals, current vacancies, or sponsorship commitments. H-1B calendar-year history uses the last recorded action, which can be a later withdrawal. Wage minima/maxima are reported ranges rather than typical salaries; pay periods remain separate. A missing date, location, or wage is not inferred. Profiles show snapshot dates and coverage limitations. A zero can still be genuine: a foreign subsidiary (for example IBM India Private Limited) files H-1B LCAs but not PERM applications.

## Data preparation and refresh

`backend/scripts/refresh-employers.js` uses four independently selectable phases (identities always follow a directory refresh):

```sh
node scripts/refresh-employers.js --directory --profiles   # directory, then identities, then profiles
node scripts/refresh-employers.js --identities              # rebuild identities from the current directory
node scripts/refresh-employers.js --worksites
```

The directory groups covered employer-name index metadata, then reads one projected example per name. This avoids loading every full disclosure into the application. Each completed program generation retires stale directory entries only after that entire program scan succeeds. Directory refreshes retain stable profile IDs and other programs while processing a program.

The identity phase backfills each reported name's `nameKey`, scans FEIN-bearing PERM/PWD records in natural order (only recent disclosures carry FEINs), groups directory names by `nameKey` inside MongoDB, and merges FEIN/reviewed links in memory. Only linked clusters are buffered, so memory stays bounded. Each run upserts `employer_identities` with a new generation, writes `identity`/`identitySlug` onto changed reported names, and retires identities from older generations only after every name has its current identity. Until the first build finishes, directory and profile reads fall back to exact reported names. A name added by a directory refresh is its own identity until the next build.

Profile summaries are materialized separately, using a narrow projection before bounded MongoDB facets. A refresh warms up to twenty initial profiles, including Synthropic where reported, plus requested profiles. Initial featured selection uses imported H-1B volume; it is not a recommendation or ranking of employers. Additional profiles build on demand, with one active computation per API process, per-query deadlines, retries after failures, and an explicit preparation state. Pending profiles remain noindex. Existing snapshots remain readable with their timestamp while a refresh runs.

The daily `laborlens-employer-refresh` CronJob runs on skycat with a 512 MiB Node heap, a one-core CPU limit, and a 768 MiB memory limit. A renewable database lease also prevents manual and scheduled refreshes from overlapping. Administrative program clearing removes corresponding directory counts and profile caches.

## Separate employer and worksite searches

`location` continues to mean the employer's business address. `worksite` searches the reported primary worksite city/state. They can be combined, including with exact employer selection, job title, case number, and dates. Additional worksites and alternate disclosures remain available in the original case details; this filter does not claim to search every secondary worksite.

The importer derives `_WORKSITE_CITY_LOWER`, `_WORKSITE_STATE_LOWER`, and `_DISCOVERY_VERSION` from reported canonical fields and known archive aliases. Worksite metadata never falls back to the employer's address. The resumable migration reads small batches, uses the same Unicode case-folding as the importer, groups equal derived locations into writes, and preserves source values and timestamps. Concurrent new imports with fresh metadata win over a migration batch.

Each program gains a normalization-progress index and three partial covering worksite indexes (city, state, recent date). Worksite preparation brings each program to twelve indexes, including the original unique case-number index. The separate certification-sort migration adds three H-1B indexes (fifteen H-1B indexes in total). The bounded recent-index trial preserves fast first pages for common worksite filters; incomplete trials fall back without truncating older matches. City/state overlaps are deduplicated for results, counts, and insights. No existing indexes are pruned in this release.

Worksite search is enabled per program only after normalization and all required indexes finish. `GET /api/employers/status` exposes readiness. During preparation the worksite control is disabled; employer search remains available. The daily refresh catches any older unnormalized records.

## Public rendering and deployment

Employer directory and profile requests are routed by the ingress to Express. The backend image includes the frontend's production React server bundle, template, and pruned runtime dependencies. It renders the same components used by the browser, with escaped JSON bootstrap data, unique metadata, canonical URLs, real 404s, and canonical-slug redirects. The frontend serves the matching hashed assets. CI builds the backend from the repository root; `deploy.sh` uses the same context.

Completed featured profiles appear in `/employers/sitemap.xml`; robots.txt advertises that sitemap. Directory and case-result links provide crawlable profile discovery. Unknown profiles have real HTTP 404 responses; pending summaries remain noindex. No ranking outcome is promised.

## Verification

MongoDB integration tests compare exact names, worksite/employer filters, overlapping branches, pagination, separate counts and insights. Profiler assertions check that normal worksite selections/counts use covered metadata and fetch only displayed disclosures. Tests also verify stable IDs, distinct punctuation variants, wage-period separation, history, source provenance, HTTP contracts, redirects, and missing pages.

Browser verification uses a separate local database and real APIs/SSR. It exercises directory and search autocomplete, keyboard selection, exact-name browsing, employer/worksite combinations, profile-to-case return navigation, responsive layouts from 320 to 3440 pixels, both themes, JavaScript-disabled profile content, and real 404s. Production verification should repeat representative public flows after the initial refresh completes.

## Directory ordering

The directory browses every employer identity in pages of 24. Its default is most imported H-1B applications; alternatives are PERM volume, PWD volume, and normalized name A–Z/Z–A. Counts combine the identity's filing names and include all imported years and all case statuses. Equal volumes use normalized name and then stable ID. Sorting and prefix search apply before pagination, and their URL parameters survive browser navigation. Autocomplete retains its separate bounded suggestions endpoint.

Identity sort indexes cover the selected program count, normalized search name and stable ID; prefix searches read a multikey index of every member's search name and normalized name. Only the displayed employers are then fetched. The profile sitemap still includes completed featured summaries. Additional employer summaries prepare on demand.


## Reviewed filing-name groups

`backend/services/employerGroups.js` contains explicit, source-reviewed links that automatic evidence cannot establish. The Infosys group links `infosys limited`, `infosys ltd.` and their spelling variants with the documented former `infosys technologies limited` name. DOL corporate address/tax-ID-ending metadata and Infosys's official [naming history](https://www.infosys.com/investors/shareholder-services/faqs.html) support the reviewed links. Infosys Public Services, BPM/BPO, Consulting, Solutions and other similarly named companies are not included.

The Google group links `google llc` with its former legal name `google inc.` (and their spelling variants). Alphabet's [FY2017 Form 10-K](https://www.sec.gov/Archives/edgar/data/0001652044/000165204418000007/goog10-kq42017.htm) states that Google Inc. converted into a limited liability company in September 2017; DOL filings under both names report 1600 Amphitheatre Parkway, Mountain View, CA 94043. Google Inc. filings predate FEIN disclosure, so no automatic link exists. Other Google-named entities are not included.

Group and identity queries translate to a bounded exact-name `$in`, never a broad brand prefix. Conflicting exact/group filters and unknown IDs return HTTP 400. The original case names, case IDs and source fields are unchanged.

Combined snapshots use a membership-derived cache ID (`<identity>:names:<scope>`), isolated from exact-name caches, so a previously cached zero PERM summary cannot be reused for a combined profile. Single-name identities keep their existing cache. `node scripts/refresh-employer-groups.js` (or `--group=<reviewed ID>`) prepares reviewed-group snapshots after an identity build; the daily profile refresh also uses identities. Registry changes do not rewrite case records or require new case indexes.
