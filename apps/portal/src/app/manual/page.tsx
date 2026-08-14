import { redirect } from "next/navigation";

import { ManualShell } from "@/components/manual/ManualShell";
import { getCurrentSession } from "@/lib/auth";

export const metadata = { title: "AI 投资决策分析助手 · 投资助手门户" };

export default async function ManualPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");

  return <ManualShell />;
}
