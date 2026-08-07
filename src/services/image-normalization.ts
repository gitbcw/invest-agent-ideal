import { createRequire } from "node:module";

const nodeRequire = createRequire(__filename);
const ONE_MIB = 1024 * 1024;
const TEN_MIB = 10 * ONE_MIB;

/** Normalize only images above 1MiB. The optional sharp dependency is used when available. */
export async function normalizeImageBytes(format: "png" | "jpeg" | "webp", bytes: Buffer): Promise<{ bytes: Buffer; mimeType: string }> {
  if (bytes.length <= ONE_MIB) return { bytes, mimeType: format === "jpeg" ? "image/jpeg" : `image/${format}` };
  let sharp: ((input: Buffer) => any) | undefined;
  try { sharp = nodeRequire("sharp"); } catch { /* Runtime without image codec: preserve bytes and enforce the hard limit. */ }
  if (!sharp) {
    if (bytes.length > TEN_MIB) throw new Error("image normalization unavailable for oversized image");
    return { bytes, mimeType: format === "jpeg" ? "image/jpeg" : `image/${format}` };
  }
  // Sharp strips metadata by default when re-encoding; rotate uses EXIF orientation before it is discarded.
  const pipeline = sharp(bytes).rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true });
  const output = format === "png" ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : format === "webp" ? await pipeline.webp({ quality: 88 }).toBuffer() : await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  if (output.length > TEN_MIB) throw new Error("normalized image exceeds 10MB");
  return { bytes: output, mimeType: format === "jpeg" ? "image/jpeg" : `image/${format}` };
}
