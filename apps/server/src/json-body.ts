// JSON body 解析：Fastify 默认对「Content-Type: application/json 但 body 为空」抛
// FST_ERR_CTP_EMPTY_JSON_BODY(400)，桌面端/脚本的无体 DELETE、无体 POST 会被拦。
// 这里替换为宽松解析：空体 → undefined，坏 JSON 仍报错。
import type { FastifyInstance } from "fastify";

export function registerLenientJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "" || body === undefined) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      (error as Error & { statusCode?: number }).statusCode = 400;
      done(error, undefined);
    }
  });
}
