"""Class-name prediction contract shared by measurement and delivery."""
import numpy as np

def predictions(values, rows, labels):
    vector = np.asarray(values)
    if vector.shape != (rows,):
        raise ValueError("Class-label predictions must be row aligned")
    allowed = set(labels)
    if any(not isinstance(value, str) or value not in allowed for value in vector):
        raise ValueError("Predictions must be within the training class label set")
    return vector.tolist()
