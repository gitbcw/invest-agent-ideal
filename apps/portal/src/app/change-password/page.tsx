import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";
import { ChangePasswordCard } from "@/components/auth/ChangePasswordCard";

export const metadata = { title: "修改密码 · 投资助手门户" };

export default async function ChangePasswordPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <header className="mb-6">
          <h1 className="text-xl font-semibold">修改密码</h1>
          <p className="mt-1 text-sm text-ink-500">
            {session.mustChangePassword
              ? "检测到当前是临时密码,请设置一个新密码后即可开始使用。"
              : "请输入当前密码并设置新密码。"}
          </p>
        </header>
        <ChangePasswordCard mustChange={session.mustChangePassword} />
      </div>
    </main>
  );
}
