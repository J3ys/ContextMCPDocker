#!/bin/sh
set -eu

ollama_host="${OLLAMA_HOST:-http://ollama:11434}"
attempts="${OLLAMA_WAIT_ATTEMPTS:-60}"
count=0

until OLLAMA_HOST="$ollama_host" ollama list >/dev/null 2>&1; do
  count=$((count + 1))
  if [ "$count" -ge "$attempts" ]; then
    printf '%s\n' "Timed out waiting for ollama at $ollama_host" >&2
    exit 1
  fi
  sleep 2
done

OLLAMA_HOST="$ollama_host" ollama pull "${OLLAMA_MODEL:-nomic-embed-text}"
