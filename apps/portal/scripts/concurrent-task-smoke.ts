import { nanoid } from "nanoid";

const base = process.env.PORTAL_BASE ?? "http://127.0.0.1:3100";
const username = process.env.PORTAL_USER ?? "primary";
const password = process.env.PORTAL_PASS ?? "User@2026";

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  return {
    status: response.status,
    body: await response.json() as any,
    cookie: response.headers.get("set-cookie")?.split(";")[0]
  };
}

async function main() {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (login.status !== 200 || !login.body?.ok || !login.cookie) {
    throw new Error(`login failed status=${login.status}`);
  }

  const runId = `${Date.now()}_${nanoid(6)}`;
  const conversationIds = [1, 2, 3].map((index) => `web_concurrent_smoke_${runId}_${index}`);
  const startedAt = Date.now();
  const results = await Promise.all(conversationIds.map((conversationId, index) => request(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { cookie: login.cookie! },
      body: JSON.stringify({
        text: `本地并发验收任务 ${index + 1}：请只回复“任务 ${index + 1} 完成”。`,
        idempotencyKey: `concurrent_smoke_${runId}_${index + 1}`
      })
    }
  )));

  const succeeded = results.flatMap((result, index) =>
    result.status === 200 && result.body?.ok && result.body?.data?.ok
      ? [{ index, result }]
      : []
  );
  const limited = results.flatMap((result, index) =>
    result.status === 200 && result.body?.ok && result.body?.data?.error?.code === "CONCURRENT_TASK_LIMIT"
      ? [{ index, result }]
      : []
  );
  if (succeeded.length !== 2 || limited.length !== 1) {
    throw new Error(`unexpected outcomes success=${succeeded.length} limited=${limited.length}`);
  }

  for (const { index } of succeeded) {
    const detail = await request(`/api/conversations/${conversationIds[index]}`, {
      headers: { cookie: login.cookie! }
    });
    const messages = detail.body?.data?.messages ?? [];
    if (detail.status !== 200 || !detail.body?.ok || messages.length < 2) {
      throw new Error(`conversation ${index + 1} was not persisted independently`);
    }
    if (messages.some((message: any) => message.conversationId !== conversationIds[index])) {
      throw new Error(`conversation ${index + 1} contains cross-task messages`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    elapsedMs: Date.now() - startedAt,
    succeeded: succeeded.map(({ index }) => conversationIds[index]),
    limited: limited.map(({ index }) => conversationIds[index])
  }));
}

void main().catch((error) => {
  console.error(`[concurrent-task-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
