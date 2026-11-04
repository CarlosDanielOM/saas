/** DimaFX purchase and playback logs are kept for 365 days (privacy policy), then MongoDB expires them. */
export const DIMAFX_LOG_RETENTION_DAYS = 365;
export const DIMAFX_LOG_RETENTION_SECONDS = DIMAFX_LOG_RETENTION_DAYS * 24 * 60 * 60;
