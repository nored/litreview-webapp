#!/usr/bin/env bash
# Replay every dumped LLM request for one paper, sequentially.
# Saves each response to <name>_response.json and produces a single
# REPORT.md at the end that you can read to assess every result.
#
# Usage:
#   bash tests/quality/probes/replay_all.sh paper012

set -euo pipefail

HOST="${LR_HOST:-http://localhost:4174}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SUBDIR="${1:-paper012}"
PAPER_DIR="$DIR/$SUBDIR"

[[ -d "$PAPER_DIR" ]] || { echo "no such dir: $PAPER_DIR — run dump_prompts.mjs first" >&2; exit 1; }

REPORT="$PAPER_DIR/REPORT.md"
echo "# Assessment report — $SUBDIR" > "$REPORT"
echo "" >> "$REPORT"
echo "Generated $(date '+%Y-%m-%d %H:%M:%S')" >> "$REPORT"
echo "" >> "$REPORT"

echo "=== Replay all: $SUBDIR ==="
echo ""
echo "| request                                  | items | ms     | finish |"
echo "|-------------------------------------------|------:|-------:|--------|"

TOTAL_MS=0
TOTAL_REQ=0
TOTAL_ITEMS=0

for user_file in "$PAPER_DIR"/*_user.txt; do
  [[ -f "$user_file" ]] || continue
  name="$(basename "$user_file" _user.txt)"
  schema_file="$PAPER_DIR/${name}_schema.json"
  resp_file="$PAPER_DIR/${name}_response.json"
  [[ -f "$schema_file" ]] || continue

  BODY=$(jq -n \
    --rawfile usr "$user_file" \
    --argjson sch "$(cat "$schema_file")" \
    '{model:"qwen", messages:[{"role":"user","content":$usr}], temperature:0, stream:false,
       response_format:{"type":"json_schema","json_schema":{"name":"out","schema":$sch}}}')

  START=$(python3 -c 'import time; print(int(time.time()*1000))')
  HTTP=$(curl -sS -o "$resp_file" -w "%{http_code}" -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' -d "$BODY" --max-time 600 || echo 0)
  END=$(python3 -c 'import time; print(int(time.time()*1000))')
  MS=$((END - START))

  if [[ "$HTTP" == "200" ]]; then
    CONTENT=$(jq -r '.choices[0].message.content // empty' "$resp_file")
    N=$(echo "$CONTENT" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
    FINISH=$(jq -r '.choices[0].finish_reason // "?"' "$resp_file")
  else
    N=0; FINISH="HTTP$HTTP"
    CONTENT=""
  fi

  TOTAL_MS=$((TOTAL_MS + MS))
  TOTAL_REQ=$((TOTAL_REQ + 1))
  TOTAL_ITEMS=$((TOTAL_ITEMS + N))
  printf "| %-41s | %5s | %6s | %-6s |\n" "$name" "$N" "$MS" "$FINISH"

  # Append per-request section to REPORT.md
  {
    echo "## $name"
    echo ""
    echo "- elapsed: ${MS} ms"
    echo "- items: $N"
    echo "- finish: $FINISH"
    echo ""
    echo "### TASK"
    echo ""
    TASK_LINE=$(grep -m1 '^TASK:' "$user_file" 2>/dev/null || echo '(no TASK: line)')
    echo "> ${TASK_LINE#TASK: }"
    echo ""
    echo "### Items"
    echo ""
    if [[ "$N" -eq 0 ]]; then
      echo "_(no items returned)_"
    elif [[ -n "$CONTENT" ]]; then
      echo '```json'
      echo "$CONTENT" | jq .
      echo '```'
    else
      echo "_(empty response)_"
    fi
    echo ""
  } >> "$REPORT"
done

echo ""
echo "=== Aggregate ==="
echo "requests:   $TOTAL_REQ"
echo "total ms:   $TOTAL_MS"
echo "total items:$TOTAL_ITEMS"
echo ""
echo "REPORT:     $REPORT"

{
  echo ""
  echo "## Aggregate"
  echo ""
  echo "- requests: $TOTAL_REQ"
  echo "- total ms: $TOTAL_MS"
  echo "- total items: $TOTAL_ITEMS"
} >> "$REPORT"
