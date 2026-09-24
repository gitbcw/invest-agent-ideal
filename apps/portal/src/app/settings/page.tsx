import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { SettingsShell } from "@/components/settings/SettingsShell";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <SettingsShell />;
}
