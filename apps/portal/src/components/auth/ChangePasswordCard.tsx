"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface ChangePasswordCardProps {
  mustChange: boolean;
}

export function ChangePasswordCard({ mustChange }: ChangePasswordCardProps) {
  const router = useRouter();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmNewPassword: confirmPassword
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "修改失败");
        return;
      }
      setDone(true);
      setTimeout(() => {
        router.replace(mustChange ? "/chat" : "/chat");
        router.refresh();
      }, 800);
    } catch (err) {
      setError((err as Error).message ?? "网络异常");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-300">
        密码修改成功,正在进入聊天页...
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-lg border border-ink-200 bg-white p-6 shadow-sm dark:border-ink-700 dark:bg-ink-900"
    >
      <label className="block">
        <span className="mb-1 block text-sm font-medium">当前密码</span>
        <input
          className="input-base"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">新密码</span>
        <input
          className="input-base"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          required
          minLength={8}
        />
        <span className="mt-1 block text-xs text-ink-500">至少 8 位,包含字母和数字,且不能与账号相同</span>
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">再次输入新密码</span>
        <input
          className="input-base"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
        />
      </label>
      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className="btn-primary w-full"
        disabled={loading || !currentPassword || !newPassword || !confirmPassword}
      >
        {loading ? "提交中..." : "修改密码"}
      </button>
    </form>
  );
}
