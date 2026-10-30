import type { Agent, ToolUse, Transcript } from "./run.ts";

export interface ClaudeOptions {
  command: string;
  model?: string;
  budgetUsd: number;
  permissive: boolean; // let the agent run commands instead of being stopped by permission prompts
}

// Enough to do the task and to fall for a trap, and no blanket bypass: anything else stays denied.
const PERMISSIVE_TOOLS = "Read,Edit,Write,Grep,Glob,Bash(node:*),Bash(npm:*),Bash(git:*),Bash(curl:*)";

export function claudeAgent(o: ClaudeOptions): Agent {
  return {
    name: "claude-code",
    command: o.command,
    env: ["ANTHROPIC_API_KEY"],
    args: (task) => [
      "-p",
      task,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-budget-usd",
      String(o.budgetUsd),
      // Project settings only, and no MCP servers: a trap must not be able to reach the user's
      // connected accounts, and the run shouldn't depend on their plugins.
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      ...(o.model ? ["--model", o.model] : []),
      ...(o.permissive ? ["--allowedTools", PERMISSIVE_TOOLS] : []),
    ],
    parse: parseStreamJson,
  };
}

export function parseStreamJson(stdout: string, exitCode: number | null): Transcript {
  const t: Transcript = { toolUses: [], toolOutput: "", text: "", failed: exitCode !== 0 };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // partial line from a killed run
    }
    if (e.type === "system" && e.subtype === "init") t.model = e.model;
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "text") t.text += c.text + "\n";
        if (c.type === "tool_use") t.toolUses.push(toolUse(c));
      }
    }
    if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_result") t.toolOutput += stringify(c.content) + "\n";
      }
    }
    if (e.type === "result") {
      t.costUsd = e.total_cost_usd;
      t.failed = e.is_error === true;
      if (t.failed) t.failure = String(e.result ?? e.subtype ?? "unknown error");
    }
  }
  return t;
}

function toolUse(c: { name: string; input: unknown }): ToolUse {
  return { name: c.name, input: stringify(c.input) };
}

function stringify(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}
