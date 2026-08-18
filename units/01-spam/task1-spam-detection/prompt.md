# Unit 01 — Spam detection

Welcome to the first unit of the Smartlab. This unit deals with the detection of
spam. You will develop a learning system that automatically analyzes emails and
identifies spam messages. So, you will be implementing your own spam filter.

For the development of your system, training data will be provided in the first
week. For each email in this data, it is known whether it is "ham" (0) or "spam"
(1). You can use the data freely for the development, testing, and calibration of
your learning system.

In the second week, a test dataset will be made available. There are no labels
for these data, and it is your task to predict whether each email is "ham" (0)
or "spam" (1). These predictions, along with your system's source code, should be
uploaded to our web platform.

The unit concludes after the second week. Each group can submit a maximum of
three prediction attempts. The best submission will be evaluated. All submissions
will be presented in a high score. In case of a tie, the time of submission will
determine the ranking.

Good luck, and don't eat too much spam!

---

## Task 1 — Spam Detection with Machine Learning (50 points)

In the first task of this unit, the focus is on analyzing the content of emails
and detecting spam. The data consists of extracted email content that has already
been prepared using various techniques for easier analysis. Here's an example of
a message:

```text
Subject: mid-year 2000 performance feedback
note: you will receive this message each time you are selected
as a reviewer. you have been selected to participate in the mid
...
```

The format for your system's predictions looks like this:

```text
data/spam1-test/dslkfhkajsdhfkj.x;0
data/spam1-test/wueziqwewuewefs.x;1
data/spam1-test/xmnbxcmnxuedasf.x;0
...
```

The first field is the filename of the email, and the second field is your
prediction. In the example, the email `wueziqwewuewefs.x` is classified as spam.
Please make sure to use the correct path and filenames.

The performance of your system will be evaluated using **Balanced Accuracy**
(BACC). This measures the accuracy of the system, separately averaged for both
classes.

## Data

Training data is available in this environment under:

```text
data/spam1-train/       # one file per email
spam1-train.labels      # official label list
```

Each training email's label is encoded in its filename extension:
`...<name>.0` = ham, `...<name>.1` = spam. The test set (unlabeled) is released
in week two under `data/spam1-test/`.
