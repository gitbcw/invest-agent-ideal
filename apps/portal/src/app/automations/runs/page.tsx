import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";

export const metadata = { title: "澜策 · 运行记录" };

export default async function AutomationRunsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  redirect("/automations?view=runs");
}
