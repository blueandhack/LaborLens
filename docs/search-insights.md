# Search insights

Select **Explore insights** above PWD or PERM results. With filters, it analyzes all matching cases, independent of the visible page or table/card layout. With no filters, it shows the imported dataset overview for that program. **Explore all data** clears the current filters. Select a year on the trend or in the accessible data table to apply that year filter.

## What the charts mean

- The trend counts each stored case once by its actual determination date (PWD) or decision date (PERM), in UTC calendar years. It does not use disclosure fiscal years, receipt dates, filing totals, or alternate source/worksite records as additional cases.
- Null, non-date, and out-of-range dates are excluded from the trend and explicitly counted below it. Empty calendar years show zero matching *imported* records; historical coverage is expanding, so gaps do not imply that no applications existed.
- Outcomes trim whitespace and normalize status case. DOL distinctions such as Certified versus Certified-Expired remain separate. Blank/non-string statuses become Not Reported. The six largest statuses are named; the remaining count is Other statuses. Counts and shares include cases without usable dates. These are descriptive status shares, not a prediction or an approval probability.
- An overview is a saved summary, with its calculation time displayed in the viewer's local timezone. It can differ from the current results total while an import is running. A stale summary is explicitly marked when an import changes its revision or it is older than 24 hours. Imports and analytics are not a transactionally frozen database snapshot.

The charts use SVG with exact text values, native point tooltips, keyboard-accessible year links, a full data table, light/dark tokens, and reduced-motion support. They do not depend on a chart library or transmit data to an external analytics service.

## Template selection

The Lieflat Charts skill's actual `templates/basics-gallery.html` implementations supply the chart geometry, adapted to React and the existing LaborLens typography/theme.

| Data | Candidates compared | Selected implementation |
| --- | --- | --- |
| One annual count series | L11 event lineage describes individual events, not yearly counts; L3 barcode suits dense daily observations; F1 ladder bars can compare years but lack the continuous calendar floor | **F2 Hairline Line**, card “Thirty days of sign-ups”, source block B2: calendar floor, unsmoothed path, dots and separated peak labels. One dot becomes one calendar year; no invented weekend encoding. |
| Status composition with long labels | L14 waffle rounds small categories; F4 donut makes small shares hard to compare and needs detached labels | **F5 Tick Rows**, card “Six teams, shipped and counted”, source block C1: labeled horizontal queues, guide, repeated ticks, every-fifth mark and exact counts. Each full tick is 2%; a partial tick has proportional width. |

Mono is adapted consistently to existing paper/ink theme tokens. Each figure retains its title, subtitle, plot and source line. Year selection replaces the standalone template's replay interaction because it performs useful case research.

## Performance and refresh

`GET /api/search/insights` and `GET /api/search/perm/insights` accept the same filters as search. Pagination and view parameters do not affect analysis. The UI loads the chart JS/CSS and requests data only after expansion; case results load independently.

Filtered work has a shared five-second database budget, no disk spill, one active computation per API process, and a bounded 32-entry, 60-second single-flight cache. Identical requests share work. Distinct concurrent work receives a recoverable error instead of creating a queue. A disconnected reader does not cancel a computation another reader shares; that work still has the five-second limit. HTTP responses cache for 15 seconds. Oversized status vocabularies (over 1,000 distinct normalized statuses per stream) fail explicitly, rather than returning misleading top categories or retaining unbounded application state.

Covering indexes include status alongside filter/date metadata. Employer/title/date queries use their corresponding metadata streams. Location queries use disjoint city and state streams: the state stream excludes city matches, preventing duplicates where both prefixes match. Analytics never fetches large disclosure documents for these paths. Specific case-number queries may fetch their few matching documents through the unique identifier index.

Unfiltered overview requests read one small persisted document in `search_insights`, rather than scanning millions of cases. Summaries refresh after successful automatic imports, after manual imports, and daily at **03:45 America/Los_Angeles** as a recovery path. Background computations run sequentially per program with a 60-second limit each. A revision check prevents an older refresh from overwriting a later import/clear; clearing data also removes its summary. Refresh failure does not mark a completed import as failed.

To seed or rebuild summaries after creating the indexes, run in the backend environment with its private `MONGO_URI`:

```sh
node scripts/search-indexes.js
node scripts/refresh-insights.js --force
```

Build new index versions before deploying the code that hints them. Once all new replicas are ready, prune known obsolete indexes with `node scripts/search-indexes.js --check --prune-obsolete`. Eight indexes remain per case collection. The MongoDB cache remains 384 MiB. Old application images require their old hinted indexes to be rebuilt before a rollback after pruning.

## Validation

MongoDB 9 integration tests compare all supported filter combinations to case-search matches, including overlapping city/state prefixes, mixed-case states and case numbers, missing dates, qualified outcomes, more than one page, empty results, shared requests and refresh/clear races. Database profiler assertions require zero full-document reads on normal analytics paths. Frontend tests verify calendar gaps/count conservation and fractional tick shares, including tiny categories and empty data.
