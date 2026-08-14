#!/bin/sh
set -eu

command="${1:-server}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  server)
    if [ "${PINECONE_MODE:-local}" = "local" ]; then
      sh /app/scripts/wait-for-http.sh "${PINECONE_CONTROLLER_HOST:-http://pinecone:5080}/indexes" "pinecone-local"
      sh /app/scripts/wait-for-http.sh "${OLLAMA_BASE_URL:-http://ollama:11434}/api/tags" "ollama"
      cd /app
      exec npx wrangler dev \
        --config deployments/example/cloudflare-worker/wrangler.jsonc \
        --ip 0.0.0.0 \
        --port "${PORT:-8787}" \
        --local-protocol http \
        --show-interactive-dev-session=false \
        --var "PINECONE_INDEX_NAME:${PINECONE_INDEX_NAME:-contextmcp-docs}" \
        --var "EMBEDDING_PROVIDER:${EMBEDDING_PROVIDER:-ollama}" \
        --var "EMBEDDING_MODEL:${EMBEDDING_MODEL:-${OLLAMA_MODEL:-nomic-embed-text}}" \
        --var "EMBEDDING_DIMENSIONS:${EMBEDDING_DIMENSIONS:-${OLLAMA_DIMENSIONS:-768}}" \
        --var "PINECONE_API_KEY:${PINECONE_API_KEY:-pclocal}" \
        --var "PINECONE_MODE:${PINECONE_MODE:-local}" \
        --var "PINECONE_CONTROLLER_HOST:${PINECONE_CONTROLLER_HOST:-http://pinecone:5080}" \
        --var "OLLAMA_BASE_URL:${OLLAMA_BASE_URL:-http://ollama:11434}" \
        --var "ENABLE_RERANK:${ENABLE_RERANK:-false}" \
        --var "OPENAI_API_KEY:${OPENAI_API_KEY:-}"
    fi
    cd /app
    exec npm run dev:example
    ;;
  reindex)
    exec /app/scripts/reindex.sh "$@"
    ;;
  help|-h|--help)
    printf '%s\n' "Usage: entrypoint.sh [server|reindex|<command> ...]"
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
