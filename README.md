# LaborLens

A web application for searching U.S. Department of Labor Prevailing Wage Determination (PWD) and PERM labor certification cases. Built with React, Express/Node.js, and MongoDB.

## Features

- **PWD & PERM Search** — filter by company, job title, case number, location, and year
- **Case Detail View** — full field breakdown for individual PWD and PERM records
- **Excel Import** — stream-process large DOL `.xlsx` disclosure files into MongoDB with real-time progress
- **Admin Auth** — JWT-protected import and data management endpoints

## Local Development

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
page every **Sunday at 3:00 AM America/Los_Angeles**. It imports the newest fiscal
year and latest cumulative release for **both PWD and PERM**, including multiple
form variants when a release has them. Existing historical cases are retained;
this job does not backfill every historical fiscal year. Worksite and appendix
files are excluded because they are not case disclosure records.

Files stream to temporary disk and records are upserted by `CASE_NUMBER`. HTTP
validators and SHA-256 hashes skip successfully imported files that have not
changed. Revised files at the same URL are reimported. A failed/partial import
is retried safely, and Kubernetes retries a failed job once. The importer refuses
to downgrade a program to an older release than one already imported.

Automatic imports, manual uploads, and clearing data share an expiring MongoDB
lease so they cannot write over each other. Failures are recorded instead of
silently counting incomplete imports as successful. Import history survives pod
restarts in `import_runs` and `import_sources`. The admin Import page shows the
latest checks, file progress, and errors. Year dropdown caches refresh within
10 minutes after a scheduled import.

The CronJob uses the same backend image as the web API; CI updates both image
tags together. Temporary files disappear when the job pod is removed. Job logs
are retained for seven days; durable history remains in MongoDB.

```bash
# Discover current file URLs without changing the database
cd backend
npm run import:dol -- --discover

# Import now using MONGO_URI from the environment or backend/.env
npm run import:dol

# Replay current files even when previously imported (for recovery)
npm run import:dol -- --force
```

From a cluster administrator session:

```bash
kubectl -n laborlens get cronjob laborlens-auto-import
kubectl -n laborlens create job --from=cronjob/laborlens-auto-import laborlens-import-manual-$(date +%s)
kubectl -n laborlens logs job/<job-name> -f
```

Run importer tests with `cd backend && npm test`. To include database integration
tests, provide `MONGO_TEST_URI` pointing to a disposable MongoDB instance. Tests
create and drop only a uniquely named `laborlens_import_test_*` database.
