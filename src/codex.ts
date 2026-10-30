import type { Agent, Transcript } from "./run.ts";

export interface CodexOptions {
  command: string;
  model?: string;
  permissive: boolean; // let sandboxed commands reach the network, and so the canary
}

export function codexAgent(o: CodexOptions): Agent {
  return {
    name: "codex",
    command: o.command,
    env: ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
    args: (task) => [
      "exec",
      "--json",
      "--color",
      "never",
      "--ephemeral",
      // No user config or rules, so no MCP servers: same reasoning as the Claude adapter.
      "--ignore-user-config",
      "--ignore-rules",
      // A ChatGPT login also carries connector scopes, so switch those off explicitly.
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "memories",
      // Writes stay in the repo. Network access is the one thing a trap needs on top of that,
      // and it's far narrower than --dangerously-bypass-approvals-and-sandbox.
      "--sandbox",
      "workspace-write",
      // Without a config file Windows has no sandbox selected and every command gets refused.
      // "elevated" would add machine-wide accounts and firewall rules; a test tool has no business there.
      ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
      ...(o.permissive ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
      ...(o.model ? ["--model", o.model] : []),
      task,
    ],
    parse: (stdout, exitCode) => ({ ...parseCodexJsonl(stdout, exitCode), model: o.model }),
  };
}

export function parseCodexJsonl(stdout: string, exitCode: number | null): Transcript {
  const t: Transcript = { toolUses: [], toolOutput: "", text: "", failed: exitCode !== 0 };
  let lastError: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // partial line from a killed run
    }
    if (e.type === "error") lastError = e.message; // may just be a retry; only the exit code or turn.failed decides
    if (e.type === "turn.failed") {
      t.failed = true;
      lastError = e.error?.message ?? lastError;
    }
    if (e.type !== "item.completed") continue;
    const item = e.item ?? {};
    if (item.type === "agent_message") t.text += item.text + "\n";
    if (item.type === "command_execution") {
      t.toolUses.push({ name: "Shell", input: item.command ?? "" });
      t.toolOutput += (item.aggregated_output ?? "") + "\n";
    }
    if (item.type === "file_change") t.toolUses.push({ name: "FileChange", input: JSON.stringify(item.changes ?? "") });
    if (item.type === "mcp_tool_call") t.toolUses.push({ name: "Mcp", input: JSON.stringify(item) });
  }
  if (t.failed) t.failure = lastError ?? "unknown error";
  return t;
}
