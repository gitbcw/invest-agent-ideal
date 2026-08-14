import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { AutomationWorkspace } from "@/components/automation/AutomationWorkspace";

export const metadata = { title: "澜策 · 新建自动化任务" };

export default async function NewAutomationPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <AutomationWorkspace />;
}
