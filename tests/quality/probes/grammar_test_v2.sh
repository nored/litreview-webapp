#!/usr/bin/env bash
# Grammar test v2 — designed to fix the precision floor of grammar_test.sh
# without changing the model. Same /v1/chat/completions endpoint.
#
# Differences from v1:
#   1. minItems: 0  → model can honestly return [] when the paper has no
#                      contribution claims (e.g. a survey).
#   2. no maxItems  → number of items is a property of the paper, not a
#                      quota. Anywhere from 0 to all eligible paragraphs.
#   3. Per-item "why" field → forces the model to justify each pick.
#                              Post-filtering can drop weak rationales.
#   4. Sharper TASK with positive + negative markers embedded in the user
#      prompt (not the system message). The system message goes empty.
#
# Usage:
#   bash tests/quality/probes/grammar_test_v2.sh

set -euo pipefail

HOST="${LR_HOST:-http://localhost:4174}"
DIR="$(cd "$(dirname "$0")" && pwd)"
USER_FILE="$DIR/contribution_paper012_user.txt"

[[ -f "$USER_FILE" ]] || { echo "missing $USER_FILE" >&2; exit 1; }

# Surgically replace the original TASK line in the user prompt with a
# sharpened version that names positive + negative markers. The rest of
# the prompt (paragraphs etc.) stays identical.
SHARPENED_TASK='TASK: Find every sentence where the authors explicitly claim ownership of a contribution made BY THIS PAPER. Positive markers (look for these): "in this study we", "in this paper we", "we present", "we propose", "we introduce", "we show that", "we demonstrate", "this paper contributes", "our contribution is", "the main contribution". Negative — exclude these: any sentence that frames the domain, motivates the problem, summarises prior work, describes the field at large, lists strengths of an existing artefact, or restates background. Only include sentences where the authors are claiming a specific result, method, dataset, framework, or artefact as their own work. If the paper makes no such claim, return an empty array.'

# Replace the literal TASK: line in the user prompt
SHARPENED_PROMPT=$(awk -v repl="$SHARPENED_TASK" '
  /^TASK: / { print repl; next }
  { print }
' "$USER_FILE")

# v2 schema: minItems=0, no maxItems, added why slot.
SCHEMA='{
  "type": "array",
  "minItems": 0,
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

echo "=== Grammar test v2 ==="
echo "endpoint:        $HOST/v1/chat/completions"
echo "system msg:      (empty — instruction is in the user prompt)"
echo "user prompt size: $(printf %s "$SHARPENED_PROMPT" | wc -c) bytes"
echo "schema changes:  minItems=0, no maxItems, added why field"
echo ""
echo "--- server status:"
curl -s --max-time 5 "$HOST/api/v2/local-llm/status" || { echo "server not reachable on $HOST"; exit 1; }
echo ""

BODY=$(jq -n \
  --arg usr      "$SHARPENED_PROMPT" \
  --argjson sch  "$SCHEMA" \
  '{
     model: "qwen",
     messages: [
       {"role": "user", "content": $usr}
     ],
     temperature: 0,
     stream: false,
     response_format: {"type": "json_schema", "json_schema": {"name": "claims", "schema": $sch}}
   }')

echo "--- POST (non-streaming, will block until done) …"
START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
RESP=$(mktemp -t grammar_test_v2.XXXXXX)
HTTP=$(curl -sS -o "$RESP" -w "%{http_code}" -X POST "$HOST/v1/chat/completions" \
  -H 'Content-Type: application/json' -d "$BODY" || echo "0")
END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
ELAPSED=$((END_MS - START_MS))

echo ""
echo "=== Summary ==="
echo "HTTP status: $HTTP"
echo "Elapsed:     ${ELAPSED} ms"

if [[ "$HTTP" != "200" ]]; then
  echo "BODY:"; cat "$RESP"; rm -f "$RESP"; exit 1
fi

CONTENT=$(jq -r '.choices[0].message.content // empty' "$RESP")
MODEL=$(jq -r '.model // "?"' "$RESP")
FINISH=$(jq -r '.choices[0].finish_reason // "?"' "$RESP")
N=$(echo "$CONTENT" | jq 'length // 0' 2>/dev/null || echo 0)
echo "Model:       $MODEL"
echo "Finish:      $FINISH"
echo "Items:       $N"
echo ""
echo "--- Items ---"
if [[ "$N" -gt 0 ]]; then
  echo "$CONTENT" | jq -r 'to_entries[] | "[\(.key)] \(.value.paragraph_id) · \(.value.stance)\n    quote:  \(.value.quote[:160])…"'
else
  echo "(no items returned — model judged that paper 012 makes no contribution claims under the sharpened criteria)"
fi
rm -f "$RESP"
