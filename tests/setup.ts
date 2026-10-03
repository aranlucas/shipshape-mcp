import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { beforeEach, afterEach, afterAll, vi } from "vitest";

// Miniflare uses its own dispatcher for local workerd traffic. Its Node-side
// redirects, and any un-injected Undici transport, must never reach the network.
const previousDispatcher = getGlobalDispatcher();

const offlineDispatcher = new MockAgent();

offlineDispatcher.disableNetConnect();

setGlobalDispatcher(offlineDispatcher);

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await offlineDispatcher.close();
});

// Every test supplies its own synthetic transport. Unexpected global fetches fail closed.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL): Promise<Response> => {
      throw new Error(
        `Unexpected outbound request in an offline test: ${String(input)}`,
      );
    },
  );
});

afterEach(() => vi.unstubAllGlobals());
