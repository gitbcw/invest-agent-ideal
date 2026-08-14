import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { AutomationWorkspace } from "@/components/automation/AutomationWorkspace";

type Params = { params: { runId: string } };

export async function generateMetadata({ params }: Params) {
  return { title: `澜策 · 运行记录 ${params.runId}` };
}

export default async function AutomationRunPage({ params: _params }: Params) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <AutomationWorkspace />;
}
