// Before connecting, the Connect sheet asks the address who it is: the server's public descriptor names it, and a
// failure is sorted into one thing the person can fix.
import { EXAMPLE_ADDRESS, isLoopbackHost, parseServerInput, serverTransport } from "./server-address.mjs";
import { isTailnetHost } from "./tailnet.mjs";

const DESCRIPTOR = "/.well-known/openmausbot/environment";

/** The sentence for each problem, in the window's catalog and main's alike ({host}, {example} filled in). */
export const CONNECT_PROBLEM_KEYS = Object.freeze({
  empty: "native.connect.empty",
  codeOnly: "native.connect.codeOnly",
  emailCode: "native.connect.emailCode",
  oldCode: "native.connect.oldCode",
  scriptKey: "native.connect.scriptKey",
  notACode: "native.connect.notACode",
  publicHttp: "native.connect.publicHttp",
  phoneLink: "native.connect.phoneLink",
  notAnAddress: "native.connect.notAnAddress",
  unreachable: "native.connect.unreachable",
  dns: "native.connect.dns",
  certificate: "native.connect.certificate",
  notMausBot: "native.connect.notMausBot",
  loopback: "native.connect.loopback",
  localNetwork: "native.connect.localNetwork",
  tailscaleOff: "native.connect.tailscaleOff",
  otherTailnet: "native.connect.otherTailnet",
  tailnetBlocked: "native.connect.tailnetBlocked",
  tailnetSilent: "native.connect.tailnetSilent",
});

/**
 * Why an address only a tailnet reaches did not answer: Tailscale is off on this computer, the name is not on this
 * computer's tailnet (MagicDNS answers only names it knows), macOS refused at once (its Local Network permission covers
 * Tailscale's addresses too, and refuses with "no route to host" rather than letting the request time out), or the
 * computer there is asleep, offline or not sharing.
 */
function tailnetProblem(kind, platform, tailnet) {
  if (!tailnet) return "tailscaleOff";
  if (kind === "dns") return "otherTailnet";
  if (kind === "noRoute" && platform === "darwin") return "tailnetBlocked";
  return "tailnetSilent";
}

/** Chromium's net errors (Electron 43 `session.fetch`) and Node's (undici) for the same causes. */
function failureKind(error) {
  const text = `${error?.message ?? ""} ${error?.cause?.code ?? ""} ${error?.cause?.message ?? ""} ${error?.name ?? ""}`;
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|EAI_NONAME/i.test(text)) return "dns";
  if (/ERR_CERT|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|certificate/i.test(text)) return "certificate";
  if (/TimeoutError|TIMED_OUT|ETIMEDOUT|aborted/i.test(text)) return "timeout";
  if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) return "refused";
  if (/ADDRESS_UNREACHABLE|EHOSTUNREACH|ENETUNREACH|NETWORK_ACCESS_DENIED/i.test(text)) return "noRoute";
  return "unreachable";
}

async function describe(origin, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${origin}${DESCRIPTOR}`, { redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, kind: failureKind(error) };
  }
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (typeof body?.environmentId !== "string" || !body.environmentId) return { ok: false, kind: "notMausBot" };
  return { ok: true, environmentId: body.environmentId, label: typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : new URL(origin).host,
    version: typeof body.version === "string" ? body.version.slice(0, 32) : null };
}

/**
 * Reads the sheet's fields and finds the server: `{ outcome: "found", origin, label, version, transport, code, credential }`,
 * or `{ outcome: "problem", problem, host?, code? }` with one of parseServerInput's problems or: unreachable, dns,
 * certificate, notMausBot, loopback (an address on this computer that is this app's own workspace, or nothing at all).
 * `ownEnvironmentId()`: this app's own local workspace, so a "this computer" link copied off a server is caught.
 */
export async function probeServer({ address, code = "", fetch: fetchImpl, ownEnvironmentId = async () => null, timeoutMs = 6_000, platform = process.platform, tailnet = () => true }) {
  const parsed = parseServerInput(address, code);
  if (!parsed.ok) {
    const { ok: _ok, ...problem } = parsed;
    return { outcome: "problem", ...problem };
  }
  let failure = null;
  for (const origin of parsed.candidates) {
    const { host, hostname } = new URL(origin);
    const loopback = isLoopbackHost(hostname);
    const found = await describe(origin, fetchImpl, timeoutMs);
    if (!found.ok) {
      const kind = found.kind === "noRoute" ? "unreachable" : found.kind;
      // macOS 15 blocks an app from the local network until the person allows it, and the request then just fails.
      const blockedOnMac = platform === "darwin" && serverTransport(origin) === "private-http" && (kind === "unreachable" || kind === "timeout");
      const tailnetHost = isTailnetHost(hostname.replace(/^\[|\]$/g, "")) && found.kind !== "certificate" && found.kind !== "notMausBot";
      const problem = loopback ? { problem: "loopback", host } : tailnetHost ? { problem: tailnetProblem(found.kind, platform, tailnet()), host } : blockedOnMac ? { problem: "localNetwork", host }
        : { problem: kind === "refused" || kind === "timeout" ? "unreachable" : kind, host, ...(kind === "refused" || kind === "timeout" ? { reason: kind } : {}) };
      // A later guess at a tailnet name that just didn't answer says less than whatever an earlier one said.
      if (!(failure && problem.problem === "tailnetSilent")) failure = problem;
      continue;
    }
    if (loopback && found.environmentId === await ownEnvironmentId().catch(() => null)) return { outcome: "problem", problem: "loopback", host };
    return { outcome: "found", origin, label: found.label, version: found.version, transport: serverTransport(origin), code: parsed.code, credential: parsed.credential };
  }
  return { outcome: "problem", ...failure };
}

/**
 * Connecting from the desktop: `probe` for the sheet's line under the field; `connect` for its button, which names the
 * server already, so it opens exactly what it finds or resolves with the problem; `connectAsking` for a link from the
 * clipboard or Settings, which names the server in main's own dialog (`ask(found)`) first and throws a problem's sentence.
 * `open(found, name)` saves the server and opens its /pair page.
 */
export function createServerConnect({ fetch: fetchImpl, ownEnvironmentId, ask, open, t, tailnet }) {
  const probe = (address, code = "") => probeServer({ address, code, fetch: fetchImpl, ownEnvironmentId, tailnet });
  return {
    probe,
    async connect(address, code = "") {
      const found = await probe(address, code);
      if (found.outcome !== "found") return found;
      open(found);
      return { outcome: "connected", label: found.label };
    },
    async connectAsking(input, name) {
      const found = await probe(input);
      if (found.outcome !== "found") throw new Error(t(CONNECT_PROBLEM_KEYS[found.problem], { host: found.host ?? "", example: EXAMPLE_ADDRESS }));
      if (!(await ask(found))) return false;
      open(found, name);
      return true;
    },
  };
}
