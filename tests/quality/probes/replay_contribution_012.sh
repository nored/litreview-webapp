#!/usr/bin/env bash
# Replay the exact LLM request that returned "[]" for paper 012's
# contribution-claim extraction. Server must be running on port 4174.
#
# The prompts:
#   - tests/quality/probes/contribution_paper012_system.txt
#   - tests/quality/probes/contribution_paper012_user.txt
# are the verbatim system + user messages the extractor built.
#
# Usage:
#   bash tests/quality/probes/replay_contribution_012.sh
#
# Optional: override the model with a different provider / model first:
#   curl -X POST http://localhost:4174/api/v2/local-llm/select \
#     -H 'Content-Type: application/json' \
#     -d '{"model_id":"qwen2.5-7b-instruct-q4"}'
#   # wait for state=ready, then run this script

set -euo pipefail

HOST="${LR_HOST:-http://localhost:4174}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEM_FILE="$DIR/contribution_paper012_system.txt"
USER_FILE="$DIR/contribution_paper012_user.txt"

if [[ ! -f "$SYSTEM_FILE" ]] || [[ ! -f "$USER_FILE" ]]; then
  echo "missing prompt files in $DIR" >&2
  exit 1
fi

echo "--- server status:"
curl -s --max-time 5 "$HOST/api/v2/local-llm/status" || { echo "server not reachable on $HOST"; exit 1; }
echo ""

echo "--- prompt sizes:"
wc -c "$SYSTEM_FILE" "$USER_FILE"

echo ""
echo "--- POST /api/llm/chat (streaming SSE; -N disables curl buffering) ---"
echo ""

# Build the JSON body via jq so multi-line text + special chars are
# safely escaped. Requires jq.
jq -Rsn \
  --arg sys "$(cat "$SYSTEM_FILE")" \
  --rawfile usr "$USER_FILE" \
  '{provider:"webllm", system:$sys, user:$usr, temperature:0}' \
| curl -N -X POST "$HOST/api/llm/chat" \
    -H 'Content-Type: application/json' \
    -d @-

echo ""
echo "--- done ---"
