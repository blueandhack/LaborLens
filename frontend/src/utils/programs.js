export const programs = {
  pwd: {
    label: "PWD", title: "Prevailing wage search", yearKey: "determinationYear",
    endpoint: "/api/search", event: "determination", wageLabel: "Prevailing wage",
    dateLabel: "Determination date", yearLabel: "Determination year", events: "determinations", receivedLabel: "Received",
    subtitle: "Find the wage determined for a job, employer, and location.",
    description: "Prevailing wages are the rates determined by the Department of Labor, rather than reported salaries.",
  },
  perm: {
    label: "PERM", title: "PERM case search", yearKey: "decisionYear",
    endpoint: "/api/search/perm", event: "decision", wageLabel: "Offered wage",
    dateLabel: "Decision date", yearLabel: "Decision year", events: "decisions", receivedLabel: "Received",
    subtitle: "Compare employers, offered wages, and labor certification decisions.",
    description: "Offered wages come from PERM labor certification filings. They are different from prevailing wage determinations.",
  },
  h1b: {
    label: "H-1B", title: "H-1B LCA search", yearKey: "decisionYear",
    endpoint: "/api/search/h1b", event: "last action", wageLabel: "LCA offered wage",
    dateLabel: "Last action date", yearLabel: "Last action year", events: "recorded actions", receivedLabel: "DOL received",
    subtitle: "Explore employer labor condition applications and reported wage ranges.",
    description: "These are H-1B Labor Condition Applications (LCAs), not USCIS visa approvals. One application can request multiple workers. Wages retain their reported pay periods. Location filters use the employer’s address; reported worksite details appear within each case.",
    dateExplanation: "The last action date may reflect a withdrawal years after the LCA was certified. It does not always indicate initial certification. DOL reports the original certification date separately for Certified–Withdrawn cases; it may be absent for other statuses.",
  },
};
