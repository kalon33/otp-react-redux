export const RoutingQueryCallResult = {
  // A second foreground search asking the identical question while the first
  // is still in flight. Backlog 17.8: the app fires two searches 0.4-0.9 s
  // apart (a Plan tap plus the location-change auto-replan the same tap
  // triggers), and each was a full three-combination fan-out against a 2-vCPU
  // box. The second is duplicated work, so it is refused rather than sent.
  DUPLICATE_SEARCH_IN_FLIGHT: 3,
  INVALID_MODE_SELECTION: 2,
  INVALID_QUERY: 1,
  SUCCESS: 0
}
