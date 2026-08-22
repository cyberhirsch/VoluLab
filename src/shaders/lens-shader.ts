/**
 * The camera node's lens, as a screen-space pass.
 *
 * Radial distortion, lateral chromatic aberration and vignetting - the
 * three things a lens does to an image after the scene has been drawn.
 * Exposure and depth of field are *not* here: both belong to the
 * gaussians themselves (exposure has to happen before tonemapping, and
 * defocus is a widening of each gaussian, not a screen blur), so they
 * live in the splat shader.
 *
 * The pass reads a copy of the frame and writes back into it, upstream of
 * the gizmo pass - so the scene warps but the handles you click do not,
 * and the export path, which reads the same buffer, gets the lens too.
 *
 * Colour arrives premultiplied by alpha, so the vignette multiplies all
 * four channels: darkening a premultiplied pixel means taking its
 * coverage down with it, otherwise transparent exports gain dark fringes.
 */

const vertexShader = /* glsl */ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    uniform sampler2D srcTexture;
    uniform vec2 texSize;

    // x: k1, y: k2, z: chromatic aberration, w: vignette amount
    uniform vec4 lensParams;
    // x: vignette softness
    uniform vec4 lensParams2;

    // radial polynomial: the standard Brown-Conrady even terms. Negative
    // k1 barrels (wide-angle), positive pincushions (telephoto).
    vec2 distort(vec2 p, float scale) {
        float r2 = dot(p, p);
        return p * (1.0 + (lensParams.x * r2 + lensParams.y * r2 * r2) * scale);
    }

    // sample in the -1..1 aspect-corrected space, transparent outside the
    // frame so a barrelled image keeps clean edges instead of smearing
    vec4 sampleAt(vec2 p, float aspect) {
        vec2 uv = vec2(p.x / aspect, p.y) * 0.5 + 0.5;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
            return vec4(0.0);
        }
        // texture2DLod, not texture2D, and the reason is subtle: WGSL
        // forbids implicit-derivative sampling in non-uniform control
        // flow, and this call sits after a conditional return. With
        // texture2D the whole shader module is rejected - silently, since
        // the transpile succeeds and only pipeline creation fails - and
        // every draw using it disappears. An explicit LOD needs no
        // derivatives and is legal anywhere; the frame has no mips, so
        // level 0 is what we wanted regardless. GLSL has no such rule,
        // which is why this only ever broke on WebGPU.
        return texture2DLod(srcTexture, uv, 0.0);
    }

    void main(void) {
        float aspect = texSize.x / texSize.y;

        vec2 uv = gl_FragCoord.xy / texSize;
        vec2 p = (uv - 0.5) * 2.0;
        p.x *= aspect;

        float ca = lensParams.z;

        vec4 color;
        if (ca != 0.0) {
            // lateral chromatic aberration: the channels focus at slightly
            // different magnifications, which is why fringing grows toward
            // the corners rather than sitting uniformly across the frame
            vec4 r = sampleAt(distort(p, 1.0 + ca), aspect);
            vec4 g = sampleAt(distort(p, 1.0), aspect);
            vec4 b = sampleAt(distort(p, 1.0 - ca), aspect);
            color = vec4(r.r, g.g, b.b, g.a);
        } else {
            color = sampleAt(distort(p, 1.0), aspect);
        }

        float amount = lensParams.w;
        if (amount > 0.0) {
            // radius normalised so the vignette reaches the frame edge
            // rather than the corner, which is where it reads as a lens
            // rather than as a hole
            float softness = max(lensParams2.x, 1e-3);
            float r = length(p) / max(aspect, 1.0);
            float vig = 1.0 - amount * smoothstep(1.0 - softness, 1.0 + softness, r);
            color *= vig;
        }

        gl_FragColor = color;
    }
`;

export { vertexShader, fragmentShader };
