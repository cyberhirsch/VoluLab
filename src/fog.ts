/**
 * A fog / depth tint node's settings, which an object holds while the node
 * is applied (Splat.fog) and the splat shader reads as three uniforms.
 *
 * The colour goes towards `colour` by how far a gaussian is from the camera
 * (depth) or how low it is in the world (height): none before `start`, the
 * full `amount` past `end`, smoothly between. For height, `start` is the
 * height the fog is full below and `end` the one it is gone above.
 */
type FogMode = 'depth' | 'height';

type FogSettings = {
    mode: FogMode;
    /** linear RGB the colour blends towards */
    colour: [number, number, number];
    /** the most the colour is blended, 0..1 */
    amount: number;
    start: number;
    end: number;
};

const normalizeFog = (s: Partial<FogSettings>): FogSettings => {
    const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
    const colour = Array.isArray(s.colour) && s.colour.length === 3 ? s.colour.map(c => Math.max(0, num(c, 0.7))) as [number, number, number] : [0.7, 0.75, 0.8] as [number, number, number];
    const start = num(s.start, 0);
    return {
        mode: s.mode === 'height' ? 'height' : 'depth',
        colour,
        amount: Math.min(1, Math.max(0, num(s.amount, 0.6))),
        start,
        end: Math.max(start + 1e-4, num(s.end, start + 10))
    };
};

/**
 * The uniforms for an object's fog: [mode (0 off, 1 depth, 2 height),
 * start, end, amount], the colour, and the plane that gives a model-space
 * centre its world height (the second row of the world matrix).
 */
const fogUniforms = (fog: FogSettings | null, world: ArrayLike<number>) => {
    if (!fog) return { params: [0, 0, 1, 0], colour: [0, 0, 0], plane: [0, 1, 0, 0] };
    return {
        params: [fog.mode === 'height' ? 2 : 1, fog.start, Math.max(fog.start + 1e-4, fog.end), fog.amount],
        colour: fog.colour.slice(),
        plane: [world[1], world[5], world[9], world[13]]
    };
};

export { normalizeFog, fogUniforms, type FogMode, type FogSettings };
