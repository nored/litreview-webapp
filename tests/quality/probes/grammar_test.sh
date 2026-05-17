#!/usr/bin/env bash
# Grammar-constrained decoding test via the OpenAI-compatible
# /v1/chat/completions endpoint (works against any llama-server / Ollama /
# litreview-webapp). Non-streaming so we can print a clean summary at
# the end instead of raw SSE chunks flying past.
#
# Two ways to pass a grammar in the request body:
#   1) "grammar": "<GBNF source>"
#   2) "response_format": { "type": "json_schema",
#                           "json_schema": { "schema": <JSON Schema> } }
# This script uses (2). Swap the body for raw GBNF if you prefer.
#
# Usage:
#   bash tests/quality/probes/grammar_test.sh

set -euo pipefail

HOST="${LR_HOST:-http://localhost:4174}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEM_FILE="$DIR/contribution_paper012_system.txt"
USER_FILE="$DIR/contribution_paper012_user.txt"

[[ -f "$SYSTEM_FILE" && -f "$USER_FILE" ]] || { echo "missing prompt files in $DIR" >&2; exit 1; }

echo "=== Grammar test ==="
echo ""
echo "endpoint: $HOST/v1/chat/completions"
echo "system msg ($(wc -c < "$SYSTEM_FILE") bytes): $(cat "$SYSTEM_FILE")"
echo "user prompt size: $(wc -c < "$USER_FILE") bytes"
echo ""
echo "--- server status:"
curl -s --max-time 5 "$HOST/api/v2/local-llm/status" || { echo "server not reachable on $HOST"; exit 1; }
echo ""

SCHEMA='{
  "type": "array",
  "minItems": 1,
  "maxItems": 3,
  "items": {
    "type": "object",
    "properties": {
      "quote":        {"type": "string", "minLength": 12},
      "paragraph_id": {"type": "string"},
      "stance":       {"type": "string", "enum": ["asserts","validates","theorises","challenges","extends"]}
    },
    "required": ["quote","paragraph_id","stance"],
    "additionalProperties": false
  }
}'

BODY=$(jq -n \
  --arg sys      "$(cat "$SYSTEM_FILE")" \
  --rawfile usr  "$USER_FILE" \
  --argjson sch  "$SCHEMA" \
  '{
     model: "qwen",
     messages: [
       {"role": "system", "content": $sys},
       {"role": "user",   "content": $usr}
     ],
     temperature: 0,
     stream: false,
     response_format: {"type": "json_schema", "json_schema": {"name": "claims", "schema": $sch}}
   }')

echo ""
echo "--- POST (non-streaming, will block until done) …"
START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
RESPONSE_FILE=$(mktemp -t grammar_test_resp.XXXXXX)
HTTP_CODE=$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X POST "$HOST/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "$BODY" || echo "0")
END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
ELAPSED_MS=$((END_MS - START_MS))

echo ""
echo "=== Summary ==="
echo "HTTP status:    $HTTP_CODE"
echo "Elapsed:        ${ELAPSED_MS} ms"
echo "Response bytes: $(wc -c < "$RESPONSE_FILE")"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "---"
  echo "BODY:"
  cat "$RESPONSE_FILE"
  echo ""
  rm -f "$RESPONSE_FILE"
  exit 1
fi

CONTENT=$(jq -r '.choices[0].message.content // empty' "$RESPONSE_FILE")
FINISH=$(jq -r '.choices[0].finish_reason // "?"' "$RESPONSE_FILE")
MODEL=$(jq -r '.model // "?"' "$RESPONSE_FILE")
echo "Model:          $MODEL"
echo "Finish reason:  $FINISH"
echo "Content chars:  $(printf %s "$CONTENT" | wc -c)"
echo ""
echo "--- Content (assistant message) ---"
echo "$CONTENT"
echo "--- end content ---"
echo ""

# Validate the content is parseable JSON conforming to the schema shape.
if echo "$CONTENT" | jq -e 'type == "array" and length >= 1' >/dev/null 2>&1; then
  N=$(echo "$CONTENT" | jq 'length')
  echo "Grammar verdict: ✓ valid JSON array, $N item(s)"
  echo ""
  echo "--- Items ---"
  echo "$CONTENT" | jq -r 'to_entries[] | "[\(.key)] paragraph_id=\(.value.paragraph_id), stance=\(.value.stance), quote=\(.value.quote[:120])…"'
else
  echo "Grammar verdict: ✗ content is NOT a valid non-empty JSON array (grammar may have failed to build)"
fi

rm -f "$RESPONSE_FILE"
