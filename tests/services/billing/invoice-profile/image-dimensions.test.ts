import { describe, expect, it } from "vitest";

import {
  detectImageType,
  imageDimensions,
  jpegDimensions,
  pngDimensions,
  svgDimensions,
} from "@/services/billing/invoice-profile/image-dimensions";
import { jpeg, png, svg } from "@/tests/helpers/logo-fixtures";

// bm60-spec §Tests — the pure PNG/JPEG/SVG parsers (D3): happy paths, and
// truncated or hostile input handled as a typed result, never a throw.

describe("detectImageType (D2 check 2)", () => {
  it("detects PNG, JPEG and SVG from their bytes", () => {
    expect(detectImageType(png(400, 300))).toBe("image/png");
    expect(detectImageType(jpeg(400, 300))).toBe("image/jpeg");
    expect(detectImageType(svg())).toBe("image/svg+xml");
  });

  it("finds the SVG root after a BOM, whitespace, comments and a DOCTYPE", () => {
    const text = `﻿  <?xml version="1.0"?>\n<!-- a comment -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg width="300" height="300"></svg>`;
    expect(detectImageType(Buffer.from(text, "utf8"))).toBe("image/svg+xml");
  });

  it.each([
    ["random bytes", Buffer.from([1, 2, 3, 4, 5])],
    ["an empty buffer", Buffer.alloc(0)],
    ["HTML", Buffer.from("<html><svg></svg></html>")],
    ["invalid UTF-8", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0xfe])],
    ["an unterminated comment", Buffer.from("<!-- <svg></svg>")],
    ["<svgx>", Buffer.from("<svgx></svgx>")],
  ])("returns null for %s", (_label, bytes) => {
    expect(detectImageType(bytes)).toBeNull();
  });
});

describe("pngDimensions", () => {
  it("reads IHDR width and height", () => {
    expect(pngDimensions(png(640, 320))).toEqual({
      ok: true,
      width: 640,
      height: 320,
    });
  });

  it.each([
    ["a truncated buffer", png(640, 320).subarray(0, 20)],
    [
      "a bogus IHDR length",
      (() => {
        const b = png(640, 320);
        b.writeUInt32BE(14, 8);
        return b;
      })(),
    ],
    [
      "IHDR not the first chunk",
      (() => {
        const b = png(640, 320);
        b.write("IDAT", 12, "latin1");
        return b;
      })(),
    ],
    ["a zero width", png(0, 320)],
  ])("rejects %s as mime without throwing", (_label, bytes) => {
    expect(pngDimensions(bytes)).toMatchObject({ ok: false, reason: "mime" });
  });
});

describe("jpegDimensions", () => {
  it.each([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcd, 0xcf])(
    "reads SOF marker 0x%s",
    (sof) => {
      expect(jpegDimensions(jpeg(800, 600, { sof }))).toEqual({
        ok: true,
        width: 800,
        height: 600,
      });
    },
  );

  it.each([
    ["no SOF before SOS", jpeg(800, 600, { withSof: false })],
    ["a truncated buffer", jpeg(800, 600).subarray(0, 25)],
    ["only the SOI", Buffer.from([0xff, 0xd8, 0xff])],
    ["DHT (0xC4) is not a frame", jpeg(800, 600, { sof: 0xc4 })],
    [
      "a segment length under 2",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0]),
    ],
    [
      "garbage between markers",
      Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78, 0, 0]),
    ],
  ])("rejects %s as mime without throwing", (_label, bytes) => {
    expect(jpegDimensions(bytes)).toMatchObject({ ok: false, reason: "mime" });
  });
});

describe("svgDimensions", () => {
  it.each([
    ['width="400" height="300"', 400, 300],
    ['width="400px" height="300.4px"', 400, 300],
    ['viewBox="0 0 512 384"', 512, 384],
    ["viewBox='0,0,320,320'", 320, 320],
    // width/height missing one of the pair falls back to the viewBox.
    ['width="400" viewBox="0 0 600 450"', 600, 450],
  ])("reads %s", (attrs, width, height) => {
    expect(svgDimensions(svg(attrs).toString("utf8"))).toEqual({
      ok: true,
      width,
      height,
    });
  });

  it("does not take a > inside a quoted attribute as the end of the tag", () => {
    expect(
      svgDimensions(
        svg('data-x="a>b" width="400" height="300"').toString("utf8"),
      ),
    ).toEqual({ ok: true, width: 400, height: 300 });
  });

  it.each([
    'width="100%" height="100%"',
    'width="10em" height="10em"',
    'width="80mm" height="40mm"',
    'width="918pt" height="612pt" viewBox="0 0 918 612"',
  ])("rejects non-px units as dimensions: %s", (attrs) => {
    expect(svgDimensions(svg(attrs).toString("utf8"))).toMatchObject({
      ok: false,
      reason: "dimensions",
    });
  });

  it.each(["", 'viewBox="0 0 a b"', 'viewBox="0 0 300"', 'viewBox="0 0 0 0"'])(
    "rejects missing or unusable sizing (%s) as dimensions",
    (attrs) => {
      expect(svgDimensions(svg(attrs).toString("utf8"))).toMatchObject({
        ok: false,
        reason: "dimensions",
      });
    },
  );

  it("imageDimensions dispatches by type and rejects non-UTF-8 SVG", () => {
    expect(imageDimensions("image/png", png(300, 300))).toMatchObject({
      ok: true,
    });
    expect(
      imageDimensions("image/svg+xml", Buffer.from([0xff, 0xfe, 0xfd])),
    ).toMatchObject({ ok: false, reason: "mime" });
  });
});
