# LaborLens

A web application for searching U.S. Department of Labor Prevailing Wage Determination (PWD) and PERM labor certification cases. Built with React, Express/Node.js, and MongoDB.

## Features

- **PWD & PERM Search** — filter by company, job title, case number, location, and year
- **Comparison table & cards** — wide-screen tables with sticky headers and employer columns, plus responsive cards and a saved layout preference
- **Case Detail View** — wage and date summaries, grouped disclosure fields, original source values, and related PWD lookups
- **Excel Import** — stream-process large DOL `.xlsx` disclosure files into MongoDB with real-time progress
- **Admin Auth** — JWT-protected import and data management endpoints

Search filters, page size, pagination, and explicit layout choices stay in the URL. Employer, job-title, city/state, and case-number searches match the beginning of the reported value. Year filters use recorded calendar dates; missing dates are never inferred from fiscal years. PWD rates and PERM offered wages retain their reported pay periods.

## Local Development

MongoDB is pinned to 9.0.4 and the backend uses Node 24. See the [MongoDB migration and recovery notes](docs/mongodb-upgrade.md) before reusing an older database volume.

Optional encrypted Google Drive backup and isolated restore utilities are documented in the [backup setup and recovery guide](docs/google-drive-backup.md).

The **H-1B Search** tab at `/h1b` covers H-1B Labor Condition Applications from DOL disclosure data. It supports the same search, details, and Insights views as PWD/PERM. See [H-1B data coverage and import notes](docs/h1b-data.md).

### Docker (recommended)

```bash
docker-compose up --build -d
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:5001 |
| MongoDB | mongodb://localhost:27017 |

### Without Docker

```bash
# Backend
cd backend
cp .env.example .env   # fill in values
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

## Environment Variables

See `backend/.env.example` for all required variables:

| Variable | Description |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `ADMIN_INIT_PASSWORD` | Password for the initial admin account (used only when no admin exists) |

## Deployment

The project uses GitHub Actions + ArgoCD on k3s:

1. Push to `main` → GitHub Actions builds and pushes images to `ghcr.io/blueandhack/laborlens-*`
2. CI commits updated image tags to `k8s/`
3. ArgoCD detects the change and syncs the cluster automatically

To deploy your own instance:

1. Edit `k8s/argocd-app.yaml` with your repo URL
2. Create the required secret on your cluster:
   ```bash
   kubectl create secret generic laborlens-secrets \
     --from-literal=jwt-secret='...' \
     --from-literal=admin-init-password='...' \
     -n pwd-lookup
   kubectl label secret laborlens-secrets -n pwd-lookup app.kubernetes.io/instance=external
   ```
3. Update `k8s/ingress.yaml` with your domain
4. Apply the ArgoCD app:
   ```bash
   kubectl apply -f k8s/argocd-app.yaml
   ```

See `docs/secret.example.yaml` for the secret format.

## Data Source

Import DOL disclosure data from:
- [Foreign Labor Certification Data Center](https://flcdatacenter.com/) — PWD datasets
- [DOL PERM Disclosure Data](https://www.dol.gov/agencies/eta/foreign-labor/performance) — PERM datasets

## Automatic DOL imports

The `laborlens-auto-import` Kubernetes CronJob checks the official DOL performance
page every **Sunday at 3:00 AM America/Los_Angeles**. It checks **PWD and PERM
archives from FY2008 onward**, prioritizing the newest cumulative releases and
retaining all form variants. Up to four changed files are handled per weekly run.
The `laborlens-history-import` CronJob resumes two pending files each hour at
minute 15, oldest first, until the archive is complete. It skips completed files
without downloading them again and yields safely when another import is active.
Worksite and appendix files are excluded because they are not case disclosures.

DOL publishes PERM files back to **2008** and national PWD files starting in
**2010**. Missing PWD 2008–2009 files are reported as a coverage gap, not invented.
See [the complete historical audit](docs/historical-import-audit.md) and its
[per-file JSON results](docs/historical-import-audit.json).

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
