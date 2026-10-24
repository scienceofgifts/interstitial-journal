# Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Authentication & Verification Invariant**: Every read or write operation requires an authenticated user with a verified email (`request.auth != null && request.auth.token.email_verified == true`).
2. **Ownership Invariant**: Every `JournalEntry` in `/entries/{entryId}` and `UserSettings` in `/user_settings/{userId}` is strictly private to its `ownerId` (`ownerId == request.auth.uid`). No user can read, list, create, update, or delete another user's entries or settings.
3. **Strict Key & Schema Invariant**: Every `create` and `update` operation must pass `isValidJournalEntry(incoming())` or `isValidUserSettings(incoming())`, enforcing exact key allowlists (`hasAll` and `hasOnly`), string length bounds, numeric ranges, and regex patterns.
4. **Immutability Invariant**: On update of `/entries/{entryId}`, `id`, `ownerId`, `createdAt`, `createdAtIso`, and `dateKey` cannot be modified. On update of `/user_settings/{userId}`, `ownerId` cannot be modified.
5. **Temporal Integrity Invariant**: `createdAt` must equal `request.time` on creation, and `updatedAt` must equal `request.time` on creation and update.
6. **Path Variable Hardening Invariant**: Document IDs (`{entryId}`, `{userId}`) must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters for single-document operations (`get`, `create`, `update`, `delete`).

## 2. The "Dirty Dozen" Payloads
1. **Identity Spoofing on Entry Create**: Authenticated user `user_A` attempts to create `/entries/entry_1` with `ownerId: "user_B"`.
2. **Unverified Email Spoof Attack**: Authenticated user `user_A` with `email_verified: false` attempts to read or create an entry.
3. **Shadow / Ghost Field Injection on Create**: User sends a valid `JournalEntry` payload plus an undeclared field `"isAdmin": true`.
4. **Shadow Field Injection on Update**: User attempts to update `/entries/entry_1` by adding `"extraField": "malicious"`.
5. **Immutable `createdAt` Tampering on Update**: Owner attempts to modify `createdAt` or `createdAtIso` during an entry edit.
6. **Ownership Transfer Attack on Update**: Owner attempts to change `ownerId` from `"user_A"` to `"user_B"` on an existing entry.
7. **Value Poisoning on Update**: Owner updates `finalText` with an empty string `""` or a 100,000-character string (exceeding `maxLength: 50000`).
8. **ID Poisoning Attack**: User attempts to create a document with an invalid ID containing spaces or special characters or exceeding 128 chars.
9. **Client Timestamp Forgery**: User attempts to create an entry with a backdated client timestamp (`createdAt != request.time`).
10. **Cross-Tenant List Scraping**: Authenticated user `user_A` attempts an unfiltered `list` query on `/entries` without restricting `ownerId == request.auth.uid`.
11. **Unauthorized Cross-User Settings Read (PII/Privacy Leak)**: `user_A` attempts `get` on `/user_settings/user_B`.
12. **Invalid Enum Injection on Settings**: `user_A` attempts to update `/user_settings/user_A` with `theme: "neon-cyberpunk"` (not in `['light', 'dark', 'system']`).
