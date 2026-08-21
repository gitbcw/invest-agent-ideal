/**
 * Pure helpers for the conversation working-state checkpoint described in
 * docs/conversation-coherence-state-design.md.
 *
 * This module deliberately has no database, runtime, or model dependencies.
 * The state is derived context only; it is not an authority or permission
 * boundary.
 */

export const CONVERSATION_WORKING_STATE_VERSION = 1 as const;
export const CONVERSATION_WORKING_STATE_MAX_BYTES = 12 * 1024;
export const CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES = 4 * 1024;

export type ConversationDecisionState =
  | "discussed"
  | "proposed"
  | "confirmed-in-conversation"
  | "authoritative"
  | "superseded"
  | "rejected";

export type ConversationDecisionConfidence = "high" | "medium" | "low";

export type ConversationAuthorityKind =
  | "workspace-asset"
  | "service-entity"
  | "tool-result"
  | "audit-event";

export interface ConversationWorkingStateScopeV1 {
  userId: string;
  projectId: string;
  instanceId: string;
}

export interface ConversationTopicV1 {
  id: string;
  label: string;
  aliases: string[];
  lastTouchedMessageId: string;
}

export interface ConversationDecisionV1 {
  id: string;
  topicId: string;
  entity: string;
  field: string;
  value: unknown;
  state: ConversationDecisionState;
  supersedes: string[];
  sourceMessageIds: string[];
  authorityRef?: string;
  confidence: ConversationDecisionConfidence;
}

export interface ConversationPendingQuestionV1 {
  id: string;
  topicId: string;
  text: string;
  sourceMessageIds: string[];
}

export interface ConversationAuthoritativeRefV1 {
  id: string;
  kind: ConversationAuthorityKind;
  locator: string;
  revision?: string;
  checksum?: string;
  observedAt: string;
}

export interface ConversationWorkingStateV1 {
  version: 1;
  conversationId: string;
  scope: ConversationWorkingStateScopeV1;
  throughMessageId: string;
  throughCreatedAt: string;
  topics: ConversationTopicV1[];
  decisions: ConversationDecisionV1[];
  pendingQuestions: ConversationPendingQuestionV1[];
  authoritativeRefs: ConversationAuthoritativeRefV1[];
  generatedAt: string;
  generatorVersion: string;
  sourceDigest: string;
}

export interface ConversationWorkingStateValidationIssue {
  path: string;
  message: string;
}

export interface ConversationWorkingStateValidationResult {
  valid: boolean;
  issues: ConversationWorkingStateValidationIssue[];
  bytes?: number;
  state?: ConversationWorkingStateV1;
}

export interface ConversationWorkingStateValidationOptions {
  /** Override only for tests or a future schema revision. */
  maxBytes?: number;
  /** Validate the state against the supplied conversation scope. */
  expectedScope?: ConversationWorkingStateScopeV1;
  /** Validate the checkpoint against the supplied conversation id. */
  expectedConversationId?: string;
}

export interface ConversationWorkingStatePromptSliceOptions {
  /** Explicitly select topics; this takes precedence over query matching. */
  topicIds?: readonly string[];
  /** Match topic labels, aliases, entities, fields, and values. */
  query?: string;
  /** At most this many topics are injected. Defaults to three. */
  maxTopics?: number;
  /** Prompt cap in UTF-8 bytes. Defaults to four kilobytes. */
  maxBytes?: number;
  /** Include non-current decisions as a do-not-revive summary. */
  includeSuperseded?: boolean;
}

const DECISION_STATES = new Set<ConversationDecisionState>([
  "discussed",
  "proposed",
  "confirmed-in-conversation",
  "authoritative",
  "superseded",
  "rejected",
]);
const DECISION_CONFIDENCE = new Set<ConversationDecisionConfidence>(["high", "medium", "low"]);
const AUTHORITY_KINDS = new Set<ConversationAuthorityKind>([
  "workspace-asset",
  "service-entity",
  "tool-result",
  "audit-event",
]);

const ROOT_KEYS = [
  "version",
  "conversationId",
  "scope",
  "throughMessageId",
  "throughCreatedAt",
  "topics",
  "decisions",
  "pendingQuestions",
  "authoritativeRefs",
  "generatedAt",
  "generatorVersion",
  "sourceDigest",
] as const;
const SCOPE_KEYS = ["userId", "projectId", "instanceId"] as const;
const TOPIC_KEYS = ["id", "label", "aliases", "lastTouchedMessageId"] as const;
const DECISION_KEYS = [
  "id",
  "topicId",
  "entity",
  "field",
  "value",
  "state",
  "supersedes",
  "sourceMessageIds",
  "authorityRef",
  "confidence",
] as const;
const PENDING_KEYS = ["id", "topicId", "text", "sourceMessageIds"] as const;
const AUTHORITY_KEYS = ["id", "kind", "locator", "revision", "checksum", "observedAt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function checkExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ConversationWorkingStateValidationIssue[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push({ path: `${path}.${key}`, message: "unknown property" });
  }
  for (const key of allowed) {
    if (!hasOwn(value, key) && !optionalSet.has(key)) issues.push({ path: `${path}.${key}`, message: "missing property" });
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: ConversationWorkingStateValidationIssue[],
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return false;
  }
  return true;
}

function requireTimestamp(
  value: unknown,
  path: string,
  issues: ConversationWorkingStateValidationIssue[],
): value is string {
  if (!requireNonEmptyString(value, path, issues)) return false;
  if (Number.isNaN(Date.parse(value))) issues.push({ path, message: "must be a parseable timestamp" });
  return true;
}

function requireStringArray(
  value: unknown,
  path: string,
  issues: ConversationWorkingStateValidationIssue[],
): value is string[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return false;
  }
  for (const [index, item] of value.entries()) {
    requireNonEmptyString(item, `${path}[${index}]`, issues);
  }
  return true;
}

function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
}

function addIssue(
  issues: ConversationWorkingStateValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function duplicateIds(
  ids: readonly string[],
  path: string,
  issues: ConversationWorkingStateValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) addIssue(issues, `${path}[${index}]`, `duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

function sameScope(
  actual: ConversationWorkingStateScopeV1,
  expected: ConversationWorkingStateScopeV1,
): boolean {
  return actual.userId === expected.userId
    && actual.projectId === expected.projectId
    && actual.instanceId === expected.instanceId;
}

/** Return the stable identity used to detect competing current decisions. */
export function conversationDecisionKey(decision: Pick<ConversationDecisionV1, "topicId" | "entity" | "field">): string {
  return `${decision.topicId}\u001f${decision.entity}\u001f${decision.field}`;
}

/**
 * Project a decision list into the current effective decisions.
 *
 * A decision referenced by an active replacement is excluded even when a
 * producer forgot to rewrite its old state. This makes supersession monotonic
 * at the prompt boundary and prevents an old rule from resurfacing.
 */
export function projectCurrentDecisions(
  decisions: readonly ConversationDecisionV1[],
): ConversationDecisionV1[] {
  const supersededIds = new Set<string>();
  for (const decision of decisions) {
    if (decision.state === "superseded" || decision.state === "rejected") continue;
    for (const supersededId of decision.supersedes) supersededIds.add(supersededId);
  }

  const projected: ConversationDecisionV1[] = [];
  const indexByKey = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.state === "superseded" || decision.state === "rejected") continue;
    if (supersededIds.has(decision.id)) continue;
    const key = conversationDecisionKey(decision);
    const previousIndex = indexByKey.get(key);
    if (previousIndex !== undefined) {
      // The list is chronological in every checkpoint. Keep the newest value
      // as a defensive projection; strict validation still reports the clash.
      projected[previousIndex] = decision;
      continue;
    }
    indexByKey.set(key, projected.length);
    projected.push(decision);
  }
  return projected;
}

export const currentConversationDecisions = projectCurrentDecisions;

/** Validate a V1 checkpoint without mutating it. */
export function validateConversationWorkingState(
  input: unknown,
  options: ConversationWorkingStateValidationOptions = {},
): ConversationWorkingStateValidationResult {
  const issues: ConversationWorkingStateValidationIssue[] = [];
  if (!isRecord(input)) {
    return { valid: false, issues: [{ path: "$", message: "must be an object" }] };
  }
  checkExactKeys(input, ROOT_KEYS, "$", issues);

  if (input.version !== CONVERSATION_WORKING_STATE_VERSION) addIssue(issues, "$.version", "must equal 1");
  const conversationId = requireNonEmptyString(input.conversationId, "$.conversationId", issues) ? input.conversationId : "";
  const throughMessageId = requireNonEmptyString(input.throughMessageId, "$.throughMessageId", issues)
    ? input.throughMessageId
    : "";
  const generatorVersion = requireNonEmptyString(input.generatorVersion, "$.generatorVersion", issues)
    ? input.generatorVersion
    : "";
  const sourceDigest = requireNonEmptyString(input.sourceDigest, "$.sourceDigest", issues) ? input.sourceDigest : "";
  const throughCreatedAt = requireTimestamp(input.throughCreatedAt, "$.throughCreatedAt", issues)
    ? input.throughCreatedAt
    : "";
  const generatedAt = requireTimestamp(input.generatedAt, "$.generatedAt", issues) ? input.generatedAt : "";

  const scopeValue = input.scope;
  let scope: ConversationWorkingStateScopeV1 = { userId: "", projectId: "", instanceId: "" };
  if (!isRecord(scopeValue)) {
    addIssue(issues, "$.scope", "must be an object");
  } else {
    checkExactKeys(scopeValue, SCOPE_KEYS, "$.scope", issues);
    scope = {
      userId: requireNonEmptyString(scopeValue.userId, "$.scope.userId", issues) ? scopeValue.userId : "",
      projectId: requireNonEmptyString(scopeValue.projectId, "$.scope.projectId", issues) ? scopeValue.projectId : "",
      instanceId: requireNonEmptyString(scopeValue.instanceId, "$.scope.instanceId", issues) ? scopeValue.instanceId : "",
    };
  }
  if (options.expectedScope && !sameScope(scope, options.expectedScope)) addIssue(issues, "$.scope", "does not match expected scope");
  if (options.expectedConversationId !== undefined && conversationId !== options.expectedConversationId) {
    addIssue(issues, "$.conversationId", "does not match expected conversation");
  }

  const topics: ConversationTopicV1[] = [];
  const topicIds: string[] = [];
  if (!Array.isArray(input.topics)) {
    addIssue(issues, "$.topics", "must be an array");
  } else {
    for (const [index, item] of input.topics.entries()) {
      const path = `$.topics[${index}]`;
      if (!isRecord(item)) {
        addIssue(issues, path, "must be an object");
        continue;
      }
      checkExactKeys(item, TOPIC_KEYS, path, issues);
      const id = requireNonEmptyString(item.id, `${path}.id`, issues) ? item.id : "";
      const label = requireNonEmptyString(item.label, `${path}.label`, issues) ? item.label : "";
      const lastTouchedMessageId = requireNonEmptyString(item.lastTouchedMessageId, `${path}.lastTouchedMessageId`, issues)
        ? item.lastTouchedMessageId
        : "";
      const aliases = requireStringArray(item.aliases, `${path}.aliases`, issues) ? item.aliases : [];
      topicIds.push(id);
      topics.push({ id, label, aliases, lastTouchedMessageId });
    }
  }
  duplicateIds(topicIds, "$.topics", issues);
  const topicIdSet = new Set(topicIds);

  const refs: ConversationAuthoritativeRefV1[] = [];
  const refIds: string[] = [];
  if (!Array.isArray(input.authoritativeRefs)) {
    addIssue(issues, "$.authoritativeRefs", "must be an array");
  } else {
    for (const [index, item] of input.authoritativeRefs.entries()) {
      const path = `$.authoritativeRefs[${index}]`;
      if (!isRecord(item)) {
        addIssue(issues, path, "must be an object");
        continue;
      }
      checkExactKeys(item, AUTHORITY_KEYS, path, issues, ["revision", "checksum"]);
      const id = requireNonEmptyString(item.id, `${path}.id`, issues) ? item.id : "";
      const kind = item.kind;
      if (!AUTHORITY_KINDS.has(kind as ConversationAuthorityKind)) addIssue(issues, `${path}.kind`, "invalid authority kind");
      const locator = requireNonEmptyString(item.locator, `${path}.locator`, issues) ? item.locator : "";
      const observedAt = requireTimestamp(item.observedAt, `${path}.observedAt`, issues) ? item.observedAt : "";
      for (const optional of ["revision", "checksum"] as const) {
        if (hasOwn(item, optional)) requireNonEmptyString(item[optional], `${path}.${optional}`, issues);
      }
      refIds.push(id);
      refs.push({
        id,
        kind: kind as ConversationAuthorityKind,
        locator,
        ...(item.revision !== undefined ? { revision: item.revision as string } : {}),
        ...(item.checksum !== undefined ? { checksum: item.checksum as string } : {}),
        observedAt,
      });
    }
  }
  duplicateIds(refIds, "$.authoritativeRefs", issues);
  const refIdSet = new Set(refIds);

  const decisions: ConversationDecisionV1[] = [];
  const decisionIds: string[] = [];
  if (!Array.isArray(input.decisions)) {
    addIssue(issues, "$.decisions", "must be an array");
  } else {
    for (const [index, item] of input.decisions.entries()) {
      const path = `$.decisions[${index}]`;
      if (!isRecord(item)) {
        addIssue(issues, path, "must be an object");
        continue;
      }
      checkExactKeys(item, DECISION_KEYS, path, issues, ["authorityRef"]);
      const id = requireNonEmptyString(item.id, `${path}.id`, issues) ? item.id : "";
      const topicId = requireNonEmptyString(item.topicId, `${path}.topicId`, issues) ? item.topicId : "";
      const entity = requireNonEmptyString(item.entity, `${path}.entity`, issues) ? item.entity : "";
      const field = requireNonEmptyString(item.field, `${path}.field`, issues) ? item.field : "";
      if (!topicIdSet.has(topicId)) addIssue(issues, `${path}.topicId`, "must reference a topic");
      if (!isJsonValue(item.value)) addIssue(issues, `${path}.value`, "must be a JSON value");
      if (!DECISION_STATES.has(item.state as ConversationDecisionState)) addIssue(issues, `${path}.state`, "invalid decision state");
      if (!DECISION_CONFIDENCE.has(item.confidence as ConversationDecisionConfidence)) addIssue(issues, `${path}.confidence`, "invalid confidence");
      const supersedes = requireStringArray(item.supersedes, `${path}.supersedes`, issues) ? item.supersedes : [];
      const sourceMessageIds = requireStringArray(item.sourceMessageIds, `${path}.sourceMessageIds`, issues)
        ? item.sourceMessageIds
        : [];
      if (hasOwn(item, "authorityRef")) {
        if (!requireNonEmptyString(item.authorityRef, `${path}.authorityRef`, issues)) {
          // The shape error above is sufficient.
        } else if (!refIdSet.has(item.authorityRef)) {
          addIssue(issues, `${path}.authorityRef`, "must reference an authoritativeRefs entry");
        }
      }
      if (item.state === "authoritative" && (typeof item.authorityRef !== "string" || !refIdSet.has(item.authorityRef))) {
        addIssue(issues, `${path}.authorityRef`, "is required for authoritative decisions");
      }
      if (supersedes.includes(id)) addIssue(issues, `${path}.supersedes`, "cannot supersede itself");
      decisionIds.push(id);
      decisions.push({
        id,
        topicId,
        entity,
        field,
        value: item.value,
        state: item.state as ConversationDecisionState,
        supersedes,
        sourceMessageIds,
        ...(hasOwn(item, "authorityRef") ? { authorityRef: item.authorityRef as string } : {}),
        confidence: item.confidence as ConversationDecisionConfidence,
      });
    }
  }
  duplicateIds(decisionIds, "$.decisions", issues);
  const decisionIdSet = new Set(decisionIds);
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const [index, decision] of decisions.entries()) {
    for (const supersededId of decision.supersedes) {
      const predecessor = decisionById.get(supersededId);
      if (!predecessor) {
        if (!decisionIdSet.has(supersededId)) {
          addIssue(issues, `$.decisions[${index}].supersedes`, `unknown decision ${JSON.stringify(supersededId)}`);
        }
      } else if (predecessor.state !== "superseded" && predecessor.state !== "rejected") {
        addIssue(issues, `$.decisions[${index}].supersedes`, `decision ${JSON.stringify(supersededId)} must be marked superseded or rejected`);
      }
    }
  }

  const pendingQuestions: ConversationPendingQuestionV1[] = [];
  const pendingIds: string[] = [];
  if (!Array.isArray(input.pendingQuestions)) {
    addIssue(issues, "$.pendingQuestions", "must be an array");
  } else {
    for (const [index, item] of input.pendingQuestions.entries()) {
      const path = `$.pendingQuestions[${index}]`;
      if (!isRecord(item)) {
        addIssue(issues, path, "must be an object");
        continue;
      }
      checkExactKeys(item, PENDING_KEYS, path, issues);
      const id = requireNonEmptyString(item.id, `${path}.id`, issues) ? item.id : "";
      const topicId = requireNonEmptyString(item.topicId, `${path}.topicId`, issues) ? item.topicId : "";
      const text = requireNonEmptyString(item.text, `${path}.text`, issues) ? item.text : "";
      const sourceMessageIds = requireStringArray(item.sourceMessageIds, `${path}.sourceMessageIds`, issues)
        ? item.sourceMessageIds
        : [];
      if (!topicIdSet.has(topicId)) addIssue(issues, `${path}.topicId`, "must reference a topic");
      pendingIds.push(id);
      pendingQuestions.push({ id, topicId, text, sourceMessageIds });
    }
  }
  duplicateIds(pendingIds, "$.pendingQuestions", issues);

  // Multiple live values for one field are ambiguous. A replacement chain is
  // the only valid way for a later value to coexist with its predecessor.
  const currentByKey = new Map<string, ConversationDecisionV1>();
  const supersededIds = new Set(decisions.flatMap((decision) => decision.supersedes));
  for (const decision of decisions) {
    if (decision.state === "superseded" || decision.state === "rejected" || supersededIds.has(decision.id)) continue;
    const key = conversationDecisionKey(decision);
    const previous = currentByKey.get(key);
    if (previous) addIssue(issues, `$.decisions[${decision.id}]`, `conflicts with current decision ${JSON.stringify(previous.id)}`);
    else currentByKey.set(key, decision);
  }

  const state: ConversationWorkingStateV1 = {
    version: 1,
    conversationId,
    scope,
    throughMessageId,
    throughCreatedAt,
    topics,
    decisions,
    pendingQuestions,
    authoritativeRefs: refs,
    generatedAt,
    generatorVersion,
    sourceDigest,
  };

  let bytes: number | undefined;
  try {
    const serialized = JSON.stringify(state);
    bytes = new TextEncoder().encode(serialized).byteLength;
    const maxBytes = options.maxBytes ?? CONVERSATION_WORKING_STATE_MAX_BYTES;
    if (bytes > maxBytes) addIssue(issues, "$", `serialized state is ${bytes} bytes; maximum is ${maxBytes}`);
  } catch {
    addIssue(issues, "$", "must be serializable as JSON");
  }

  return issues.length === 0
    ? { valid: true, issues: [], bytes, state }
    : { valid: false, issues, bytes };
}

/** Validate and return a safe V1 state, throwing a concise error on failure. */
export function assertConversationWorkingState(
  input: unknown,
  options: ConversationWorkingStateValidationOptions = {},
): ConversationWorkingStateV1 {
  const result = validateConversationWorkingState(input, options);
  if (!result.valid || !result.state) {
    const detail = result.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    const suffix = result.issues.length > 4 ? `; ${result.issues.length - 4} more issue(s)` : "";
    throw new Error(`invalid ConversationWorkingStateV1${detail ? `: ${detail}` : ""}${suffix}`);
  }
  return result.state;
}

export const parseConversationWorkingState = assertConversationWorkingState;

/**
 * Result-shaped parser used by metadata readers. Unlike the throwing parser,
 * this form lets a corrupt checkpoint degrade to the next older checkpoint.
 */
export function parseConversationWorkingStateV1(
  input: unknown,
):
  | { ok: true; value: ConversationWorkingStateV1 }
  | { ok: false; error: string } {
  const result = validateConversationWorkingState(input);
  if (result.valid && result.state) return { ok: true, value: result.state };
  const detail = result.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  const suffix = result.issues.length > 4 ? `; ${result.issues.length - 4} more issue(s)` : "";
  return { ok: false, error: `invalid ConversationWorkingStateV1${detail ? `: ${detail}` : ""}${suffix}` };
}

/** Serialize only a validated state and enforce the UTF-8 byte cap. */
export function serializeConversationWorkingState(
  input: ConversationWorkingStateV1,
  options: ConversationWorkingStateValidationOptions = {},
): string {
  const state = assertConversationWorkingState(input, options);
  const serialized = JSON.stringify(state);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > (options.maxBytes ?? CONVERSATION_WORKING_STATE_MAX_BYTES)) {
    throw new Error(`ConversationWorkingStateV1 exceeds byte cap: ${bytes}`);
  }
  return serialized;
}

function valueForPrompt(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return "[unserializable]";
  }
}

function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const suffix = "\n[working state slice clipped]";
  const suffixBytes = encoder.encode(suffix).byteLength;
  const clipCodePoints = (value: string, budget: number): string => {
    let clipped = "";
    for (const codePoint of value) {
      const candidate = clipped + codePoint;
      if (encoder.encode(candidate).byteLength > budget) break;
      clipped = candidate;
    }
    return clipped;
  };
  if (suffixBytes >= maxBytes) return clipCodePoints(suffix, maxBytes);
  return `${clipCodePoints(text, maxBytes - suffixBytes)}${suffix}`;
}

function topicMatchesQuery(
  topic: ConversationTopicV1,
  decisions: readonly ConversationDecisionV1[],
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return false;
  const fields = [topic.id, topic.label, ...topic.aliases];
  for (const decision of decisions) {
    if (decision.topicId !== topic.id) continue;
    fields.push(decision.entity, decision.field, valueForPrompt(decision.value));
  }
  return fields.some((field) => field.toLocaleLowerCase().includes(normalized));
}

/**
 * Format a bounded, relevant prompt slice. It explicitly labels the state as
 * derived context and lists superseded values only as values that must not be
 * revived.
 */
export function formatConversationWorkingStatePromptSlice(
  state: ConversationWorkingStateV1,
  options: ConversationWorkingStatePromptSliceOptions = {},
): string {
  const maxBytes = options.maxBytes ?? CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES;
  const maxTopics = Math.max(1, Math.min(3, Math.floor(options.maxTopics ?? 3)));
  const includeSuperseded = options.includeSuperseded ?? true;
  const projected = projectCurrentDecisions(state.decisions);
  const explicitTopicIds = options.topicIds ? new Set(options.topicIds) : undefined;
  const selectedTopics = state.topics
    .filter((topic) => explicitTopicIds?.has(topic.id) || (!explicitTopicIds && options.query && topicMatchesQuery(topic, state.decisions, options.query)))
    .slice(0, maxTopics);
  const topics = selectedTopics.length > 0
    ? selectedTopics
    : state.topics.slice(0, maxTopics);
  const topicSet = new Set(topics.map((topic) => topic.id));
  const current = projected.filter((decision) => topicSet.has(decision.topicId));
  const stale = state.decisions.filter((decision) => {
    if (!topicSet.has(decision.topicId)) return false;
    if (decision.state === "superseded" || decision.state === "rejected") return true;
    return !current.some((item) => item.id === decision.id);
  });
  const lines: string[] = [
    "[Conversation working state: derived context, not authority or permission]",
    `Conversation: ${state.conversationId}`,
    `Checkpoint: ${state.throughMessageId}`,
    "Current topics:",
  ];
  for (const topic of topics) {
    const aliases = topic.aliases.length > 0 ? ` (aliases: ${topic.aliases.join(", ")})` : "";
    lines.push(`- ${topic.id}: ${topic.label}${aliases}`);
  }
  lines.push("Current decisions:");
  if (current.length === 0) lines.push("- none");
  for (const decision of current) {
    const authority = decision.state === "authoritative" ? "; authority must be rechecked against its reference" : "";
    lines.push(`- ${decision.entity}.${decision.field} = ${valueForPrompt(decision.value)} [${decision.state}]${authority}`);
  }
  if (includeSuperseded) {
    lines.push("Superseded/rejected values (do not revive):");
    if (stale.length === 0) lines.push("- none");
    for (const decision of stale) {
      lines.push(`- ${decision.entity}.${decision.field} = ${valueForPrompt(decision.value)} [${decision.state}; do not revive]`);
    }
  }
  const pending = state.pendingQuestions.filter((question) => topicSet.has(question.topicId));
  lines.push("Pending questions:");
  if (pending.length === 0) lines.push("- none");
  for (const question of pending) lines.push(`- ${question.text}`);
  lines.push("Authoritative items still require reading the referenced current entity or asset.");
  return clipUtf8(lines.join("\n"), maxBytes);
}

export const formatWorkingStatePromptSlice = formatConversationWorkingStatePromptSlice;

/** Check the instance-scoped rollout flag. Empty or missing means disabled. */
export function isConversationWorkingStateEnabled(
  instanceId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!instanceId.trim()) return false;
  const raw = env.COHERENCE_STATE_INSTANCE_ALLOWLIST;
  if (!raw) return false;
  const entries = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return entries.includes("*") || entries.includes(instanceId);
}

export const isCoherenceStateEnabled = isConversationWorkingStateEnabled;
