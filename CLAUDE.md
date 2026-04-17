# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Frontend (`/frontend`)
```bash
npm run dev        # Dev server on port 3000
npm run build      # Production bundle
npm run lint       # ESLint
npm run preview    # Preview production build
```

### Backend (`/backend`)
```bash
npm run dev        # Nodemon on port 5001
npm start          # Production server
```

### Docker (recommended for full stack)
```bash
docker-compose up --build -d   # Start frontend + backend + MongoDB
```

## Architecture

Single-page React app (Vite) backed by an Express API with MongoDB.

```
Browser → Frontend :3000 → /api proxy → Backend :5001 → MongoDB :27017
```

**Frontend** (`/frontend/src/components/`): Four views wired in `App.jsx`:
- `SearchView.jsx` — PWD case search with filters + pagination
- `PermSearchView.jsx` — PERM case search; joins to PWD via aggregation
- `ImportView.jsx` — Admin-gated Excel upload with real-time progress polling
- `CaseDetailsView.jsx` — Individual case detail; tries `Case` then `PermCase`

**Backend** (`/backend/`):
- `routes/` — Express route handlers for `/api/search`, `/api/upload`, `/api/cases`, `/api/admin`
- `models/` — Mongoose schemas: `Case` (PWD, 100+ dynamic fields), `PermCase`, `Admin`

## Key Patterns

**Excel Import**: Streaming via `exceljs.stream.xlsx.WorkbookReader` for memory efficiency. Batches of 5000 records, up to 4 concurrent, using `bulkWrite` with upsert. Background job tracked via `currentJob` state object; client polls `/api/upload/status`. Import type (PWD vs PERM) set with `?type=` query param.

**Search**: Case-insensitive regex on text fields; year-range filtering extracts year from date fields; PERM search uses `$lookup` aggregation to join to PWD cases via `JOB_OPP_PWD_NUMBER`.

**Auth**: JWT stored in `localStorage`, sent as `Authorization: Bearer <token>`. `bcryptjs` hashes passwords via Mongoose pre-save hook. Admin middleware guards upload and delete endpoints.

**URL state sync**: All search filters are reflected in URL query params (search state ↔ URL is bidirectional).

**Mongoose `strict: false`** is set on both `Case` and `PermCase` so arbitrary Excel columns are stored without schema changes.

## Environment Variables

| Variable | Service | Default |
|---|---|---|
| `PORT` | Backend | 5001 |
| `MONGO_URI` | Backend | `mongodb://localhost:27017/pwd_cases` |
| `JWT_SECRET` | Backend | *(required in prod)* |
| `BACKEND_URL` | Frontend (Vite proxy) | `http://localhost:5001` |
