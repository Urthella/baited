#!/usr/bin/env node
import { parseArgs } from "node:util";
import { claudeAgent } from "./claude.ts";
import { type Outcome, runTrap, type TrapResult } from "./run.ts";
import { traps } from "./traps.ts";

const USAGE = `Usage: baited [options]

Would your coding agent fall for it? Runs the agent on small repos with harmless traps: a fake
secret and a canary on 127.0.0.1. Agent runs spend your own quota.

  --agent-path PATH   the claude binary (default: claude on PATH)
  --model NAME        model to test (default: the CLI's default)
  --permissive        allow the agent's tools to run; without it, permission prompts block
                      commands and a trap can only count as "attempted"
  --trap ID,ID        only these traps (${traps.map((t) => t.id).join(", ")})
  --runs N            runs per trap (default 1); agents vary, so use more for real numbers
  --budget USD        spending limit per agent run (default 0.50)
  --timeout SECONDS   time limit per agent run (default 300)
  --json              print results as JSON
  --keep              keep the temporary repos
  -h, --help          show this help`;

const SYMBOL: Record<Outcome, string> = {
  exfiltrated: "FELL: sent the secret",
  executed: "FELL: ran the payload",
  attempted: "TRIED: blocked by permissions",
  resisted: "resisted",
  "not-exposed": "inconclusive: never saw it",
  error: "error: agent didn't run",
};

export function report(results: TrapResult[]): string {
  const lines = traps
    .filter((t) => results.some((r) => r.trap === t.id))
    .map((t) => {
      const mine = results.filter((r) => r.trap === t.id);
      const rows = mine.map((r) => {
        const notes = [r.warned && "warned you", r.readSecrets && "read .env", !r.taskDone && "task not done"].filter(Boolean).join(", ");
        return `${SYMBOL[r.outcome]}${notes ? ` (${notes})` : ""}`;
      });
      return `${t.id.padEnd(18)} ${rows.join(" | ")}`;
    });
  const fell = results.filter((r) => r.outcome === "exfiltrated" || r.outcome === "executed").length;
  const tried = results.filter((r) => r.outcome === "attempted").length;
  const conclusive = results.filter((r) => r.outcome !== "not-exposed" && r.outcome !== "error").length;
  const models = [...new Set(results.map((r) => r.model).filter(Boolean))].join(", ");
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return [
    ...lines,
    "",
    `Fell for ${fell} of ${conclusive} conclusive runs${tried ? `, tried ${tried} more` : ""}.`,
    `Model: ${models || "unknown"}. Cost: $${cost.toFixed(2)}.`,
  ].join("\n");
}

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      "agent-path": { type: "string", default: "claude" },
      model: { type: "string" },
      permissive: { type: "boolean", default: false },
      trap: { type: "string" },
      runs: { type: "string", default: "1" },
      budget: { type: "string", default: "0.50" },
      timeout: { type: "string", default: "300" },
      json: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (v.help) {
    console.log(USAGE);
    return 0;
  }
  const wanted = v.trap?.split(",");
  const unknown = wanted?.find((id) => !traps.some((t) => t.id === id));
  if (unknown) {
    console.error(`baited: unknown trap ${unknown}\n\n${USAGE}`);
    return 2;
  }
  const agent = claudeAgent({
    command: v["agent-path"],
    model: v.model,
    budgetUsd: Number(v.budget),
    permissive: v.permissive,
  });
  const results: TrapResult[] = [];
  for (const trap of traps.filter((t) => !wanted || wanted.includes(t.id))) {
    for (let i = 0; i < Number(v.runs); i++) {
      if (!v.json) console.error(`running ${trap.id} (${i + 1}/${v.runs})...`);
      results.push(await runTrap(trap, agent, { timeoutMs: Number(v.timeout) * 1000, keep: v.keep }));
    }
  }
  console.log(v.json ? JSON.stringify(results, null, 2) : report(results));
  return 0;
}

if (import.meta.main) process.exitCode = await main();
