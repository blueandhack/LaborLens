# Labor Case Lookup Portal

A web application for looking up and managing Prevailing Wage Determination (PWD) and PERM cases. The application features a React frontend, an Express/Node.js backend, and a MongoDB 8.x database, all containerized with Docker.

## Project Structure

- `frontend/`: React application built with Vite
- `backend/`: Node.js & Express API server
- `docker-compose.yml`: Configuration for running the entire stack locally

## Features

- **Import Excel Data**: Upload and parse large `.xlsx` datasets for PWD and PERM cases into the MongoDB database with real-time progress tracking.
- **Admin Authentication**: Secure the import and data cleanup functionality with an admin login system.
- **Advanced Search**: Search and filter cases by company, job title, case number, and dynamic year dropdowns that sync with existing database records.
- **Data Cleanup**: Quickly clear all case records from the database to start fresh.
- **Dockerized**: Easy setup and local development using Docker Compose.

## Prerequisites

- [Docker](https://www.docker.com/products/docker-desktop/) installed on your machine.
- [Node.js](https://nodejs.org/) (if running outside of Docker).
- **MongoDB 8.x** (if running outside of Docker).

## Getting Started

### Using Docker (Recommended)

To start the entire application stack (Frontend, Backend, and MongoDB), simply run:

```bash
docker-compose up --build -d
```

The services will be available at:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5001
- **MongoDB**: mongodb://localhost:27017

### Local Development (Without Docker)

You can also run the services individually for development. Configure the `.env` files in both directories according to your local setup as needed.

#### 1. Start MongoDB
Ensure you have a MongoDB 8.x instance running locally on port `27017`.

#### 2. Start the Backend server
```bash
cd backend
npm install
npm run dev
```
*(Runs on `http://localhost:5001` or the port defined in `PORT` env var)*

#### 3. Start the Frontend dev server
The frontend proxy dynamically points to the backend URL. You can specify it using the `BACKEND_URL` environment variable if your backend is not running on the default `localhost:5001`.
```bash
cd frontend
export BACKEND_URL=http://localhost:5001
npm install
npm run dev
```

## API Endpoints Overview

- `POST /api/upload`: Upload an Excel `.xlsx` file and stream progress as it processes into MongoDB (Requires Admin Auth).
- `DELETE /api/cases`: Clear all records from the database (Requires Admin Auth).
- `GET /api/search`: Search cases with filters.
- `GET /api/search/years`: Retrieve dynamic dropdown options for determination and received years.
- `GET /api/cases/:id`: Get case details by ID.
- `POST /api/admin/*`: Admin authentication, setup, and validation routes.

## Performance Note

The application includes an optimized Excel import pipeline utilizing asynchronous unordered batch inserts to process massive files efficiently with minimal memory overhead.
