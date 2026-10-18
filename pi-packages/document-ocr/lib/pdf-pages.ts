import path from "node:path";

/** 把 PDF 栅格化成 PNG；图片文件原样返回。缺少 canvas 时给出可配置替代方案。 */
export async function documentToPngPages(bytes: Uint8Array, fileName: string): Promise<Buffer[]> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext !== ".pdf") return [Buffer.from(bytes)];
  if (bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString("utf8") !== "%PDF") {
    return [Buffer.from(bytes)];
  }

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let createCanvas: typeof import("@napi-rs/canvas").createCanvas;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    ({ createCanvas } = await import("@napi-rs/canvas"));
  } catch (err) {
    throw new Error(
      `PDF 扫描件需要 pdfjs-dist 与 @napi-rs/canvas 才能栅格化。也可以把 OCR_ENGINE 设为 vision 并绑定视觉模型。原因：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  pdfjs.GlobalWorkerOptions.workerSrc = "";
  const pdf = await pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const pages: Buffer[] = [];
  const scale = 2;
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    pages.push(canvas.toBuffer("image/png"));
  }
  return pages;
}
