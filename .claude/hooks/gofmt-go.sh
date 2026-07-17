#!/usr/bin/env bash
#
# Claude Code PostToolUse hook: auto-format Go files on edit.
#
# After the agent edits/writes a .go file, run `gofmt -w` on it so Go code is always
# canonically formatted regardless of how it was written. No-ops for non-Go files and
# when gofmt isn't installed. Never fails the tool (always exits 0); stays silent on
# stdout so it doesn't interfere with other hooks' JSON output.
set -euo pipefail

# The tool payload arrives as JSON on stdin; pull out the edited file path.
path="$(python3 -c 'import json,sys; print((json.load(sys.stdin).get("tool_input") or {}).get("file_path",""))' 2>/dev/null || true)"

case "$path" in
	*.go) ;;
	*) exit 0 ;;
esac

[ -f "$path" ] || exit 0
command -v gofmt >/dev/null 2>&1 || exit 0

gofmt -w "$path" >/dev/null 2>&1 || true
exit 0
