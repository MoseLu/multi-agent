#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
node start.js --workers="${1:-3}"
