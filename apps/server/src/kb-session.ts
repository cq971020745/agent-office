import { listKbAccessTokens } from "./auth.js";
import { KbAuthError, loadKbSession } from "./kb-auth.js";

/** 知识库访问凭证靠活动续期；本服务常驻时主动 getInfo，避免工作台空闲超时。 */
const KEEP_MS = 10 * 60_000;

export async function renewStoredKbSessions(): Promise<{ ok: number; expired: number; failed: number }> {
  let ok = 0;
  let expired = 0;
  let failed = 0;
  for (const row of listKbAccessTokens()) {
    try {
      await loadKbSession(row.token);
      ok += 1;
    } catch (err) {
      if (err instanceof KbAuthError) expired += 1;
      else failed += 1;
    }
  }
  return { ok, expired, failed };
}

export function startKbSessionKeeper(): void {
  const tick = (): void => {
    void renewStoredKbSessions().catch((err) => {
      console.warn("[kb-session] 续期失败：", err);
    });
  };
  const timer = setInterval(tick, KEEP_MS);
  timer.unref();
  const first = setTimeout(tick, 20_000);
  first.unref();
}
