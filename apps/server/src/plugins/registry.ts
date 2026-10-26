import type { FastifyInstance } from "fastify";
import { db, now } from "../db.js";
import type { PlatformPlugin, PluginContext, PluginToolContext, TaskStartContext, TurnContext } from "./types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export class PluginRegistry {
  private readonly plugins = new Map<string, PlatformPlugin>();
  private readonly started = new Set<string>();

  register(plugin: PlatformPlugin): void {
    const { id } = plugin.manifest;
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`Invalid plugin id: ${id}`);
    if (this.plugins.has(id)) throw new Error(`Duplicate platform plugin: ${id}`);
    this.plugins.set(id, plugin);
  }

  list(): Array<PlatformPlugin["manifest"] & { enabled: boolean; status: "started" | "stopped" }> {
    return [...this.plugins.values()].map((plugin) => ({
      ...plugin.manifest,
      enabled: this.isEnabled(plugin.manifest.id),
      status: this.started.has(plugin.manifest.id) ? "started" : "stopped",
    }));
  }

  private isEnabled(id: string): boolean {
    const row = db.prepare("SELECT enabled FROM platform_plugins WHERE id = ?").get(id) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  private isActive(id: string): boolean {
    return this.isEnabled(id) && this.started.has(id);
  }

  /** Used by route guards installed for plugin-owned endpoints. */
  isPluginActive(id: string): boolean {
    return this.isActive(id);
  }

  private context(id: string): PluginContext {
    return { pluginId: id, log: (level, message, detail) => console[level](`[plugin:${id}] ${message}`, detail ?? "") };
  }

  async initialize(app: FastifyInstance): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const id = plugin.manifest.id;
      try {
        db.prepare("INSERT OR IGNORE INTO platform_plugins (id, enabled, config, updated_at) VALUES (?, 1, '{}', ?)").run(id, now());
      } catch (error) {
        this.context(id).log("error", "plugin state initialization failed", error);
        continue;
      }
      try { await plugin.migrate?.(this.context(id)); }
      catch (error) { this.context(id).log("error", "plugin migration failed", error); }
      if (this.isEnabled(id)) {
        try {
          await plugin.start?.(this.context(id));
          this.started.add(id);
        } catch (error) { this.context(id).log("error", "plugin startup failed", error); }
      }
      try {
        if (plugin.registerRoutes) {
          const routeRegistrar = plugin.registerRoutes;
          // Fastify encapsulation lets a plugin be disabled at runtime without
          // unregistering routes (Fastify deliberately has no route removal API).
          await app.register(async (scope) => {
            scope.addHook("onRequest", async (_request, reply) => {
              if (!this.isPluginActive(id)) {
                return reply.code(503).send({ error: `plugin ${id} is disabled` });
              }
            });
            await routeRegistrar(scope);
          });
        }
      }
      catch (error) { this.context(id).log("error", "plugin route registration failed", error); }
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;
    const previous = this.isEnabled(id);
    db.prepare("UPDATE platform_plugins SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), id);
    try {
      if (enabled && !this.started.has(id)) {
        await plugin.start?.(this.context(id));
        this.started.add(id);
      } else if (!enabled && this.started.has(id)) {
        await plugin.stop?.(this.context(id));
        this.started.delete(id);
      }
    } catch (error) {
      this.context(id).log("error", `failed to ${enabled ? "start" : "stop"} plugin`, error);
      db.prepare("UPDATE platform_plugins SET enabled = ?, updated_at = ? WHERE id = ?").run(previous ? 1 : 0, now(), id);
      return false;
    }
    return true;
  }

  async beforeTurn(ctx: TurnContext): Promise<string[]> {
    const results: string[] = [];
    for (const plugin of this.plugins.values()) {
      if (!this.isActive(plugin.manifest.id) || !plugin.beforeTurn) continue;
      try {
        const result = await plugin.beforeTurn(ctx);
        if (typeof result === "string" && result.trim()) results.push(result.trim());
      } catch (error) {
        this.context(plugin.manifest.id).log("warn", "beforeTurn failed; continuing without plugin output", error);
      }
    }
    return results;
  }

  async afterTurn(ctx: TurnContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (!this.isActive(plugin.manifest.id) || !plugin.afterTurn) continue;
      try {
        await plugin.afterTurn(ctx);
      } catch (error) {
        this.context(plugin.manifest.id).log("warn", "afterTurn failed", error);
      }
    }
  }

  async createTools(ctx: PluginToolContext): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      if (!this.isActive(plugin.manifest.id) || !plugin.createTools) continue;
      try {
        tools.push(...await plugin.createTools(ctx));
      } catch (error) {
        this.context(plugin.manifest.id).log("warn", "tool creation failed; continuing without plugin tools", error);
      }
    }
    return tools;
  }

  async onTaskStarted(ctx: TaskStartContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (!this.isActive(plugin.manifest.id) || !plugin.onTaskStarted) continue;
      try {
        await plugin.onTaskStarted(ctx);
      } catch (error) {
        this.context(plugin.manifest.id).log("warn", "onTaskStarted failed; continuing without plugin", error);
      }
    }
  }

  async onTaskDeleted(ctx: Omit<TurnContext, "prompt">): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (!this.isActive(plugin.manifest.id) || !plugin.onTaskDeleted) continue;
      try {
        await plugin.onTaskDeleted(ctx);
      } catch (error) {
        this.context(plugin.manifest.id).log("warn", "onTaskDeleted failed", error);
      }
    }
  }
}
