const ONBOARDING_CORE_KEYS = [
  "onboarding-state",
  "notification",
  "portfolio",
  "schedules",
  "strategy",
  "watch",
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function beijingDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function onboardingStepKeys(step: string): string[] {
  const state = ["onboarding-state"];
  if (step === "style") return [...state, "strategy"];
  if (step === "review_schedule" || step === "market_watch_schedule") return [...state, "schedules"];
  if (step === "notification") return [...state, "notification", "schedules"];
  if (step === "watch_rules") return [...state, "watch"];
  return state;
}

/** Maps deterministic write operations to the physical resources they mutate. */
export function mutationResourceKeysForOperation(
  operation: string,
  input: Record<string, unknown> | undefined,
): string[] {
  switch (operation) {
    case "portfolio.apply_changes":
    case "watchlist.add":
    case "watchlist.remove":
    case "plans.set":
    case "plans.watch_conditions":
    case "plans.remove":
      // Workspace portfolio, watchlist, and stock plans currently share portfolio.yaml.
      return ["portfolio"];
    case "onboarding.confirm_portfolio":
      return ["onboarding-state", "portfolio"];
    case "onboarding.confirm_step":
      return onboardingStepKeys(text(input?.step));
    case "onboarding.complete_watch_setup":
      return ["onboarding-state", "watch", "watch-rules"];
    case "onboarding.draft.commit":
      return [...ONBOARDING_CORE_KEYS, "watch-rules"];
    case "strategies.set":
    case "strategies.remove":
    case "profiles.investment.set":
    case "profiles.methodology.set":
      return ["strategy"];
    case "watch_rules.create":
    case "watch_rules.update":
    case "watch_rules.delete":
      return ["watch-rules"];
    case "method_changes.propose":
    case "method_changes.decide":
      return ["method-changes"];
    case "method_changes.apply":
      return ["method-changes", "strategy"];
    case "preferences.apply":
      return ["schedules", "notification"];
    case "reviews.save":
      if (text(input?.kind) === "weekly" || text(input?.kind) === "monthly") {
        return [`${text(input?.kind)}-review:${text(input?.reportKey) || "invalid"}`];
      }
      return [`daily-review:${text(input?.date) || beijingDateKey()}`];
    case "reviews.daily":
      return [`daily-review:${text(input?.date) || beijingDateKey()}`];
    default:
      return [];
  }
}
