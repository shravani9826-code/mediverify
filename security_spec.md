# Security Specification for MediVerify

## Data Invariants
1. A medicine document must be associated with the authenticated user.
2. A log must reference a valid medicine document belonging to the same user.
3. A report must be private to the owner.
4. Image verification is performed via stored AI embeddings (text-only metadata).

## The Dirty Dozen Payloads (Rejection Targets)
1. **Identity Spoofing**: Attempt to create a medicine with `userId: "not-me"`.
2. **Shadow Field**: Adding `isVerified: true` to a medicine creation.
3. **Ghost Update**: Changing `userId` of an existing medicine.
4. **ID Poisoning**: Using a 1MB string as a `medicineId`.
5. **Orphan Log**: Creating a log for a non-existent `medicineId`.
6. **Cross-User Leak**: Reading another user's reports.
7. **Invalid Schedule**: Schedule with 1000 times (denial of wallet).
8. **Client Timestamp**: Setting `createdAt` to a manual date.
9. **Role Escalation**: Setting `role: "admin"` in user data.
10. **Empty Name**: Medicine with empty string name.
11. **Direct PII Read**: Attempting to read profile data without ownership.
12. **Status Bypass**: Changing log status after completion (if applicable).

## Test Runner (Logic Overview)
The `firestore.rules` will be tested using standard Firebase Emulator rules testing logic.
Each of the above payloads MUST return `PERMISSION_DENIED`.
