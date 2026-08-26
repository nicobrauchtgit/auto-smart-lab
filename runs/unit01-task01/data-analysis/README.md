# Data Analysis Directory - Unit 01 Task 01

This directory contains the independent deep data analysis for the spam vs ham email classification task.

## Files

- **deep-report.md**: The main analysis report with all findings, statistics, and recommendations
- **statistics.json**: Machine-readable aggregate statistics for both classes

## Key Findings Summary

- **Dataset**: Enron-Spam variant with 16,662 emails (8,360 ham, 8,302 spam)
- **Balance**: Nearly perfect (50.17% vs 49.83%)
- **Top Features**: 
  - Obfuscated URL presence (~37% in spam vs ~0% in ham)
  - Exclamation marks (5x more in spam)
  - Spam keywords (3x more in spam)
  - Subject line length (33% longer in spam)

## Report Structure

The deep-report.md contains:
1. Executive summary and dataset identification
2. Class distribution and file structure
3. Content analysis (length, structure)
4. Structural feature analysis (URLs, HTML, email addresses)
5. Text pattern analysis (characters, digits, words, punctuation)
6. Obfuscation analysis
7. Spam keyword analysis
8. Content sampling observations
9. Data quality and leakage risks
10. Feature hypothesis handoff with prioritization
11. Reproducible commands and scripts
12. Measurement summary table
13. Recommendations for model development

All findings are clearly labeled as MEASURED, SAMPLED, or HYPOTHESIS.

## Usage

The report is self-contained and can be read independently. The statistics.json file can be loaded by analysis scripts:

```python
import json
with open('runs/unit01-task01/data-analysis/statistics.json') as f:
    stats = json.load(f)
```

## PDO Compliance

- No existing solver code or prior analysis reports were inspected or reused
- All analysis was performed directly on the training data ZIP
- All findings are based on deterministic local script execution
- Web search results are properly cited
