// 轻量安全 Markdown 渲染：先整体转义再施加格式，杜绝注入。
// 支持标题 / 粗斜体 / 行内代码 / 代码块 / 列表 / 引用 / 链接（仅 http/https）/ 分隔线。

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeUrl(url: string): string {
  return /^(https?:\/\/)/i.test(url) ? url : "";
}

export function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  // 先抽出围栏代码块，避免内部内容被行内规则改写
  let work = src.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    blocks.push(`<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  work = escapeHtml(work);

  const lines = work.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join("<br>"))}</p>`);
      para = [];
    }
  };
  const closeList = (): void => {
    if (list) {
      out.push(list === "ul" ? "</ul>" : "</ol>");
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const codeToken = line.match(/^\u0000B(\d+)\u0000$/);
    if (codeToken) {
      flushPara();
      closeList();
      out.push(blocks[Number(codeToken[1])]!);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push("<hr>");
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (list !== want) {
        closeList();
        out.push(want === "ul" ? "<ul>" : "<ol>");
        list = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join("\n");

  function inline(s: string): string {
    return s
      .replace(/`([^`]+)`/g, (_m, c: string) => `<code class="inline">${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => {
        const u = safeUrl(url);
        return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
      });
  }
}
