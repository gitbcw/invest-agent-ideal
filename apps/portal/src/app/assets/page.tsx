import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { AssetLibraryShell } from "@/components/assets/AssetLibraryShell";

export const metadata = { title: "澜策 · 我的文件" };

export default async function AssetsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  return <AssetLibraryShell />;
}
