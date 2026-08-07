#!/bin/sh
set -eu

if [ "${PINECONE_MODE:-local}" = "local" ]; then
  sh /app/scripts/wait-for-http.sh "${PINECONE_CONTROLLER_HOST:-http://pinecone:5080}/indexes" "pinecone-local"
  sh /app/scripts/wait-for-http.sh "${OLLAMA_BASE_URL:-http://ollama:11434}/api/tags" "ollama"
fi

cd /app

if [ -n "${LOCAL_DOCS_REPOS:-}" ]; then
  sh /app/scripts/generate-local-repos-config.sh /app/config.local-repos-base.yaml /tmp/generated-config.yaml
  exec npm run reindex:dodo -- --config /tmp/generated-config.yaml "$@"
fi

exec npm run reindex:dodo -- "$@"
