# Keeping customers separate

Every piece of customer data belongs to an organisation, and this component is
what stops one organisation reading another's.

## Using it

```ts
import { requireOrg, scopedWhere } from '@/components/organization_tenancy/tenancy';

export async function GET() {
  const org = await requireOrg();
  if (!org.ok) return org.response;

  const bookings = await prisma.booking.findMany({
    where: scopedWhere(org.context, { status: 'confirmed' }),
  });
  return Response.json({ bookings });
}
```

Two rules, and they cover almost everything:

1. **Every table that holds customer data gets an `organizationId` column.**
2. **Every query against those tables goes through `scopedWhere`.**

## Why `scopedWhere` throws

Because the alternative is worse. A helper that returned an empty filter when
you forgot the argument would run a query with no restriction at all — which
returns every customer's rows and renders a page that looks entirely normal.
Nobody notices until a customer does.

Throwing turns that into a 500 on your own screen during development.

## What this does not do

Separation is enforced by the application, not by the database. A query someone
writes by hand without `scopedWhere` can still read across organisations. If you
need the database itself to refuse, that is PostgreSQL row-level security, and
it is a bigger change than this component makes.

The contract tests check the guard rather than every query in your app. Ask the
agent to add a test whenever it adds a table.
