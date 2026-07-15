import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { NewCustomerForm } from "@/components/customers/new-customer-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Manage Customer" };

export default async function NewCustomerPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT);

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Add New Customer
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          New customers always start at <strong>Registered</strong> /{" "}
          <strong>Initialized</strong>.
        </p>
      </header>
      <NewCustomerForm />
    </main>
  );
}
