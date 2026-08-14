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
      # Provide runtime vars to the Worker via a .dev.vars file (dotenv format)
      # instead of `--var KEY:VALUE`. wrangler's --var splits on ':', which
      # mangles values that contain colons (e.g. http://pinecone:5080), causing
      # those vars to be silently dropped. .dev.vars is loaded automatically by
      # `wrangler dev` and handles colons/slashes correctly.
      dev_vars="deployments/example/cloudflare-worker/.dev.vars"
      cat > "$dev_vars" <<EOF
PINECONE_INDEX_NAME=${PINECONE_INDEX_NAME:-contextmcp-docs}
EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER:-ollama}
EMBEDDING_MODEL=${EMBEDDING_MODEL:-${OLLAMA_MODEL:-nomic-embed-text}}
EMBEDDING_DIMENSIONS=${EMBEDDING_DIMENSIONS:-${OLLAMA_DIMENSIONS:-768}}
PINECONE_API_KEY=${PINECONE_API_KEY:-pclocal}
PINECONE_MODE=${PINECONE_MODE:-local}
PINECONE_CONTROLLER_HOST=${PINECONE_CONTROLLER_HOST:-http://pinecone:5080}
OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-http://ollama:11434}
ENABLE_RERANK=${ENABLE_RERANK:-false}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
GEMINI_API_KEY=${GEMINI_API_KEY:-}
EOF
      exec npx wrangler dev \
        --config deployments/example/cloudflare-worker/wrangler.jsonc \
        --ip 0.0.0.0 \
        --port "${PORT:-8787}" \
        --local-protocol http \
        --show-interactive-dev-session=false
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
