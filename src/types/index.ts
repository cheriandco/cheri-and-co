/** Typed domain models. Names mirror the conceptual entities in the brief so
 *  they can later map 1:1 onto Supabase tables. */

export type AgentKey = "b2c" | "b2b" | "amazon" | "content" | "crm";

export type AgentStatus = "active" | "idle" | "attention";

export interface Agent {
  key: AgentKey;
  name: string;
  status: AgentStatus;
  lastActivity: string;
  actionsToday: number;
  latestAction: string;
}

export type Range = "today" | "7d" | "30d" | "90d" | "custom";

export interface Kpi {
  id: string;
  label: string;
  value: number;
  change: number; // percent vs previous period
  comparison: string;
  spark: number[];
  href: string;
}

export interface TrendPoint {
  label: string;
  b2c: number;
  b2b: number;
}
export type TrendSeries = Record<"7d" | "30d" | "90d", TrendPoint[]>;

export type PipelineStage =
  | "new"
  | "qualified"
  | "contacted"
  | "interested"
  | "negotiation"
  | "won"
  | "lost";

export interface FunnelStage {
  stage: PipelineStage;
  label: string;
  count: number;
}

export interface Deal {
  id: string;
  retailerId: string;
  business: string;
  location: string;
  stage: PipelineStage;
  score: number;
  owner: string;
  updated: string;
}

export type EnquiryStatus = "new" | "ai_replied" | "needs_human" | "resolved";

export interface Enquiry {
  id: string;
  customerId: string;
  customer: string;
  handle: string;
  message: string;
  time: string;
  status: EnquiryStatus;
  product: string;
  handler: "AI" | "Human";
}

export interface Message {
  id: string;
  from: "customer" | "ai" | "human";
  text: string;
  time: string;
}

export interface Conversation extends Enquiry {
  messages: Message[];
}

export type Temperature = "HOT" | "WARM" | "COLD";

export interface Retailer {
  id: string;
  business: string;
  location: string;
  category: string;
  score: number;
  temperature: Temperature;
  status: string;
  lastActivity: string;
  contact: string;
  email: string;
  phone: string;
  instagram: string;
  website: string;
  mapsUrl: string;
  qualification: string;
  stage: PipelineStage;
}

export interface Customer {
  id: string;
  name: string;
  instagram: string;
  phone: string;
  email: string;
  city: string;
  firstSeen: string;
  interests: string[];
  amazonClicks: number;
  flipkartClicks: number;
  purchases: number;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;
  price: number;
  stock: number;
  channels: string[];
  status: "active" | "draft" | "low_stock";
}

export type ContentStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "scheduled"
  | "published"
  | "rejected";

export type ThumbTone = "blush" | "rose" | "sand" | "sage" | "plum" | "pearl";

export interface ContentItem {
  id: string;
  name: string;
  platform: "Instagram" | "Pinterest" | "Email" | "Amazon A+";
  type: "Reel" | "Carousel" | "Post" | "Story" | "Newsletter" | "Listing";
  date: string;
  status: ContentStatus;
  tone: ThumbTone;
  reach?: number;
  engagement?: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed";

/** Set on approvals created by the Content & Marketing Agent so the claim guard can re-check them on approval. */
export interface ContentApprovalMeta {
  kind: "content_draft";
  subject: string;
  isSample: boolean;
  allowedClaims: string[];
}

export interface Approval {
  id: string;
  title: string;
  type: "Instagram reply" | "B2B outreach" | "Content" | "Amazon listing" | "Pricing change";
  generatedBy: AgentKey;
  created: string;
  status: ApprovalStatus;
  preview: string;
  tone: ThumbTone;
  meta?: ContentApprovalMeta;
}

export interface AuditEntry {
  id: string;
  approvalId: string;
  action: "approve" | "reject" | "edit";
  actor: string;
  at: string;
  note?: string;
}

export type Level = "high" | "medium" | "low";

export interface AmazonRow {
  id: string;
  product: string;
  demand: Level;
  competition: Level;
  avgPrice: number;
  opportunity: number;
  recommendation: string;
}

export interface AmazonCompetitor {
  id: string;
  brand: string;
  asin: string;
  price: number;
  rating: number;
  reviews: number;
  rank: string;
}

export interface AmazonReview {
  id: string;
  product: string;
  rating: number;
  theme: string;
  sentiment: "positive" | "neutral" | "negative";
  excerpt: string;
}

export interface AmazonPricing {
  id: string;
  product: string;
  ourPrice: number;
  marketLow: number;
  marketHigh: number;
  suggested: number;
}

export interface AmazonListing {
  id: string;
  product: string;
  asin: string;
  titleScore: number;
  imageScore: number;
  status: "live" | "needs_work" | "draft";
}

export type Priority = "high" | "medium" | "low";

export interface Task {
  id: string;
  title: string;
  source: string;
  due: string;
  priority: Priority;
  assignee: string;
  status: "open" | "done" | "postponed";
  href: string;
}

export interface Activity {
  id: string;
  at: string;
  actor: string;
  text: string;
  /** Agent that produced the entry, when it came from one. */
  agent?: AgentKey;
  /** Retailer or customer the entry is about (used for profile timelines). */
  ref?: string;
}

export interface AppNotification {
  id: string;
  kind:
    | "approvals"
    | "followups"
    | "b2b"
    | "amazon"
    | "integration"
    | "error";
  title: string;
  detail: string;
  time: string;
  href: string;
}

export interface BrandRule {
  id: string;
  title: string;
  detail: string;
}

export interface User {
  name: string;
  role: string;
  email: string;
}

export interface ReportSection {
  id: string;
  label: string;
  metrics: { label: string; value: string; change: number }[];
  series: { label: string; value: number }[];
  seriesTitle: string;
}

export interface DashboardSummary {
  kpis: Kpi[];
  funnel: FunnelStage[];
  trend: TrendSeries;
  agents: Agent[];
  enquiries: Enquiry[];
  retailers: Retailer[];
  content: ContentItem[];
  approvals: Approval[];
  amazon: AmazonRow[];
  tasks: Task[];
}
