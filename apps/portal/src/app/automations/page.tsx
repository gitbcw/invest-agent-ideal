import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";
import { AutomationShell } from "@/components/automation/AutomationShell";

export const metadata = { title: "澜策 · 自动化任务" };

export default async function AutomationsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <AutomationShell />;
}
