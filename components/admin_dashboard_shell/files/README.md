# A way for you to see what is going on

An admin area at `/admin`, with a menu that shows each person only what their
role lets them open.

## Adding a page

1. Create it under `src/app/admin/`.
2. Add it to `NAV` in `navigation.ts` with the permission it needs.
3. Call `guardAdminPage()` at the top of the page.

```tsx
export default async function MembersPage() {
  const context = await guardAdminPage('/admin/members');
  // ...
}
```

## Why both steps

**Hiding a menu item is not security.** The URL is still typeable. Filtering the
menu is a courtesy — a link someone cannot use is a dead end that makes the
product feel broken — but the page behind it has to check for itself.

A page you forget to list in `NAV` has no permission attached, and the guard
refuses it rather than allowing it. Defaulting the other way would mean every
page added in a hurry was open to anyone signed in.

## What it does not do

- Plain HTML and CSS. No component framework, no charts, no data tables.
- The overview page is a placeholder. Replace it with what you actually need to
  keep an eye on.
