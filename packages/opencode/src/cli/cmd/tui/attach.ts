import { cmd } from "../cmd"
import { UI } from "@/cli/ui"
import { tui } from "./app"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import * as prompts from "@clack/prompts"
import { cfAccessToken, listWorkspaces, sandboxConnect } from "./seal"

function parseHeaders(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined
  const result: Record<string, string> = {}
  for (const value of values) {
    const idx = value.indexOf(":")
    if (idx === -1) throw new Error(`Invalid header format: "${value}". Expected "Key: Value"`)
    const key = value.slice(0, idx).trim()
    const val = value.slice(idx + 1).trim()
    if (!key) throw new Error(`Invalid header format: "${value}". Missing key.`)
    result[key] = val
  }
  return result
}

// Resolve the TUI target URL and Basic Auth headers.
//
// Three cases:
//   1. --password given (or OPENCODE_SERVER_PASSWORD set) → use as-is (direct attach)
//   2. No password, CF Access credentials stored for the URL → auto-fetch workspace
//      secret + preview URL from the Seal API
//   3. No password, no stored credentials → attach without auth (local server)
async function resolveTarget(
  url: string,
  password: string | undefined,
  customHeaders: Record<string, string> | undefined,
): Promise<{ url: string; headers: Record<string, string> | undefined }> {
  const explicit = password ?? process.env.OPENCODE_SERVER_PASSWORD
  if (explicit) {
    return {
      url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${explicit}`).toString("base64")}`, ...customHeaders },
    }
  }

  // The URL passed to `attach` doubles as the Seal base URL (e.g.
  // https://superseal.cloudflare.dev/code). Normalize it the same way
  // `opencode auth login` does so the auth.json lookup hits the right key.
  const sealBase = url.replace(/\/+$/, "")

  const token = await cfAccessToken(sealBase).catch(() => null)
  if (!token) {
    // No CF Access credentials stored — treat as a plain local server.
    return { url, headers: customHeaders }
  }

  // Fetch workspace list from the Seal API.
  const workspaces = await listWorkspaces(sealBase).catch((err: unknown) => {
    throw new Error(`Failed to fetch workspaces from ${sealBase}: ${err instanceof Error ? err.message : String(err)}`)
  })

  if (workspaces.length === 0) {
    throw new Error("No workspaces found. Create one from the web UI first.")
  }

  const workspace = await (async () => {
    if (workspaces.length === 1) return workspaces[0]
    const choice = await prompts.select({
      message: "Select workspace",
      options: workspaces.map((w) => ({ label: w.name, value: w.id })),
    })
    if (prompts.isCancel(choice)) throw new UI.CancelledError()
    return workspaces.find((w) => w.id === choice)!
  })()

  // Poll until the sandbox's opencode port is exposed (container may still be
  // starting). Retry every 5 seconds for up to 60 seconds before giving up.
  const spinner = prompts.spinner()
  spinner.start(`Waiting for sandbox to start…`)
  const connect = await (async () => {
    const MAX_ATTEMPTS = 12
    const DELAY_MS = 5000
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await sandboxConnect(sealBase, workspace.id)
      if (!result) {
        spinner.stop("No active sandbox")
        throw new Error(`No active sandbox for workspace "${workspace.name}". Start one from the web UI first.`)
      }
      if (result.opencodeUrl) return result
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, DELAY_MS))
    }
    spinner.stop("Timed out")
    throw new Error(`Sandbox for workspace "${workspace.name}" did not become ready within 60 seconds.`)
  })()
  spinner.stop("Sandbox ready")

  const opencodeUrl = new URL(connect.opencodeUrl!).origin
  return {
    url: opencodeUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${connect.secret}`).toString("base64")}`, ...customHeaders },
  }
}

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096 or https://superseal.cloudflare.dev/code",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("header", {
        alias: ["H"],
        type: "string",
        array: true,
        describe: "custom header to send in the format 'Key: Value' (can be specified multiple times)",
      }),
  handler: async (args) => {
    const unguard = win32InstallCtrlCGuard()
    try {
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      const directory = (() => {
        if (!args.dir) return undefined
        try {
          process.chdir(args.dir)
          return process.cwd()
        } catch {
          // If the directory doesn't exist locally (remote attach), pass it through.
          return args.dir
        }
      })()

      const customHeaders = parseHeaders(args.header)
      const target = await resolveTarget(args.url, args.password, customHeaders)
      const config = await TuiConfig.get()
      await tui({
        url: target.url,
        config,
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers: target.headers,
      })
    } finally {
      unguard?.()
    }
  },
})
