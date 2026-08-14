import { Suspense } from "react";

import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = { title: "登录 · 投资助手门户" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">投资助手门户</h1>
          <p className="mt-2 text-sm text-ink-500">登录后即可与你的专属投资助手对话</p>
        </header>
        <Suspense fallback={<LoginFormFallback />}>
          <LoginForm />
        </Suspense>
        <footer className="mt-6 text-center text-xs text-ink-400">
          首次登录后请尽快修改密码。
        </footer>
      </div>
    </main>
  );
}

function LoginFormFallback() {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-6 shadow-sm dark:border-ink-700 dark:bg-ink-900">
      <div className="mb-4 h-9 animate-pulse rounded bg-ink-100 dark:bg-ink-800" />
      <div className="mb-4 h-9 animate-pulse rounded bg-ink-100 dark:bg-ink-800" />
      <div className="h-9 animate-pulse rounded bg-accent-500/30" />
    </div>
  );
}
