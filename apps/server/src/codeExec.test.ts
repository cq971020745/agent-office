import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCodeRunArgs, detectDocker, resetDockerDetection } from "./codeExec.js";

describe("buildCodeRunArgs", () => {
  it("javascript 使用 node:22-alpine 并挂载工作区", () => {
    const args = buildCodeRunArgs("javascript", "/tmp/ws", ".run/main.js");
    assert.equal(args[0], "run");
    assert.equal(args[1], "--rm");
    assert.equal(args[args.length - 2], "node");
    assert.equal(args[args.length - 1], ".run/main.js");
    assert.ok(args.includes("node:22-alpine"));
    const vIdx = args.indexOf("-v");
    assert.equal(args[vIdx + 1], "/tmp/ws:/workspace:ro");
  });

  it("python 使用 python:3.12-alpine 且入口是 python3", () => {
    const args = buildCodeRunArgs("python", "/tmp/ws", ".run/main.py");
    assert.ok(args.includes("python:3.12-alpine"));
    assert.equal(args[args.length - 2], "python3");
  });

  it("隔离约束齐备：无网络、内存/CPU/进程数受限、根只读、工作区只读", () => {
    for (const lang of ["javascript", "python"] as const) {
      const args = buildCodeRunArgs(lang, "/tmp/ws", ".run/main.js");
      assert.ok(args.includes("--network"));
      assert.ok(args.includes("none"));
      assert.ok(args.includes("--memory"));
      assert.ok(args.includes("512m"));
      assert.ok(args.includes("--cpus"));
      assert.ok(args.includes("--pids-limit"));
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("-w"));
      assert.ok(args.includes("/workspace"));
      assert.match(args.find((a) => a.endsWith(":/workspace:ro")) ?? "", /\/workspace:ro$/);
    }
  });
});

describe("detectDocker", () => {
  it("返回布尔值并缓存（本机未装守护进程时应稳定返回 false）", async () => {
    resetDockerDetection();
    const first = await detectDocker();
    assert.equal(typeof first, "boolean");
    const second = await detectDocker();
    assert.equal(first, second);
  });
});
