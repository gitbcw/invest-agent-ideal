# Onboarding Quality Standards

Grade each standard `pass`, `partial`, or `fail`. These standards define user outcomes and failure boundaries; test procedure belongs in `audit-checklist.md`.

## ONB-01 Identity And Setup Framing

**User outcome:** On the first incomplete onboarding turn, the user knows this is their investment assistant, understands that a short initial setup is in progress, knows what information is needed now, and knows a draft will be confirmed before saving. Holdings, cash position, and watchlist may be supplied as text or screenshots without a separate “开始” gate.

**Fail when:** Identity or setup context is missing; the opening jumps abruptly into a “most important step”; it asks for unnecessary private data; or it requires a content-free start confirmation.

## ONB-02 Progressive Guided Flow

**User outcome:** The conversation feels like one continuous guide. Each successful step acknowledges what completed, briefly explains why the next step matters, and asks one concrete next question. Missing information produces a focused clarification, and detours resume from current state without replaying confirmed work.

**Fail when:** The user must guess how to continue, say “下一步继续”, encounters a dead end, is sent back to an earlier completed step, or receives multiple poorly separated decisions at once.

## ONB-03 Draft, Confirmation, And Save Semantics

**User outcome:** Each section is drafted before it is accepted. One ordinary confirmation after the displayed draft is sufficient and bound to that exact revision; accepting it only updates the service-owned onboarding draft. After every required section is accepted, one frozen snapshot is applied and verified as the durable Workspace configuration. Failed final commits remain visible in audit evidence and do not masquerade as success.

**Fail when:** A workspace file changes before final commit; a normal confirmation is ignored or requested again; the assistant claims a draft is already effective; a frozen snapshot differs from accepted revisions; or a final commit fails while the assistant claims success.

## ONB-04 State And Workspace Consistency

**User outcome:** Conversation claims, onboarding state, workspace files, audit records, and pending confirmations agree. Securities are resolved to usable codes or ambiguity is surfaced; user-provided weights and cash ratio are retained; internal paths, APIs, tokens, runtime diagnostics, and implementation vocabulary never reach customer copy.

**Fail when:** Any authoritative sources contradict the reply, a completed step is missing required data, ambiguity is silently guessed, accepted user data disappears, stale market facts are presented as fresh, or internal text leaks to the user.

## ONB-05 Rule And Observation Boundary

**User outcome:** The user understands that explicit rules inspect executable conditions, while scheduled market-watch/review provides periodic broader observation. Rules are created only from explicit catalog-supported inputs after their own draft and confirmation. Skipping rules creates none and does not imply continuous or guaranteed monitoring.

**Fail when:** Generic risk preference, cost price, or “帮我盯风险” becomes a concrete rule; periodic observation is described as real-time/continuous/guaranteed; rule and notification concepts are mixed; or branch outcomes disagree with scoped rules and audits.

## ONB-06 Direct Completion And Useful Handoff

**User outcome:** An explicit skip or accepted executable rule draft completes the last decision directly. No content-free “确认完成” is required. The user first receives a short message that configuration is being completed, then a completion notification after the frozen snapshot is verified. Final state is complete and no pending confirmation remains.

**Fail when:** Another completion-only confirmation is requested; the assistant claims completion while state is incomplete; pending confirmations remain; or the journey ends without a usable transition into the product.
