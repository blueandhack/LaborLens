# Public search sorting

PWD defaults to newest determination date, PERM to newest decision date, and the H-1B website to newest certification date. Each date supports newest/oldest ordering. All case pages also support received-date ordering; H-1B additionally retains last-action ordering. Missing primary dates follow dated results in either direction. Stable IDs resolve date ties; received-date ties use the program event date before the stable ID.

H-1B certification follows DOL's record layout: a currently Certified case uses its determination date; other statuses use the separately reported ORIGINAL_CERT_DATE. A Certified-Withdrawn case without an original date remains undated. A denial or withdrawal action never becomes an inferred certification. The last-action year filter and historical insights retain their explicitly labeled calendar-event semantics.

Reference: https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Record_Layout_FY2026_Q1.pdf

## API and navigation

The case API accepts `sort=event_desc|event_asc|received_desc|received_asc`, plus `certification_desc|certification_asc` for H-1B. Omitted sort retains the existing event-descending API contract; the H-1B UI explicitly requests certification ordering. Unrecognized sorts return HTTP 400.

The server orders the complete matching dataset before pagination. Counts and insights are independent of sort. Changing order resets the URL to page one, retains filters/layout/page size, and preserves the chosen order when returning from a case. Sorted result URLs are noindex; clean landing pages retain their canonical identity.

## Deployment

Before releasing the new controls, run `node scripts/prepare-sorting.js` in a bounded background worker using the production database. It creates three employer-directory volume indexes and three H-1B certification indexes sequentially. Existing indexes remain intact; source cases are not rewritten. The complete index contract can be read-checked with `node scripts/search-indexes.js --check` (15 H-1B indexes, 12 PWD and 12 PERM).

Certification pages merge bounded, disjoint streams of current certifications and original certification dates. Employer/title-prefix indexes keep sparse queries bounded. Deep pages expand bounded indexed windows until each date stream is complete for that page, then merge inside MongoDB; combined employer/worksite queries use their covering prefix index. All sorting queries have deadlines; only the displayed disclosures are fetched into the API response.

## Verification

Real MongoDB tests compare both directions against independently ordered complete matches, including ties, absent dates, withdrawn/denied records, overlapping locations, sparse and nonexistent employers, last pages and pages beyond the bounded in-memory merge. Profiler checks verify covered certification selection. Directory tests verify global volume/name ordering and pagination. Browser checks cover controls, URL state, case return, browser Back, server-rendered directory variants and phone/wide-screen layouts.
