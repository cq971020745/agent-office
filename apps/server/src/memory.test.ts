import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cheng-memory-"));

const { migrate } = await import("./db.js");
const { db, now } = await import("./db.js");
const { LocalMemoryBackend, memoryPlugin } = await import("./plugins/memory.js");
const { PluginRegistry } = await import("./plugins/registry.js");

migrate();
for (const id of ["u1", "u2"]) {
  db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'member', ?)").run(id, id, "test", now());
}

test("local memory is isolated, searchable, deduplicated and deletable", () => {
  const backend = new LocalMemoryBackend();
  backend.retain({ userId: "u1", kind: "preference", content: "用户偏好简洁的中文说明", confidence: 0.7 });
  backend.retain({ userId: "u1", kind: "preference", content: "用户偏好简洁的中文说明", confidence: 0.9 });
  backend.retain({ userId: "u2", kind: "preference", content: "用户偏好简洁的中文说明" });

  assert.equal(backend.list("u1").length, 1);
  assert.equal(backend.list("u2").length, 1);
  assert.equal(backend.recall({ userId: "u1", query: "中文说明" }).length, 1);
  assert.equal(backend.recall({ userId: "u2", query: "中文说明" }).length, 1);

  const id = backend.list("u1")[0]!.id;
  assert.equal(backend.forget("u1", id), true);
  assert.equal(backend.list("u1").length, 0);
  assert.equal(backend.forget("u1", id), false);
});

test("task source memories can be removed without touching another user", () => {
  const backend = new LocalMemoryBackend();
  backend.retain({ userId: "u1", kind: "experience", content: "task one result", sourceTaskId: "t1" });
  backend.retain({ userId: "u2", kind: "experience", content: "task one result", sourceTaskId: "t1" });
  assert.equal(backend.forgetTask("u1", "t1"), 1);
  assert.equal(backend.list("u1").length, 0);
  assert.equal(backend.list("u2").filter((m) => m.sourceTaskId === "t1").length, 1);
});

test("memory API preserves the experience kind", async () => {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    request.user = { sub: "u1", role: "member" };
  });
  await memoryPlugin.registerRoutes?.(app);
  await app.ready();

  const response = await app.inject({ method: "POST", url: "/memory", payload: { content: "route experience kind", kind: "experience" } });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().kind, "experience");
  await app.close();
});

test("plugin registry runs only enabled lifecycle hooks and allows runtime toggling", async () => {
  const registry = new PluginRegistry();
  const calls: string[] = [];
  registry.register({
    manifest: { id: "test-plugin", version: "1", name: "test", description: "test" },
    start: () => { calls.push("start"); },
    stop: () => { calls.push("stop"); },
    beforeTurn: () => { calls.push("before"); return "context"; },
  });
  await registry.initialize({} as never);
  assert.deepEqual(await registry.beforeTurn({ userId: "u1", taskId: "t1", agentId: "a1", prompt: "question" }), ["context"]);
  assert.deepEqual(calls, ["start", "before"]);
  assert.equal(await registry.setEnabled("test-plugin", false), true);
  assert.deepEqual(await registry.beforeTurn({ userId: "u1", taskId: "t1", agentId: "a1", prompt: "question" }), []);
  assert.deepEqual(calls, ["start", "before", "stop"]);
});

test("plugin registry isolates task-start hooks and skips disabled plugins", async () => {
  const registry = new PluginRegistry();
  const calls: string[] = [];
  registry.register({
    manifest: { id: "task-start-plugin", version: "1", name: "task start", description: "test" },
    onTaskStarted: (ctx) => { calls.push(`${ctx.taskId}:${ctx.workspacePath}`); },
  });
  await registry.initialize({} as never);
  await registry.onTaskStarted({ userId: "u1", taskId: "t2", agentId: "a1", workspacePath: "C:/workspace" });
  assert.deepEqual(calls, ["t2:C:/workspace"]);
  assert.equal(await registry.setEnabled("task-start-plugin", false), true);
  await registry.onTaskStarted({ userId: "u1", taskId: "t3", agentId: "a1", workspacePath: "C:/workspace" });
  assert.deepEqual(calls, ["t2:C:/workspace"]);
});

test("disabled plugin routes remain registered but reject requests", async () => {
  const app = Fastify();
  const registry = new PluginRegistry();
  registry.register({
    manifest: { id: "route-test", version: "1", name: "routes", description: "routes" },
    registerRoutes: (scope) => { scope.get("/plugin-route-test", async () => ({ ok: true })); },
  });
  await registry.initialize(app);
  await app.ready();

  assert.equal((await app.inject("/plugin-route-test")).statusCode, 200);
  assert.equal(await registry.setEnabled("route-test", false), true);
  const disabled = await app.inject("/plugin-route-test");
  assert.equal(disabled.statusCode, 503);
  assert.deepEqual(disabled.json(), { error: "plugin route-test is disabled" });
  await app.close();
});
