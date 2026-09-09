# Iteration 1: Baseline Model

## Model
- Logistic Regression (solver='saga', penalty='l2', C=1.0, max_iter=500)
- Random state: 4021

## Features
1. TF-IDF word n-grams (unigrams + bigrams, lowercase, sublinear_tf, max_features=20000, min_df=5)
2. TF-IDF character trigrams (lowercase=False, sublinear_tf, max_features=10000, min_df=5)
3. Explicit punctuation features:
   - Normalized count of '!' characters
   - Normalized count of '$' characters
   - Normalized count of '?' characters
   - Uppercase letter ratio
   - Digit ratio
   - Special character ratio
   - Document length

## Training
- 5-fold stratified K-fold cross-validation
- 1 repeat
- Fold seed: 40434 (from harness)
- Training examples: 14995
- Sealed examples: 1667

## Notes
- First iteration: baseline model
- Avoided filename/path features to prevent target leakage
- Used content-only features as recommended by research
- Model should NOT score near 1.000 (would indicate leakage)
