#!/bin/bash
# HEIC to JPEG conversion using ImageMagick
# Usage: ./convert-heic.sh input.heic [output.jpg] [quality]

set -e

INPUT="$1"
OUTPUT="${2:-${INPUT%.heic}.jpg}"
QUALITY="${3:-85}"

if [ -z "$INPUT" ]; then
  echo "Usage: $0 input.heic [output.jpg] [quality]"
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "Error: Input file not found: $INPUT"
  exit 1
fi

# Check if ImageMagick is installed
if ! command -v magick &> /dev/null; then
  echo "Error: ImageMagick not installed"
  echo "Install with: brew install imagemagick"
  exit 1
fi

# Convert HEIC to JPEG
magick convert "$INPUT" -quality "$QUALITY" "$OUTPUT"

echo "Converted: $OUTPUT"
