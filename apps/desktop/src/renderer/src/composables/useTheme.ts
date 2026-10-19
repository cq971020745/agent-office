/**
 * 外观主题：浅色 / 深色 / 玻璃拟态 + 主色预设 / 自选。
 * 通过 html[data-theme] 与 CSS 变量驱动全站，localStorage 持久化。
 */

import { computed, ref } from "vue";

export type ThemeMode = "light" | "dark" | "glass";
export type AccentId =
  | "pine"
  | "teal"
  | "ocean"
  | "indigo"
  | "amber"
  | "crimson"
  | "graphite"
  | "custom";

export type AccentPreset = {
  id: Exclude<AccentId, "custom">;
  label: string;
  /** 浅色模式下的基准色 */
  color: string;
};

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "pine", label: "墨松", color: "#177e5b" },
  { id: "teal", label: "瀑青", color: "#0f766e" },
  { id: "ocean", label: "沧海", color: "#1a6fbf" },
  { id: "indigo", label: "暮靛", color: "#4338ca" },
  { id: "amber", label: "琥珀", color: "#b45309" },
  { id: "crimson", label: "绛朱", color: "#be123c" },
  { id: "graphite", label: "石墨", color: "#475569" },
];

export const THEME_MODES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: "light", label: "浅色", hint: "纸面清爽" },
  { id: "dark", label: "深色", hint: "低光专注" },
  { id: "glass", label: "玻璃", hint: "毛玻璃拟态" },
];

const STORAGE_MODE = "agent-office-theme";
const STORAGE_ACCENT = "agent-office-accent";
const STORAGE_CUSTOM = "agent-office-accent-custom";
/** v3：整体再压浅一档，并重置旧深浅记忆 */
const STORAGE_DEPTH = "agent-office-depth-v3";
const STORAGE_FX = "agent-office-micro-fx";
const STORAGE_BUDDY = "agent-office-muni-buddy";
const DEFAULT_CUSTOM = "#177e5b";
/** 深浅默认值：0 最浅 → 100 最深；玻璃默认很浅 */
const DEFAULT_DEPTH: Record<ThemeMode, number> = { light: 22, dark: 38, glass: 10 };

export function depthHint(mode: ThemeMode): string {
  if (mode === "glass") return "全局调节面板透明度、模糊与底图压暗";
  if (mode === "dark") return "全局调节暗色背景与面板深浅";
  return "全局调节浅色底色与面板浓淡";
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? DEFAULT_CUSTOM;
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) [rp, gp, bp] = [c, x, 0];
  else if (hh < 120) [rp, gp, bp] = [x, c, 0];
  else if (hh < 180) [rp, gp, bp] = [0, c, x];
  else if (hh < 240) [rp, gp, bp] = [0, x, c];
  else if (hh < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t));
}

/**
 * 按模式推导表面色 / 玻璃透明度。
 * depth: 0 最浅（更通透或更亮）→ 100 最深（更实或更暗）。
 */
export function deriveDepthTokens(
  mode: ThemeMode,
  depth: number
): Record<string, string> {
  // 幂次 >1：滑杆前大半段都偏浅，只有拉到很深才明显变实
  const t = Math.pow(clamp(depth, 0, 100) / 100, 1.45);

  if (mode === "light") {
    const surface = mixHex("#ffffff", "#eef2ee", t);
    const bg = mixHex("#ffffff", "#f3f6f3", t);
    return {
      "--bg": bg,
      "--surface": surface,
      "--surface-2": mixHex("#fafbfa", "#e6ebe6", t),
      "--sidebar-bg": mixHex("#fcfdfc", "#ebf0eb", t),
      "--border": mixHex("#f2f4f2", "#d5ddd5", t),
      "--border-strong": mixHex("#e8ece8", "#c0cac1", t),
      "--border-faint": mixHex("#f8f9f8", "#e8ede8", t),
      "--glass-blur": "0px",
      "--glass-saturate": "1",
      "--glass-dim": "0",
      "--glass-panel": surface,
      "--glass-input": surface,
      "--glass-brand": bg,
      "--glass-accent-glow": "0.08",
      "--overlay": `rgba(16, 22, 19, ${lerp(0.28, 0.48, t).toFixed(3)})`,
      "--shadow-1": `0 1px 2px rgba(20, 28, 24, ${lerp(0.02, 0.06, t).toFixed(3)})`,
      "--shadow-2": `0 1px 2px rgba(20, 28, 24, ${lerp(0.02, 0.05, t).toFixed(3)}), 0 6px 20px rgba(20, 28, 24, ${lerp(0.03, 0.09, t).toFixed(3)})`,
      "--shadow-pop": `0 4px 12px rgba(16, 22, 19, ${lerp(0.04, 0.1, t).toFixed(3)}), 0 20px 48px rgba(16, 22, 19, ${lerp(0.08, 0.18, t).toFixed(3)})`,
    };
  }

  if (mode === "dark") {
    // 最浅端抬升灰阶，避免「调到最浅仍很黑」
    const surface = mixHex("#2e3531", "#141916", t);
    const bg = mixHex("#232a26", "#0c100e", t);
    return {
      "--bg": bg,
      "--surface": surface,
      "--surface-2": mixHex("#383f3b", "#1c221e", t),
      "--sidebar-bg": mixHex("#29302c", "#101512", t),
      "--border": mixHex("#434b46", "#222824", t),
      "--border-strong": mixHex("#556058", "#2e3631", t),
      "--border-faint": mixHex("#353c38", "#181d1a", t),
      "--glass-blur": "0px",
      "--glass-saturate": "1",
      "--glass-dim": "0",
      "--glass-panel": surface,
      "--glass-input": surface,
      "--glass-brand": bg,
      "--glass-accent-glow": "0.16",
      "--overlay": `rgba(5, 8, 6, ${lerp(0.38, 0.65, t).toFixed(3)})`,
      "--shadow-1": `0 1px 2px rgba(0, 0, 0, ${lerp(0.14, 0.32, t).toFixed(3)})`,
      "--shadow-2": `0 1px 2px rgba(0, 0, 0, ${lerp(0.12, 0.28, t).toFixed(3)}), 0 6px 20px rgba(0, 0, 0, ${lerp(0.18, 0.38, t).toFixed(3)})`,
      "--shadow-pop": `0 4px 12px rgba(0, 0, 0, ${lerp(0.16, 0.34, t).toFixed(3)}), 0 20px 48px rgba(0, 0, 0, ${lerp(0.28, 0.5, t).toFixed(3)})`,
    };
  }

  // 玻璃：最浅几乎全透；深端才逐步实色（地板刻意压低）
  const surfaceA = lerp(0.01, 0.2, t);
  const surface2A = lerp(0.02, 0.28, t);
  const sidebarA = lerp(0.04, 0.48, t);
  const borderA = lerp(0.04, 0.26, t);
  const inputA = lerp(0.015, 0.16, t);
  const panelA = lerp(0.03, 0.4, t);
  const brandA = lerp(0.04, 0.5, t);
  // 浮层（下拉/右键菜单/弹层）悬浮在正文上，必须比面板实得多，否则与底层内容互相透出
  const popA = lerp(0.6, 0.88, t);
  const blur = Math.round(lerp(8, 36, t));
  const dim = lerp(0.0, 0.48, t);
  const overlayA = lerp(0.18, 0.58, t);
  const accentGlow = lerp(0.08, 0.4, t);

  return {
    "--bg": "transparent",
    "--surface": `rgba(255, 255, 255, ${surfaceA.toFixed(3)})`,
    "--surface-2": `rgba(255, 255, 255, ${surface2A.toFixed(3)})`,
    "--sidebar-bg": `rgba(10, 16, 24, ${sidebarA.toFixed(3)})`,
    "--border": `rgba(255, 255, 255, ${borderA.toFixed(3)})`,
    "--border-strong": `rgba(255, 255, 255, ${lerp(0.07, 0.34, t).toFixed(3)})`,
    "--border-faint": `rgba(255, 255, 255, ${lerp(0.02, 0.14, t).toFixed(3)})`,
    "--glass-blur": `${blur}px`,
    "--glass-saturate": String(lerp(1.15, 1.65, t).toFixed(2)),
    "--glass-dim": dim.toFixed(3),
    "--glass-panel": `rgba(16, 22, 32, ${panelA.toFixed(3)})`,
    "--glass-input": `rgba(255, 255, 255, ${inputA.toFixed(3)})`,
    "--glass-brand": `rgba(8, 14, 24, ${brandA.toFixed(3)})`,
    "--glass-pop": `rgba(17, 24, 36, ${popA.toFixed(3)})`,
    "--glass-accent-glow": accentGlow.toFixed(3),
    "--overlay": `rgba(4, 8, 14, ${overlayA.toFixed(3)})`,
    "--code-bg": `rgba(6, 10, 16, ${lerp(0.32, 0.78, t).toFixed(3)})`,
    "--term-bg": `rgba(4, 8, 12, ${lerp(0.36, 0.82, t).toFixed(3)})`,
    "--shadow-1": `0 1px 2px rgba(0, 0, 0, ${lerp(0.04, 0.2, t).toFixed(3)})`,
    "--shadow-2": `0 1px 2px rgba(0, 0, 0, ${lerp(0.05, 0.22, t).toFixed(3)}), 0 10px 28px rgba(0, 0, 0, ${lerp(0.06, 0.3, t).toFixed(3)})`,
    "--shadow-pop": `0 8px 28px rgba(0, 0, 0, ${lerp(0.08, 0.34, t).toFixed(3)}), 0 28px 64px rgba(0, 0, 0, ${lerp(0.1, 0.42, t).toFixed(3)})`,
  };
}

/** 根据基准色与模式生成 accent 相关 token */
export function deriveAccentTokens(
  baseHex: string,
  mode: ThemeMode
): {
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentBorder: string;
  onAccent: string;
  rgb: string;
} {
  const rgb = hexToRgb(baseHex);
  const [h, s, l] = rgbToHsl(...rgb);

  let accentRgb: [number, number, number];
  let strongRgb: [number, number, number];

  if (mode === "light") {
    // 浅色：保持饱和，略压亮度保证对比
    accentRgb = hslToRgb(h, clamp(s, 0.35, 0.72), clamp(l, 0.28, 0.42));
    strongRgb = hslToRgb(h, clamp(s + 0.05, 0.4, 0.78), clamp(l - 0.1, 0.18, 0.34));
  } else {
    // 深色 / 玻璃：提亮主色，强色再亮一点用于 hover
    accentRgb = hslToRgb(h, clamp(s, 0.4, 0.7), clamp(l + 0.12, 0.45, 0.62));
    strongRgb = hslToRgb(h, clamp(s, 0.42, 0.72), clamp(l + 0.2, 0.52, 0.7));
  }

  const accent = rgbToHex(...accentRgb);
  const accentStrong = rgbToHex(...strongRgb);
  const softA = mode === "light" ? 0.12 : 0.16;
  const borderA = mode === "light" ? 0.28 : 0.42;
  const onAccent =
    relativeLuminance(...accentRgb) > 0.45 ? "#0b1410" : "#ffffff";

  return {
    accent,
    accentStrong,
    accentSoft: `rgba(${accentRgb.join(", ")}, ${softA})`,
    accentBorder: `rgba(${accentRgb.join(", ")}, ${borderA})`,
    onAccent,
    rgb: accentRgb.join(", "),
  };
}

function readMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_MODE);
  if (saved === "dark" || saved === "light" || saved === "glass") return saved;
  return "light";
}

function readAccentId(): AccentId {
  const saved = localStorage.getItem(STORAGE_ACCENT);
  if (saved === "custom") return "custom";
  if (ACCENT_PRESETS.some((p) => p.id === saved)) return saved as AccentId;
  return "pine";
}

function readCustomHex(): string {
  return normalizeHex(localStorage.getItem(STORAGE_CUSTOM) || "") ?? DEFAULT_CUSTOM;
}

function readDepthMap(): Record<ThemeMode, number> {
  const out = { ...DEFAULT_DEPTH };
  try {
    const raw = localStorage.getItem(STORAGE_DEPTH);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<Record<ThemeMode, unknown>>;
    for (const key of ["light", "dark", "glass"] as ThemeMode[]) {
      const n = Number(parsed[key]);
      if (Number.isFinite(n)) out[key] = clamp(Math.round(n), 0, 100);
    }
  } catch {
    // ignore corrupt storage
  }
  return out;
}

function resolveBaseColor(accentId: AccentId, customHex: string): string {
  if (accentId === "custom") return normalizeHex(customHex) ?? DEFAULT_CUSTOM;
  return ACCENT_PRESETS.find((p) => p.id === accentId)?.color ?? DEFAULT_CUSTOM;
}

function readFxEnabled(): boolean {
  const raw = localStorage.getItem(STORAGE_FX);
  if (raw === "0") return false;
  if (raw === "1") return true;
  return false; // 默认关闭，避免打扰
}

function readBuddyEnabled(): boolean {
  return localStorage.getItem(STORAGE_BUDDY) !== "0"; // 默认开启
}

/** 把主题写到 <html>，挂载前也可调用以避免闪烁 */
export function applyThemeToDocument(
  mode: ThemeMode,
  accentId: AccentId,
  customHex: string,
  depth: number,
  fxEnabled = false
): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.accent = accentId;
  root.dataset.depth = String(clamp(Math.round(depth), 0, 100));
  root.dataset.fx = fxEnabled ? "on" : "off";

  const base = resolveBaseColor(accentId, customHex);
  const accent = deriveAccentTokens(base, mode);
  const surfaces = deriveDepthTokens(mode, depth);
  const style = root.style;
  style.setProperty("--accent", accent.accent);
  style.setProperty("--accent-strong", accent.accentStrong);
  style.setProperty("--accent-soft", accent.accentSoft);
  style.setProperty("--accent-border", accent.accentBorder);
  style.setProperty("--on-accent", accent.onAccent);
  style.setProperty("--accent-rgb", accent.rgb);
  style.setProperty("--accent-base", base);
  for (const [key, value] of Object.entries(surfaces)) {
    style.setProperty(key, value);
  }
}

export function bootstrapTheme(): void {
  const depths = readDepthMap();
  const mode = readMode();
  applyThemeToDocument(
    mode,
    readAccentId(),
    readCustomHex(),
    depths[mode],
    readFxEnabled()
  );
}

const mode = ref<ThemeMode>(readMode());
const accentId = ref<AccentId>(readAccentId());
const customHex = ref(readCustomHex());
const depthMap = ref<Record<ThemeMode, number>>(readDepthMap());
const fxEnabled = ref(readFxEnabled());
const buddyEnabled = ref(readBuddyEnabled());

function persistAndApply(): void {
  localStorage.setItem(STORAGE_MODE, mode.value);
  localStorage.setItem(STORAGE_ACCENT, accentId.value);
  localStorage.setItem(STORAGE_CUSTOM, customHex.value);
  localStorage.setItem(STORAGE_DEPTH, JSON.stringify(depthMap.value));
  localStorage.setItem(STORAGE_FX, fxEnabled.value ? "1" : "0");
  localStorage.setItem(STORAGE_BUDDY, buddyEnabled.value ? "1" : "0");
  applyThemeToDocument(
    mode.value,
    accentId.value,
    customHex.value,
    depthMap.value[mode.value],
    fxEnabled.value
  );
}

export function useTheme() {
  const activeBaseColor = computed(() =>
    resolveBaseColor(accentId.value, customHex.value)
  );
  const depth = computed(() => depthMap.value[mode.value]);

  function setMode(next: ThemeMode): void {
    mode.value = next;
    persistAndApply();
  }

  function setAccentId(next: AccentId): void {
    accentId.value = next;
    persistAndApply();
  }

  function setCustomHex(hex: string): void {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    customHex.value = normalized;
    accentId.value = "custom";
    persistAndApply();
  }

  function setDepth(next: number): void {
    depthMap.value = {
      ...depthMap.value,
      [mode.value]: clamp(Math.round(next), 0, 100),
    };
    persistAndApply();
  }

  function setFxEnabled(next: boolean): void {
    fxEnabled.value = next;
    persistAndApply();
  }

  function setBuddyEnabled(next: boolean): void {
    buddyEnabled.value = next;
    persistAndApply();
  }

  /** 兼容旧「一键切换浅/深」；玻璃态下切到浅色 */
  function cycleMode(): void {
    const order: ThemeMode[] = ["light", "dark", "glass"];
    const i = order.indexOf(mode.value);
    setMode(order[(i + 1) % order.length]!);
  }

  return {
    mode,
    accentId,
    customHex,
    depth,
    depthMap,
    fxEnabled,
    buddyEnabled,
    activeBaseColor,
    setMode,
    setAccentId,
    setCustomHex,
    setDepth,
    setFxEnabled,
    setBuddyEnabled,
    cycleMode,
  };
}
