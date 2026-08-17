/**
 * Analytic eigendecomposition of a symmetric 3x3 matrix, for turning a
 * conditional 3D covariance into the scale + rotation form GSplatData wants.
 *
 * Eigenvalues by Cardano on the characteristic polynomial; eigenvectors by
 * row cross-products of (A - lambda I). Covariances here can be tiny (a
 * gaussian's std in metres, squared), so the matrix is scale-normalised by
 * its largest entry first - the decomposition is scale-equivariant and this
 * keeps the arithmetic in a healthy range.
 */

type EigenResult = {
    // eigenvalues, descending
    values: [number, number, number];
    // matching unit eigenvectors as the COLUMNS of a right-handed basis,
    // flattened row-major: v[col] = (m[col], m[3 + col], m[6 + col])
    vectors: Float64Array;
};

const TWO_PI_3 = (2 * Math.PI) / 3;

// cross product of rows i and j of a row-major 3x3
const rowCross = (m: Float64Array, i: number, j: number, out: Float64Array, o: number) => {
    const a0 = m[i * 3], a1 = m[i * 3 + 1], a2 = m[i * 3 + 2];
    const b0 = m[j * 3], b1 = m[j * 3 + 1], b2 = m[j * 3 + 2];
    out[o] = a1 * b2 - a2 * b1;
    out[o + 1] = a2 * b0 - a0 * b2;
    out[o + 2] = a0 * b1 - a1 * b0;
};

// unit eigenvector of A for eigenvalue lambda: the largest cross product of
// two rows of (A - lambda I) spans the null-space complement. Returns the
// squared norm of the chosen cross product so callers can detect degeneracy.
const eigenvector = (
    xx: number, xy: number, xz: number, yy: number, yz: number, zz: number,
    lambda: number, out: Float64Array, o: number
): number => {
    const m = new Float64Array([
        xx - lambda, xy, xz,
        xy, yy - lambda, yz,
        xz, yz, zz - lambda
    ]);
    const c = new Float64Array(9);
    rowCross(m, 0, 1, c, 0);
    rowCross(m, 0, 2, c, 3);
    rowCross(m, 1, 2, c, 6);

    let best = 0;
    let bestLen = -1;
    for (let k = 0; k < 3; k++) {
        const len = c[k * 3] ** 2 + c[k * 3 + 1] ** 2 + c[k * 3 + 2] ** 2;
        if (len > bestLen) {
            bestLen = len;
            best = k;
        }
    }

    if (bestLen > 0) {
        const inv = 1 / Math.sqrt(bestLen);
        out[o] = c[best * 3] * inv;
        out[o + 1] = c[best * 3 + 1] * inv;
        out[o + 2] = c[best * 3 + 2] * inv;
    }
    return bestLen;
};

// write into column `dst` a unit vector orthogonal to column `src`
const orthogonal = (m: Float64Array, src: number, dst: number) => {
    const x = m[src], y = m[3 + src], z = m[6 + src];
    // cross with the axis least aligned with the source
    let ox: number, oy: number, oz: number;
    if (Math.abs(x) <= Math.abs(y) && Math.abs(x) <= Math.abs(z)) {
        ox = 0; oy = -z; oz = y;
    } else if (Math.abs(y) <= Math.abs(z)) {
        ox = z; oy = 0; oz = -x;
    } else {
        ox = -y; oy = x; oz = 0;
    }
    const inv = 1 / Math.sqrt(ox * ox + oy * oy + oz * oz);
    m[dst] = ox * inv;
    m[3 + dst] = oy * inv;
    m[6 + dst] = oz * inv;
};

/**
 * Decompose the symmetric matrix given by its six unique entries.
 */
const eigenSymmetric3 = (
    xx: number, xy: number, xz: number, yy: number, yz: number, zz: number
): EigenResult => {
    const identity = () => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // scale-normalise
    const mag = Math.max(Math.abs(xx), Math.abs(xy), Math.abs(xz), Math.abs(yy), Math.abs(yz), Math.abs(zz));
    if (!(mag > 0) || !Number.isFinite(mag)) {
        return { values: [0, 0, 0], vectors: identity() };
    }
    const s = 1 / mag;
    xx *= s; xy *= s; xz *= s; yy *= s; yz *= s; zz *= s;

    const offSq = xy * xy + xz * xz + yz * yz;
    let l0: number, l1: number, l2: number;
    if (offSq < 1e-28) {
        // effectively diagonal
        l0 = xx; l1 = yy; l2 = zz;
    } else {
        const q = (xx + yy + zz) / 3;
        const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * offSq;
        const p = Math.sqrt(p2 / 6);
        // r = det((A - qI) / p) / 2, clamped for acos
        const b00 = (xx - q) / p, b11 = (yy - q) / p, b22 = (zz - q) / p;
        const b01 = xy / p, b02 = xz / p, b12 = yz / p;
        const det = b00 * (b11 * b22 - b12 * b12) -
                    b01 * (b01 * b22 - b12 * b02) +
                    b02 * (b01 * b12 - b11 * b02);
        const r = Math.min(1, Math.max(-1, det / 2));
        const phi = Math.acos(r) / 3;
        l0 = q + 2 * p * Math.cos(phi);
        l2 = q + 2 * p * Math.cos(phi + 2 * TWO_PI_3);
        l1 = 3 * q - l0 - l2;
    }

    // sort descending
    let v: number;
    if (l0 < l1) {
        v = l0; l0 = l1; l1 = v;
    }
    if (l1 < l2) {
        v = l1; l1 = l2; l2 = v;
    }
    if (l0 < l1) {
        v = l0; l0 = l1; l1 = v;
    }

    const vectors = identity();
    const spread = Math.max(Math.abs(l0), Math.abs(l2));
    const distinct01 = Math.abs(l0 - l1) > 1e-9 * Math.max(spread, 1e-30);
    const distinct12 = Math.abs(l1 - l2) > 1e-9 * Math.max(spread, 1e-30);

    if (distinct01 || distinct12) {
        const tmp = new Float64Array(3);
        if (distinct01) {
            // l0 is separated: solve for it, then for l2, complete with a cross
            eigenvector(xx, xy, xz, yy, yz, zz, l0, tmp, 0);
            vectors[0] = tmp[0]; vectors[3] = tmp[1]; vectors[6] = tmp[2];
            const ok = eigenvector(xx, xy, xz, yy, yz, zz, l2, tmp, 0);
            if (ok > 0) {
                vectors[2] = tmp[0]; vectors[5] = tmp[1]; vectors[8] = tmp[2];
            } else {
                // l1 == l2: any direction orthogonal to v0 works
                orthogonal(vectors, 0, 2);
            }
            // v1 = v2 x v0 keeps the basis right-handed
            vectors[1] = vectors[5] * vectors[6] - vectors[8] * vectors[3];
            vectors[4] = vectors[8] * vectors[0] - vectors[2] * vectors[6];
            vectors[7] = vectors[2] * vectors[3] - vectors[5] * vectors[0];
        } else {
            // l0 == l1, l2 separated
            eigenvector(xx, xy, xz, yy, yz, zz, l2, tmp, 0);
            vectors[2] = tmp[0]; vectors[5] = tmp[1]; vectors[8] = tmp[2];
            orthogonal(vectors, 2, 0);
            vectors[1] = vectors[5] * vectors[6] - vectors[8] * vectors[3];
            vectors[4] = vectors[8] * vectors[0] - vectors[2] * vectors[6];
            vectors[7] = vectors[2] * vectors[3] - vectors[5] * vectors[0];
        }
    }
    // fully isotropic: identity stands

    return { values: [l0 * mag, l1 * mag, l2 * mag], vectors };
};

/**
 * Rotation matrix (row-major, columns = basis vectors) to quaternion, wxyz.
 * Flips the third column first if the basis is left-handed.
 */
const rotationToQuat = (m: Float64Array, out: Float32Array, o: number) => {
    // determinant; a reflection becomes a rotation by negating one column
    const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (det < 0) {
        m[2] = -m[2]; m[5] = -m[5]; m[8] = -m[8];
    }

    // Shepperd's method, largest-pivot branch
    const t = m[0] + m[4] + m[8];
    let w: number, x: number, y: number, z: number;
    if (t > 0) {
        const s = Math.sqrt(t + 1) * 2;
        w = 0.25 * s;
        x = (m[7] - m[5]) / s;
        y = (m[2] - m[6]) / s;
        z = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        w = (m[7] - m[5]) / s;
        x = 0.25 * s;
        y = (m[1] + m[3]) / s;
        z = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
        const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
        w = (m[2] - m[6]) / s;
        x = (m[1] + m[3]) / s;
        y = 0.25 * s;
        z = (m[5] + m[7]) / s;
    } else {
        const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
        w = (m[3] - m[1]) / s;
        x = (m[2] + m[6]) / s;
        y = (m[5] + m[7]) / s;
        z = 0.25 * s;
    }

    out[o] = w;
    out[o + 1] = x;
    out[o + 2] = y;
    out[o + 3] = z;
};

export { eigenSymmetric3, rotationToQuat, type EigenResult };
