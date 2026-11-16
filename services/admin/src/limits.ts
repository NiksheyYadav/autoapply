/** Caps the service enforces itself. Hard limits on payloads live in @atlas/types (`ADMIN_MAX_*`). */
export interface ServiceLimits {
  /** Rows in one CSV export. Defaults to `ADMIN_MAX_EXPORT_ROWS`. */
  exportMaxRows?: number;
  /** Requests per client IP per minute. */
  importRatePerMinute?: number;
  exportRatePerMinute?: number;
}

/** Bulk endpoints are expensive and carry personal data, so they get a much tighter limit than the global one. */
export const DEFAULT_IMPORT_RATE_PER_MINUTE = 10;
export const DEFAULT_EXPORT_RATE_PER_MINUTE = 10;
