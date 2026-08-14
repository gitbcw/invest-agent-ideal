import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { AutomationWorkspace } from "@/components/automation/AutomationWorkspace";

type Params = { params: { taskId: string } };

export async function generateMetadata({ params }: Params) {
  return { title: `澜策 · 自动化任务 ${params.taskId}` };
}

export default async function AutomationTaskPage({ params: _params }: Params) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <AutomationWorkspace />;
}
