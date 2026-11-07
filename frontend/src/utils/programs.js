export const programs = {
  pwd: {
    label: "PWD", title: "Prevailing wage search", yearKey: "determinationYear",
    endpoint: "/api/search", event: "determination", wageLabel: "Prevailing wage",
    subtitle: "Find the wage determined for a job, employer, and location.",
    description: "Prevailing wages are the rates determined by the Department of Labor, rather than reported salaries.",
  },
  perm: {
    label: "PERM", title: "PERM case search", yearKey: "decisionYear",
    endpoint: "/api/search/perm", event: "decision", wageLabel: "Offered wage",
    subtitle: "Compare employers, offered wages, and labor certification decisions.",
    description: "Offered wages come from PERM labor certification filings. They are different from prevailing wage determinations.",
  },
  h1b: {
    label: "H-1B", title: "H-1B LCA search", yearKey: "decisionYear",
    endpoint: "/api/search/h1b", event: "decision", wageLabel: "LCA offered wage",
    subtitle: "Explore employer labor condition applications and reported wage ranges.",
    description: "These are H-1B Labor Condition Applications (LCAs), not USCIS visa approvals. One application can request multiple workers. Wages retain their reported pay periods. Location filters use the employer’s address; reported worksite details appear within each case.",
  },
};
