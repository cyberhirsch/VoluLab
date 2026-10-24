/**
 * A zip archive written in one piece, every entry stored.
 *
 * Written by hand rather than with a zip library, and for one reason:
 * readers that take an archive as a stream - Brush's dataset loader -
 * reject entries whose sizes arrive after the data, in a trailing
 * descriptor, which is what a streaming writer must emit, since it does
 * not know the size until the data is written. Holding the whole archive
 * in memory, the size and checksum are known before each header and no
 * descriptor is needed; every local header is then complete, which is
 * also what lets a GSV player read an entry in place by HTTP Range.
 *
 * Stored, because what goes in - jpegs, WebP, float buffers - gains little
 * from deflate, and a stored entry can be read in place.
 */

// crc32, because a zip entry has to carry one and the headers are ours
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

const crc32 = (data: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};

type ZipEntry = {
    name: string;
    data: Uint8Array;
};

/** Entries in the order given, then the central directory. */
const storedZip = (files: ZipEntry[]): Uint8Array => {
    const encoder = new TextEncoder();

    type Entry = { name: Uint8Array, data: Uint8Array, crc: number, offset: number };
    const entries: Entry[] = [];

    let size = 0;
    for (const file of files) {
        const name = encoder.encode(file.name);
        entries.push({ name, data: file.data, crc: crc32(file.data), offset: size });
        size += 30 + name.length + file.data.length;     // local header + payload
    }

    const centralOffset = size;
    size += entries.reduce((sum, e) => sum + 46 + e.name.length, 0) + 22;

    // no zip64: past these, the offsets and counts no longer fit
    if (size > 0xffffffff || entries.length >= 0xffff) {
        throw new Error('archive too large: more than 4 GB or 65535 entries');
    }

    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;

    const u32 = (value: number) => {
        view.setUint32(at, value, true);
        at += 4;
    };
    const u16 = (value: number) => {
        view.setUint16(at, value, true);
        at += 2;
    };
    const raw = (value: Uint8Array) => {
        bytes.set(value, at);
        at += value.length;
    };

    for (const entry of entries) {
        u32(0x04034b50);            // local file header
        u16(20);                    // version needed
        u16(0);                     // flags: no data descriptor
        u16(0);                     // method: stored
        u16(0);                     // time
        u16(0x21);                  // date: a valid 1980-01-01
        u32(entry.crc);
        u32(entry.data.length);     // compressed size
        u32(entry.data.length);     // uncompressed size
        u16(entry.name.length);
        u16(0);                     // extra length
        raw(entry.name);
        raw(entry.data);
    }

    for (const entry of entries) {
        u32(0x02014b50);            // central directory header
        u16(20);                    // version made by
        u16(20);                    // version needed
        u16(0);
        u16(0);
        u16(0);
        u16(0x21);
        u32(entry.crc);
        u32(entry.data.length);
        u32(entry.data.length);
        u16(entry.name.length);
        u16(0);                     // extra
        u16(0);                     // comment
        u16(0);                     // disk number
        u16(0);                     // internal attributes
        u32(0);                     // external attributes
        u32(entry.offset);
        raw(entry.name);
    }

    u32(0x06054b50);                // end of central directory
    u16(0);
    u16(0);
    u16(entries.length);
    u16(entries.length);
    u32(size - 22 - centralOffset);
    u32(centralOffset);
    u16(0);

    return bytes;
};

export { crc32, storedZip, type ZipEntry };
