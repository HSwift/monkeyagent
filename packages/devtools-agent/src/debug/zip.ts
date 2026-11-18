/**
 * Minimal ZIP writer (deflate via the platform CompressionStream, no dependencies).
 * Supports UTF-8 names and archives below 4 GiB / 65535 entries, which is ample for debug packs.
 */

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
  /** Modification time; defaults to the archive time. */
  date?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  // Cast: lib.dom types CompressionStream input as BufferSource, which excludes shared buffers.
  const deflate = new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return collect(source.pipeThrough(deflate));
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export async function createZip(entries: ZipEntry[], now = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.replace(/^\/+/, '');
    if (!name || names.has(name)) throw new Error(`Invalid or duplicate zip entry: ${entry.name}`);
    names.add(name);
    const nameBytes = encoder.encode(name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const deflated = await deflateRaw(raw);
    // Tiny or incompressible entries are stored as-is.
    const [method, body] = deflated.length < raw.length ? [8, deflated] : [0, raw];
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.date ?? now);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true); // version needed
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, method, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, raw.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }
  const directory = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, names.size, true);
  end.setUint16(10, names.size, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset, true);
  return concat([...parts, directory, new Uint8Array(end.buffer)]);
}
