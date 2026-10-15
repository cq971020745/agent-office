import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSafeMcpEnv } from "./mcp.js";
import { resolveDelegatedAgent, type DelegatedAgentLookupRow } from "./runner.js";
import { computeNextRunAt, parseScheduleExpr } from "./scheduler.js";

describe("scheduler：定时表达式解析与下次触发时间计算", () => {
  it("parseScheduleExpr 识别 daily / weekly / interval 并拒绝非法值", () => {
    assert.deepEqual(parseScheduleExpr("daily:09:30"), { kind: "daily", hour: 9, minute: 30 });
    assert.deepEqual(parseScheduleExpr("weekly:1:08:15"), { kind: "weekly", dayOfWeek: 1, hour: 8, minute: 15 });
    assert.deepEqual(parseScheduleExpr("interval:60"), { kind: "interval", minutes: 60 });

    assert.equal(parseScheduleExpr("daily:25:00"), null);
    assert.equal(parseScheduleExpr("weekly:8:09:00"), null);
    assert.equal(parseScheduleExpr("interval:2"), null);
    assert.equal(parseScheduleExpr("invalid"), null);
  });

  it("computeNextRunAt：interval 按分钟偏移计算", () => {
    const base = new Date("2026-10-15T08:00:00.000Z");
    const next = computeNextRunAt("interval:30", base);
    assert.equal(next, "2026-10-15T08:30:00.000Z");
  });

  it("computeNextRunAt：daily 未过今日时刻取今日，已过取明日", () => {
    const base = new Date(2026, 9, 15, 8, 0, 0, 0);
    const sameDay = new Date(computeNextRunAt("daily:09:30", base)!);
    assert.equal(sameDay.getDate(), 15);
    assert.equal(sameDay.getHours(), 9);
    assert.equal(sameDay.getMinutes(), 30);

    const nextDay = new Date(computeNextRunAt("daily:07:30", base)!);
    assert.equal(nextDay.getDate(), 16);
    assert.equal(nextDay.getHours(), 7);
    assert.equal(nextDay.getMinutes(), 30);
  });
});

describe("delegate_to_agent：目标专家解析（resolveDelegatedAgent）", () => {
  const candidates: DelegatedAgentLookupRow[] = [
    {
      id: "agent-writer",
      name: "公文写作助手",
      description: "撰写各类通知与公文",
      system_prompt: "...",
      provider_id: "p1",
      model_id: "m1",
      tool_policy: "{}",
    },
    {
      id: "agent-researcher",
      name: "深度研究员",
      description: "行业调研与数据分析",
      system_prompt: "...",
      provider_id: "p1",
      model_id: "m1",
      tool_policy: "{}",
    },
  ];

  it("支持按精确名称、精确 ID 或模糊名称匹配，且排除当前专家自身", () => {
    assert.equal(resolveDelegatedAgent("公文写作助手", candidates)?.id, "agent-writer");
    assert.equal(resolveDelegatedAgent("agent-researcher", candidates)?.name, "深度研究员");
    assert.equal(resolveDelegatedAgent("研究员", candidates)?.id, "agent-researcher");
    // 排除自身，防止自己委派给自己死循环
    assert.equal(resolveDelegatedAgent("公文写作助手", candidates, "公文写作助手"), undefined);
  });
});

describe("buildSafeMcpEnv：MCP 子进程环境变量隔离", () => {
  it("剥离 JWT_SECRET 等服务端敏感变量，仅保留白名单与显式配置的 env", () => {
    const fakeProcessEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      JWT_SECRET: "super-secret-jwt-key",
      INTERNAL_DB_PASSWORD: "db-password",
    };
    const out = buildSafeMcpEnv({ CUSTOM_TOKEN: "tok-123" }, fakeProcessEnv);
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.HOME, "/home/tester");
    assert.equal(out.CUSTOM_TOKEN, "tok-123");
    assert.equal(out.JWT_SECRET, undefined);
    assert.equal(out.INTERNAL_DB_PASSWORD, undefined);
  });
});
