import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";

export const metadata = { title: "澜策 · 规则巡检" };

// Rule patrol moved into the automation workspace as a view (usage is rare,
// not worth a standalone destination). Keep the route for old links.
export default async function PatrolPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  redirect("/automations?view=patrol");
}
