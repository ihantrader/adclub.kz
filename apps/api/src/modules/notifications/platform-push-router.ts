import type { PushPlatform } from "@adclub/contracts";
import {
  PushProvider,
  type PushChannelName,
  type PushSendRequest,
  type PushSendResult,
} from "./push-provider";

/**
 * `PUSH_PROVIDER=live` (TASK-056, ARCHITECTURE 4.81): the device's platform
 * decides who takes the push — an iPhone's token is an APNs token, an
 * Android's is an FCM one. This is the one place that decides it; the sender
 * and the modules see one `PushProvider` as before.
 */
export class PlatformPushRouter extends PushProvider {
  constructor(private readonly byPlatform: Readonly<Record<PushPlatform, PushProvider>>) {
    super();
  }

  providerFor(platform: PushPlatform): PushChannelName {
    return this.byPlatform[platform].providerFor(platform);
  }

  send(request: PushSendRequest, signal: AbortSignal): Promise<PushSendResult> {
    return this.byPlatform[request.platform].send(request, signal);
  }
}
