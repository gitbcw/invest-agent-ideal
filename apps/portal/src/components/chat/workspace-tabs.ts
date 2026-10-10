export interface WorkspaceTabState {
  tabId: string;
  pinned: boolean;
}

export function openPinnedTab<T extends WorkspaceTabState>(tabs: T[], incoming: T, maxTabs: number): T[] {
  const existing = tabs.some((tab) => tab.tabId === incoming.tabId);
  const next = existing
    ? tabs.map((tab) => tab.tabId === incoming.tabId ? { ...tab, ...incoming, pinned: true } : tab)
    : [...tabs, { ...incoming, pinned: true }];
  return limitTabs(next, maxTabs);
}

export function pinTab<T extends WorkspaceTabState>(tabs: T[], tabId: string): T[] {
  return tabs.map((tab) => tab.tabId === tabId ? { ...tab, pinned: true } : tab);
}

function limitTabs<T>(tabs: T[], maxTabs: number): T[] {
  return tabs.length > maxTabs ? tabs.slice(tabs.length - maxTabs) : tabs;
}
