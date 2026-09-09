import type { Breaker } from './breaker.js';
import type { FetchLike } from './marked-fetch.js';

export interface ConnectInfo {
  message: string;
  /**
   * The hosted server's own URL — the route that needs no install and no API key to start. Optional
   * because an older issuer deployment answers without it; absent must stay absent rather than be
   * filled in with a guess, since a fabricated URL would point the agent at a host that may serve
   * nothing.
   */
  remote_url?: string;
  remote_config?: unknown;
  install_command: string;
  /** Why the npm route is the second choice while the published build lags the current surface. */
  install_caveat?: string;
  docs_url: string;
  client_config?: unknown;
  updated_at?: string;
  source: 'live' | 'offline_fallback';
}

/**
 * Cap on the connect payload this will accept.
 *
 * The live payload measures ~800 bytes, so 64 KiB is ~80× headroom. The verifier's own
 * `MAX_REMOTE_BODY_BYTES` is 512 KiB because it reads artifacts that can legitimately be large (a
 * JWKS, a status list); nothing here can be, so the cap is tighter. A local constant rather than an
 * import: it is not exported from the verifier's `index.ts`, and this package must not reach into
 * another one's internals.
 *
 * TWO BOUNDS the name does not carry, both shared verbatim with the verifier's version of this
 * check and recorded so `_BYTES` is not later read as a guarantee: `body.length` counts UTF-16 code
 * units, so a 64 Ki-CHARACTER body can be ~192 KiB of UTF-8; and the second check runs after
 * `response.text()` has already buffered, so it refuses the payload rather than preventing it being
 * held. The declared-length check above it is the only pre-transfer refusal, and the real bound on
 * what can be buffered is the breaker's 4.5s deadline.
 */
const MAX_CONNECT_BODY_BYTES = 64 * 1024;

/**
 * The text `proof_connect` falls back to when the issuer cannot be reached.
 *
 * It is deliberately marked `offline_fallback` in the payload rather than served silently: this
 * copy is FROZEN into the publisher's `node_modules` at install time, and the live answer changes
 * between the parts of the single-MCP plan (a remote server arrives in part 3). An agent reading
 * a stale instruction with no signal that it is stale would confidently tell a user to do the
 * wrong thing.
 */
export const OFFLINE_FALLBACK: ConnectInfo = {
  message:
    'Proof (proof.holdings) verifies real-world control — domains, phone numbers, and human approval — and issues signed proof tokens an agent can check. The full Proof MCP server adds the rest of the platform to this client. The quickest way in is the hosted server at https://api.proof.holdings/mcp — nothing to install and no API key needed to start. This text was packaged with the Proof layer and may be out of date; proof.holdings/docs/mcp always has the current instructions.',
  // The production address, deliberately: a copy frozen into node_modules cannot know which
  // deployment it will be read beside, and this is the same posture `docs_url` already takes.
  remote_url: 'https://api.proof.holdings/mcp',
  remote_config: {
    mcpServers: { proof: { type: 'http', url: 'https://api.proof.holdings/mcp' } },
  },
  install_command: 'npx -y @proof-holdings/mcp-server',
  install_caveat:
    'The @proof-holdings/mcp-server build currently on npm predates the delegation tools and the keyless public mode, so it exposes an older and smaller surface. Until it is republished, remote_url is the way to reach the current server.',
  docs_url: 'https://proof.holdings/docs/mcp',
  source: 'offline_fallback',
};

/**
 * Fetches the current connection instructions at CALL time (SC-6), through the showcase breaker
 * so a slow or dead issuer costs the publisher's user one bounded wait rather than one per call.
 *
 * Never throws and never caches: two calls in a row do exactly the same thing, which is what
 * "harmless on repeat" means for a tool an agent may call speculatively.
 */
export async function fetchConnectInfo(
  baseUrl: string,
  breaker: Breaker,
  fetchImpl: FetchLike,
): Promise<ConnectInfo> {
  const origin = baseUrl.replace(/\/+$/, '');

  const outcome = await breaker.run(async (signal) => {
    const response = await fetchImpl(`${origin}/api/v1/mcp/connect`, {
      method: 'GET',
      signal,
      // The same posture `packages/delegation-verifier/src/status.ts` takes on its remote reads,
      // adopted here rather than left as an unexplained difference — and the reason is sharper on
      // this path: what comes back becomes INSTRUCTIONS in the agent's context. `baseUrl` is the
      // publisher's to configure, so an open redirect on it would carry this read off the origin
      // they chose, with the answer still presented as ours.
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`connect info responded ${response.status}`);
    }

    // Declared length first (cheap, refuses before the transfer), then the real one, because
    // `content-length` is absent under chunked encoding and is a claim either way.
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CONNECT_BODY_BYTES) {
      throw new Error('connect info response is too large');
    }
    const body = await response.text();
    if (body.length > MAX_CONNECT_BODY_BYTES) {
      throw new Error('connect info response is too large');
    }

    return JSON.parse(body) as Partial<ConnectInfo>;
  });

  if (!outcome.ok) {
    return OFFLINE_FALLBACK;
  }

  const body = outcome.value;
  if (typeof body?.message !== 'string' || typeof body?.install_command !== 'string') {
    return OFFLINE_FALLBACK;
  }

  // Field-by-field rather than a spread: what comes back becomes instructions in the agent's
  // context, so the shape an issuer can put there is the one this package chose to carry. The cost
  // is that a new issuer-side field is inert until it is added here — which is why the remote
  // route below had to be added explicitly rather than arriving on its own.
  return {
    message: body.message,
    ...(typeof body.remote_url === 'string' ? { remote_url: body.remote_url } : {}),
    ...(body.remote_config !== undefined ? { remote_config: body.remote_config } : {}),
    install_command: body.install_command,
    ...(typeof body.install_caveat === 'string' ? { install_caveat: body.install_caveat } : {}),
    docs_url: typeof body.docs_url === 'string' ? body.docs_url : OFFLINE_FALLBACK.docs_url,
    ...(body.client_config !== undefined ? { client_config: body.client_config } : {}),
    ...(typeof body.updated_at === 'string' ? { updated_at: body.updated_at } : {}),
    source: 'live',
  };
}
