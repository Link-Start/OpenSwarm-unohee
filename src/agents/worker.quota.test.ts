// Purpose: Unit tests for isProviderQuotaError quota-signal detection (INT-1927)

import { describe, it, expect } from 'vitest';
import { isProviderQuotaError } from './worker.js';

describe('isProviderQuotaError', () => {
  it('detects genuine quota / rate-limit errors', () => {
    expect(isProviderQuotaError('Codex responses error (429): usage limit reached')).toBe(true);
    expect(isProviderQuotaError('Error: quota exceeded for this org')).toBe(true);
    expect(isProviderQuotaError('rate limit hit, try again later')).toBe(true);
    expect(isProviderQuotaError('insufficient_quota')).toBe(true);
    expect(isProviderQuotaError('too many requests')).toBe(true);
  });

  it('does NOT misread a billing-themed task as a quota failure (INT-1927)', () => {
    // A payment/billing feature task whose summary mentions these words must not
    // trigger a spurious adapter fallback.
    expect(isProviderQuotaError('Implement the billing page and invoice export')).toBe(false);
    expect(isProviderQuotaError('Add payment billing cycle support to the dashboard')).toBe(false);
    expect(isProviderQuotaError('Fix the invoice total rounding bug')).toBe(false);
  });

  it('still flags billing when paired with a real quota word (INT-1927)', () => {
    expect(isProviderQuotaError('Your billing limit has been exceeded')).toBe(true);
    expect(isProviderQuotaError('account suspended: billing quota reached')).toBe(true);
  });

  it('returns false for empty / undefined input', () => {
    expect(isProviderQuotaError(undefined)).toBe(false);
    expect(isProviderQuotaError('')).toBe(false);
  });
});
