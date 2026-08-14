"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface LoginApiResult {
  ok: boolean;
  data?: {
    user: {
      username: string;
      role: "user" | "admin";
      mustChangePassword: boolean;
      assistantId: string;
      instanceId: string;
    };
  };
  error?: { code: string; message: string };
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/chat";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const json = (await res.json()) as LoginApiResult;
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "账号或密码错误");
        return;
      }
      const data = json.data!;
      const dest = data.user.mustChangePassword ? "/change-password" : next;
      router.replace(dest);
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? "网络异常");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-ink-200 bg-white p-6 shadow-sm dark:border-ink-700 dark:bg-ink-900"
    >
      <label className="mb-4 block">
        <span className="mb-1 block text-sm font-medium text-ink-700 dark:text-ink-200">账号</span>
        <input
          className="input-base"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          maxLength={64}
        />
      </label>
      <label className="mb-4 block">
        <span className="mb-1 block text-sm font-medium text-ink-700 dark:text-ink-200">密码</span>
        <input
          className="input-base"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          maxLength={128}
        />
      </label>
      {error ? (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn-primary w-full" disabled={loading || !username || !password}>
        {loading ? "登录中..." : "登录"}
      </button>
    </form>
  );
}
