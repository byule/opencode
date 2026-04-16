import { text } from "node:stream/consumers"
import { AppRuntime } from "@/effect/app-runtime"
import { Auth } from "@/auth"
import { Process } from "@/util"
import { Effect } from "effect"

// Decode the `exp` claim from a JWT without verifying the signature.
// Returns undefined if the token is not a valid JWT or has no exp.
function jwtExp(token: string): number | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
    return typeof payload.exp === "number" ? payload.exp : undefined
  } catch {
    return undefined
  }
}

function isExpired(expires: number | undefined): boolean {
  if (expires === undefined) return false
  // Refresh 60 seconds before actual expiry so we don't send a just-expired token.
  return Date.now() / 1000 > expires - 60
}

// Run the stored command and return its stdout trimmed.
async function runCommand(command: readonly string[]): Promise<string> {
  const proc = Process.spawn([...command], { stdout: "pipe" })
  if (!proc.stdout) throw new Error(`command produced no stdout: ${command[0]}`)
  const [exit, output] = await Promise.all([proc.exited, text(proc.stdout)])
  if (exit !== 0) throw new Error(`command exited ${exit}: ${command[0]}`)
  return output.trim()
}

// Return the CF Access token for `baseUrl`, refreshing via the stored command
// if the cached token is expired. Throws if no wellknown entry exists.
export async function cfAccessToken(baseUrl: string): Promise<string> {
  const norm = baseUrl.replace(/\/+$/, "")
  const auth = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Auth.Service
      return yield* svc.get(norm)
    }),
  )

  if (!auth || auth.type !== "wellknown") {
    throw new Error(`No CF Access credentials stored for ${norm}. Run: opencode auth login ${norm}`)
  }

  if (!isExpired(auth.expires)) return auth.token

  if (!auth.command || auth.command.length === 0) {
    throw new Error(`Token for ${norm} is expired and no refresh command is stored. Run: opencode auth login ${norm}`)
  }

  const token = await runCommand(auth.command)
  const expires = jwtExp(token)

  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Auth.Service
      yield* svc.set(norm, { ...auth, token, expires })
    }),
  )

  return token
}

type SealWorkspace = {
  id: string
  name: string
  activeSandbox: { opencodeUrl: string } | null
}

// Fetch the list of workspaces from the Seal API using the stored CF Access token.
export async function listWorkspaces(baseUrl: string): Promise<SealWorkspace[]> {
  const norm = baseUrl.replace(/\/+$/, "")
  const token = await cfAccessToken(norm)
  const res = await fetch(`${norm}/api/workspaces`, {
    headers: { "cf-access-jwt-assertion": token },
  })
  if (!res.ok) throw new Error(`Seal API returned ${res.status} fetching workspaces`)
  const data = (await res.json()) as { workspaces: SealWorkspace[] }
  return data.workspaces
}

// Fetch the per-sandbox Basic Auth secret for `workspaceId`.
export async function sandboxSecret(baseUrl: string, workspaceId: string): Promise<string> {
  const norm = baseUrl.replace(/\/+$/, "")
  const token = await cfAccessToken(norm)
  const res = await fetch(`${norm}/api/workspaces/${workspaceId}/sandbox-secret`, {
    headers: { "cf-access-jwt-assertion": token },
  })
  if (!res.ok) throw new Error(`Seal API returned ${res.status} fetching sandbox secret`)
  const data = (await res.json()) as { secret: string }
  return data.secret
}
