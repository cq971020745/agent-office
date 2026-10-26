/**
 * 皮肤包：用户自制的客户端外观覆盖层（manifest + 纯 CSS + 资源，无可执行代码）。
 * 级联位于 runtime-theme 主题层之上（同特异性后写者胜），皮肤只写覆盖项；
 * 服务端 {DATA_DIR}/skins 是唯一事实：内置包随应用同步，用户包目录放置或 zip 上传。
 * 取舍见 docs/adr/0011-skin-packs-css-only.md。
 */

import { ref } from "vue";
import { API_BASE, ApiError, fetchSkinCss, getToken, listSkins, type SkinCatalog, type SkinInfo } from "../api";

const STORAGE_SKIN = "agent-office-skin";

function readSkinId(): string {
  return localStorage.getItem(STORAGE_SKIN) ?? "";
}

const skinId = ref<string>(readSkinId());
const skins = ref<SkinInfo[]>([]);
const broken = ref<SkinCatalog["broken"]>([]);
/** 皮肤包根目录（服务端数据目录），供「打开皮肤目录」按钮使用 */
const skinDir = ref<string>("");
/** 最近一次皮肤加载失败提示；ThemePicker 观察并转 toast */
const skinNotice = ref<string>("");

let currentTag: HTMLStyleElement | null = null;

/**
 * CSS 里的相对 url() 改写为服务端文件接口：CSS 发起的资源请求不带 Authorization
 * 头，接口支持 ?token=。data:/http(s):/根相对 一律原样保留（外联由 CSP 兜底，
 * 见 docs/adr/0011）。外链 @import 直接移除：皮肤样式不应引入第三方样式源。
 */
function rewriteAssetUrls(css: string, id: string): string {
  const token = encodeURIComponent(getToken());
  return css
    .replace(/@import\s+[^;]*?(?:https?:)?\/\/[^;]*;?/gi, "/* 外链 @import 已按皮肤策略移除 */")
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote: string, raw: string) => {
      const target = raw.trim();
      if (!target || /^(data:|https?:|blob:|\/\/)/i.test(target) || target.startsWith("/")) return match;
      return `url(${quote}${API_BASE}/skins/${encodeURIComponent(id)}/file?path=${encodeURIComponent(target)}&token=${token}${quote})`;
    });
}

function removeSkinTag(): void {
  currentTag?.remove();
  currentTag = null;
  delete document.documentElement.dataset.skin;
}

/** 应用皮肤：拉 CSS → 改写资源地址 → 注入 <style>；id 为空表示回到无皮肤。 */
async function applySkin(id: string): Promise<void> {
  removeSkinTag();
  if (!id) return;
  try {
    const css = await fetchSkinCss(id);
    const tag = document.createElement("style");
    tag.dataset.skinStyle = id;
    tag.textContent = rewriteAssetUrls(css, id);
    document.head.appendChild(tag);
    currentTag = tag;
    document.documentElement.dataset.skin = id;
  } catch (err) {
    // 皮肤失效（被删/包损坏）：回退无皮肤并清掉持久化选择，由面板提示
    localStorage.removeItem(STORAGE_SKIN);
    skinId.value = "";
    const detail = err instanceof ApiError ? err.message : "皮肤加载失败";
    skinNotice.value = `皮肤「${id}」已回退：${detail}`;
    return;
  }
  skinNotice.value = "";
}

async function refreshSkins(): Promise<void> {
  try {
    const catalog = await listSkins();
    skins.value = catalog.skins;
    broken.value = catalog.broken;
    skinDir.value = catalog.skinDir ?? "";
    // 已选皮肤被删除时自动回退并清掉选择
    if (skinId.value && !catalog.skins.some((s) => s.id === skinId.value)) {
      skinId.value = "";
      localStorage.removeItem(STORAGE_SKIN);
      await applySkin("");
    }
  } catch {
    // 服务端未就绪时保持现状，面板下次打开再刷
  }
}

function setSkin(id: string): void {
  skinId.value = id;
  if (id) localStorage.setItem(STORAGE_SKIN, id);
  else localStorage.removeItem(STORAGE_SKIN);
  void applySkin(id);
}

export function useSkin() {
  return { skinId, skins, broken, skinDir, skinNotice, setSkin, refreshSkins };
}

/** 启动时恢复已选皮肤。异步拉取，不阻塞首帧（皮肤是覆盖层，晚一点无碍）。 */
export function bootstrapSkin(): void {
  if (skinId.value) void applySkin(skinId.value);
}
