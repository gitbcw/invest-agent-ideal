import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { AttentionShell } from "@/components/attention/AttentionShell";

export const dynamic = "force-dynamic";

export default async function AttentionPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <AttentionShell />;
}
