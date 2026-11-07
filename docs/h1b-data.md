# H-1B LCA data

The `/h1b` tab searches H-1B Labor Condition Applications (LCAs) in a separate `h1bcases` collection. Search, table/cards, pagination, URL state, details, year filters and optional Insights use the existing bounded query/cache infrastructure.

## Source and meaning

The source is the [DOL OFLC performance disclosure page](https://www.dol.gov/agencies/eta/foreign-labor/performance) and its main LCA workbook. The initial release is **FY2026 Q3**, covering decisions from October 1, 2025 through June 30, 2026. The [official record layout](https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY26Q3/LCA_Record_Layout_FY2026_Q3.pdf) defines the fields. The current main workbook has 437,496 nonblank data rows (formatted empty rows are ignored): full-file validation identified **426,952 distinct H-1B applications** and excluded 10,544 H-1B1/E-3 rows, with no missing case identifiers or duplicate H-1B applications.

- Only visa class H-1B (also accepting the spelling H1B) is imported. H-1B1 and E-3 records do not enter this collection. Missing visa classes fail preflight before case writes.
- These are DOL LCA application decisions, not USCIS petition or visa approvals. An application can request multiple workers. Search/Insights counts are applications, not worker counts.
- Cards show `WAGE_RATE_OF_PAY_FROM` / `WAGE_RATE_OF_PAY_TO` with `WAGE_UNIT_OF_PAY`. They are offered wages, not payroll observations. Hourly or missing-period values are never silently annualized. The separate source prevailing-wage fields remain available in details.
- Decision and received filters use the actual recorded calendar dates, not disclosure fiscal years. The initial release is partial-year data; earlier H-1B archives are not automatically backfilled.
- Location search uses employer city/state. The reported worksite appears alongside table results and in full details; it may differ from the employer address. Appendix/worksite supplement files are not counted as additional applications. Only the main-file worksite information is imported.
- Original source columns and any invalid source values are preserved. The first full-file audit found one Excel error in `EMPLOYER_PROVINCE`, retained as a source issue; it does not affect case IDs, search or wage fields.

## Import and operations

Create indexes before routing traffic to the new program. The migration script now also handles a program collection that does not yet exist. Each collection retains eight indexes, including the unique case-number index; MongoDB's configured cache budget is unchanged.

```sh
node scripts/search-indexes.js
node scripts/auto-import.js --programs=h1b --max-files=1
```

Run these in the backend environment with its private `MONGO_URI`. All files receive a complete preflight before database writes and use the shared import/clear/backup lease. Workbook download, parsing, source tracking, duplicate handling and historical-write protection use the established importer. A source's validation report records excluded visa classes and counts.

After normalization and preflight, H-1B uses native bulk upserts to avoid re-casting its wide disclosures through Mongoose. Creation/update timestamps are written explicitly, and replay preserves case IDs and creation times. A disposable 5,000-record benchmark took 4.84 seconds through schema casting versus 0.43 seconds with native writes; actual import time also includes parsing, network and index work. PWD/PERM retain their established write paths.

Weekly automatic imports discover the newest cumulative release for PWD, PERM and H-1B. Quarterly files are cumulative, so superseded quarters and supplement files are excluded. The hourly archive job explicitly selects `--programs=pwd,perm` so adding this tab does not launch a large H-1B historical backfill. `--programs` accepts a comma-separated subset; the CLI defaults to all three programs.

After successful imports, H-1B's saved whole-dataset Insights overview refreshes. The daily refresh also includes all three programs. Filtered analytics retain their five-second budget and optional lazy loading. Database backups include the new collection automatically because they dump the application database.

## Checks

The tests cover LCA file discovery/spelling variants, exclusion of H-1B1/E-3, wage/date/SOC mapping, multiple-worksite preservation, preflight failure before writes, empty-collection index creation, covered search/analytics, HTTP search/year/details/Insights consistency, application counts versus worker positions, hourly pay and URL state. The full official workbook is additionally audited privately outside Git.
