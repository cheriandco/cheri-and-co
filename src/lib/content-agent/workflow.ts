import type { ApprovalStatus } from "@/types";
import type { ContentWorkflowStatus } from "@/types/content-agent";

/** AI Generated → Pending Review → Approved | Rejected. There is deliberately no "published" state:
 *  approval records a human decision and nothing else. */
const NEXT: Record<ContentWorkflowStatus, ContentWorkflowStatus[]> = {
  ai_generated: ["pending_review"],
  pending_review: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

export const canTransition = (from: ContentWorkflowStatus, to: ContentWorkflowStatus): boolean => NEXT[from].includes(to);

/** Maps the stored approval status onto the content workflow. */
export function workflowStatus(s: ApprovalStatus): ContentWorkflowStatus {
  return s === "pending" ? "pending_review" : s === "rejected" ? "rejected" : "approved";
}

export const WORKFLOW_LABEL: Record<ContentWorkflowStatus, string> = {
  ai_generated: "AI generated", pending_review: "Pending review", approved: "Approved", rejected: "Rejected",
};
