export function shouldTripEventsubCircuitBreaker(
    totalManaged: number,
    unhealthyManaged: number,
    ratio = 0.25,
    minCount = 5
): boolean {
    if (totalManaged <= 0 || unhealthyManaged < Math.max(1, minCount)) return false;
    return unhealthyManaged / totalManaged > Math.min(1, Math.max(0, ratio));
}
