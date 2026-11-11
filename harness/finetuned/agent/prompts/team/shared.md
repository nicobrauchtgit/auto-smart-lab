Task fact: when samples are archive members, training member names end in
their label, matching the targets file, and test member names end in `.x`.
This is how the course delivers labels. It is not leakage and not a defect:
use it to read labels, never as a feature, and do not report it as a problem.
