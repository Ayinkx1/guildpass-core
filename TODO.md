# TODO - Role mutation API (assignment/removal)

## Steps
1. Inspect existing integration tests for routes (assign/remove) and see what’s missing vs acceptance criteria.
2. Add/extend `MemberService` unit tests for invalid community/wallet/role cases and unauthorised/authenticated behavior.
3. Enforce auth on `GET /v1/communities/:communityId/members` (admin-only) so admin clients are protected consistently.
4. Add route-level integration tests for:
   - assign success
   - remove success
   - duplicate safe behavior
   - unauthorised => 401/403
   - invalid wallet/community/role => 400
   - cross-community scoping => no leakage
5. Ensure SDK-lite / shared-types exports match the API contract paths.
6. Run test suite(s) for access-api + sdk-lite and fix any failures.
7. Update routes integration tests to cover role mutation endpoints (assign/remove) and negative cases.


