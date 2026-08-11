/**
 * The platform token minter — the assistant service's one outbound
 * dependency, behind a port so tests never dial the agent platform.
 *
 * The production adapter wraps the platform SDK's PlatformClient helper
 * (`createPlatformClientAuth`): client_id + client_secret prove THIS
 * BACKEND to the platform; the user identity in each mint call is
 * asserted, taken on trust — which is exactly why the service above
 * this port mints strictly for its own authenticated caller.
 */

import { createPlatformClientAuth } from "@stigmer/sdk/node";
import type { AssistantConfig } from "../config.js";

export interface MintInput {
  /** The law User id — the platform's stable per-org identity key. */
  readonly userId: string;
  /**
   * The user's email (lowercase — the pipeline normalizes it at every
   * write). This is the value the platform hands back to the MCP
   * entrance as the stigmer_user caller identity, so it is what makes
   * the whole chain resolve.
   */
  readonly userEmail: string;
  /** Display name, for the platform-side profile. */
  readonly userName?: string;
}

export interface MintResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export type AssistantTokenMinter = (input: MintInput) => Promise<MintResult>;

export function createPlatformTokenMinter(config: AssistantConfig): AssistantTokenMinter {
  const auth = createPlatformClientAuth({
    baseUrl: config.apiBaseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  return async (input) => {
    const minted = await auth.mintUserToken({
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
    });
    return { accessToken: minted.accessToken, expiresInSeconds: minted.expiresIn };
  };
}
