#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if ! node --input-type=module -e "import('@pinecone-database/pinecone').then(() => process.exit(0)).catch(() => process.exit(1))" >/dev/null 2>&1; then
  printf '%s\n' 'Missing project dependency: @pinecone-database/pinecone' >&2
  printf '%s\n' 'Run `npm install` in the project root before using backup/restore scripts.' >&2
  exit 1
fi

node scripts/restore-local-index.mjs "$@"
