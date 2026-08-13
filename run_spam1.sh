#!/usr/bin/env bash
set -euo pipefail

# End-to-end spam1 run: download data if needed, validate, and write submission.
cd "$(dirname "$0")"

python3 smartlab_agent.py download spam1
python3 smartlab_agent.py validate spam1 --validation-fraction 0.2 --seed 13
python3 smartlab_agent.py solve spam1 --out submissions/spam1_predictions.csv
