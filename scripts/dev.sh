#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
	set -a
	# shellcheck disable=SC1091
	source "$ROOT/.env"
	set +a
fi

cd "$ROOT/server"
exec go run .
