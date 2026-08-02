import type { TraceContext } from '@atlas/types';
import { newUuid } from './ids.js';

/**
 * Trace identifiers flow request → event → worker → log line so a single
 * user action can be reconstructed across services (docs/06, docs/10).
 */
export function newTraceContext(partial: Partial<TraceContext> = {}): TraceContext {
  return {
    trace_id: partial.trace_id ?? newUuid(),
    correlation_id: partial.correlation_id ?? partial.trace_id ?? newUuid(),
    organization_id: partial.organization_id ?? null,
    user_id: partial.user_id ?? null,
  };
}

/** Derives a child context that keeps the trace but gets a fresh correlation. */
export function childTrace(parent: TraceContext, overrides: Partial<TraceContext> = {}): TraceContext {
  return {
    trace_id: parent.trace_id,
    correlation_id: overrides.correlation_id ?? newUuid(),
    organization_id: overrides.organization_id ?? parent.organization_id,
    user_id: overrides.user_id ?? parent.user_id,
  };
}

export const TRACE_HEADER = 'x-trace-id';
export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
