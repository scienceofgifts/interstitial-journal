/**
 * Security Rules Verification Suite for Dirty Dozen Payloads
 * Verifies that all 12 adversarial payloads in security_spec.md return PERMISSION_DENIED.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Identity Spoofing on Entry Create',
    operation: 'create',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { ownerId: 'user_B', finalText: 'Spoofed entry' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Spoof Attack',
    operation: 'create',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: false },
    payload: { ownerId: 'user_A', finalText: 'Unverified write' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow / Ghost Field Injection on Create',
    operation: 'create',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { ownerId: 'user_A', finalText: 'Hello', isAdmin: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow Field Injection on Update',
    operation: 'update',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { finalText: 'Updated', extraField: 'malicious' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Immutable createdAt Tampering on Update',
    operation: 'update',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { createdAtIso: '1999-01-01T00:00:00.000Z' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Ownership Transfer Attack on Update',
    operation: 'update',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { ownerId: 'user_B' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Value Poisoning on Update (Empty finalText)',
    operation: 'update',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { finalText: '' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'ID Poisoning Attack',
    operation: 'create',
    path: '/entries/invalid id with spaces!',
    auth: { uid: 'user_A', email_verified: true },
    payload: { ownerId: 'user_A', finalText: 'Valid text' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Client Timestamp Forgery',
    operation: 'create',
    path: '/entries/entry_1',
    auth: { uid: 'user_A', email_verified: true },
    payload: { ownerId: 'user_A', createdAt: '2020-01-01T00:00:00Z' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Cross-Tenant List Scraping',
    operation: 'list',
    path: '/entries',
    auth: { uid: 'user_A', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Unauthorized Cross-User Settings Read',
    operation: 'get',
    path: '/user_settings/user_B',
    auth: { uid: 'user_A', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Invalid Enum Injection on Settings',
    operation: 'update',
    path: '/user_settings/user_A',
    auth: { uid: 'user_A', email_verified: true },
    payload: { theme: 'neon-cyberpunk' },
    expectedResult: 'PERMISSION_DENIED',
  },
];
