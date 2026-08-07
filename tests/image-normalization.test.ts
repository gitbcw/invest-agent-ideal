import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharpDefault from "sharp";

const sharp = sharpDefault as unknown as <I>(input: I, opts?: Record<string, unknown>) => Sharpish;
interface Sharpish {
  jpeg(opts?: Record<string, unknown>): Sharpish;
  png(opts?: Record<string, unknown>): Sharpish;
  webp(opts?: Record<string, unknown>): Sharpish;
  rotate(): Sharpish;
  resize(opts: Record<string, unknown>): Sharpish;
  withMetadata(opts?: Record<string, unknown>): Sharpish;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ channels: number; exif?: Buffer; orientation?: number }>;
}

const ONE_MIB = 1024 * 1024;
const TEN_MIB = 10 * ONE_MIB;

const normalizer = (async () => (await import("../src/services/image-normalization.js")))();

/** A >1MiB JPEG that still compresses well below the 10MB ceiling. */
async function largeJpeg(): Promise<Buffer> {
  const noise = randomBytes(2200 * 2200 * 3);
  return sharp(noise, { raw: { width: 2200, height: 2200, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

test("images at or below 1MiB are passed through byte-for-byte", async () => {
  const { normalizeImageBytes } = await normalizer;
  const cases: Array<{ format: "jpeg" | "png" | "webp"; build: () => Promise<Buffer> }> = [
    { format: "jpeg", build: () => sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).jpeg().toBuffer() },
    { format: "png", build: () => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer() },
    { format: "webp", build: () => sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).webp().toBuffer() },
  ];
  for (const { format, build } of cases) {
    const input = await build();
    assert.ok(input.length <= ONE_MIB, "fixture must be <=1MiB");
    const result = await normalizeImageBytes(format, input);
    assert.equal(Buffer.compare(input, result.bytes), 0);
  }
});

test("a large JPEG is re-encoded, kept under 10MB and changed", async () => {
  const { normalizeImageBytes } = await normalizer;
  const input = await largeJpeg();
  assert.ok(input.length > ONE_MIB);
  const result = await normalizeImageBytes("jpeg", input);
  assert.ok(result.bytes.length <= TEN_MIB);
  assert.notEqual(Buffer.compare(input, result.bytes), 0);
  assert.equal(result.mimeType, "image/jpeg");
});

test("a large WebP is re-encoded and stays under 10MB", async () => {
  const { normalizeImageBytes } = await normalizer;
  const noise = randomBytes(2000 * 2000 * 3);
  const input = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).webp({ quality: 100 }).toBuffer();
  assert.ok(input.length > ONE_MIB);
  const result = await normalizeImageBytes("webp", input);
  assert.ok(result.bytes.length <= TEN_MIB);
  assert.equal(result.mimeType, "image/webp");
});

test("a large transparent PNG keeps PNG format and an alpha channel", async () => {
  const { normalizeImageBytes } = await normalizer;
  // 1200x1200x4 noise stays above 1MiB but compresses under the 10MB ceiling.
  const noise = randomBytes(1200 * 1200 * 4);
  const input = await sharp(noise, { raw: { width: 1200, height: 1200, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  assert.ok(input.length > ONE_MIB);
  const result = await normalizeImageBytes("png", input);
  assert.equal(result.mimeType, "image/png");
  assert.ok(result.bytes.length <= TEN_MIB);
  const channels = (await sharpMeta(result.bytes)).channels;
  assert.equal(channels, 4, "transparency must be preserved as an alpha channel");
});

test("EXIF metadata is stripped during normalization", async () => {
  const { normalizeImageBytes } = await normalizer;
  const noise = randomBytes(1500 * 1500 * 3);
  const input = await sharp(noise, { raw: { width: 1500, height: 1500, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
  assert.ok(input.length > ONE_MIB);
  const result = await normalizeImageBytes("jpeg", input);
  const meta = await sharpMeta(result.bytes);
  assert.ok(!meta.exif || meta.exif.length === 0, "EXIF must be stripped from the normalized output");
  assert.notEqual(meta.orientation, 6, "orientation flag must not survive normalization");
});

test("undecodable image bytes are rejected, not silently stored", async () => {
  const { normalizeImageBytes } = await normalizer;
  const garbage = randomBytes(ONE_MIB + 1024);
  await assert.rejects(() => normalizeImageBytes("jpeg", garbage));
});

test("an image whose normalized output still exceeds 10MB is rejected", async () => {
  const { normalizeImageBytes } = await normalizer;
  // High-entropy noise barely compresses as PNG, so the re-encoded output
  // stays above the 10MB ceiling and must be refused.
  const noise = randomBytes(2048 * 2048 * 3);
  const input = await sharp(noise, { raw: { width: 2048, height: 2048, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
  assert.ok(input.length > ONE_MIB);
  await assert.rejects(
    () => normalizeImageBytes("png", input),
    (error: unknown) => /10MB|exceeds/i.test(error instanceof Error ? error.message : String(error)),
  );
});

// Minimal sharp metadata helper kept inline so the test file is self-contained.
async function sharpMeta(buffer: Buffer): Promise<{ channels: number; exif?: Buffer; orientation?: number }> {
  const mod = await import("sharp");
  const instance = (mod.default as unknown as <I>(input: I) => Sharpish)(buffer);
  return instance.metadata();
}
