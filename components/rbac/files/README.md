# Who is allowed to do what

Three roles — owner, admin, member — and a single table saying what each can do.

## Using it

```ts
import { requirePermission } from '@/components/rbac/require-permission';

export async function DELETE() {
  const allowed = await requirePermission('data:delete');
  if (!allowed.ok) return allowed.response;   // 403 with a readable message
  // ...
}
```

Ask for the **permission**, never the role. `if (role === 'ADMIN')` scattered
through a codebase cannot be reviewed and drifts the moment a fourth role
appears; `requirePermission('data:delete')` reads the same everywhere and the
answer lives in one file.

## The two decisions in the matrix

**An admin cannot manage billing.** The person who runs the team day to day is
usually not the person whose card is on file.

**Only an owner can delete the organisation.** It is the one action with no undo.

Both are one-line changes in `permissions.ts` if your product disagrees — and
the contract tests will tell you exactly what you changed.

## What it does not do

- The three roles are fixed. You cannot define new ones at runtime.
- Permissions cover the whole organisation. There is no "this person can see
  only these records".
