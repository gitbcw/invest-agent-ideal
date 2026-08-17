import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";
import { UsageShell } from "@/components/usage/UsageShell";

export const metadata = { title: "澜策 · 使用记录" };

export default async function UsagePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <UsageShell username={session.username} />;
}
