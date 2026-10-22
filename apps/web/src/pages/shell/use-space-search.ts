import type { SearchHit } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";

export function useSpaceSearch(
  rpc: ReturnType<typeof createSpaceRpc>,
  query: string,
  activityMode: boolean,
) {
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const spaceQuery = query.trim();
  const showSpaceSearch = !activityMode && spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showSpaceSearch, spaceQuery]);

  return { searchHits, setSearchHits, searchLoading, showSpaceSearch };
}
