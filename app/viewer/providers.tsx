"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * React Query provider scoped to the /viewer route. The QueryClient is created
 * in state so it survives re-renders but is never shared across requests (it is
 * a client component — one per browser session). Chunk blobs are immutable and
 * the manifest is small, so we keep data fresh for a few seconds and lean on
 * keepPreviousData at the call sites to keep the table on screen during fetches.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            retry: false,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
