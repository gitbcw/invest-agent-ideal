"use client";

import { useEffect, useRef, useState } from "react";
import { BarChart3, BookOpen, ChevronDown, KeyRound, LogOut } from "lucide-react";

interface UserMenuProps {
  username: string;
  compact?: boolean;
  onOpenManual: () => void;
  onOpenUsage: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}

export function UserMenu({ username, compact = false, onOpenManual, onOpenUsage, onChangePassword, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={compact
          ? "flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-white"
          : "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-[#343541] transition hover:bg-white"}
        aria-label={compact ? `${username} 的账户菜单` : undefined}
        title={compact ? "账户菜单" : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#B4232C] text-sm font-semibold text-white">
          {initials(username)}
        </span>
        {!compact ? <span className="flex-1 truncate">{username}</span> : null}
        {!compact ? <ChevronDown size={15} className={`text-[#8e8ea0] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 w-48 overflow-hidden rounded-md border border-black/10 bg-white py-1 text-sm text-[#343541] shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-black/5"
            onClick={() => {
              setOpen(false);
              onOpenManual();
            }}
          >
            <BookOpen size={15} aria-hidden="true" />
            <span>使用手册</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-black/5"
            onClick={() => {
              setOpen(false);
              onOpenUsage();
            }}
          >
            <BarChart3 size={15} aria-hidden="true" />
            <span>使用记录</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-black/5"
            onClick={() => {
              setOpen(false);
              onChangePassword();
            }}
          >
            <KeyRound size={15} aria-hidden="true" />
            <span>修改密码</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 transition hover:bg-red-50"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <LogOut size={15} aria-hidden="true" />
            <span>退出登录</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "U";
  const first = trimmed.charAt(0).toUpperCase();
  return first;
}
