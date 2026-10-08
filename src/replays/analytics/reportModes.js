// ---------------------------------------------------------------------------
// replays/analytics/reportModes.js
// The three documents one pattern-finder scan can be written as, shared by the
// Teams and Players chapters.
//
//   detailed  every number the scan has (antistratConfig / playerScoutConfig)
//   summary   the prep sheet a coach writes for a match (antistratSummary)
//   internal  the same scan turned inward, on our own rounds, to find what
//             loses them (antistratInternal / playerScoutModes)
// ---------------------------------------------------------------------------

export const REPORT_MODES = [
  { key: 'detailed', label: 'Detailed' },
  { key: 'summary', label: 'Summary' },
  { key: 'internal', label: 'Internal' }
];
