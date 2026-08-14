import type { Metadata } from "next";
import "./globals.css";
import { FilePanelProvider } from "@/components/file-panel/FilePanelProvider";

export const metadata: Metadata = {
  title: "澜策 · 投资助手",
  description: "澜策投资助手门户,登录后可直接与你的专属投资助手对话",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-full"><FilePanelProvider>{children}</FilePanelProvider></body>
    </html>
  );
}
