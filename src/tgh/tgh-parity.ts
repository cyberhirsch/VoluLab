import { Events } from '../events';
import { TghModel } from './tgh-model';

/**
 * Numerical parity check of the TGH port against the training code.
 *
 * scripts/gen_parity_fixture.py (in the VolumetricVideo repo) builds a small
 * random model with the real Python classes and records what they produce.
 * This loads the same model through the production npz path and compares:
 * active row sets exactly, means and alphas directly, and covariances by
 * rebuilding them from the emitted scale + rotation - which also proves the
 * eigendecomposition round-trips.
 *
 * Run from the browser console:
 *   await scene.events.invoke('tgh.parity', '<base url of fixture files>')
 */

type FixtureCase = {
    t: number;
    indices: number[];
    xyz: number[][];
    cov6: number[][];
    alpha: number[];
    f_dc: number[][];
    f_rest: number[][];
};

const registerTghParityEvents = (events: Events) => {
    events.function('tgh.parity', async (baseUrl: string = '') => {
        const model = await TghModel.fromNpz(await (await fetch(`${baseUrl}/fixture.npz`)).blob());
        const fixture = await (await fetch(`${baseUrl}/fixture.json`)).json();

        const report: any = { count: model.numSplats, cases: [] };

        for (const c of fixture.cases as FixtureCase[]) {
            const M = c.indices.length;
            const idx = model.activeIndices(c.t);
            const indicesMatch = idx.length === M && c.indices.every((v, i) => idx[i] === v);

            const frame = model.evalFrame(c.t);
            const p = (name: string) => frame.props.get(name);

            let xyzErr = 0;
            let covErr = 0;
            let alphaErr = 0;
            let shErr = 0;

            for (let i = 0; i < M; i++) {
                xyzErr = Math.max(xyzErr,
                    Math.abs(p('x')[i] - c.xyz[i][0]),
                    Math.abs(p('y')[i] - c.xyz[i][1]),
                    Math.abs(p('z')[i] - c.xyz[i][2]));

                // rebuild covariance from log-scale + quaternion:
                // C = R diag(exp(2 s)) R^T
                const w = p('rot_0')[i], x = p('rot_1')[i], y = p('rot_2')[i], z = p('rot_3')[i];
                const r = [
                    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
                    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
                    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
                ];
                const e = [
                    Math.exp(2 * p('scale_0')[i]),
                    Math.exp(2 * p('scale_1')[i]),
                    Math.exp(2 * p('scale_2')[i])
                ];
                const cov = (a: number, b: number) => {
                    return r[a * 3] * e[0] * r[b * 3] +
                           r[a * 3 + 1] * e[1] * r[b * 3 + 1] +
                           r[a * 3 + 2] * e[2] * r[b * 3 + 2];
                };
                const packed = [cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2)];
                for (let k = 0; k < 6; k++) {
                    const expect = c.cov6[i][k];
                    const scale = Math.max(Math.abs(expect), 1e-6);
                    covErr = Math.max(covErr, Math.abs(packed[k] - expect) / scale);
                }

                // alpha survives a logit round-trip with the storage clamp
                const alpha = 1 / (1 + Math.exp(-p('opacity')[i]));
                const expectAlpha = Math.min(1 - 1e-6, Math.max(1e-6, c.alpha[i]));
                alphaErr = Math.max(alphaErr, Math.abs(alpha - expectAlpha));

                for (let k = 0; k < 3; k++) {
                    shErr = Math.max(shErr, Math.abs(p(`f_dc_${k}`)[i] - c.f_dc[i][k]));
                }
                for (let k = 0; k < 45; k++) {
                    shErr = Math.max(shErr, Math.abs(p(`f_rest_${k}`)[i] - c.f_rest[i][k]));
                }
            }

            report.cases.push({
                t: c.t,
                active: `${idx.length}/${M}`,
                indicesMatch,
                xyzErr,
                covRelErr: covErr,
                alphaErr,
                shErr
            });
        }

        report.pass = report.cases.every((c: any) => {
            return c.indicesMatch && c.xyzErr < 1e-4 && c.covRelErr < 1e-3 && c.alphaErr < 1e-5 && c.shErr < 1e-6;
        });
        return report;
    });
};

export { registerTghParityEvents };
