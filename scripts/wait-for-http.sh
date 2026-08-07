#!/bin/sh
set -eu

url="$1"
name="${2:-service}"
attempts="${3:-60}"
count=0

until curl -fsS "$url" >/dev/null 2>&1; do
  count=$((count + 1))
  if [ "$count" -ge "$attempts" ]; then
    printf '%s\n' "Timed out waiting for $name at $url" >&2
    exit 1
  fi
  sleep 2
done
