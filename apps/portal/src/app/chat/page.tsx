import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";
import { ChatShell } from "@/components/chat/ChatShell";

export const metadata = { title: "澜策 · 投资助手" };

export default async function ChatPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");

  return (
    <ChatShell
      initialUser={{
        id: session.sub,
        username: session.username,
        role: session.role,
        assistantId: session.assistantId,
        instanceId: session.instanceId
      }}
    />
  );
}
