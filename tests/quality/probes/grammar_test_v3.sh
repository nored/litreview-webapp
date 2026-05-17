#!/usr/bin/env bash
# Grammar test v3 — runs the live extractor on a full paper.
#
# Fires POST /api/v2/papers/<id>/extract-phase2 against the live server,
# which now uses the minimal-prompt + grammar-constrained pattern across
# every LLM call:
#
#   - claims (11 claim_types via extract_claims_v2.mjs)  → schemas/claims.json
#   - numerical results (extract_numerical_v2.mjs)        → schemas/numerical.json
#   - citation stance (extract_stance_v2.mjs)             → schemas/stance.json
#
# Reads the resulting structured data via /api/v2/papers/<id>/phase2-structured
# and prints per-type counts plus a few sample items.
#
# Usage:
#   bash tests/quality/probes/grammar_test_v3.sh             # default paper 012
#   bash tests/quality/probes/grammar_test_v3.sh 014          # any paper id
#   PAPER_ID=034 bash tests/quality/probes/grammar_test_v3.sh

set -euo pipefail

HOST="${LR_HOST:-http://localhost:4174}"
PAPER_ID="${PAPER_ID:-${1:-012}}"

echo "=== Grammar test v3 — full paper through the live extractor ==="
echo "endpoint: $HOST"
echo "paper_id: $PAPER_ID"
echo ""

echo "--- server status:"
curl -sS --max-time 5 "$HOST/api/v2/local-llm/status" || { echo "server not reachable on $HOST"; exit 1; }
echo ""
echo ""

echo "--- (1) grobid-ingest (idempotent; quick if already done):"
START=$(python3 -c 'import time; print(int(time.time()*1000))')
GROBID_OUT=$(curl -sS -X POST "$HOST/api/v2/papers/$PAPER_ID/grobid-ingest" -H 'Content-Type: application/json' -d '{}')
END=$(python3 -c 'import time; print(int(time.time()*1000))')
GROBID_MS=$((END - START))
echo "$GROBID_OUT" | jq -r '"  sections=\(.summary.sections // "?") paragraphs=\(.summary.paragraphs // "?")  (\("$GROBID_MS") ms)"' 2>/dev/null || echo "$GROBID_OUT"

echo ""
echo "--- (2) extract-phase2 (entities + claims + numerical + stance, all with grammar):"
START=$(python3 -c 'import time; print(int(time.time()*1000))')
P2_OUT=$(curl -sS -X POST "$HOST/api/v2/papers/$PAPER_ID/extract-phase2" -H 'Content-Type: application/json' -d '{}' --max-time 1800)
END=$(python3 -c 'import time; print(int(time.time()*1000))')
P2_MS=$((END - START))

ELAPSED_SEC=$(python3 -c "print(round($P2_MS/1000, 1))")
echo "  done in ${ELAPSED_SEC}s"
echo ""
echo "--- per-step report:"
echo "$P2_OUT" | jq '{
  entities: { n_paragraphs: .steps.entities.n_paragraphs_scanned, n_spans: .steps.entities.n_spans, elapsed_ms: .steps.entities.elapsed_ms },
  claims:   { mode: .steps.claims.mode, total_accepted: .steps.claims.total_accepted, total_rejected: .steps.claims.total_rejected, by_type: .steps.claims.by_type, errors: (.steps.claims.errors | length), elapsed_ms: .steps.claims.elapsed_ms },
  numerical:{ mode: .steps.numerical.mode, total_accepted: .steps.numerical.total_accepted, total_rejected: .steps.numerical.total_rejected, llm_calls_used: .steps.numerical.llm_calls_used, elapsed_ms: .steps.numerical.elapsed_ms },
  stance:   { mode: .steps.stance.mode, total: .steps.stance.total, classified: .steps.stance.classified, by_stance: .steps.stance.by_stance, llm_calls: .steps.stance.llm_calls, elapsed_ms: .steps.stance.elapsed_ms }
}'

echo ""
echo "--- (3) read back the structured data via /phase2-structured:"
STRUCT=$(curl -sS "$HOST/api/v2/papers/$PAPER_ID/phase2-structured")

echo "--- claims by type (count + first quote):"
echo "$STRUCT" | jq -r '
  .claims.by_type
  | to_entries[]
  | "  \(.key) [\(.value | length)]:"
    + (if (.value | length) > 0
       then "\n    - \(.value[0].stance) :: \(.value[0].text[:140])…"
       else ""
       end)
'

echo ""
echo "--- numerical results (count):"
echo "$STRUCT" | jq -r '"  \((.numerical // []) | length) result(s)"'
echo "$STRUCT" | jq -r '(.numerical // [])[:5] | .[] | "    - metric=\(.metric) value=\(.value) dataset=\(.dataset // "?") split=\(.split // "?")"'

echo ""
echo "--- citation stance (histogram):"
echo "$STRUCT" | jq -r '
  (.citation_markers // [])
  | map(.stance // "unclassified")
  | group_by(.)
  | map({key: .[0], n: length})
  | from_entries
  | to_entries[]
  | "  \(.key): \(.value)"
'

echo ""
echo "=== Summary ==="
echo "paper:    $PAPER_ID"
echo "grobid:   ${GROBID_MS} ms"
echo "phase2:   ${P2_MS} ms"
TOTAL_CLAIMS=$(echo "$P2_OUT" | jq -r '.steps.claims.total_accepted // 0')
TOTAL_NUM=$(echo "$P2_OUT" | jq -r '.steps.numerical.total_accepted // 0')
STANCE_CLASS=$(echo "$P2_OUT" | jq -r '.steps.stance.classified // 0')
STANCE_TOTAL=$(echo "$P2_OUT" | jq -r '.steps.stance.total // 0')
echo "claims:   $TOTAL_CLAIMS accepted across 11 claim_types"
echo "numerical:$TOTAL_NUM results"
echo "stance:   $STANCE_CLASS / $STANCE_TOTAL citations classified"
