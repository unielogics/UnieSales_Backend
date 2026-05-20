#!/usr/bin/env bash
# Pulls the production secret bundle from Secrets Manager into a local .env file.
# Use only for local dev when you need real prod credentials (e.g. testing OAuth).
# Production runtime reads secrets directly via the EC2 instance role — no .env needed.
set -euo pipefail

SECRET_ID="${AWS_SECRET_ID:-uniesales/prod/app}"
REGION="${AWS_REGION:-us-east-1}"
OUTPUT="${1:-.env}"

if [ -f "$OUTPUT" ]; then
  echo "refusing to overwrite existing $OUTPUT — pass a different path or remove it first"
  exit 1
fi

echo "fetching $SECRET_ID from $REGION → $OUTPUT"
aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" \
  --region "$REGION" \
  --query SecretString --output text \
  | python3 -c '
import json, sys
for k, v in json.load(sys.stdin).items():
    if v is None or v == "":
        continue
    # quote values containing spaces or special chars
    if any(c in v for c in " \"$\\#"):
        v = "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    print(f"{k}={v}")
' > "$OUTPUT"
chmod 600 "$OUTPUT"
echo "wrote $OUTPUT"
