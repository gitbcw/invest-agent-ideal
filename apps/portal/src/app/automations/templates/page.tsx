import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";

export const metadata = { title: "澜策 · 自动化模板" };

export default async function AutomationTemplatesPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  redirect("/automations?view=templates");
}
