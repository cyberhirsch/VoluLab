import { Vec3 } from 'playcanvas';

import { VoxelGrid } from '../../voxels';

/**
 * MagicaVoxel .vox reader, onto the existing voxel element.
 *
 * The format is RIFF-shaped: 'VOX ' + version, then a MAIN chunk whose
 * children include SIZE/XYZI pairs (one per model) and an optional RGBA
 * palette. Version 1 of this reader takes the first model; the nTRN/nGRP
 * scene graph that places multiple models is a noted follow-up.
 *
 * MagicaVoxel is Z-up; the engine is Y-up. Sizes map (x,y,z) -> (x,z,y),
 * and the model is centred on x/z with its base resting on y=0.
 */

// MagicaVoxel's default palette, used when the file carries no RGBA chunk.
// Stored as the abgr words the format defines.
const DEFAULT_PALETTE = new Uint32Array([
    0x00000000, 0xffffffff, 0xffccffff, 0xff99ffff, 0xff66ffff, 0xff33ffff, 0xff00ffff, 0xffffccff,
    0xffccccff, 0xff99ccff, 0xff66ccff, 0xff33ccff, 0xff00ccff, 0xffff99ff, 0xffcc99ff, 0xff9999ff,
    0xff6699ff, 0xff3399ff, 0xff0099ff, 0xffff66ff, 0xffcc66ff, 0xff9966ff, 0xff6666ff, 0xff3366ff,
    0xff0066ff, 0xffff33ff, 0xffcc33ff, 0xff9933ff, 0xff6633ff, 0xff3333ff, 0xff0033ff, 0xffff00ff,
    0xffcc00ff, 0xff9900ff, 0xff6600ff, 0xff3300ff, 0xff0000ff, 0xffffffcc, 0xffccffcc, 0xff99ffcc,
    0xff66ffcc, 0xff33ffcc, 0xff00ffcc, 0xffffcccc, 0xffcccccc, 0xff99cccc, 0xff66cccc, 0xff33cccc,
    0xff00cccc, 0xffff99cc, 0xffcc99cc, 0xff9999cc, 0xff6699cc, 0xff3399cc, 0xff0099cc, 0xffff66cc,
    0xffcc66cc, 0xff9966cc, 0xff6666cc, 0xff3366cc, 0xff0066cc, 0xffff33cc, 0xffcc33cc, 0xff9933cc,
    0xff6633cc, 0xff3333cc, 0xff0033cc, 0xffff00cc, 0xffcc00cc, 0xff9900cc, 0xff6600cc, 0xff3300cc,
    0xff0000cc, 0xffffff99, 0xffccff99, 0xff99ff99, 0xff66ff99, 0xff33ff99, 0xff00ff99, 0xffffcc99,
    0xffcccc99, 0xff99cc99, 0xff66cc99, 0xff33cc99, 0xff00cc99, 0xffff9999, 0xffcc9999, 0xff999999,
    0xff669999, 0xff339999, 0xff009999, 0xffff6699, 0xffcc6699, 0xff996699, 0xff666699, 0xff336699,
    0xff006699, 0xffff3399, 0xffcc3399, 0xff993399, 0xff663399, 0xff333399, 0xff003399, 0xffff0099,
    0xffcc0099, 0xff990099, 0xff660099, 0xff330099, 0xff000099, 0xffffff66, 0xffccff66, 0xff99ff66,
    0xff66ff66, 0xff33ff66, 0xff00ff66, 0xffffcc66, 0xffcccc66, 0xff99cc66, 0xff66cc66, 0xff33cc66,
    0xff00cc66, 0xffff9966, 0xffcc9966, 0xff999966, 0xff669966, 0xff339966, 0xff009966, 0xffff6666,
    0xffcc6666, 0xff996666, 0xff666666, 0xff336666, 0xff006666, 0xffff3366, 0xffcc3366, 0xff993366,
    0xff663366, 0xff333366, 0xff003366, 0xffff0066, 0xffcc0066, 0xff990066, 0xff660066, 0xff330066,
    0xff000066, 0xffffff33, 0xffccff33, 0xff99ff33, 0xff66ff33, 0xff33ff33, 0xff00ff33, 0xffffcc33,
    0xffcccc33, 0xff99cc33, 0xff66cc33, 0xff33cc33, 0xff00cc33, 0xffff9933, 0xffcc9933, 0xff999933,
    0xff669933, 0xff339933, 0xff009933, 0xffff6633, 0xffcc6633, 0xff996633, 0xff666633, 0xff336633,
    0xff006633, 0xffff3333, 0xffcc3333, 0xff993333, 0xff663333, 0xff333333, 0xff003333, 0xffff0033,
    0xffcc0033, 0xff990033, 0xff660033, 0xff330033, 0xff000033, 0xffffff00, 0xffccff00, 0xff99ff00,
    0xff66ff00, 0xff33ff00, 0xff00ff00, 0xffffcc00, 0xffcccc00, 0xff99cc00, 0xff66cc00, 0xff33cc00,
    0xff00cc00, 0xffff9900, 0xffcc9900, 0xff999900, 0xff669900, 0xff339900, 0xff009900, 0xffff6600,
    0xffcc6600, 0xff996600, 0xff666600, 0xff336600, 0xff006600, 0xffff3300, 0xffcc3300, 0xff993300,
    0xff663300, 0xff333300, 0xff003300, 0xffff0000, 0xffcc0000, 0xff990000, 0xff660000, 0xff330000,
    0xff0000ee, 0xff0000dd, 0xff0000bb, 0xff0000aa, 0xff000088, 0xff000077, 0xff000055, 0xff000044,
    0xff000022, 0xff000011, 0xff00ee00, 0xff00dd00, 0xff00bb00, 0xff00aa00, 0xff008800, 0xff007700,
    0xff005500, 0xff004400, 0xff002200, 0xff001100, 0xffee0000, 0xffdd0000, 0xffbb0000, 0xffaa0000,
    0xff880000, 0xff770000, 0xff550000, 0xff440000, 0xff220000, 0xff110000, 0xffeeeeee, 0xffdddddd,
    0xffbbbbbb, 0xffaaaaaa, 0xff888888, 0xff777777, 0xff555555, 0xff444444, 0xff222222, 0xff111111
]);

const CELL_SIZE = 0.1;

const readVox = (bytes: Uint8Array): VoxelGrid => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (offset: number) => String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
    );

    if (tag(0) !== 'VOX ') {
        throw new Error('Not a MagicaVoxel file');
    }

    let size: [number, number, number] | null = null;
    let voxels: Uint8Array | null = null;
    let palette = DEFAULT_PALETTE;

    // walk MAIN's children; the first SIZE/XYZI pair is the model we take
    let offset = 8;
    const walk = (end: number) => {
        while (offset + 12 <= end) {
            const id = tag(offset);
            const contentSize = view.getUint32(offset + 4, true);
            const childrenSize = view.getUint32(offset + 8, true);
            const contentStart = offset + 12;

            if (id === 'MAIN') {
                offset = contentStart + contentSize;
                walk(contentStart + contentSize + childrenSize);
                continue;
            }
            if (id === 'SIZE' && !size) {
                size = [
                    view.getUint32(contentStart, true),
                    view.getUint32(contentStart + 4, true),
                    view.getUint32(contentStart + 8, true)
                ];
            } else if (id === 'XYZI' && !voxels) {
                const count = view.getUint32(contentStart, true);
                voxels = bytes.subarray(contentStart + 4, contentStart + 4 + count * 4);
            } else if (id === 'RGBA') {
                palette = new Uint32Array(256);
                for (let i = 0; i < 255; i++) {
                    palette[i + 1] = view.getUint32(contentStart + i * 4, true);
                }
            }
            offset = contentStart + contentSize + childrenSize;
        }
    };
    walk(bytes.byteLength);

    if (!size || !voxels) {
        throw new Error('No model found in this .vox file');
    }

    // MagicaVoxel z-up -> engine y-up
    const dims: [number, number, number] = [size[0], size[2], size[1]];
    const count = voxels.length / 4;
    const cells = new Uint32Array(count);
    const colors = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
        const vx = voxels[i * 4];
        const vy = voxels[i * 4 + 1];
        const vz = voxels[i * 4 + 2];
        const colorIndex = voxels[i * 4 + 3];

        // (x, y, z) in file -> (x, z, y) in engine, flat index x + y*dx + z*dx*dy
        cells[i] = vx + vz * dims[0] + vy * dims[0] * dims[1];

        // palette entries are abgr words; index c reads stored entry c (the
        // palette array is already shifted by one above)
        const rgba = palette[colorIndex];
        colors[i * 4] = (rgba & 0xff) / 255;
        colors[i * 4 + 1] = ((rgba >> 8) & 0xff) / 255;
        colors[i * 4 + 2] = ((rgba >> 16) & 0xff) / 255;
        colors[i * 4 + 3] = ((rgba >>> 24) & 0xff) / 255;
    }

    // centred on x/z, base resting on the ground plane
    const origin = new Vec3(
        -(dims[0] - 1) * CELL_SIZE / 2,
        CELL_SIZE / 2,
        -(dims[2] - 1) * CELL_SIZE / 2
    );

    return { dims, origin, cellSize: CELL_SIZE, cells, colors };
};

export { readVox };
