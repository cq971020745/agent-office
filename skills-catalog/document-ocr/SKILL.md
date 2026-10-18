---
name: document-ocr
description: 扫描件、图片型 PDF、照片用 ocr_to_md 转成 .parsed/ Markdown；默认开源 Tesseract.js，可配置 OCR 模型
---

# 扫描件 OCR

工作区里的扫描 PDF、截图、照片、图片型 PDF 没有文字层，`doc_to_md` 会得到空正文。调用 `ocr_to_md`。不要安装系统 Tesseract，也不要把本地附件上传到云盘只为提取正文。

## 工具路由

| 文件 | 先调用 | 何时换工具 |
|---|---|---|
| `.docx` / `.doc` / `.pptx` / `.xlsx` 等数字版 Office | `doc_to_md` | 一般不需要 OCR |
| 可复制文字的 PDF | `doc_to_md` | Saved-To Markdown 几乎没有正文时再 `ocr_to_md` |
| 扫描件 PDF、图片型 PDF | `ocr_to_md` | 直接 OCR |
| `.png` `.jpg` `.jpeg` `.tif` `.tiff` `.bmp` `.webp` `.gif` | `ocr_to_md` | 不要用 `workspace_read` 当文本读 |

参数：`path` 为工作区相对路径，`outputDir` 通常 `.parsed/<文件名去后缀>`。再用 `workspace_read` 读返回的 `Saved-To` 路径。

## 引擎与模型

默认开源 **Tesseract.js**（官方 tessdata 语言包，不依赖本机 tesseract 安装）。可配置：

| 方式 | 作用 |
|---|---|
| 供应商「扫描件 OCR 模型」 | 绑定 `textin` 走合合 TextIn；绑定其他模型走该供应商多模态接口 |
| `OCR_ENGINE` | `tesseract` / `vision` / `textin`（未设时看供应商绑定） |
| `OCR_MODEL` | Tesseract 语言包，如 `chi_sim+eng`、`chi_sim`、`eng`；vision 时为模型 ID |
| `{DATA_DIR}/ocr.json` | `{ "engine": "tesseract", "model": "chi_sim+eng" }` |
| `OCR_TESSDATA_DIR` / `OCR_TESSDATA_BASE_URL` | 语言包缓存目录或下载镜像 |
| 登录后自动种入的「TextIn OCR」供应商 | 模型 ID `textin`，默认地址 `http://10.50.11.17`；密钥写在该供应商或 `TEXT_IN_API_KEY` / `~/.agents/key/TEXT_IN_API_KEY` |

不要向用户索要或打印密钥。单文件不超过 20MB。入库仍上传原文件，除非用户只要文本稿。
