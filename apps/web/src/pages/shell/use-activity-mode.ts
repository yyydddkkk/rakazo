import { useCallback, useId, useState } from "react";
import type { ActivityListFilters } from "../../lib/activity-list-filters";
import { emptyActivityFilters } from "../../lib/activity-list-filters";
import { readActivityMode, writeActivityMode } from "../../lib/activity-mode";

export function useActivityMode(setQuery: (query: string) => void) {
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const [activityFilters, setActivityFilters] = useState<ActivityListFilters>(emptyActivityFilters);
  const [activityFiltersExpanded, setActivityFiltersExpanded] = useState(false);
  const activityFiltersId = useId();
  const activityFilterCount =
    Number(activityFilters.status !== "all") +
    Number(Boolean(activityFilters.dateRange.from)) +
    Number(Boolean(activityFilters.dateRange.to));
  const toggleActivityMode = useCallback(() => {
    setQuery("");
    setActivityFilters(emptyActivityFilters());
    setActivityFiltersExpanded(false);
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  return {
    activityMode,
    activityFilters,
    setActivityFilters,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    activityFiltersId,
    activityFilterCount,
    toggleActivityMode,
  };
}
