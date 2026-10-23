import {
    BoundingBox,
    Color,
    Entity,
    Mesh,
    MeshInstance,
    StandardMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from './serializer';

/**
 * A regular grid of filled cells - the second kind of thing this app knows how
 * to hold, alongside a splat.
 *
 * Deliberately not gaussians arranged on a lattice. A voxel here has a cell
 * index and a colour and nothing else: no covariance, no view-dependent
 * shading, no per-gaussian state. That is the point of it being its own type -
 * the things a splat carries are exactly what a voxel format does not want,
 * and pretending otherwise would mean carrying them to no purpose and then
 * discarding them at export.
 *
 * The renderer is one mesh: the faces of filled cells that border an empty
 * one, each carrying its cell's colour as a vertex colour. A face between
 * two filled cells can never be seen, so it is never built - a capture fills
 * a shell, and what is drawn is that shell's surface rather than every box
 * in it. One draw call, the engine's own unlit material, no shader of ours,
 * and the same on both backends. It replaced a box entity per cell, which
 * was certainly correct and slow from the thousands on.
 */

// the six faces of a unit cube about its centre: the neighbour each one
// looks onto, and its corners wound counter-clockwise seen from outside
const FACES: { dir: [number, number, number], corners: [number, number, number][] }[] = [
    { dir: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { dir: [-1, 0, 0], corners: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
    { dir: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { dir: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { dir: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { dir: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }
];

/**
 * The visible faces of a grid, as positions, sRGB colours and triangles.
 */
const buildSurface = (grid: VoxelGrid) => {
    const { dims, origin, cellSize, cells, colors } = grid;
    const filled = new Set<number>(cells);
    const at = (x: number, y: number, z: number) => {
        if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return false;
        return filled.has((z * dims[1] + y) * dims[0] + x);
    };

    // count first, so every array is allocated once at its size
    let faces = 0;
    const cellXYZ = (flat: number): [number, number, number] => [
        flat % dims[0],
        Math.floor(flat / dims[0]) % dims[1],
        Math.floor(flat / (dims[0] * dims[1]))
    ];
    cells.forEach((flat) => {
        const [x, y, z] = cellXYZ(flat);
        FACES.forEach(({ dir }) => {
            if (!at(x + dir[0], y + dir[1], z + dir[2])) faces++;
        });
    });

    const positions = new Float32Array(faces * 4 * 3);
    const colours = new Uint8Array(faces * 4 * 4);
    const indices = new Uint32Array(faces * 6);
    const half = cellSize * 0.5;
    let face = 0;

    cells.forEach((flat, i) => {
        const [x, y, z] = cellXYZ(flat);
        const cx = origin.x + x * cellSize;
        const cy = origin.y + y * cellSize;
        const cz = origin.z + z * cellSize;
        const r = Math.round(Math.min(1, Math.max(0, colors[i * 4])) * 255);
        const g = Math.round(Math.min(1, Math.max(0, colors[i * 4 + 1])) * 255);
        const b = Math.round(Math.min(1, Math.max(0, colors[i * 4 + 2])) * 255);

        FACES.forEach(({ dir, corners }) => {
            if (at(x + dir[0], y + dir[1], z + dir[2])) return;
            const v = face * 4;
            corners.forEach((c, k) => {
                positions[(v + k) * 3] = cx + c[0] * half;
                positions[(v + k) * 3 + 1] = cy + c[1] * half;
                positions[(v + k) * 3 + 2] = cz + c[2] * half;
                colours[(v + k) * 4] = r;
                colours[(v + k) * 4 + 1] = g;
                colours[(v + k) * 4 + 2] = b;
                colours[(v + k) * 4 + 3] = 255;
            });
            indices.set([v, v + 1, v + 2, v, v + 2, v + 3], face * 6);
            face++;
        });
    });

    return { positions, colours, indices, faces };
};

export type VoxelGrid = {
    /** cells along each axis */
    dims: [number, number, number];
    /** world position of the centre of cell (0,0,0) */
    origin: Vec3;
    /** edge length of one cell */
    cellSize: number;
    /** filled cells, as flat indices into dims */
    cells: Uint32Array;
    /** rgba per filled cell, parallel to `cells` */
    colors: Float32Array;
};

class Voxels extends Element {
    grid: VoxelGrid;
    entity: Entity;
    name: string;

    private boundStorage = new BoundingBox();

    constructor(grid: VoxelGrid, name = 'voxels') {
        super(ElementType.voxel);
        this.grid = grid;
        this.name = name;
        this.entity = new Entity('voxels');
    }

    get filled() {
        return this.grid.cells.length;
    }

    add() {
        const { dims, origin, cellSize } = this.grid;

        // built once, on the first add: the grid does not change after
        if (!this.entity.render) {
            const surface = buildSurface(this.grid);
            if (surface.faces > 0) {
                const mesh = new Mesh(this.scene.graphicsDevice);
                mesh.setPositions(surface.positions);
                mesh.setColors32(surface.colours);
                mesh.setIndices(surface.indices);
                mesh.update();

                // unlit, coloured by the vertices. Unlit, the standard
                // material shows only its emissive - a diffuse colour comes
                // out black, which is what the box-per-cell renderer drew.
                // The colours are sRGB, as a material colour is, so the
                // engine is told to decode them.
                const material = new StandardMaterial();
                material.diffuse = new Color(0, 0, 0);
                material.emissive = new Color(1, 1, 1);
                material.emissiveVertexColor = true;
                // a real engine flag the typings do not carry
                (material as any).vertexColorGamma = true;
                material.useLighting = false;
                material.update();

                this.entity.addComponent('render', {
                    meshInstances: [new MeshInstance(mesh, material)]
                });
            }
        }

        this.scene.contentRoot.addChild(this.entity);

        this.boundStorage.setMinMax(
            new Vec3(origin.x - cellSize * 0.5, origin.y - cellSize * 0.5, origin.z - cellSize * 0.5),
            new Vec3(
                origin.x + (dims[0] - 0.5) * cellSize,
                origin.y + (dims[1] - 0.5) * cellSize,
                origin.z + (dims[2] - 0.5) * cellSize
            )
        );

        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    remove() {
        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
        this.scene.forceRender = true;
    }

    destroy() {
        super.destroy();
        this.entity.destroy();
    }

    serialize(serializer: Serializer) {
        serializer.pack(this.grid.dims[0], this.grid.dims[1], this.grid.dims[2]);
        serializer.pack(this.grid.cellSize);
        serializer.pack(this.grid.cells.length);
    }

    get worldBound(): BoundingBox {
        return this.boundStorage;
    }
}

/**
 * Resample a set of points onto a grid.
 *
 * A cell takes the opacity-weighted mean colour of everything that lands in
 * it, and its alpha is the mean opacity. Weighting by opacity rather than
 * counting evenly matters because a capture is mostly faint gaussians: an
 * unweighted mean lets a cloud of near-invisible points outvote the few solid
 * ones that actually describe the surface.
 *
 * Cells nothing lands in are simply absent - the grid is stored as a list of
 * filled cells rather than as a dense array, because a capture fills a shell
 * and leaves the volume empty.
 */
export const voxelise = (
    points: { x: Float32Array, y: Float32Array, z: Float32Array },
    colors: { r: Float32Array, g: Float32Array, b: Float32Array, a: Float32Array },
    include: (i: number) => boolean,
    count: number,
    resolution: number
): VoxelGrid => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let any = false;

    for (let i = 0; i < count; ++i) {
        if (!include(i)) continue;
        any = true;
        if (points.x[i] < x0) x0 = points.x[i];
        if (points.y[i] < y0) y0 = points.y[i];
        if (points.z[i] < z0) z0 = points.z[i];
        if (points.x[i] > x1) x1 = points.x[i];
        if (points.y[i] > y1) y1 = points.y[i];
        if (points.z[i] > z1) z1 = points.z[i];
    }

    if (!any) {
        return {
            dims: [1, 1, 1],
            origin: new Vec3(),
            cellSize: 1,
            cells: new Uint32Array(0),
            colors: new Float32Array(0)
        };
    }

    // the longest axis gets `resolution` cells; the others get however many
    // that cell size gives them, so cells stay cubic
    const span = Math.max(x1 - x0, y1 - y0, z1 - z0) || 1;
    const cellSize = span / Math.max(1, resolution);
    const dim = (lo: number, hi: number) => Math.max(1, Math.ceil((hi - lo) / cellSize) + 1);
    const dims: [number, number, number] = [dim(x0, x1), dim(y0, y1), dim(z0, z1)];

    const acc = new Map<number, { r: number, g: number, b: number, a: number, w: number, n: number }>();

    for (let i = 0; i < count; ++i) {
        if (!include(i)) continue;
        const cx = Math.min(dims[0] - 1, Math.floor((points.x[i] - x0) / cellSize));
        const cy = Math.min(dims[1] - 1, Math.floor((points.y[i] - y0) / cellSize));
        const cz = Math.min(dims[2] - 1, Math.floor((points.z[i] - z0) / cellSize));
        const flat = (cz * dims[1] + cy) * dims[0] + cx;

        const alpha = colors.a[i];
        // a floor on the weight, so a cell holding nothing but transparent
        // points still takes their colour rather than dividing by zero
        const w = Math.max(1e-4, alpha);

        let cell = acc.get(flat);
        if (!cell) {
            cell = { r: 0, g: 0, b: 0, a: 0, w: 0, n: 0 };
            acc.set(flat, cell);
        }
        cell.r += colors.r[i] * w;
        cell.g += colors.g[i] * w;
        cell.b += colors.b[i] * w;
        cell.a += alpha;
        cell.w += w;
        cell.n++;
    }

    const flats = [...acc.keys()].sort((a, b) => a - b);
    const cells = new Uint32Array(flats.length);
    const out = new Float32Array(flats.length * 4);

    flats.forEach((flat, i) => {
        const cell = acc.get(flat);
        cells[i] = flat;
        out[i * 4] = cell.r / cell.w;
        out[i * 4 + 1] = cell.g / cell.w;
        out[i * 4 + 2] = cell.b / cell.w;
        out[i * 4 + 3] = cell.a / cell.n;
    });

    return {
        dims,
        origin: new Vec3(x0, y0, z0),
        cellSize,
        cells,
        colors: out
    };
};

export { Voxels };
