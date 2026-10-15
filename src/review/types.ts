import type { Confidence, Evidence, Priority } from "../domain/types";

export const REVIEW_CATEGORIES = [
  "standards",
  "pull_requests",
  "dependencies",
  "cleanup",
  "health",
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const REVIEW_STATES = ["needs_review", "observed", "unknown", "not_applicable"] as const;

export type ReviewState = (typeof REVIEW_STATES)[number];

/** A review proposal is evidence, never authority to mutate a repository. */
export interface ReviewFinding {
  readonly id: string;
  readonly repository: string;
  readonly category: ReviewCategory;
  readonly title: string;
  readonly state: ReviewState;
  readonly priority: Priority;
  readonly confidence: Confidence;
  readonly current: string;
  readonly desired: string;
  readonly nextStep: string;
  readonly evidence: readonly Evidence[];
  readonly approvalRequired: boolean;
}

export interface RepositoryReview {
  readonly repository: string;
  readonly url: string;
  readonly commit: string | null;
  readonly collectedAt: string;
  readonly findings: readonly ReviewFinding[];
  readonly limitations: readonly string[];
}
