import {
    BoundingBox,
    Color,
    Entity,
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
 * The renderer is a box entity per filled cell. That is honest rather than
 * clever: it is certainly correct, it needs no custom shader, and it is slow
 * once the count runs into thousands. Making it fast means instancing with a
 * per-instance colour stream, which is a vertex format and a shader - worth
 * doing when the counts demand it and not before.
 */

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
        const { dims, origin, cellSize, cells, colors } = this.grid;

        cells.forEach((flat, i) => {
            const x = flat % dims[0];
            const y = Math.floor(flat / dims[0]) % dims[1];
            const z = Math.floor(flat / (dims[0] * dims[1]));

            const material = new StandardMaterial();
            material.diffuse = new Color(colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2]);
            material.opacity = colors[i * 4 + 3];
            material.useLighting = false;
            material.update();

            const cell = new Entity(`cell${flat}`);
            cell.addComponent('render', { type: 'box', material });
            cell.setLocalScale(cellSize, cellSize, cellSize);
            cell.setLocalPosition(
                origin.x + x * cellSize,
                origin.y + y * cellSize,
                origin.z + z * cellSize
            );
            this.entity.addChild(cell);
        });

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
