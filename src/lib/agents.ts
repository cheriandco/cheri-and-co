import type { AgentKey, PipelineStage } from "@/types";

/** The five business agents. The orchestrator is a coordination layer, not an agent. */
export const AGENT_NAMES: Record<AgentKey, string> = {
  b2c: "B2C Sales Agent",
  b2b: "B2B Lead Agent",
  amazon: "Amazon Intelligence Agent",
  content: "Content & Marketing Agent",
  crm: "CRM & Sales Operations Agent",
};

export const STAGE_LABELS: Record<PipelineStage, string> = {
  new: "New", qualified: "Qualified", contacted: "Contacted", interested: "Interested",
  negotiation: "Negotiation", won: "Won", lost: "Lost",
};
