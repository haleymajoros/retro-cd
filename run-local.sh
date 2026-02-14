#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "Serving DiscSpin 95 at http://127.0.0.1:5500/"
python3 -m http.server 5500
