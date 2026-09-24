import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <WorkspaceShell />;
}
