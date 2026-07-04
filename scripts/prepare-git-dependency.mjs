import { spawnSync } from "node:child_process"

const isPnpm = process.env.npm_execpath?.includes("pnpm") ?? false
const command = isPnpm ? "pnpm" : "npm"
const args = isPnpm
  ? ["--filter", "tunnels", "build"]
  : ["run", "build", "--workspace", "tunnels"]

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
