/** Social media posts inside the Content & Marketing Agent (demo only: nothing is ever posted anywhere). */
import type { ThumbTone } from "./index";

export const SOCIAL_PLATFORMS = ["Instagram", "Facebook", "LinkedIn"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialStatus = "draft" | "pending_approval" | "approved" | "rejected" | "simulated_published";

/** SAMPLE numbers. They describe no real post and no real audience. */
export interface SocialMetrics {
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  /** Engagement rate in percent. */
  engagement: number;
}

export interface SocialPost {
  id: string;
  title: string;
  topic: string;
  platform: SocialPlatform;
  caption: string;
  hashtags: string[];
  creativeBrief: string;
  imageDirection: string;
  /** Explicit date (YYYY-MM-DD) for posts a visitor plans. */
  scheduledFor?: string;
  /** Sample posts are placed relative to today so the calendar never looks stale. */
  dayOffset?: number;
  /** Set when the post has been sent to the approval queue; the status then follows that approval. */
  approvalId?: string;
  /** Status of a sample post that has no approval record. */
  seedStatus?: SocialStatus;
  /** True after "Simulate publish". Nothing is posted anywhere. */
  simulatedPublished?: boolean;
  isSample: boolean;
  tone: ThumbTone;
  metrics?: SocialMetrics;
}

export interface SocialPostView extends SocialPost {
  status: SocialStatus;
  scheduledFor: string;
}

export interface SocialPostInput {
  title: string;
  topic: string;
  platform: SocialPlatform;
  caption: string;
  hashtags: string[];
  creativeBrief: string;
  imageDirection: string;
  scheduledFor?: string;
}

export type AssistMode = "ideas" | "caption" | "brief";

export interface AssistResult {
  mode: AssistMode;
  /** Always says that this is a template response and no AI model is connected. */
  label: string;
  suggestions: string[];
  hashtags: string[];
  /** Prohibited wording (price, discount, stock, unapproved claims) found in the visitor's own text. */
  warnings: string[];
}
