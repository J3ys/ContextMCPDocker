# ContextMCP Dockerized Setup

This repository wraps the upstream `dodopayments/context-mcp` project and provides two Docker Compose entrypoints:

- `docker-compose.local.yml` for fully local development with Ollama + Pinecone Local
- `docker-compose.cloud.yml` for app/reindex flows backed by cloud services

With new changes being made most likely it will be moved to a fork of the upstream project.

## Local mode

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Review `config.yaml` and replace the placeholder source before indexing.

3. Start Pinecone Local and Ollama:

```bash
docker compose -f docker-compose.local.yml up -d pinecone ollama
```

4. Pull the default embedding model:

```bash
docker compose -f docker-compose.local.yml --profile bootstrap run --rm ollama-bootstrap
```

   Alternatively, if Ollama is running directly on the host:

```bash
ollama pull nomic-embed-text
```

5. Run reindex:

```bash
docker compose -f docker-compose.local.yml --profile reindex run --rm reindex
```

6. Start the app:

```bash
docker compose -f docker-compose.local.yml up -d app
```

## Local Pinecone backup and restore

Pinecone Local is in-memory and does not provide native backup/restore.
This repository adds a repo-owned export/import workflow on top of the local API.

Because the local index is in memory, it is a good idea to create a backup right after a successful indexing run. That way you can restore the same local corpus after a reboot instead of rerunning a long reindex.

Before using the backup/restore scripts on a fresh clone, install the small host-side helper dependency:

```bash
npm install
```

Create a backup:

```bash
./scripts/backup-local-index.sh
```

This writes a new folder under `./backups/`, for example:

```text
backups/contextmcp-docs-2026-07-31T12-00-00Z/
```

Restore from the latest backup:

```bash
./scripts/restore-local-index.sh
```

Restore from a specific backup:

```bash
BACKUP_DIR=./backups/contextmcp-docs-2026-07-31T12-00-00Z ./scripts/restore-local-index.sh
```

Useful knobs:

- `BACKUP_ROOT` - where backup folders are created
- `BACKUP_DIR` - explicitly restore from a specific backup folder
- `BACKUP_BATCH_SIZE` - vectors per exported backup file
- `RESTORE_INDEX_NAME` - restore into a different local index name
- `RESTORE_CLEAR_FIRST=false` - keep existing vectors and upsert on top
- `RESTORE_UPSERT_BATCH_SIZE` - vectors per restore upsert request

Restore behavior notes:

- the restore script will create the target index if it does not exist
- if the target index already exists, restore validates dimension and metric compatibility before clearing anything

## Local multi-repo indexing (optional)

Instead of editing `config.yaml` per repository, you can index an arbitrary
list of local repositories by setting two variables in `.env`:

```bash
LOCAL_DOCS_ROOT=/absolute/path/to/your/projects
LOCAL_DOCS_REPOS=repo-one=java,repo-two=typescript:sub/path
```

- `LOCAL_DOCS_ROOT` is mounted read-only into the `reindex` container at `/workspace/repos`.
- `LOCAL_DOCS_REPOS` is a comma-separated list of `repo=language` pairs. Each
  `repo` must be a subdirectory name under `LOCAL_DOCS_ROOT`. `language` must
  be one of `java`, `typescript`, or `javascript`. You can optionally append a
  repo-relative subpath after the language (`repo=language:sub/path`) when the
  actual source code lives below the repo root, for example
  `Hybris=java:hybris/bin/custom`.
- Each repo is indexed as one mixed source set: the AST-aware `parser: code`
  chunker extracts method/function/class chunks from code files and whole-file
  chunks from text-like config/infra files (for example yaml/yml/json/
  properties/xml/toml/conf/cfg/ini, shell scripts, Dockerfiles, and common
  dot-config files such as `.gitignore`, `.dockerignore`, `.editorconfig`).
  Common build/tooling directories are still skipped (`.git`, `node_modules`,
  `build`, `.gradle`, `.idea`, etc.).
- When `LOCAL_DOCS_REPOS` is unset, this feature does nothing and reindex
  falls back to the source configured in `config.yaml`, unchanged.

Run it the same way as the standard local flow:

```bash
docker compose -f docker-compose.local.yml --profile reindex run --rm reindex
docker compose -f docker-compose.local.yml up -d app
```

## Cloud mode

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Change `.env` for cloud usage:

- set `PINECONE_MODE=cloud`
- set `PINECONE_API_KEY` to your real key
- clear `PINECONE_CONTROLLER_HOST`
- set `OPENAI_API_KEY`, or update `config.cloud.yaml` to a different embedding provider before setting that provider's key

3. Review `config.cloud.yaml` and replace the placeholder source before indexing.

4. Run the cloud reindex/app flow:

```bash
docker compose -f docker-compose.cloud.yml --profile reindex run --rm reindex
docker compose -f docker-compose.cloud.yml up -d app
```

## Notes

- Pinecone Local is development-only.
- Pinecone Local is in-memory and not production-safe.
- Pinecone Local records do not persist after shutdown.
- The Docker image vendors upstream ContextMCP `v0.5.0` and applies a small local-support patch at build time.
