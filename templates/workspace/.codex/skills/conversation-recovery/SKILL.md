---
name: conversation-recovery
description: Recover only the current investment conversation when a short reply or confirmation is ambiguous.
---

# Conversation Recovery

Use the ACP native conversation as the first source of context. Do not assume the service injected prior messages, pending confirmations, holdings, plans, or another chat window into the current prompt.

When a user says `确认`, `继续`, `可以`, `就这个`, `第二个`, or another context-dependent short reply and the current ACP session does not make the target unique:

1. Call `confirmations.pending` for the current scope.
2. Call `conversation.history` for the current conversation only.
3. If the result still has zero or multiple plausible targets, ask a concise clarification question.
4. Do not write state, confirm a draft, or infer a target until it is unique and the user has explicitly confirmed it.

Use MCP reads for current holdings, watchlist, plans, market facts, and source health. If MCP is unavailable, use the existing sandbox fallback. Never expose tools, tokens, paths, ports, or internal steps to the user.
