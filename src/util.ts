import { createHash, timingSafeEqual } from 'node:crypto';

export type JsonRecord = Record<string, unknown>;
export const record = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
export const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => record(value)[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableJson(record(value)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');
export function secretMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 24) return null;
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(apikey|api_key|authorization|headers|base64|password|token|jpegThumbnail)$/i.test(key)).map(([key, child]) => [key, sanitize(child, depth + 1)]));
  }
  return value;
}
export class AppError extends Error {
  constructor(readonly code: string, readonly statusCode = 400, readonly retryable = false) { super(code); }
}
