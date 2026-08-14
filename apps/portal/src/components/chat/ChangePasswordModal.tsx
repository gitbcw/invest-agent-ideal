"use client";

import { useState, type FormEvent } from "react";

interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

export function ChangePasswordModal({ open, onClose, onDone }: ChangePasswordModalProps) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!open) return null;

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
      setSuccess(true);
      setTimeout(() => {
        onClose();
        onDone?.();
      }, 700);
    } catch (err) {
      setError((err as Error).message ?? "网络异常");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setCurrent("");
    setNew("");
    setConfirm("");
    setError(null);
    setSuccess(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-ink-200 bg-white p-6 shadow-lg dark:border-ink-700 dark:bg-ink-900">
        <h2 className="mb-4 text-base font-semibold">修改密码</h2>
        {success ? (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            密码修改成功。
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium">当前密码</span>
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
              <span className="mb-1 block text-xs font-medium">新密码</span>
              <input
                className="input-base"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNew(e.target.value)}
                required
                minLength={8}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium">再次输入新密码</span>
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
            <div className="flex items-center justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={handleClose}>
                取消
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={loading || !currentPassword || !newPassword || !confirmPassword}
              >
                {loading ? "提交中..." : "确认修改"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
