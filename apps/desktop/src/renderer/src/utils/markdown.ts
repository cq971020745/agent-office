// 安全增强型 Markdown 渲染器：先整体转义再施加格式，杜绝 XSS 注入。
// 支持：GFM 表格（含左/中/右对齐）、代码块语法着色 + 一键复制、任务复选框列表（- [x]）、
// 多行引用块（>）、标题（h1-h6）、粗斜体、删除线、行内代码、有序/无序列表、安全链接（http/https）、分隔线。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url: string): string {
  return /^(https?:\/\/)/i.test(url) ? url : "";
}

const KW_RE =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|interface|type|import|from|export|default|async|await|try|catch|finally|throw|new|in|of|def|elif|except|lambda|yield|with|as|pass|True|False|None|true|false|null|undefined|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|GROUP|BY|ORDER|LIMIT|CREATE|TABLE)\b/g;

/** 轻量无注入风险的代码语法着色：按词法切分后再逐段 escapeHtml */
function highlightCode(raw: string, lang: string): string {
  if (!raw) return "";
  const l = lang.toLowerCase();
  if (l === "txt" || l === "text" || l === "markdown" || l === "md") {
    return escapeHtml(raw);
  }
  // 单趟词法正则：注释 | 字符串 | 数字 | 标识符
  const tokenRe =
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_]\w*)/g;
  let out = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(raw)) !== null) {
    if (m.index > lastIdx) {
      out += escapeHtml(raw.slice(lastIdx, m.index));
    }
    const [full, comment, str, num, ident] = m;
    if (comment !== undefined) {
      out += `<span class="hl-c">${escapeHtml(full)}</span>`;
    } else if (str !== undefined) {
      out += `<span class="hl-s">${escapeHtml(full)}</span>`;
    } else if (num !== undefined) {
      out += `<span class="hl-n">${escapeHtml(full)}</span>`;
    } else if (ident !== undefined) {
      KW_RE.lastIndex = 0;
      if (KW_RE.test(ident)) {
        out += `<span class="hl-k">${escapeHtml(full)}</span>`;
      } else {
        out += escapeHtml(full);
      }
    } else {
      out += escapeHtml(full);
    }
    lastIdx = tokenRe.lastIndex;
  }
  if (lastIdx < raw.length) {
    out += escapeHtml(raw.slice(lastIdx));
  }
  return out;
}

// 全局事件委托：处理所有 Markdown 代码块的「复制代码」按钮点击
if (typeof window !== "undefined") {
  window.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement | null)?.closest?.("[data-md-copy]") as HTMLButtonElement | null;
    if (!target) return;
    const wrap = target.closest(".code-block-wrap");
    const codeEl = wrap?.querySelector("pre.md-code code");
    const text = codeEl?.textContent ?? "";
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      const prev = target.textContent;
      target.textContent = "已复制 ✓";
      target.classList.add("copied");
      setTimeout(() => {
        target.textContent = prev || "复制";
        target.classList.remove("copied");
      }, 1500);
    });
  });
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
  const cells = splitTableCells(trimmed);
  return cells.length >= 2 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableAlignments(line: string): ("left" | "center" | "right" | "")[] {
  return splitTableCells(line).map((c) => {
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    if (c.startsWith(":")) return "left";
    return "";
  });
}

export function renderMarkdown(src: string): string {
  if (!src) return "";
  const blocks: string[] = [];
  // 先抽出围栏代码块，避免内部内容被行内规则改写
  let work = src.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    const cleanCode = code.replace(/\n$/, "");
    const safeLang = escapeHtml(lang || "text");
    const highlighted = highlightCode(cleanCode, lang);
    blocks.push(
      `<div class="code-block-wrap"><div class="code-head"><span class="code-lang">${safeLang}</span><button type="button" class="code-copy" data-md-copy="1">复制</button></div><pre class="md-code"><code>${highlighted}</code></pre></div>`
    );
    return `\n\u0000B${blocks.length - 1}\u0000\n`;
  });

  work = escapeHtml(work);

  const lines = work.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let quote: string[] = [];

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
  const flushQuote = (): void => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join("<br>"))}</blockquote>`);
      quote = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();

    const codeToken = line.trim().match(/^\u0000B(\d+)\u0000$/);
    if (codeToken) {
      flushPara();
      closeList();
      flushQuote();
      out.push(blocks[Number(codeToken[1])]!);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      flushQuote();
      continue;
    }

    // GFM 表格识别：当前行含 | 且下一行是 | --- | --- | 分隔行
    const nextLine = lines[i + 1]?.trimEnd() ?? "";
    if (line.includes("|") && isTableSeparator(nextLine)) {
      flushPara();
      closeList();
      flushQuote();
      const headers = splitTableCells(line);
      const aligns = parseTableAlignments(nextLine);
      i += 1; // 跳过分隔行
      const bodyRows: string[][] = [];
      while (i + 1 < lines.length) {
        const rowLine = lines[i + 1]!.trimEnd();
        if (!rowLine.trim() || !rowLine.includes("|") || /^\u0000B\d+\u0000$/.test(rowLine.trim())) break;
        bodyRows.push(splitTableCells(rowLine));
        i += 1;
      }
      const ths = headers
        .map((h, idx) => {
          const al = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
          return `<th${al}>${inline(h)}</th>`;
        })
        .join("");
      const trs = bodyRows
        .map((row) => {
          const tds = headers
            .map((_, idx) => {
              const al = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
              return `<td${al}>${inline(row[idx] ?? "")}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`
      );
      continue;
    }

    // 引用块（> 开头，escapeHtml 后为 &gt;）
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) {
      flushPara();
      closeList();
      quote.push(bq[1]!);
      continue;
    }
    flushQuote();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
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

    // 任务复选框列表（- [ ] 或 - [x]）
    const taskMatch = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (taskMatch) {
      flushPara();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      const checked = taskMatch[1]!.toLowerCase() === "x";
      out.push(
        `<li class="task-li"><span class="task-check${checked ? " done" : ""}">${checked ? "✓" : ""}</span><span class="task-text${checked ? " done" : ""}">${inline(taskMatch[2]!)}</span></li>`
      );
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
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
  flushQuote();
  return out.join("\n");

  function inline(s: string): string {
    return s
      .replace(/`([^`]+)`/g, (_m, c: string) => `<code class="inline">${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => {
        const u = safeUrl(url);
        return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
      });
  }
}
