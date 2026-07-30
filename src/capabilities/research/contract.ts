import type {
  PublicNewsEvidenceResult,
  PublicWebPageResult,
  PublicWebSearchResult,
  ResearchNewsDependencies,
  ResearchWebReadDependencies,
  ResearchWebSearchDependencies,
} from "../../services/external-evidence-search.js";

export interface ResearchCapabilityContract {
  newsSearch(input: { query: string; days?: number; limit?: number; userId?: string | null }, dependencies?: ResearchNewsDependencies): Promise<PublicNewsEvidenceResult>;
  webSearch(input: { query: string; limit?: number; userId?: string | null }, dependencies?: ResearchWebSearchDependencies): Promise<PublicWebSearchResult>;
  webRead(input: { url: string; maxCharacters?: number; userId?: string | null }, dependencies?: ResearchWebReadDependencies): Promise<PublicWebPageResult>;
}
