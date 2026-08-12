# Getting Started

> Repository setup verified on 2026-08-12 for the Windows Docker demo workflow.

This guide covers publishing the project to GitHub and running the complete
demo on another Windows machine with Docker Desktop.

The Docker demo includes:

- React/Vite document-library frontend
- Node document and search API
- Automatic PostgreSQL migrations
- PostgreSQL 17
- Persistent database and uploaded-document storage

## 1. Publish the project to GitHub

The project folder is:

```text
E:\PDF_to_HTML
```

In GitHub Desktop:

1. Select **File → Add local repository**.
2. Select exactly `E:\PDF_to_HTML`.
3. If Desktop reports that it is not a Git repository, choose **Create a
   repository**.
4. Confirm that Desktop does not create another nested `PDF_TO_HTML` folder.
5. Review the files under **Changes**.
6. Enter `Initial commit` as the commit summary.
7. Select **Commit to main**.
8. Select **Publish repository**.
9. Choose the appropriate GitHub account or organization.
10. Keep the repository private unless every source file and sample document
    is approved for public distribution.
11. Select **Publish Repository**.

Before committing, review `src/example_documents/`. Those PDF files are not
ignored automatically and will be uploaded if included in the commit.

Do not commit:

- `.env`
- Runtime uploads under `storage/documents/`
- `node_modules/`
- `dist/`
- Docker image `.tar` archives
- Passwords, API keys, or confidential workplace documents

The checked-in `.gitignore` already excludes the common generated and local
runtime files above, except for the intentionally maintained example PDFs.

## 2. Recommended demo-machine setup

The recommended approach stores the Docker build definitions in GitHub and
builds the images on the demo machine.

Prerequisites:

- Git
- Docker Desktop
- Docker Desktop configured to use Linux containers
- Internet access for the first image build

Open PowerShell and run:

```powershell
git clone <YOUR-GITHUB-REPOSITORY-URL>
cd PDF_to_HTML
docker compose up -d --build --wait
```

When all services are healthy, open:

```text
http://localhost:5173
```

Local service addresses:

| Service | Address |
| --- | --- |
| Demo frontend | `http://localhost:5173` |
| Document API | `http://localhost:3001` |
| PostgreSQL | `localhost:54329` |

The first build may take several minutes while Docker downloads Node and
PostgreSQL base images. Later starts reuse the local images and build cache.

## 3. Check the running services

```powershell
docker compose ps
```

The `web`, `api`, and `postgres` services should report `healthy`. The
`migrate` service is expected to finish successfully and display `Exited (0)`.

To follow logs:

```powershell
docker compose logs -f web api postgres
```

To inspect migration output:

```powershell
docker compose logs migrate
```

Equivalent npm shortcuts are available after `npm install`:

```powershell
npm run demo:up
npm run demo:status
npm run demo:logs
npm run demo:down
```

Docker Compose commands do not require installing the project's Node packages
on the demo machine.

## 4. Stop and restart the demo

Stop the containers while preserving the database and uploaded documents:

```powershell
docker compose down
```

Start them again without rebuilding:

```powershell
docker compose up -d --no-build --wait
```

Uploaded documents are stored in the Git-ignored project folder:

```text
storage/documents/
```

PostgreSQL data is stored in the named Docker volume:

```text
pdf-to-html-postgres-data
```

Do not run `docker compose down --volumes` unless you intend to permanently
delete the demo database. That command does not delete `storage/documents/`,
so database and filesystem contents could become inconsistent afterward.

## 5. Optional offline image archive

Use this workflow when the demo machine cannot download or build Docker images.

On the connected development machine:

```powershell
npm run demo:export
```

This creates:

```text
artifacts\pdf-to-html-demo-images.tar
```

The archive is approximately 534 MB and contains:

- `pdf-to-html-web:demo`
- `pdf-to-html-api:demo`
- `postgres:17-alpine`

The archive is ignored by Git and should not be committed to the repository.
Transfer it by USB or attach it to a GitHub Release.

On the demo machine, download or copy the archive into the project and run:

```powershell
docker load --input .\artifacts\pdf-to-html-demo-images.tar
docker compose up -d --no-build --wait
```

Then open `http://localhost:5173`.

## 6. Change conflicting ports

If ports `5173`, `3001`, or `54329` are already in use, copy `.env.example` to
`.env` and update the values before building:

```text
PDF_WEB_PORT=5273
PDF_API_PORT=3101
PDF_DB_PORT=55329
VITE_DOCUMENT_API_BASE=http://localhost:3101
CORS_ALLOWED_ORIGINS=http://localhost:5273
```

Because the API address is embedded in the frontend build, rebuild after
changing `VITE_DOCUMENT_API_BASE`:

```powershell
docker compose up -d --build --wait
```

Open the configured frontend address, such as `http://localhost:5273`.

## 7. Common problems

### A port is already allocated

Stop the existing process/container or configure alternate ports in `.env`.

```powershell
docker compose ps
Get-NetTCPConnection -State Listen | Where-Object LocalPort -In 5173,3001,54329
```

### The frontend cannot reach the API

Confirm that the browser origin exactly matches `CORS_ALLOWED_ORIGINS` and that
`VITE_DOCUMENT_API_BASE` points to the host-visible API address. Rebuild the web
image after changing either value.

### Migrations fail

Inspect the migration and PostgreSQL logs:

```powershell
docker compose logs migrate postgres
```

Do not edit migrations that have already been applied. Add a new numbered
migration for schema changes.

### Docker Desktop is not running

Start Docker Desktop and wait until its engine reports that it is running:

```powershell
docker desktop status
docker version
```

### Rebuild after pulling changes

```powershell
git pull
docker compose up -d --build --wait
```

## 8. Development without the complete Docker stack

For normal local development, PostgreSQL can remain in Docker while the React
and Node processes run directly on Windows:

```powershell
npm install
npm run db:up
npm run db:migrate
npm run server
```

In a second PowerShell window:

```powershell
npm run dev
```

Open `http://localhost:5173`.

Do not run the host API/frontend and their Docker equivalents on the same ports
at the same time.
