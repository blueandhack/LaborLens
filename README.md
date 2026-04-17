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
