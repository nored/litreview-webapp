#!/usr/bin/env bash
# Replay ONE dumped LLM request. POSTs the user prompt + schema to the
# live server's /v1/chat/completions endpoint, prints a clean summary.
#
# Usage:
#   bash tests/quality/probes/replay.sh paper012/claims_contribution
#   bash tests/quality/probes/replay.sh paper012/numerical_01_table_012_tbl_0
#   bash tests/quality/probes/replay.sh paper012/stance_batch_01
#
# Argument is the request name relative to tests/quality/probes/, without
# the _user.txt or _schema.json suffix.

set -euo pipefail

HOST="${LR_HOST:-http://localhost:4174}"
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: bash $0 <paper_dir>/<request_name>" >&2
  echo "example: bash $0 paper012/claims_contribution" >&2
  exit 1
fi

USER_FILE="$DIR/${NAME}_user.txt"
SCHEMA_FILE="$DIR/${NAME}_schema.json"

if [[ ! -f "$USER_FILE" ]] || [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "missing files for $NAME:" >&2
  echo "  $USER_FILE" >&2
  echo "  $SCHEMA_FILE" >&2
  exit 1
fi

echo "=== Replay: $NAME ==="
echo "user prompt:  $(wc -c < "$USER_FILE") bytes — $USER_FILE"
echo "schema:       $SCHEMA_FILE"
echo ""
echo "--- TASK line:"
grep -m1 '^TASK:' "$USER_FILE" || echo "  (no TASK: line)"
echo ""

BODY=$(jq -n \
  --rawfile usr "$USER_FILE" \
  --argjson sch "$(cat "$SCHEMA_FILE")" \
  '{
     model: "qwen",
     messages: [{"role":"user","content":$usr}],
     temperature: 0,
     stream: false,
     response_format: {"type":"json_schema","json_schema":{"name":"out","schema":$sch}}
   }')

START=$(python3 -c 'import time; print(int(time.time()*1000))')
# Persist the response next to the prompt files so the on-disk
# <name>_response.json always reflects the latest replay — single-shot
# or batched. (Was mktemp+rm before, which left a stale file on disk
# from any previous replay_all run.)
RESP="$DIR/${NAME}_response.json"
HTTP=$(curl -sS -o "$RESP" -w "%{http_code}" -X POST "$HOST/v1/chat/completions" \
  -H 'Content-Type: application/json' -d "$BODY" || echo 0)
END=$(python3 -c 'import time; print(int(time.time()*1000))')
ELAPSED=$((END - START))

echo "HTTP:    $HTTP"
echo "Elapsed: ${ELAPSED} ms"
echo "Saved:   ${RESP#$DIR/}"

if [[ "$HTTP" != "200" ]]; then cat "$RESP"; exit 1; fi

CONTENT=$(jq -r '.choices[0].message.content // empty' "$RESP")
N=$(echo "$CONTENT" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
FINISH=$(jq -r '.choices[0].finish_reason // "?"' "$RESP")
echo "Finish:  $FINISH"
echo "Items:   $N"
echo ""
echo "--- raw content ---"
echo "$CONTENT"
echo "--- end ---"
