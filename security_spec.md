# Security Rules Specification

## 1. Data Invariants
- A user config record at `/users/{userId}` can only be read or written by the authenticated user with the matching `userId`.
- Users cannot modify or view other users' configuration, posts, or logs under `/users/{userId}/...`
- On creation of posts or config, system fields like updated dates must align with current timestamps or valid values.
- Values for Drive folder id and social media credentials must be strictly checked.

## 2. The "Dirty Dozen" Malicious Payloads (Attempts to bypass identity / integrity)
1. **Malicious Auth Spoofing**: Attempt to write to `/users/alice/posts/post1` as user `bob` (rejection: userId != auth.uid).
2. **Global Read Attempt**: Request read on all users `/users` without auth (rejection: default-deny).
3. **Malicious ID Poisoning**: Write post with massive ID string (`/users/alice/posts/` + 1MB junk) (rejection: size limit).
4. **Privilege Escalation**: Post a user config that modifies roles if roles were present (rejection: keys/role limits).
5. **No Auth Creation**: Attempting of creating a post item without signing in (rejection: auth != null).
6. **Fake Creation Time**: Create post item with static or client-skewed `createdAt` instead of `request.time` (rejection: timestamps check).
7. **Bypass State Machine**: Update post status directly from `pending_review` to `posted` without filling `selectedCaption` (rejection: schema check).
8. **Malicious User Modification**: Editing another customer's configuration keys.
9. **Log Fabrication**: Fabricate other users' cron logs (rejection: path validation matches user auth).
10. **Junk Field Insertion**: Insert `ghost_field: true` into `posts` or `users` schema (rejection: strict size or keys list).
11. **Spoofed Email / Identity**: Authenticating with unverified email or invalid token claims to read config (rejection: verified email flag or uid matching).
12. **Recursive Cost Attack**: Forcing list view on others without `resource.data` filter constraints.

## 3. Test Cases Blueprint
Testing verifies permissions are denied for unauthorized owners. Since we deploy standard security rules, the layout is protected.
