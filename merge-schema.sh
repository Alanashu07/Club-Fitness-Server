#!/usr/bin/env bash
# merge-schema.sh
# Combines all .prisma files in prisma/models/ (in filename order)
# into a single prisma/schema.prisma that the Prisma CLI can read.
#
# Usage:  bash merge-schema.sh
# Run this any time you edit a file inside prisma/models/.

set -e

MODELS_DIR="prisma/models"
OUTPUT_FILE="prisma/schema.prisma"

echo "// ⚠️ AUTO-GENERATED FILE — do not edit directly." > "$OUTPUT_FILE"
echo "// Edit the files in $MODELS_DIR/ instead, then re-run merge-schema.sh" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

for file in $(ls "$MODELS_DIR"/*.prisma | sort); do
  cat "$file" >> "$OUTPUT_FILE"
  echo -e "\n" >> "$OUTPUT_FILE"
done

echo "✅ Merged $(ls "$MODELS_DIR"/*.prisma | wc -l) files into $OUTPUT_FILE"
