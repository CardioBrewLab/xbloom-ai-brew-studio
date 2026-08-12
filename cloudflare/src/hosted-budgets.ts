/**
 * Keep hosted model work below the EdgeOne Cloud Function 120-second ceiling.
 * Scalar values stay outside the Worker entry module because workerd treats
 * named entry exports as RPC handlers.
 */
export const HOSTED_MAX_TOTAL_BUDGET_MS = 112_000;
export const HOSTED_SINGLE_TOTAL_BUDGET_MS = 105_000;
export const HOSTED_BEAN_PARSE_TOTAL_BUDGET_MS = 105_000;
