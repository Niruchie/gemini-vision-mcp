# Security Policy

## Report a vulnerability

Use GitHub's **private vulnerability reporting**: *Security* tab -> *Report a vulnerability*.
Please do not open a public issue for anything exploitable.

Include as much of this as you can:

- affected commit / version,
- how you run it (transport, `HOST`, and any `MCP_*` flags),
- step-by-step reproduction, minimal PoC, and observed vs. expected behavior,
- whether the attack needs a valid `MCP_AUTH_TOKEN`,
- impact you think it has.

This is a personal project, so no SLA: reports are handled on a best-effort basis.
You will be credited in the advisory unless you prefer otherwise.

## Supported versions

Only the `master` branch. There are no tagged releases yet.

## In scope

The security controls this project claims, and therefore the things worth attacking:

- `/mcp` authentication (bearer token, constant-time comparison, fail-closed startup).
- `Host` / `Origin` validation (DNS-rebinding protection).
- SSRF guards: non-`http(s)` schemes, loopback/private/link-local/CGNAT/multicast
  targets, redirect hops, DNS-resolution-based checks and their bypasses
  (alternative IP encodings, IPv4-mapped IPv6, TOCTOU between check and fetch).
- Resource limits: request body, URL response and file size caps, fetch timeout,
  redirect count, session cap and idle reaping.
- Leakage of secrets, local paths or stack traces through logs, error responses
  or the `config://gemini-vision` resource.

## Out of scope (by design)

- **The tools read files and fetch URLs.** `vision_from_file` can read anything the
  process can read and the resource tools can fetch anything the pod can reach.
  That is the feature, not a vulnerability: whoever holds the token has exactly
  that access. Do not expose the server to people you would not give a shell to.
- **Deliberate opt-outs.** `MCP_ALLOW_PRIVATE_URLS=1`, `MCP_ALLOW_INSECURE_HTTP=1`,
  `MCP_ALLOWED_HOSTS=*` (or an empty token on a loopback bind) reduce protection on
  purpose.
- **Cost or quota** consumed by legitimate calls to the Gemini API.
- **Upstream code** (`@google/genai`, `@modelcontextprotocol/sdk`, `express`,
  `zod`): report those to their maintainers. Dependabot keeps them updated here.
- Anything requiring a token that was already leaked, shared or committed
  elsewhere.

## Operator checklist

- Keep the default loopback bind, or set `MCP_AUTH_TOKEN` to a long random value
  (`openssl rand -hex 32`) and never share it.
- Do not expose `/mcp` to the internet. Behind a proxy or ingress, keep auth on and
  set `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` to your real hostnames.
- Run it as an unprivileged user in a container (the image and Helm chart already
  do: non-root, read-only root filesystem, all capabilities dropped).
- Remember that every file and URL you point it at is sent to the Gemini API.
- Rotate the API key and the bearer token if either may have leaked; restart to
  apply.

## No warranty

This software is provided **"as is", without warranty of any kind**, express or
implied, including but not limited to the warranties of merchantability, fitness
for a particular purpose and non-infringement. The author is **not liable** for any
claim, damage, data loss, cost or other liability arising from the use, misuse or
modification of this software. See [LICENSE](LICENSE) for the binding terms.
