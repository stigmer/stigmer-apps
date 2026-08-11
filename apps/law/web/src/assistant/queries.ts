/**
 * The assistant config read (T05 web leg). Deploy-static by nature —
 * the backend answers from boot config — so it is fetched once per app
 * session and never refetched in the background. `enabled: false` is a
 * NORMAL answer (the open-source posture: no platform org, no
 * assistant), not an error state.
 */

import { useQuery } from "@tanstack/react-query";
import { useApiClients } from "../api/clients.js";
import type { GetAssistantConfigResponse } from "../gen/stigmer/law/assistant/v1/assistant_pb.js";

export function useAssistantConfig() {
  const clients = useApiClients();
  return useQuery<GetAssistantConfigResponse>({
    queryKey: ["assistant", "config"],
    queryFn: () => clients.assistant.getConfig({}),
    staleTime: Infinity,
    // A transient failure must not permanently hide the affordance —
    // react-query's default retry covers blips; a hard failure leaves
    // the button hidden, which is the safe direction.
    refetchOnWindowFocus: false,
  });
}
