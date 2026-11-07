# H-1B LCA data

The `/h1b` tab searches H-1B Labor Condition Applications (LCAs) in a separate `h1bcases` collection. Search, table/cards, pagination, URL state, details, year filters and optional Insights use the existing bounded query/cache infrastructure.

## Source and meaning

The source is the [DOL OFLC performance disclosure page](https://www.dol.gov/agencies/eta/foreign-labor/performance) and its main LCA workbook. The initial release is **FY2026 Q3**, covering decisions from October 1, 2025 through June 30, 2026. The [official record layout](https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY26Q3/LCA_Record_Layout_FY2026_Q3.pdf) defines the fields. The current main workbook has 437,496 nonblank data rows (formatted empty rows are ignored): full-file validation identified **426,952 distinct H-1B applications** and excluded 10,544 H-1B1/E-3 rows, with no missing case identifiers or duplicate H-1B applications.

- Only visa class H-1B (also accepting the spelling H1B) is imported. H-1B1 and E-3 records do not enter this collection. Missing visa classes fail preflight before case writes.
- These are DOL LCA application decisions, not USCIS petition or visa approvals. An application can request multiple workers. Search/Insights counts are applications, not worker counts.
- Cards show `WAGE_RATE_OF_PAY_FROM` / `WAGE_RATE_OF_PAY_TO` with `WAGE_UNIT_OF_PAY`. They are offered wages, not payroll observations. Hourly or missing-period values are never silently annualized. The separate source prevailing-wage fields remain available in details.
- Decision and received filters use the actual recorded calendar dates, not disclosure fiscal years. The latest release is partial-year data. Historical backfill discovers the official annual files from FY2008 onward; FY2009 has separate legacy and iCERT files, and both are retained.
- H-1B calls the source `DECISION_DATE` **Last action date**. DOL defines it as the last significant event or determination, so it can be a withdrawal years after certification. The year filter and Insights timeline use that last action; they do not measure initial certification processing time. `RECEIVED_DATE` is labeled **DOL received**. The separate `ORIGINAL_CERT_DATE`, defined for Certified–Withdrawn applications, is shown when available and never inferred from a later event. H-1B does not display a receipt-to-decision duration. The API's `decisionYear` parameter is retained for existing links.
- Location search uses employer city/state. The reported worksite appears alongside table results and in full details; it may differ from the employer address. Appendix/worksite supplement files are not counted as additional applications. Only the main-file worksite information is imported.
- Original source columns and any invalid source values are preserved. The FY2026 Q3 audit found one `#NAME?` Excel error in `EMPLOYER_PROVINCE` for case `I-200-26154-978573`. Its reported employer address is Wixom, MI, USA, so the optional province was resolved as not applicable (null). `_DOL_CELL_ERRORS` retains the original error and `_DOL_CELL_RESOLUTIONS` records the resolution and source evidence. Validation reports show the original issue and its resolved count. The scoped, idempotent `scripts/repair-h1b-province.js --apply` repairs that verified production record and its report; subsequent imports apply the same conservative rule to US addresses with a reported valid state.

## Import and operations

Create indexes before routing traffic to the new program. The migration script now also handles a program collection that does not yet exist. Each collection retains eight indexes, including the unique case-number index; MongoDB's configured cache budget is unchanged.

```sh
node scripts/search-indexes.js
node scripts/auto-import.js --programs=h1b --max-files=1
```

Run these in the backend environment with its private `MONGO_URI`. All files receive a complete preflight before database writes and use the shared import/clear/backup lease. Workbook download, parsing, source tracking, duplicate handling and historical-write protection use the established importer. A source's validation report records excluded visa classes and counts.

After normalization and preflight, H-1B uses native bulk upserts to avoid re-casting its wide disclosures through Mongoose. Creation/update timestamps are written explicitly, and replay preserves case IDs and creation times. A disposable 5,000-record benchmark took 4.84 seconds through schema casting versus 0.43 seconds with native writes; actual import time also includes parsing, network and index work. PWD/PERM retain their established write paths.

Weekly automatic imports discover the newest cumulative release for PWD, PERM and H-1B. Quarterly files are cumulative, so superseded quarters and supplement files are excluded. The hourly archive job selects `--programs=pwd,perm,h1b` and resumes pending files from FY2008. Completed files are skipped and the shared import lease prevents overlapping writes. `--programs` accepts a comma-separated subset; the CLI defaults to all three programs.

After successful imports, H-1B's saved whole-dataset Insights overview refreshes. The daily refresh also includes all three programs. Filtered analytics retain their five-second budget and optional lazy loading. Database backups include the new collection automatically because they dump the application database.

## Checks

The tests cover LCA file discovery/spelling variants, exclusion of H-1B1/E-3, wage/date/SOC mapping, multiple-worksite preservation, preflight failure before writes, empty-collection index creation, covered search/analytics, HTTP search/year/details/Insights consistency, application counts versus worker positions, hourly pay and URL state. The full official workbook is additionally audited privately outside Git.

On November 7, 2026, production loading and the saved Insights overview both matched **426,952 applications**. The final replay inserted 391,952 applications and updated 35,000 from the first partial attempt, preserving existing case IDs. The feature passed **51 backend and nine frontend automated checks**, frontend lint, production builds and live HTTPS acceptance checks. The PWD archive job was resumed after loading, and temporary superseded loaders were removed.

Representative live HTTPS samples: whole-program overview 0.20 seconds; employer `google` search/Insights (7,389 matches) 0.21–0.22 seconds; title `software` (64,624 matches) 0.51 seconds. Concurrent PWD employer search took 0.48 seconds. These are samples, not latency guarantees. Browser visual verification was unavailable because the browser access host was offline; served navigation/layout assets, early theme handling, APIs and data invariants were checked directly.

## Legacy archive mappings and source gaps

The official performance page currently links 20 H-1B/LCA annual-release files
covering FY2008 through FY2026, including both FY2009 systems. Pre-2008 files
were historically hosted on `flcdatacenter.com`; its old `CaseH1B.aspx` endpoint
now redirects to a missing FLAG page. No earlier downloadable source has been
verified, so the application does not claim pre-2008 coverage.

Legacy `PROGRAM` / `PROGRAM_DESIGNATION` codes map according to DOL's FY2008
record layout: R = H-1B, A = E-3 Australian, C = H-1B1 Chile, S = H-1B1
Singapore. Only H-1B rows enter `h1bcases`. iCERT case, employer, job, wage,
worker-count and date aliases map to the same search fields as current files.
FY2015 explicit combined wage ranges are split into their reported bounds;
missing bounds and wage periods are never invented. FY2019's first worksite
maps to the summary, and every additional original worksite column remains in
the full record. Early three-digit occupation groups are retained under their
original columns and are not mislabeled as SOC codes.

The currently published `H-1B_FY2010.xlsx` lacks `VISA_CLASS`, offered-wage
period, and full-time columns present in DOL's corresponding record layout.
For that exact official file (SHA-256
`01c905de6fdb49489cca5a93942e04bd453ef671147696e19bfc564fc5c1d43b`),
the importer decodes visa classification from the reported iCERT case number.
[DOL's iCERT specification](https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/PW_FY17_Record_Layout.pdf)
defines `I` as a Labor Condition Application and visa IDs 200 = H-1B,
201 = H-1B1 Chile, 202 = H-1B1 Singapore, 203 = E-3 Australian. This recovery
requires the official URL, fiscal year, matching file hash, and a complete
`I-20x-xxxxx-xxxxxx` identifier. Unrecognized identifiers block the entire
file before case writes. Missing offered-wage periods remain null; prevailing
wage periods are never substituted for offered-wage periods.

`_DOL_DERIVED_FIELDS.VISA_CLASS` records the decoded value, original case number,
rule explanation, and DOL reference. Validation reports count recovered H-1B
rows and case details identify decoded classifications. Arbitrary uploads or
changed source files with missing visa columns still require source review.
Blocked sources are not repeatedly downloaded during hourly backfill; an updated
recovery rule or an explicit `--force` retries them. Program-specific discovery
preserves the other programs in archive coverage.

On November 7, 2026, FY2008 completed its production backfill: **399,211 H-1B
applications** inserted from 405,641 source rows, with 6,430 H-1B1/E-3 rows
excluded, zero rejected identifiers, and zero field-format issues. Public
case-number and employer/year searches and the FY2008 year dropdown were
verified. The continuing archive backfill runs as a Kubernetes job, with the
hourly historical schedule providing resumable fallback; its live per-file
status is available under Administration.

The full FY2010 read-only audit independently passed all 342,575 source rows:
336,024 distinct H-1B applications decoded from their documented case IDs,
6,551 H-1B1/E-3 rows excluded, and zero rejected rows. All offered-wage periods
remain unreported, and one invalid optional end date is preserved as a source
issue. This audit confirms import eligibility, not completed production loading
of FY2010; consult file history for that file's actual import result.
