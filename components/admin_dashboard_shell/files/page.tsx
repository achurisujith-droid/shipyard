import { guardAdminPage } from '@/components/admin_dashboard_shell/guard';

/**
 * The admin home page.
 *
 * This one is yours — replace it with whatever you actually need to see. Keep
 * the `guardAdminPage` call at the top; it is what stops somebody reaching this
 * by typing the address.
 */
export default async function AdminHome() {
  const context = await guardAdminPage('/admin');

  return (
    <>
      <h1>Overview</h1>
      <p>
        This is the admin area. Only people in your organisation can reach it,
        and the menu shows each person only what their role lets them open.
      </p>
      <p className="admin-hint">
        Replace this page with what you need to keep an eye on — how many
        customers signed up this week, what is waiting for someone, whatever
        matters. Organisation <code>{context.organizationId}</code>.
      </p>
    </>
  );
}
