<div align="center">

# LaborLens

**Search U.S. Department of Labor PWD, PERM and H-1B LCA disclosure data — plus USCIS H-1B and I-140 statistics — in one place.**

[![Live site](https://img.shields.io/badge/live-laborlens.fyi-2ea44f?logo=googlechrome&logoColor=white)](https://laborlens.fyi)
[![Build](https://img.shields.io/github/actions/workflow/status/blueandhack/LaborLens/ci.yml?branch=main&label=build&logo=githubactions&logoColor=white)](https://github.com/blueandhack/LaborLens/actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/blueandhack/LaborLens?logo=git&logoColor=white)](https://github.com/blueandhack/LaborLens/commits/main)
[![GitHub stars](https://img.shields.io/github/stars/blueandhack/LaborLens?style=flat&logo=github)](https://github.com/blueandhack/LaborLens/stargazers)
[![Issues](https://img.shields.io/github/issues/blueandhack/LaborLens?logo=github)](https://github.com/blueandhack/LaborLens/issues)

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-9.0-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Kubernetes](https://img.shields.io/badge/k3s-ArgoCD-326CE5?logo=kubernetes&logoColor=white)](k8s/)

[Live site](https://laborlens.fyi) · [Data guide](https://laborlens.fyi/data) · [Documentation](#documentation) · [Report an issue](https://github.com/blueandhack/LaborLens/issues)

</div>

---

## Contents

- [Features](#features)
- [Data sources](#data-sources)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Data imports](#data-imports)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [Contributing](#contributing)

## Features

| Area | Route | What it does |
|---|---|---|
| **PWD search** | `/` | Prevailing Wage Determinations, filtered by employer, job title, case number, location and year |
| **PERM search** | `/perm` | PERM labor certifications, with related PWD lookups |
| **H-1B LCA search** | `/h1b` | DOL H-1B Labor Condition Applications (H-1B1/E-3 excluded) |
| **Case details** | `/cases/:id` | Wage and date summaries, grouped disclosure fields, original source values and alternate records |
| **Employers** | `/employers` | Employer identities merged across programs by normalized name, FEIN and USCIS tax ID |
| **Worksite map** | `/map` | Filings by state, metro, county, city and ZIP, with pan and zoom |
| **USCIS H-1B decisions** | `/h1b-approvals` | Initial and continuing approvals and denials from the USCIS H-1B Employer Data Hub |
| **I-140 statistics** | `/i140` | National USCIS Form I-140 counts |
| **Insights** | on each search | Calendar-year trends and outcome shares for any filter set |
| **Administration** | `/admin/data` | Admin-only uploads, automatic import status, coverage grid and validation reports |

- **Shareable state.** Search filters, page size, sort, pagination and layout choice all live in the URL.
- **Prefix search.** Employer, job-title, city/state and case-number searches match the beginning of the reported value; employer names tolerate punctuation and spacing differences.
- **Honest data.** Year filters use recorded calendar dates and never infer them from fiscal years. Wages keep their reported pay periods and are never silently annualized. Invalid source values are flagged and kept, not guessed.
- **Fast results.** Pages render before the total count is known; totals arrive separately. See [search performance](docs/performance.md).
- **Table or cards.** Wide-screen comparison tables with sticky headers, responsive cards on mobile, and a saved layout preference.

## Data sources

All case data comes from public U.S. government disclosures:

- [DOL OFLC performance data](https://www.dol.gov/agencies/eta/foreign-labor/performance) — PWD, PERM and H-1B LCA disclosure files
- [USCIS H-1B Employer Data Hub](https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub) — H-1B petition decisions
- [USCIS Immigration and Citizenship Data](https://www.uscis.gov/tools/reports-and-studies/immigration-and-citizenship-data) — I-140 statistics

Coverage: PERM and H-1B from FY2008, PWD from FY2010 (DOL links no national PWD files for FY2008–FY2009). LaborLens is an independent project and is not affiliated with the U.S. Department of Labor or USCIS.

## Tech stack

```
Browser ──► Frontend :3000 ──/api──► Backend :5001 ──► MongoDB :27017
           React 19 + Vite 8        Express 5 + Mongoose 9   MongoDB 9.0.8
           (build-time prerender)   (Node 24)
```

| Directory | Contents |
|---|---|
| [`frontend/`](frontend/) | React SPA with React Router; public pages are prerendered at build time for SEO |
| [`backend/`](backend/) | Express API (`routes/`, `models/`, `services/`) and the DOL import scripts |
| [`k8s/`](k8s/) | Kubernetes manifests, import CronJobs and the ArgoCD application |
| [`ops/`](ops/) | Optional encrypted Google Drive backup utilities |
| [`docs/`](docs/) | Design notes and data-coverage documentation |

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose, **or**
- Node.js 24 and MongoDB 9.0.8

MongoDB is pinned to 9.0.8. Read the [MongoDB migration and recovery notes](docs/mongodb-upgrade.md) before reusing an older database volume.

### With Docker (recommended)

```bash
git clone https://github.com/blueandhack/LaborLens.git
cd LaborLens
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
npm run dev            # http://localhost:5001

# Frontend (in a second terminal)
cd frontend
npm install
npm run dev            # http://localhost:3000
```

The database starts empty. Sign in to **Administration** (footer link, `/admin/data`) with the initial admin password to upload a DOL `.xlsx` file, or run the [importer](#data-imports).

## Configuration

See [`backend/.env.example`](backend/.env.example):

| Variable | Service | Description | Default |
|---|---|---|---|
| `PORT` | Backend | API port | `5001` |
| `MONGO_URI` | Backend | MongoDB connection string | `mongodb://localhost:27017/pwd_cases` |
| `JWT_SECRET` | Backend | Secret for signing admin JWTs (required in production) | — |
| `ADMIN_INIT_PASSWORD` | Backend | Password for the initial admin account, used only when no admin exists | — |
| `BACKEND_URL` | Frontend | Vite dev proxy target | `http://localhost:5001` |

## Testing

```bash
cd backend && npm test     # importer and API tests
cd frontend && npm test    # frontend unit tests
cd frontend && npm run lint
```

To include the database integration tests, set `MONGO_TEST_URI` to a disposable MongoDB instance. Tests create and drop only a uniquely named `laborlens_import_test_*` database. CI runs the full suite against MongoDB 9.0.8.

## Data imports

Large DOL workbooks are stream-processed, fully validated before any case is written, and upserted by `CASE_NUMBER`. In production, Kubernetes CronJobs check DOL every Sunday and backfill historical files hourly until the archive is complete.

```bash
cd backend
npm run import:dol -- --discover                                # list current files, no writes
npm run import:dol                                              # import current files
npm run import:dol -- --discover --from-year=2008               # inventory historical files
npm run import:dol -- --from-year=2008 --max-files=2 --backfill # resume backfill (safe to rerun)
npm run import:dol -- --force                                   # replay already-imported files
```

Scheduling, validation rules, duplicate handling, provenance and cluster commands are documented in [Automatic DOL imports](docs/automatic-imports.md).

## Deployment

The project deploys with GitHub Actions and ArgoCD on k3s:

1. A push to `main` runs the tests, then builds and pushes images to `ghcr.io/blueandhack/laborlens-*`.
2. CI commits the new image tags to [`k8s/`](k8s/).
3. ArgoCD detects the change and syncs the cluster.

To deploy your own instance:

1. Set your repository URL in [`k8s/argocd-app.yaml`](k8s/argocd-app.yaml).
2. Create the required secret (see [`docs/secret.example.yaml`](docs/secret.example.yaml)):
   ```bash
   kubectl create namespace laborlens
   kubectl create secret generic laborlens-secrets \
     --from-literal=jwt-secret='...' \
     --from-literal=admin-init-password='...' \
     --from-literal=mongodb-app-uri='mongodb://laborlens_app:...@laborlens-mongodb:27017/pwd_cases?authSource=pwd_cases' \
     --from-literal=mongodb-backup-local-uri='mongodb://laborlens_backup:...@127.0.0.1:27017/pwd_cases?authSource=admin' \
     -n laborlens
   kubectl label secret laborlens-secrets -n laborlens app.kubernetes.io/instance=external
   ```
3. Set your domain in [`k8s/ingress.yaml`](k8s/ingress.yaml).
4. Apply the ArgoCD application:
   ```bash
   kubectl apply -f k8s/argocd-app.yaml
   ```

Optional encrypted backups and isolated restore testing are covered in the [Google Drive backup guide](docs/google-drive-backup.md).

## Documentation

| Topic | Document |
|---|---|
| Automatic and historical imports | [docs/automatic-imports.md](docs/automatic-imports.md) |
| Historical import audit | [docs/historical-import-audit.md](docs/historical-import-audit.md) |
| H-1B LCA data and coverage | [docs/h1b-data.md](docs/h1b-data.md) |
| USCIS H-1B petition decisions | [docs/uscis-h1b.md](docs/uscis-h1b.md) |
| USCIS I-140 statistics | [docs/i140.md](docs/i140.md) |
| Employer identities | [docs/employers.md](docs/employers.md) |
| Worksite map | [docs/map.md](docs/map.md) |
| Search insights | [docs/search-insights.md](docs/search-insights.md) |
| Search sorting | [docs/search-sorting.md](docs/search-sorting.md) |
| Search performance | [docs/performance.md](docs/performance.md) |
| MongoDB upgrade and recovery | [docs/mongodb-upgrade.md](docs/mongodb-upgrade.md) |
| Encrypted backups | [docs/google-drive-backup.md](docs/google-drive-backup.md) |
| SEO audit | [docs/seo-strategy.md](docs/seo-strategy.md) |

## Contributing

Bug reports and pull requests are welcome. Please [open an issue](https://github.com/blueandhack/LaborLens/issues) to discuss larger changes first, and run the tests before submitting a PR.

If LaborLens is useful to you, a ⭐ on GitHub helps others find it.
