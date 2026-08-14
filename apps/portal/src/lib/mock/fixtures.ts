import type {
  ConversationChannel,
  ConversationMessage,
  ConversationSummary
} from "@/lib/protocol";

/**
 * Mock connector 的内置 fixtures。
 * 每个场景对应一组会话历史。
 */

const NOW = Date.now();
const day = 86_400_000;
const isoNow = new Date(NOW).toISOString();
const isoMinus = (deltaMs: number) => new Date(NOW - deltaMs).toISOString();

function mkMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  deltaMs: number;
  channel?: ConversationChannel;
  metadata?: Record<string, unknown>;
}): ConversationMessage {
  const messageId = `${input.conversationId}_${input.role}_${input.deltaMs}_${input.metadata ? "md" : "x"}`;
  return {
    messageId,
    conversationId: input.conversationId,
    userId: "primary",
    assistantId: "invest-agent-primary",
    instanceId: "invest-agent-primary",
    channel: input.channel ?? "web",
    role: input.role,
    content: input.content,
    status: "sent",
    createdAt: isoMinus(input.deltaMs),
    ...(input.metadata ? { metadata: input.metadata } : {})
  };
}

function mkConversation(input: {
  id: string;
  title: string;
  deltaMs: number;
  messageCount: number;
  lastPreview: string;
  channel?: ConversationChannel;
}): ConversationSummary {
  return {
    conversationId: input.id,
    title: input.title,
    channel: input.channel ?? "web",
    lastMessagePreview: input.lastPreview,
    messageCount: input.messageCount,
    createdAt: isoMinus(input.deltaMs + 3_600_000),
    updatedAt: isoMinus(input.deltaMs)
  };
}

export interface MockFixture {
  conversations: ConversationSummary[];
  messagesByConversation: Record<string, ConversationMessage[]>;
}

/**
 * 默认场景:3 条会话,内容简短,适合 UI 验收。
 */
export const FIXTURE_ONLINE: MockFixture = {
  conversations: [
    mkConversation({
      id: "web_001",
      title: "持仓风险快检",
      deltaMs: 30 * 60_000,
      messageCount: 4,
      lastPreview: "当前组合整体偏成长,建议关注半导体仓位"
    }),
    mkConversation({
      id: "web_002",
      title: "复盘最近一周",
      deltaMs: 3 * 3_600_000,
      messageCount: 6,
      lastPreview: "上周主要受情绪面影响,交易节奏可以更慢一点"
    }),
    mkConversation({
      id: "web_003",
      title: "选股初筛",
      deltaMs: 2 * day,
      messageCount: 8,
      lastPreview: "可以加入 ROE > 15% 的过滤"
    })
  ],
  messagesByConversation: {
    web_001: [
      mkMessage({ conversationId: "web_001", role: "user", content: "今天帮我看一下持仓风险", deltaMs: 33 * 60_000 }),
      mkMessage({ conversationId: "web_001", role: "assistant", content: "正在分析你的持仓。", deltaMs: 31 * 60_000 }),
      // A user message carrying two attachment metadata entries: one active
      // (mock_att_active) and one already past its 7-day TTL (mock_att_expired).
      // Lets the browser acceptance exercise the upload-card "保留至 <expiresAt>"
      // countdown (§13 item 1) and the "附件已过期" state (§13 item 2) against
      // a real rendered conversation card without a live clock.
      mkMessage({
        conversationId: "web_001",
        role: "user",
        content: "这是两张截图，一张刚发，一张上周的",
        deltaMs: 30 * 60_000 + 45_000,
        metadata: {
          attachments: [
            {
              attachmentId: "mock_att_active",
              id: "mock_att_active",
              type: "image",
              mimeType: "image/png",
              fileName: "持仓截图.png",
              sizeBytes: 70,
              source: "portal",
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            },
            {
              attachmentId: "mock_att_expired",
              id: "mock_att_expired",
              type: "image",
              mimeType: "image/png",
              fileName: "上周截图.png",
              sizeBytes: 70,
              source: "portal",
              expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
            }
          ]
        }
      }),
      mkMessage({ conversationId: "web_001", role: "user", content: "半导体能继续拿吗", deltaMs: 30 * 60_000 + 30_000 }),
      mkMessage({
        conversationId: "web_001",
        role: "assistant",
        content: "当前组合整体偏成长,建议关注半导体仓位。可以分批止盈一半,等回调再补。",
        deltaMs: 30 * 60_000,
        metadata: {
          artifacts: [{
            artifactId: "mock_art_daily_20260725",
            title: "持仓风险复盘",
            fileName: "2026-07-25.md",
            mimeType: "text/markdown",
            sizeBytes: 96,
            kind: "report",
            previewMode: "markdown",
            createdAt: isoMinus(30 * 60_000),
          }],
        },
      })
    ],
    web_002: [
      mkMessage({ conversationId: "web_002", role: "user", content: "复盘上周交易", deltaMs: 3 * 3_600_000 + 5 * 60_000 }),
      mkMessage({
        conversationId: "web_002",
        role: "assistant",
        content: "上周主要受情绪面影响,交易节奏可以更慢一点。追高造成的回撤约 2.4%。",
        deltaMs: 3 * 3_600_000
      })
    ],
    web_003: [
      mkMessage({ conversationId: "web_003", role: "user", content: "帮我做一轮选股初筛", deltaMs: 2 * day + 60_000 }),
      mkMessage({
        conversationId: "web_003",
        role: "assistant",
        content: "可以加入 ROE > 15% 的过滤,另外剔除最近 30 天有商誉减值的标的。",
        deltaMs: 2 * day
      })
    ]
  }
};

export const FIXTURE_EMPTY: MockFixture = {
  conversations: [],
  messagesByConversation: {}
};

/**
 * 分页场景:25 条会话,标题里带序号,方便验证翻页。
 */
export const FIXTURE_PAGED: MockFixture = (() => {
  const conversations: ConversationSummary[] = [];
  const messagesByConversation: Record<string, ConversationMessage[]> = {};
  for (let i = 1; i <= 25; i++) {
    const id = `web_p${String(i).padStart(3, "0")}`;
    const deltaMs = i * 30 * 60_000;
    const title = `分页测试会话 #${i}`;
    conversations.push(
      mkConversation({
        id,
        title,
        deltaMs,
        messageCount: 4,
        lastPreview: `第 ${i} 条会话最后一条消息预览`
      })
    );
    messagesByConversation[id] = [
      mkMessage({
        conversationId: id,
        role: "user",
        content: `第 ${i} 个会话的提问`,
        deltaMs: deltaMs + 30_000
      }),
      mkMessage({
        conversationId: id,
        role: "assistant",
        content: `第 ${i} 个会话的回复`,
        deltaMs
      })
    ];
  }
  return { conversations, messagesByConversation };
})();

export function pickFixture(scenario: string): MockFixture {
  switch (scenario) {
    case "empty":
      return FIXTURE_EMPTY;
    case "paged":
      return FIXTURE_PAGED;
    case "offline":
      return FIXTURE_EMPTY; // 离线时不参与,fixture 不会用上
    case "online":
    case "slow":
    case "failed":
    default:
      return FIXTURE_ONLINE;
  }
}

/**
 * 根据 user message 内容生成"助手回复"。
 * mock 永远不会真正调用 ACP,这里给出可读的模板回复。
 */
export function generateMockAssistantReply(userText: string): string {
  const trimmed = userText.trim();
  if (!trimmed) {
    return "(空消息)";
  }
  return [
    "收到你的问题,我是 mock connector。模拟回复如下:",
    "",
    `> ${trimmed}`,
    "",
    "实际接入 invest-agent-ideal 本地 connector 后,这里会返回 workspace ACP 的真实回复。",
    "",
    "你可以:继续问持仓/复盘/选股/提醒相关问题,或刷新页面验证历史是否落库。"
  ].join("\n");
}
