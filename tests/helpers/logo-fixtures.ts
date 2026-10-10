// bm60 — minimal, header-accurate PNG/JPEG/SVG byte builders for the logo
// upload tests. Only the parts the pure parsers read are meaningful (the PNG
// signature + IHDR, the JPEG markers up to SOF); the rest is filler.

export function png(width: number, height: number, padTo = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(6, 17); // RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = Buffer.from([
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const body = Buffer.concat([sig, ihdr, iend]);
  return padTo > body.length
    ? Buffer.concat([body, Buffer.alloc(padTo - body.length)])
    : body;
}

export function jpeg(
  width: number,
  height: number,
  { sof = 0xc0, withSof = true }: { sof?: number; withSof?: boolean } = {},
): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const frame = Buffer.alloc(19);
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(sof, 1);
  frame.writeUInt16BE(17, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame.writeUInt8(3, 9);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    ...(withSof ? [frame] : []),
    sos,
    eoi,
  ]);
}

export function svg(
  attrs = 'width="400" height="300"',
  body = '<rect width="10" height="10" fill="#2E45A9"/>',
  prolog = '<?xml version="1.0" encoding="UTF-8"?>\n',
): Buffer {
  return Buffer.from(
    `${prolog}<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`,
    "utf8",
  );
}
