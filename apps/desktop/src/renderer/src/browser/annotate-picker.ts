/**
 * 注入到 <webview> 内的元素拾取脚本。
 * executeJavaScript 返回 Promise，在用户点击目标元素后 resolve。
 */

export interface PickedElement {
  url: string;
  tag: string;
  id: string;
  classes: string[];
  text: string;
  cssPath: string;
  xpath: string;
  href: string;
  rect: { x: number; y: number; width: number; height: number };
  outerHtml: string;
}

/** 生成在 guest 页执行的拾取脚本（返回 Promise<PickedElement>） */
export function buildArmPickerScript(): string {
  return `(() => {
  if (typeof window.__aoAnnotateCleanup === "function") {
    try { window.__aoAnnotateCleanup(); } catch (_) {}
  }
  return new Promise((resolve) => {
    const STYLE_ID = "__ao-annotate-style";
    const HL_ID = "__ao-annotate-hl";
    let prev = null;
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = \`
        #\${HL_ID} {
          position: fixed !important;
          pointer-events: none !important;
          z-index: 2147483646 !important;
          border: 2px solid #2563eb !important;
          background: rgba(37, 99, 235, 0.12) !important;
          border-radius: 2px !important;
          box-sizing: border-box !important;
        }
        html.__ao-annotating, html.__ao-annotating * {
          cursor: crosshair !important;
        }
      \`;
      document.documentElement.appendChild(style);
    }
    document.documentElement.classList.add("__ao-annotating");
    let hl = document.getElementById(HL_ID);
    if (!hl) {
      hl = document.createElement("div");
      hl.id = HL_ID;
      document.documentElement.appendChild(hl);
    }

    function cssPath(el) {
      if (!(el instanceof Element)) return "";
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 8) {
        let part = cur.nodeName.toLowerCase();
        if (cur.id) {
          part += "#" + CSS.escape(cur.id);
          parts.unshift(part);
          break;
        }
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.nodeName === cur.nodeName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1;
            part += ":nth-of-type(" + idx + ")";
          }
        }
        parts.unshift(part);
        cur = parent;
      }
      return parts.join(" > ");
    }

    function xpathOf(el) {
      if (!(el instanceof Element)) return "";
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        let ix = 1;
        let sib = cur.previousElementSibling;
        while (sib) {
          if (sib.nodeName === cur.nodeName) ix++;
          sib = sib.previousElementSibling;
        }
        parts.unshift(cur.nodeName.toLowerCase() + "[" + ix + "]");
        cur = cur.parentElement;
      }
      return "/" + parts.join("/");
    }

    function placeHl(el) {
      if (!el || !(el instanceof Element)) {
        hl.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      hl.style.display = "block";
      hl.style.left = r.left + "px";
      hl.style.top = r.top + "px";
      hl.style.width = Math.max(0, r.width) + "px";
      hl.style.height = Math.max(0, r.height) + "px";
    }

    function onMove(e) {
      const t = e.target;
      if (t === hl || (t && t.id === HL_ID)) return;
      if (t !== prev) {
        prev = t;
        placeHl(t);
      }
    }

    function cleanup() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.documentElement.classList.remove("__ao-annotating");
      if (hl && hl.parentNode) hl.parentNode.removeChild(hl);
      window.__aoAnnotateCleanup = null;
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(null);
      }
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      if (!(el instanceof Element) || el.id === HL_ID) return;
      const r = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200);
      const href = el instanceof HTMLAnchorElement ? el.href : (el.getAttribute("href") || "");
      const info = {
        url: location.href,
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        classes: Array.from(el.classList || []),
        text,
        cssPath: cssPath(el),
        xpath: xpathOf(el),
        href,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        outerHtml: (el.outerHTML || "").slice(0, 800),
      };
      cleanup();
      resolve(info);
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window.__aoAnnotateCleanup = cleanup;
  });
})()`;
}

/** 取消拾取（用户关闭标注模式时调用） */
export function buildCancelPickerScript(): string {
  return `(() => {
  if (typeof window.__aoAnnotateCleanup === "function") {
    try { window.__aoAnnotateCleanup(); } catch (_) {}
  }
  return true;
})()`;
}

/** 把拾取结果格式化为发给 Agent 的 Markdown */
export function formatAnnotationPrompt(
  pick: PickedElement,
  comment: string,
  screenshotAttached: boolean
): string {
  const lines = [
    "[网页标注] 用户在预览浏览器中标注了页面元素，请按说明修改对应前端代码。",
    "",
    `- **页面 URL**：${pick.url}`,
    `- **标签**：\`${pick.tag}\`${pick.id ? ` #${pick.id}` : ""}`,
    pick.classes.length ? `- **class**：\`${pick.classes.join(" ")}\`` : null,
    pick.text ? `- **可见文本**：${JSON.stringify(pick.text)}` : null,
    `- **CSS 路径**：\`${pick.cssPath}\``,
    `- **XPath**：\`${pick.xpath}\``,
    pick.href ? `- **href**：${pick.href}` : null,
    `- **视口位置**：x=${Math.round(pick.rect.x)}, y=${Math.round(pick.rect.y)}, w=${Math.round(pick.rect.width)}, h=${Math.round(pick.rect.height)}`,
    screenshotAttached ? "- **截图**：见本消息附件（标注时页面截图）" : null,
    "",
    "### 用户说明",
    comment.trim() || "（未填写，请根据选中元素自行判断需要改进的点）",
    "",
    "### 元素 HTML 片段",
    "```html",
    pick.outerHtml,
    "```",
  ];
  return lines.filter((x) => x !== null).join("\n");
}
