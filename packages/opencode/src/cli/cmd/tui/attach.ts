import { cmd } from "../cmd"
import { UI } from "@/cli/ui"
import { tui } from "./app"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import * as prompts from "@clack/prompts"
import { cfAccessToken, listWorkspaces, sandboxSecret } from "./seal"

// Resolve the TUI target URL and Basic Auth headers.
//
// Three cases:
//   1. --password given → use as-is (existing behaviour, direct attach)
//   2. No --password, URL looks like a Seal base URL (has CF Access credentials
//      stored) → auto-fetch the workspace secret via the Seal API
//   3. No --password, no stored credentials → attach without auth (local servers)
async function resolveTarget(
  url: string,
  password: string | undefined,
): Promise<{ url: string; headers: Record<string, string> | undefined }> {
  const explicit = password ?? process.env.OPENCODE_SERVER_PASSWORD
  if (explicit) {
    return {
      url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${explicit}`).toString("base64")}` },
    }
  }

  // The URL passed to `attach` doubles as the Seal base URL (e.g.
  // https://superseal.cloudflare.dev/code). Normalize it the same way
  // `opencode auth login` does so the auth.json lookup hits the right key.
  const sealBase = url.replace(/\/+$/, "")

  const token = await cfAccessToken(sealBase).catch(() => null)
  if (!token) {
    return { url, headers: undefined }
  }

  // Fetch workspace list from the Seal API.
  const workspaces = await listWorkspaces(sealBase).catch((err: unknown) => {
    throw new Error(`Failed to fetch workspaces from ${sealBase}: ${err instanceof Error ? err.message : String(err)}`)
  })

  const active = workspaces.filter((w) => w.activeSandbox?.opencodeUrl)
  if (active.length === 0) {
    throw new Error("No workspaces with an active sandbox found. Start a sandbox from the web UI first.")
  }

  const workspace = await (async () => {
    if (active.length === 1) return active[0]
    const choice = await prompts.select({
      message: "Select workspace",
      options: active.map((w) => ({ label: w.name, value: w.id })),
    })
    if (prompts.isCancel(choice)) throw new UI.CancelledError()
    return active.find((w) => w.id === choice)!
  })()

  const secret = await sandboxSecret(sealBase, workspace.id)
  const opencodeUrl = new URL(workspace.activeSandbox!.opencodeUrl!).origin

  return {
    url: opencodeUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}` },
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

      const target = await resolveTarget(args.url, args.password)
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
