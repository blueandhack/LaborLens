# Automatic DOL imports

The `laborlens-auto-import` Kubernetes CronJob checks the official DOL performance
page every **Sunday at 3:00 AM America/Los_Angeles**. It checks the latest **PWD, PERM and H-1B** releases. Historical backfill covers
**all three programs from FY2008 onward**, prioritizing the newest cumulative releases and
retaining all form variants. Up to six changed files are handled per weekly run.
The `laborlens-history-import` CronJob resumes two pending files each hour at
minute 15, oldest first, until the archive is complete. It skips completed files
without downloading them again and yields safely when another import is active.
Worksite and appendix files are excluded because they are not case disclosures.

DOL publishes PERM files back to **2008** and national PWD files starting in
**2010**. Missing PWD 2008–2009 files are reported as a coverage gap, not invented.
H-1B legacy layouts and the verified FY2010 field recovery are documented in
[H-1B data coverage and import notes](h1b-data.md).
See [the complete historical audit](historical-import-audit.md) and its
[per-file JSON results](historical-import-audit.json).

Files stream to temporary disk and records are upserted by `CASE_NUMBER`. HTTP
validators and SHA-256 hashes skip successfully imported files that have not
changed. Revised files at the same URL are reimported. A failed/partial import
is retried safely, and Kubernetes retries a failed job once. Both jobs have a
six-hour deadline and a shared lease so only one import writes at a time.

Every workbook receives a **full-row preflight before any case writes**. Legacy
headers, schema aliases, the 1904 Excel date system, and zero-padded postal codes
are supported. Invalid optional dates/numbers become null with original values
retained in `_DOL_RAW_VALUES`; Excel error cells are retained in `_DOL_CELL_ERRORS`.
Missing case identifiers prevent the entire file from being imported.

Duplicates select the latest recorded decision/review event. Identical repeats
are collapsed; distinct records, including same-event worksite variants, are
retained in `_DOL_ALTERNATE_RECORDS`. Same-event ties prefer explicit review dates,
then the first source row. Missing pay periods are displayed as unreported;
the application never assumes an annual wage or shifts a calendar date by the
viewer's time zone.

Historical imports cannot overwrite tracked newer releases. For pre-existing
records without provenance, they fill only missing canonical/search fields,
preferring that record's own legacy aliases. Existing nonempty values are kept.
New or refreshed records receive `_DOL_SOURCE` provenance, including source URL,
fiscal year, quarter, file hash, and mapping version.

Automatic imports, manual uploads, and clearing data share an expiring MongoDB
lease so they cannot write over each other. Failures are recorded instead of
silently counting incomplete imports as successful. Import history survives pod
restarts in `import_runs` and `import_sources`. **Administration** in the footer
opens `/admin/data` (the old `/import` URL redirects there). Automatic imports
show the latest checks, coverage gaps, file progress, and searchable file history.
The live dashboard shows separate H-1B, PWD, and PERM release-file progress,
active-file case counters, and a clickable fiscal-year / quarter coverage grid.
It refreshes every 15 seconds. **Imported** means that quarterly release was
imported directly; **Covered** means a later cumulative or annual file includes
the quarter. Select a cell to inspect its source files and validation details.
Validation reports open inline with issue counts, example rows, missing values,
and field mappings; JSON export remains available. Manual uploads and access
controls have separate sections, with dataset deletion tucked under manual
upload. Case details expose invalid original values and alternate records.
Year dropdown caches refresh within 10 minutes after a scheduled import.

The CronJob uses the same backend image as the web API; CI updates both image
tags together. Temporary files disappear when the job pod is removed. Job logs
are retained for seven days; durable history remains in MongoDB.

```bash
# Discover current file URLs without changing the database
cd backend
npm run import:dol -- --discover

# Import now using MONGO_URI from the environment or backend/.env
npm run import:dol

# Inventory all available historical files
npm run import:dol -- --discover --from-year=2008

# Resume two pending historical files (safe to rerun)
npm run import:dol -- --from-year=2008 --max-files=2 --backfill

# Replay current files even when previously imported (for recovery)
npm run import:dol -- --force
```

From a cluster administrator session:

```bash
kubectl -n laborlens get cronjob laborlens-auto-import
kubectl -n laborlens get cronjob laborlens-history-import
kubectl -n laborlens create job --from=cronjob/laborlens-auto-import laborlens-import-manual-$(date +%s)
kubectl -n laborlens create job --from=cronjob/laborlens-history-import laborlens-history-manual-$(date +%s)
kubectl -n laborlens logs job/<job-name> -f
```

Run importer tests with `cd backend && npm test`. To include database integration
tests, provide `MONGO_TEST_URI` pointing to a disposable MongoDB instance. Tests
create and drop only a uniquely named `laborlens_import_test_*` database.
