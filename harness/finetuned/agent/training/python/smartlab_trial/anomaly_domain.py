"""Delivered anomaly decision domain, shared by all prediction consumers."""
DOMAIN_REASON = "predict returned values outside the delivered domain {0, 1}"


def decision_domain_reason(predictions, anomaly_label):
    if anomaly_label == 1 and predictions is not None and any(value not in (0, 1) for value in predictions):
        return DOMAIN_REASON
    return None
