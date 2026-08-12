# Docker demo package

The repository contains Docker build definitions for the complete local demo:

- `web`: the built React/Vite reference application
- `api`: the Node document, storage, and search API
- `migrate`: a one-shot database migration using the API image
- `postgres`: PostgreSQL 17

PostgreSQL data uses a named Docker volume. Uploaded documents use the project's
Git-ignored `storage/documents` folder. Both survive normal container restarts
and `docker compose down`.

## Run on another machine

Prerequisites: Git and Docker Desktop with Linux containers enabled.

```powershell
git clone <YOUR-GITHUB-REPOSITORY-URL>
cd PDF_to_HTML
docker compose up -d --build --wait
```

Open <http://localhost:5173>. The API is available at
<http://localhost:3001>, and PostgreSQL is exposed on port `54329` for local
diagnostics.

Useful commands:

```powershell
docker compose ps
docker compose logs -f web api postgres
docker compose down
```

`docker compose down` preserves demo data. Adding `--volumes` deletes the demo
database, but it does not delete the project-local uploaded-document folder.

## Optional offline image archive

The normal GitHub workflow stores the small Dockerfile and Compose definition,
then builds images on the demo machine. Binary Docker archives are too large and
change too often to commit to Git.

If the other machine cannot download base images, create an archive on a
connected machine:

```powershell
npm run demo:export
```

This creates `artifacts/pdf-to-html-demo-images.tar`. The archive is deliberately
ignored by Git. Transfer it by USB or attach it to a GitHub Release, then run on
the demo machine:

```powershell
docker load --input .\artifacts\pdf-to-html-demo-images.tar
docker compose up -d --no-build --wait
```

## Ports and configuration

Copy `.env.example` to `.env` to override ports or local-only credentials. If
the web port changes, update all three values together before building:

```text
PDF_WEB_PORT=5273
VITE_DOCUMENT_API_BASE=http://localhost:3101
PDF_API_PORT=3101
CORS_ALLOWED_ORIGINS=http://localhost:5273
```

The checked-in credentials are for an isolated local demonstration only.
