import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";
import { PatrolShell } from "@/components/patrol/PatrolShell";

export const metadata = { title: "澜策 · 规则巡检" };

export default async function PatrolPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <PatrolShell />;
}
