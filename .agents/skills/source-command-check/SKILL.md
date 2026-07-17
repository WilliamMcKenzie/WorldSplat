---
name: "source-command-check"
description: "Build, vet, and test the Go server + run the client unit tests"
---

# source-command-check

Use this skill when the user asks to run the migrated source command `check`.

## Command Template

Run the repo's health checks and report a concise pass/fail summary. Do NOT fix
anything unless I ask — just run and report.

1. **Format check** — `gofmt -l server` (lists unformatted files; empty = clean).
2. **Build** — `cd server && go build ./...`
3. **Vet** — `cd server && go vet ./...`
4. **Go tests** — `cd server && go test ./...`
5. **Client unit tests** — `node --test client/tests/*.test.mjs`
   (glob the files — passing the bare directory fails spuriously).

Report each step as ✅/❌ with the key output line. If anything fails, show the
relevant error and stop before later steps only if the failure blocks them
(e.g. a build failure makes tests moot).
