const vertexShader = /* glsl*/`
#include "gsplatCommonVS"

uniform sampler2D splatState;

uniform vec4 selectedClr;
uniform vec4 lockedClr;

uniform mat3 clrMatrix;     // tint, temperature, levels and saturation, folded
uniform vec3 clrOffset;
uniform float clrAlpha;

uniform highp usampler2D splatGrade;    // per-gaussian index into the grade palette
uniform sampler2D gradePalette;         // palette of colour grades

// Two grades, in order: whatever colour nodes have put on this gaussian, then
// the object's own.
//
// Keeping the object's grade out of the palette is what lets it stay live -
// the panel edits it and every gaussian follows, including ones a node has
// already moved to a slot. Baking it into each slot instead would freeze it at
// the moment the node ran.
//
// Index 0 means no node has touched this gaussian, which is the common case
// and costs one branch and no texture reads.
vec4 applyGrade(vec4 color) {
    uint gradeIndex = texelFetch(splatGrade, splat.uv, 0).r;

    if (gradeIndex != 0u) {
        int u = int(gradeIndex % 512u) * 4;
        int v = int(gradeIndex / 512u);

        vec4 c0 = texelFetch(gradePalette, ivec2(u, v), 0);
        vec4 c1 = texelFetch(gradePalette, ivec2(u + 1, v), 0);
        vec4 c2 = texelFetch(gradePalette, ivec2(u + 2, v), 0);
        float alpha = texelFetch(gradePalette, ivec2(u + 3, v), 0).x;

        mat3 m = mat3(c0.xyz, c1.xyz, c2.xyz);
        color = vec4(m * color.xyz + vec3(c0.w, c1.w, c2.w), color.a * alpha);
    }

    return vec4(clrMatrix * color.xyz + clrOffset, color.a * clrAlpha);
}

varying mediump vec4 texCoord_flags;            // xy: texCoord, z: selected, w: locked
varying mediump vec4 color;

#if PICK_PASS
    uniform uint pickOp;                        // 0: add, 1: remove, 2: set
    uniform int pickMode;                       // 0: pick id, 1: depth estimation
#endif

mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);

void main(void) {
    // read gaussian details
    SplatSource source;
    if (!initSource(source)) {
        gl_Position = discardVec;
        return;
    }

    // get per-gaussian edit state, discard if deleted
    uint vertexState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 7u;

    #if PICK_PASS
        if (pickOp == 0u) {
            // add: skip deleted, locked and selected splats
            if (vertexState != 0u) {
                gl_Position = discardVec;
                return;
            }
        } else if (pickOp == 1u) {
            // remove: skip deleted, locked and unselected splats
            if (vertexState != 1u) {
                gl_Position = discardVec;
                return;
            }
        } else {
            // set: skip deleted and locked splats
            if ((vertexState & 6u) != 0u) {
                gl_Position = discardVec;
                return;
            }
        }
    #else
        // skip deleted splats
        if ((vertexState & 4u) != 0u) {
            gl_Position = discardVec;
            return;
        }
    #endif

    // get center
    vec3 modelCenter = getCenter();

    SplatCenter center;
    center.modelCenterOriginal = modelCenter;
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, center)) {
        gl_Position = discardVec;
        return;
    }

    SplatCorner corner;
    if (!initCorner(source, center, corner)) {
        gl_Position = discardVec;
        return;
    }

    gl_Position = center.proj + vec4(corner.offset, 0.0);

    // store texture coord and locked state
    texCoord_flags = vec4(
        corner.uv,
        (vertexState & 1u) != 0u ? 1.0 : 0.0,       // selected
        (vertexState & 2u) != 0u ? 1.0 : 0.0        // locked
    );

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation mode: compute normalized depth in vertex shader
            float linearDepth = -center.view.z;
            float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
            vec4 clr = getColor();
            color = vec4(normalizedDepth, 0.0, 0.0, 1.0) * clr.a;
        } else {
            // pick id
            uvec4 bits = (uvec4(splat.index) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
            color = vec4(bits) / 255.0;
        }
    // handle splat color
    #elif FORWARD_PASS
        // read color
        color = getColor();

        // evaluate spherical harmonics
        #if SH_BANDS > 0
        // calculate the model-space view direction
            vec3 dir = normalize(center.view * mat3(center.modelView));

            // read sh coefficients
            vec3 sh[SH_COEFFS];
            float scale;
            readSHData(sh, scale);

            // evaluate
            color.xyz += evalSH(sh, dir) * scale;
        #endif

        // the whole grade is one matrix and one translation - saturation is a
        // linear map, so it folds in rather than following on afterwards
        color = applyGrade(color);

        // don't allow out-of-range alpha
        color.a = clamp(color.a, 0.0, 1.0);

        // apply tonemapping
        color = vec4(prepareOutputFromGamma(max(color.xyz, 0.0), -center.view.z), color.w);

        // apply locked/selected colors
        if ((vertexState & 2u) != 0u) {
            // locked
            color *= lockedClr;
        } else if ((vertexState & 1u) != 0u) {
            // selected
            color.xyz = mix(color.xyz, selectedClr.xyz, selectedClr.a);
        }
    #endif
}
`;

const fragmentShader = /* glsl*/`
varying mediump vec4 texCoord_flags;
varying mediump vec4 color;

uniform bool outlineMode;
uniform float ringSize;

#if PICK_PASS
    uniform int pickMode;           // 0: id, 1: depth estimation
#endif

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

void main(void) {
    mediump float A = dot(texCoord_flags.xy, texCoord_flags.xy);

    if (A > 1.0) {
        discard;
    }

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation
            mediump float alpha = normExp(A);
            if (alpha < 1.0 / 255.0) {
                discard;
            }
            // we should multiply by alpha here to take into account gaussian falloff,
            // but it results in less accurate depth for some reason
            gl_FragColor = color * alpha;
        } else {
            // pick id
            gl_FragColor = color;
        }
    #else
        mediump float norm = normExp(A);
        mediump float alpha = norm * color.a;

        if (texCoord_flags.w == 0.0 && ringSize > 0.0) {
            // rings mode
            if (A < 1.0 - ringSize) {
                alpha = max(0.05, alpha);
            } else {
                alpha = 0.6;
            }
        }

        bool selected = texCoord_flags.z != 0.0 && texCoord_flags.w == 0.0;

        if (outlineMode) {
            pcFragColor0 = vec4(color.xyz * alpha, alpha);
            pcFragColor1 = vec4(0.0, 0.0, 0.0, selected ? norm : 0.0);
        } else {
            if (selected) {
                pcFragColor0 = vec4(color.xyz * alpha * 0.8, alpha);
                pcFragColor1 = vec4(color.xyz * alpha * 0.2, alpha);
            } else {
                pcFragColor0 = vec4(color.xyz * alpha, alpha);
                pcFragColor1 = vec4(0.0, 0.0, 0.0, 0.0);
            }
        }
    #endif
}
`;

const gsplatCenter = /* glsl*/`
uniform highp usampler2D splatTransform;        // per-splat index into transform palette
uniform sampler2D transformPalette;             // palette of transform matrices

mat4 applyPaletteTransform(mat4 model) {
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    // read transform matrix
    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform mat4 matrix_model;
uniform mat4 matrix_view;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform vec4 camera_params;             // 1 / far, far, near, isOrtho
    uniform mat4 matrix_projection;
#endif

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, inout SplatCenter center) {
    mat4 modelView = matrix_view * applyPaletteTransform(matrix_model);
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ

        // early out if splat is behind the camera (perspective only)
        // orthographic projections don't need this check as frustum culling handles it
        if (camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        vec4 centerProj = matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        #if WEBGPU
            centerProj.z = clamp(centerProj.z, 0, abs(centerProj.w));
        #else
            centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));
        #endif

        center.proj = centerProj;
        center.projMat00 = matrix_projection[0][0];

    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

// ---------------------------------------------------------------------------
// WGSL twins. The engine composes gsplat materials from WGSL chunks on
// WebGPU and GLSL chunks on WebGL2 - overrides must be provided in both
// dialects or the WebGPU path silently falls back to the defaults (which,
// among other things, write one fragment output where the splat pass's MRT
// expects two, invalidating the whole pipeline).
// ---------------------------------------------------------------------------

const vertexShaderWGSL = /* wgsl */`
#include "gsplatCommonVS"

var splatState: texture_2d<f32>;

uniform selectedClr: vec4f;
uniform lockedClr: vec4f;

uniform clrMatrix: mat3x3f;     // tint, temperature, levels and saturation, folded
uniform clrOffset: vec3f;
uniform clrAlpha: f32;

var splatGrade: texture_2d<u32>;    // per-gaussian index into the grade palette
var gradePalette: texture_2d<f32>;  // palette of colour grades

varying vTexCoordFlags: vec4f;      // xy: texCoord, z: selected, w: locked
varying vColor: vec4f;

#ifdef PICK_PASS
    uniform pickOp: u32;            // 0: add, 1: remove, 2: set
    uniform pickMode: i32;          // 0: pick id, 1: depth estimation
#endif

const discardVec: vec4f = vec4f(0.0, 0.0, 2.0, 1.0);

// two grades in order: node grades from the palette, then the object's own
fn applyGrade(colorIn: vec4f) -> vec4f {
    var color = colorIn;
    let gradeIndex: u32 = textureLoad(splatGrade, splat.uv, 0).r;

    if (gradeIndex != 0u) {
        let u: i32 = i32(gradeIndex % 512u) * 4;
        let v: i32 = i32(gradeIndex / 512u);

        let c0: vec4f = textureLoad(gradePalette, vec2i(u, v), 0);
        let c1: vec4f = textureLoad(gradePalette, vec2i(u + 1, v), 0);
        let c2: vec4f = textureLoad(gradePalette, vec2i(u + 2, v), 0);
        let alpha: f32 = textureLoad(gradePalette, vec2i(u + 3, v), 0).x;

        let m: mat3x3f = mat3x3f(c0.xyz, c1.xyz, c2.xyz);
        color = vec4f(m * color.xyz + vec3f(c0.w, c1.w, c2.w), color.a * alpha);
    }

    return vec4f(uniform.clrMatrix * color.xyz + uniform.clrOffset, color.a * uniform.clrAlpha);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    var source: SplatSource;
    if (!initSource(&source)) {
        output.position = discardVec;
        return output;
    }

    // get per-gaussian edit state, discard if deleted
    let vertexState: u32 = u32(textureLoad(splatState, splat.uv, 0).r * 255.0 + 0.5) & 7u;

    #ifdef PICK_PASS
        if (uniform.pickOp == 0u) {
            // add: skip deleted, locked and selected splats
            if (vertexState != 0u) {
                output.position = discardVec;
                return output;
            }
        } else if (uniform.pickOp == 1u) {
            // remove: skip deleted, locked and unselected splats
            if (vertexState != 1u) {
                output.position = discardVec;
                return output;
            }
        } else {
            // set: skip deleted and locked splats
            if ((vertexState & 6u) != 0u) {
                output.position = discardVec;
                return output;
            }
        }
    #else
        // skip deleted splats
        if ((vertexState & 4u) != 0u) {
            output.position = discardVec;
            return output;
        }
    #endif

    var modelCenter: vec3f = getCenter();

    var center: SplatCenter;
    center.modelCenterOriginal = modelCenter;
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, &center)) {
        output.position = discardVec;
        return output;
    }

    var corner: SplatCorner;
    if (!initCorner(&source, &center, &corner)) {
        output.position = discardVec;
        return output;
    }

    output.position = center.proj + vec4f(corner.offset.xyz, 0.0);

    // store texture coord and selected/locked state
    output.vTexCoordFlags = vec4f(
        vec2f(corner.uv),
        select(0.0, 1.0, (vertexState & 1u) != 0u),
        select(0.0, 1.0, (vertexState & 2u) != 0u)
    );

    #ifdef PICK_PASS
        if (uniform.pickMode == 1) {
            // depth estimation mode: compute normalized depth in vertex shader
            let linearDepth: f32 = -center.view.z;
            let normalizedDepth: f32 = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
            let clr: vec4f = getColor();
            output.vColor = vec4f(normalizedDepth, 0.0, 0.0, 1.0) * clr.a;
        } else {
            // pick id
            let bits: vec4<u32> = (vec4<u32>(splat.index) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(255u);
            output.vColor = vec4f(bits) / 255.0;
        }
    #else
        var color: vec4f = getColor();

        #if SH_BANDS > 0
            let modelView3x3 = mat3x3f(center.modelView[0].xyz, center.modelView[1].xyz, center.modelView[2].xyz);
            let dir = normalize(center.view * modelView3x3);
            var sh: array<half3, SH_COEFFS>;
            var scale: f32;
            readSHData(&sh, &scale);
            color = vec4f(color.xyz + vec3f(evalSH(&sh, dir)) * scale, color.a);
        #endif

        // the whole grade is one matrix and one translation
        color = applyGrade(color);

        color.a = clamp(color.a, 0.0, 1.0);

        // apply tonemapping
        color = vec4f(prepareOutputFromGamma(max(color.xyz, vec3f(0.0)), -center.view.z), color.a);

        // apply locked/selected colors
        if ((vertexState & 2u) != 0u) {
            color = color * uniform.lockedClr;
        } else if ((vertexState & 1u) != 0u) {
            color = vec4f(mix(color.xyz, uniform.selectedClr.xyz, uniform.selectedClr.a), color.a);
        }

        output.vColor = color;
    #endif

    return output;
}
`;

const fragmentShaderWGSL = /* wgsl */`
varying vTexCoordFlags: vec4f;
varying vColor: vec4f;

uniform outlineMode: f32;
uniform ringSize: f32;

#ifdef PICK_PASS
    uniform pickMode: i32;          // 0: id, 1: depth estimation
#endif

const EXP4: f32 = exp(-4.0);
const INV_EXP4: f32 = 1.0 / (1.0 - EXP4);

fn normExp(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let A: f32 = dot(vTexCoordFlags.xy, vTexCoordFlags.xy);

    if (A > 1.0) {
        discard;
    }

    #ifdef PICK_PASS
        if (uniform.pickMode == 1) {
            // depth estimation
            let alpha: f32 = normExp(A);
            if (alpha < 1.0 / 255.0) {
                discard;
            }
            output.color = vColor * alpha;
        } else {
            // pick id
            output.color = vColor;
        }
    #else
        let norm: f32 = normExp(A);
        var alpha: f32 = norm * vColor.a;

        if (vTexCoordFlags.w == 0.0 && uniform.ringSize > 0.0) {
            // rings mode
            if (A < 1.0 - uniform.ringSize) {
                alpha = max(0.05, alpha);
            } else {
                alpha = 0.6;
            }
        }

        let selected: bool = vTexCoordFlags.z != 0.0 && vTexCoordFlags.w == 0.0;

        if (uniform.outlineMode != 0.0) {
            output.color = vec4f(vColor.xyz * alpha, alpha);
            output.color1 = vec4f(0.0, 0.0, 0.0, select(0.0, norm, selected));
        } else {
            if (selected) {
                output.color = vec4f(vColor.xyz * alpha * 0.8, alpha);
                output.color1 = vec4f(vColor.xyz * alpha * 0.2, alpha);
            } else {
                output.color = vec4f(vColor.xyz * alpha, alpha);
                output.color1 = vec4f(0.0, 0.0, 0.0, 0.0);
            }
        }
    #endif

    return output;
}
`;

const gsplatCenterWGSL = /* wgsl */`
var splatTransform: texture_2d<u32>;    // per-splat index into transform palette
var transformPalette: texture_2d<f32>;  // palette of transform matrices

fn applyPaletteTransform(model: mat4x4f) -> mat4x4f {
    let transformIndex: u32 = textureLoad(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    // read transform matrix
    let u: i32 = i32(transformIndex % 512u) * 3;
    let v: i32 = i32(transformIndex / 512u);

    var t: mat4x4f;
    t[0] = textureLoad(transformPalette, vec2i(u, v), 0);
    t[1] = textureLoad(transformPalette, vec2i(u + 1, v), 0);
    t[2] = textureLoad(transformPalette, vec2i(u + 2, v), 0);
    t[3] = vec4f(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform camera_params: vec4f;       // 1 / far, far, near, isOrtho
    uniform matrix_projection: mat4x4f;
#endif

// project the model space gaussian center to view and clip space
fn initCenter(modelCenter: vec3f, center: ptr<function, SplatCenter>) -> bool {
    let modelView: mat4x4f = uniform.matrix_view * applyPaletteTransform(uniform.matrix_model);
    let centerView: vec4f = modelView * vec4f(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ
        // early out if splat is behind the camera (perspective only)
        if (uniform.camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        var centerProj: vec4f = uniform.matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        centerProj.z = clamp(centerProj.z, 0.0, abs(centerProj.w));

        center.proj = centerProj;
        center.projMat00 = uniform.matrix_projection[0][0];
    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

export { vertexShader, fragmentShader, gsplatCenter, vertexShaderWGSL, fragmentShaderWGSL, gsplatCenterWGSL };
