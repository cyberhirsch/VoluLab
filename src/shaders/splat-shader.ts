import { debugColorsGLSL, debugColorsWGSL } from '../splat-debug';

const gsplatModify = /* glsl*/`
// The camera node's depth of field.
//
// Defocus is not a screen blur here: a gaussian seen out of focus is a
// gaussian convolved with the lens point-spread function, which is just a
// wider gaussian. So the blur is applied by growing each splat, in
// quadrature, by the circle of confusion at its depth - the projection
// then carries it to screen space for free, splats stay correctly sorted,
// and bokeh falls out of the shape rather than being faked on top.
//
// This chunk is included before gsplatCenterVS, which is why the view
// depth is declared here and filled in there.

// x: aperture (scene units), y: focus distance, z: max blur (pixels),
// w: pixels per scene unit at unit depth
uniform vec4 camDof;

// the splat's view depth, written by our gsplatCenterVS override
float camViewDepth = 0.0;

// how much the model (and palette) transform scales the splat, written
// there too: the scale grown below is in model space, the blur in world
float camModelScale = 1.0;

// energy conservation for the defocus, read by the vertex shader: a
// spread-out gaussian must lose the amplitude it gained in area
float camDofAlpha = 1.0;

// how far this splat is into defocus: 0 in focus, approaching 1 when the
// blur circle is all that is left of it. The fragment shader uses it to
// take the falloff from a gaussian toward a disc, because that is the
// difference between a blur and bokeh.
float camDofMix = 0.0;

// Motion blur (motion-nodes.ts): how far the gaussian travels while the
// shutter is open, in model space, written by the vertex shader of a 4D
// model; zero for none. The gaussian is stretched along it, and loses the
// amplitude it gains in area.
vec3 motionBlurStep = vec3(0.0);
float motionBlurAlpha = 1.0;

void modifySplatCenter(inout vec3 center) {
}

// Relighting: the gaussian's flat axis, in its own space. The relighter
// lights both sides of it and the forward pass keeps the side facing the
// camera - see relight-shaders.ts. Taken here because this is where the
// rotation and scale are to hand, and before the depth of field widens the
// scale. Same axis and tie-break as flatAxis() in the lighting kernel.
#ifdef SPLAT_LIGHTING
    vec3 splatLightAxis = vec3(0.0, 0.0, 1.0);

    vec3 relightFlatAxis(vec4 q, vec3 s) {
        vec3 e = s.x < s.y ? (s.x < s.z ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0))
                           : (s.y < s.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
        // rotate by q = (x, y, z, w)
        vec3 t = 2.0 * cross(q.xyz, e);
        return e + q.w * t + cross(q.xyz, t);
    }
#endif

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    camDofAlpha = 1.0;
    motionBlurAlpha = 1.0;

    #ifdef SPLAT_LIGHTING
        splatLightAxis = relightFlatAxis(rotation, scale);
    #endif

    // the travel, into the gaussian's own axes (by the inverse rotation),
    // added to each axis as the variance of a box of that length: exact
    // along an axis, the nearest axis-aligned shape otherwise
    #ifndef PICK_PASS
        if (dot(motionBlurStep, motionBlurStep) > 0.0) {
            vec3 qv = -rotation.xyz;
            vec3 t = 2.0 * cross(qv, motionBlurStep);
            vec3 d = motionBlurStep + rotation.w * t + cross(qv, t);
            vec3 s2 = scale * scale;
            vec3 n2 = s2 + d * d / 12.0;
            motionBlurAlpha = pow(max(s2.x * s2.y * s2.z, 1e-30) / max(n2.x * n2.y * n2.z, 1e-30), 1.0 / 3.0);
            scale = sqrt(n2);
        }
    #endif

    // picking must stay sharp - a defocused splat would answer for a
    // pixel it only covers because of the blur
    #ifndef PICK_PASS
        float aperture = camDof.x;
        float z = camViewDepth;
        if (aperture > 0.0 && z > 1e-4) {
            float focus = max(camDof.y, 1e-4);

            // thin lens: the blur circle of a point at depth z, measured
            // back at its own depth, has this radius
            float sigma = 0.5 * aperture * abs(z - focus) / focus;

            // the pixel clamp, carried to a world radius at this depth
            float maxSigma = camDof.z * z / max(camDof.w, 1e-4);
            sigma = min(sigma, maxSigma) / max(camModelScale, 1e-6);

            if (sigma > 0.0) {
                vec3 s = scale;
                float hi = max(s.x, max(s.y, s.z));
                float lo = min(s.x, min(s.y, s.z));
                float mid = s.x + s.y + s.z - hi - lo;

                float sg2 = sigma * sigma;
                scale = sqrt(s * s + vec3(sg2));

                // the two dominant axes carry the footprint, so they set
                // how much amplitude the spread costs
                camDofAlpha = (hi * mid) / sqrt((hi * hi + sg2) * (mid * mid + sg2));

                // the blur circle against the splat's own footprint
                float own = sqrt(max(hi * mid, 1e-12));
                camDofMix = clamp(sigma / (sigma + own), 0.0, 1.0);

                // a flat disc carries far more light than a gaussian of the
                // same radius, so hand back what the shape is about to gain
                camDofAlpha *= mix(1.0, 0.26, camDofMix);
            }
        }
    #endif
}

void modifySplatColor(vec3 center, inout vec4 color) {
}
`;

const vertexShader = /* glsl*/`
#include "gsplatCommonVS"

uniform sampler2D splatState;

uniform float camExposure;      // camera node exposure, linear (2^EV)

uniform vec4 selectedClr;
uniform vec4 lockedClr;

uniform mat3 clrMatrix;     // tint, temperature, levels and saturation, folded
uniform vec3 clrOffset;
uniform float clrAlpha;

// a fog node's fog (fog.ts): x mode (0 off, 1 depth, 2 height), y start,
// z end, w amount; the colour; the plane giving a model-space point its
// world height
uniform vec4 fogParams;
uniform vec3 fogColor;
uniform vec4 fogPlane;

uniform highp usampler2D splatGrade;    // per-gaussian index into the grade palette
uniform sampler2D gradePalette;         // palette of colour grades

#ifdef SPLAT_LIGHTING
    // relit light, one texture per side of each gaussian's flat axis
    uniform sampler2D splatLightPlus;
    uniform sampler2D splatLightMinus;
#endif

// A 4D gaussian played on the GPU (TGH motion form): conditioned on time it
// is the stored 3D gaussian moved along its velocity and faded by its
// temporal falloff. Everything else about it is constant.
#ifdef SPLAT_MOTION
    uniform highp sampler2D splatMotion;    // xyz: velocity per unit time, w: temporal centre
    uniform highp sampler2D splatFalloff;   // r: 1 / (2 sigma_t^2)
    uniform float motionTime;               // normalised time being shown
    uniform float motionScale;              // motion scale nodes: 1 as trained
    uniform float motionShutter;            // motion blur nodes: shutter open, in normalised time
#endif

// The debug view: this object is drawn false-coloured by one channel of its
// data (splat-debug.ts). debugMode names the channel, so switching between
// the ones worked out here is a uniform and nothing else.
#ifdef SPLAT_DEBUG
    uniform int debugMode;
    uniform vec2 debugParams;               // x: where the ramp starts, y: 1 / its length
    #ifdef SPLAT_DEBUG_TEX
        uniform sampler2D splatDebug;       // r: the channel per gaussian, where only the CPU knows it
    #endif
    ${debugColorsGLSL}
#endif

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
varying mediump float defocus;                  // 0 sharp, ->1 fully out of focus

#if PICK_PASS
    uniform uint pickOp;                        // 0: add, 1: remove, 2: set
    uniform int pickMode;                       // 0: pick id, 1: depth estimation, 2: render pass data, 3: selection matte
    #ifdef SPLAT_MOTION
        uniform float passMotionStep;           // normalised model time one timeline frame on (render passes)
    #endif
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
    // a holdout (holdout.ts): drawn to depth only, by a pass of its own
    uint holdoutState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 8u;

    #if PICK_PASS
        // a holdout is not content: it is not picked, and the passes drawn
        // with picking (depth, velocity, matte) leave it out as they would
        // a deleted gaussian. Those passes keep no depth, so what a holdout
        // hides in colour still shows in them
        if (holdoutState != 0u) {
            gl_Position = discardVec;
            return;
        }
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
        // the holdout pass draws the holdouts alone, every other pass all but them
        #ifdef SPLAT_HOLDOUT_DEPTH
            if (holdoutState == 0u) {
                gl_Position = discardVec;
                return;
            }
        #else
            if (holdoutState != 0u) {
                gl_Position = discardVec;
                return;
            }
        #endif
    #endif

    // get center
    vec3 modelCenter = getCenter();

    #ifdef SPLAT_MOTION
        vec4 motion = texelFetch(splatMotion, splat.uv, 0);
        float motionDt = motionTime - motion.w;
        modelCenter += motion.xyz * (motionDt * motionScale);
        motionBlurStep = motion.xyz * (motionScale * motionShutter);
        float motionFalloff = texelFetch(splatFalloff, splat.uv, 0).r;
        float motionAlpha = exp(-motionDt * motionDt * motionFalloff);
        if (motionAlpha < 1.0 / 255.0) {
            gl_Position = discardVec;
            return;
        }
    #else
        float motionAlpha = 1.0;
    #endif

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

    // hand the defocus to the fragment shader, which is where the shape
    // of an out-of-focus point is actually decided
    defocus = camDofMix;

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
            color = vec4(normalizedDepth, 0.0, 0.0, 1.0) * clr.a * motionAlpha;
        } else if (pickMode == 2) {
            // render passes: view depth in scene units, and how far the
            // centre moves on screen by the next frame, in NDC (render-passes.ts)
            vec2 passVelocity = vec2(0.0);
            #ifdef SPLAT_MOTION
                SplatCenter passNext;
                passNext.modelCenterOriginal = modelCenter;
                passNext.modelCenterModified = modelCenter;
                if (initCenter(modelCenter + motion.xyz * passMotionStep, passNext)) {
                    passVelocity = passNext.proj.xy / passNext.proj.w - center.proj.xy / center.proj.w;
                }
            #endif
            vec4 clr = getColor();
            color = vec4(-center.view.z, passVelocity, 1.0) * clr.a * motionAlpha;
        } else if (pickMode == 3) {
            // render passes: the selection matte
            vec4 clr = getColor();
            color = vec4((vertexState & 1u) != 0u ? 1.0 : 0.0, 0.0, 0.0, 1.0) * clr.a * motionAlpha;
        } else {
            // pick id
            uvec4 bits = (uvec4(splat.index) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
            color = vec4(bits) / 255.0;
        }
    // handle splat color
    #elif FORWARD_PASS
        // read color
        color = getColor();

        #ifdef SPLAT_DEBUG
            float debugOpacity = color.a;
        #endif

        // a defocused gaussian covers more screen, so it must be fainter
        color.a *= camDofAlpha * motionAlpha * motionBlurAlpha;

        // The debug view takes the colour's place, and from there on it is
        // the object's colour: alpha and shape stay, there is no view
        // dependence, and what comes after a colour - the grades and the
        // camera's exposure - comes after this one too. The grades are the
        // ones put on since the debug view node: the node set the object's
        // colour chain back to nothing when it applied (Splat.addDebugView).
        // Relit light stays off it, since the relighter works from the
        // object's own colour.
        #ifdef SPLAT_DEBUG
            #ifdef SPLAT_DEBUG_TEX
                float debugValue = texelFetch(splatDebug, splat.uv, 0).r;
            #else
                float debugValue = 0.0;
            #endif
            #ifdef SPLAT_MOTION
                color.xyz = debugColor(debugMode, debugParams, debugValue, debugOpacity, motion, motionFalloff, motionAlpha);
            #else
                color.xyz = debugColor(debugMode, debugParams, debugValue, debugOpacity, vec4(0.0), 0.0, 1.0);
            #endif
            color = applyGrade(color);
            color.xyz *= camExposure;
        #else

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

        // relit light lands after the grade and before exposure: the grades
        // correct the capture, the light lights the corrected capture, and
        // the camera exposes the result. Of the two sides the relighter lit,
        // the one facing the camera is the one being seen.
        #ifdef SPLAT_LIGHTING
        {
            vec3 viewDir = center.view * mat3(center.modelView);
            vec3 lit = dot(splatLightAxis, viewDir) <= 0.0
                ? texelFetch(splatLightPlus, splat.uv, 0).rgb
                : texelFetch(splatLightMinus, splat.uv, 0).rgb;
            color.xyz *= lit;
        }
        #endif

        // fog sits on the lit colour, before exposure: it is light in the
        // scene between the camera and the gaussian
        if (fogParams.x > 0.5) {
            float fogAt = fogParams.x < 1.5 ? -center.view.z : dot(fogPlane.xyz, modelCenter) + fogPlane.w;
            float fogMix = smoothstep(fogParams.y, fogParams.z, fogAt);
            if (fogParams.x > 1.5) fogMix = 1.0 - fogMix;
            color.xyz = mix(color.xyz, fogColor, fogMix * fogParams.w);
        }

        // camera exposure is the last thing before the sensor, so it lands
        // on scene-referred colour - after the object's grade, before the
        // tonemap. Doing it in a post pass instead would be a brightness
        // slider on already-tonemapped pixels, which is a different (and
        // worse) thing entirely.
        color.xyz *= camExposure;

        // (the debug view has had its grade and exposure already)
        #endif

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
varying mediump float defocus;

uniform bool outlineMode;
uniform float ringSize;

#if PICK_PASS
    uniform int pickMode;           // 0: id, 1: depth estimation, 2-3: render passes
#endif

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

/**
 * The shape of a defocused point.
 *
 * A lens images an out-of-focus point as its aperture - a disc with an
 * edge - not as a gaussian. Widening the gaussian alone therefore gives a
 * blur, however physically the widening was derived; the bokeh only
 * appears once the falloff itself flattens out and gains a rim. So the
 * profile is crossfaded from gaussian to disc as the blur circle takes
 * over the splat, which also keeps splats near focus from developing
 * hard edges they should not have.
 */
float dofFalloff(float A, float mix01) {
    float g = normExp(A);
    if (mix01 <= 0.0) {
        return g;
    }
    // flat across the circle, soft only at the very rim to stay anti-aliased
    float r = sqrt(A);
    float disc = 1.0 - smoothstep(0.82, 1.0, r);
    return mix(g, disc, mix01);
}

void main(void) {
    mediump float A = dot(texCoord_flags.xy, texCoord_flags.xy);

    if (A > 1.0) {
        discard;
    }

    #if PICK_PASS
        if (pickMode >= 1) {
            // depth estimation, and the render passes' data
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
        mediump float norm = dofFalloff(A, defocus);
        mediump float alpha = norm * color.a;

        #ifdef SPLAT_HOLDOUT_DEPTH
            // depth only, where the gaussian is solid enough to hide what is behind
            if (alpha < 0.3) {
                discard;
            }
            pcFragColor0 = vec4(0.0);
            pcFragColor1 = vec4(0.0);
            return;
        #endif

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

    // hand the depth to the depth of field, which is asked for it later
    // (initCorner) but declared earlier (gsplatModifyVS)
    camViewDepth = -centerView.z / max(centerView.w, 1e-6);
    camModelScale = pow(abs(determinant(mat3(modelView))), 1.0 / 3.0);

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

const gsplatModifyWGSL = /* wgsl */`
// The camera node's depth of field - see the GLSL twin above for why the
// blur is a widening of the gaussian rather than a screen-space pass.

// x: aperture (scene units), y: focus distance, z: max blur (pixels),
// w: pixels per scene unit at unit depth
uniform camDof: vec4f;

// the splat's view depth, written by our gsplatCenterVS override
var<private> camViewDepth: f32 = 0.0;

// how much the model (and palette) transform scales the splat - see the
// GLSL twin
var<private> camModelScale: f32 = 1.0;

// energy conservation for the defocus, read by the vertex shader
var<private> camDofAlpha: f32 = 1.0;

// 0 in focus, approaching 1 when only the blur circle is left - see the
// GLSL twin for why the falloff has to change shape, not just width
var<private> camDofMix: f32 = 0.0;

// motion blur - see the GLSL twin
var<private> motionBlurStep: vec3f = vec3f(0.0);
var<private> motionBlurAlpha: f32 = 1.0;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

// Relighting: the gaussian's flat axis - see the GLSL twin.
#ifdef SPLAT_LIGHTING
    var<private> splatLightAxis: vec3f = vec3f(0.0, 0.0, 1.0);

    fn relightFlatAxis(q: vec4f, s: vec3f) -> vec3f {
        var e = vec3f(0.0, 0.0, 1.0);
        if (s.x < s.y) {
            if (s.x < s.z) {
                e = vec3f(1.0, 0.0, 0.0);
            }
        } else if (s.y < s.z) {
            e = vec3f(0.0, 1.0, 0.0);
        }
        // rotate by q = (x, y, z, w)
        let t = 2.0 * cross(q.xyz, e);
        return e + q.w * t + cross(q.xyz, t);
    }
#endif

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    camDofAlpha = 1.0;
    motionBlurAlpha = 1.0;

    #ifdef SPLAT_LIGHTING
        splatLightAxis = relightFlatAxis(*rotation, *scale);
    #endif

    // the travel while the shutter is open - see the GLSL twin
    #ifndef PICK_PASS
        if (dot(motionBlurStep, motionBlurStep) > 0.0) {
            let q = *rotation;
            let qv = -q.xyz;
            let t = 2.0 * cross(qv, motionBlurStep);
            let d = motionBlurStep + q.w * t + cross(qv, t);
            let s = *scale;
            let s2 = s * s;
            let n2 = s2 + d * d / 12.0;
            motionBlurAlpha = pow(max(s2.x * s2.y * s2.z, 1e-30) / max(n2.x * n2.y * n2.z, 1e-30), 1.0 / 3.0);
            *scale = sqrt(n2);
        }
    #endif

    // picking must stay sharp
    #ifndef PICK_PASS
        let aperture = uniform.camDof.x;
        let z = camViewDepth;
        if (aperture > 0.0 && z > 1e-4) {
            let focus = max(uniform.camDof.y, 1e-4);
            var sigma = 0.5 * aperture * abs(z - focus) / focus;
            let maxSigma = uniform.camDof.z * z / max(uniform.camDof.w, 1e-4);
            sigma = min(sigma, maxSigma) / max(camModelScale, 1e-6);

            if (sigma > 0.0) {
                let s = *scale;
                let hi = max(s.x, max(s.y, s.z));
                let lo = min(s.x, min(s.y, s.z));
                let mid = s.x + s.y + s.z - hi - lo;

                let sg2 = sigma * sigma;
                *scale = sqrt(s * s + vec3f(sg2));

                camDofAlpha = (hi * mid) / sqrt((hi * hi + sg2) * (mid * mid + sg2));

                // the blur circle against the splat's own footprint
                let own = sqrt(max(hi * mid, 1e-12));
                camDofMix = clamp(sigma / (sigma + own), 0.0, 1.0);

                // a flat disc carries far more light than a gaussian of
                // the same radius, so hand back what the shape gains
                camDofAlpha = camDofAlpha * mix(1.0, 0.26, camDofMix);
            }
        }
    #endif
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
}
`;

const vertexShaderWGSL = /* wgsl */`
#include "gsplatCommonVS"

var splatState: texture_2d<f32>;

uniform camExposure: f32;       // camera node exposure, linear (2^EV)

uniform selectedClr: vec4f;
uniform lockedClr: vec4f;

uniform clrMatrix: mat3x3f;     // tint, temperature, levels and saturation, folded
uniform clrOffset: vec3f;
uniform clrAlpha: f32;

// a fog node's fog - see the GLSL twin
uniform fogParams: vec4f;
uniform fogColor: vec3f;
uniform fogPlane: vec4f;

var splatGrade: texture_2d<u32>;    // per-gaussian index into the grade palette
var gradePalette: texture_2d<f32>;  // palette of colour grades

#ifdef SPLAT_LIGHTING
    // relit light, one texture per side of each gaussian's flat axis
    var splatLightPlus: texture_2d<f32>;
    var splatLightMinus: texture_2d<f32>;
#endif

// a 4D gaussian played on the GPU - see the GLSL twin
#ifdef SPLAT_MOTION
    var splatMotion: texture_2d<f32>;   // xyz: velocity per unit time, w: temporal centre
    var splatFalloff: texture_2d<f32>;  // r: 1 / (2 sigma_t^2)
    uniform motionTime: f32;            // normalised time being shown
    uniform motionScale: f32;           // motion scale nodes: 1 as trained
    uniform motionShutter: f32;         // motion blur nodes: shutter open, in normalised time
#endif

// the debug view - see the GLSL twin
#ifdef SPLAT_DEBUG
    uniform debugMode: i32;
    uniform debugParams: vec2f;         // x: where the ramp starts, y: 1 / its length
    #ifdef SPLAT_DEBUG_TEX
        var splatDebug: texture_2d<f32>;    // r: the channel per gaussian, where only the CPU knows it
    #endif
    ${debugColorsWGSL}
#endif

varying vTexCoordFlags: vec4f;      // xy: texCoord, z: selected, w: locked
varying vColor: vec4f;
varying vDefocus: f32;              // 0 sharp, ->1 fully out of focus

#ifdef PICK_PASS
    uniform pickOp: u32;            // 0: add, 1: remove, 2: set
    uniform pickMode: i32;          // 0: pick id, 1: depth estimation, 2: render pass data, 3: selection matte
    #ifdef SPLAT_MOTION
        uniform passMotionStep: f32;    // normalised model time one timeline frame on (render passes)
    #endif
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
    // a holdout (holdout.ts): drawn to depth only, by a pass of its own
    let holdoutState: u32 = u32(textureLoad(splatState, splat.uv, 0).r * 255.0 + 0.5) & 8u;

    #ifdef PICK_PASS
        // a holdout is not content: it is not picked, and the passes drawn
        // with picking (depth, velocity, matte) leave it out as they would
        // a deleted gaussian. Those passes keep no depth, so what a holdout
        // hides in colour still shows in them
        if (holdoutState != 0u) {
            output.position = discardVec;
            return output;
        }
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
        // the holdout pass draws the holdouts alone, every other pass all but them
        #ifdef SPLAT_HOLDOUT_DEPTH
            if (holdoutState == 0u) {
                output.position = discardVec;
                return output;
            }
        #else
            if (holdoutState != 0u) {
                output.position = discardVec;
                return output;
            }
        #endif
    #endif

    var modelCenter: vec3f = getCenter();

    var motionAlpha: f32 = 1.0;
    #ifdef SPLAT_MOTION
        let motion: vec4f = textureLoad(splatMotion, splat.uv, 0);
        let motionDt: f32 = uniform.motionTime - motion.w;
        modelCenter = modelCenter + motion.xyz * (motionDt * uniform.motionScale);
        motionBlurStep = motion.xyz * (uniform.motionScale * uniform.motionShutter);
        let motionFalloff: f32 = textureLoad(splatFalloff, splat.uv, 0).r;
        motionAlpha = exp(-motionDt * motionDt * motionFalloff);
        if (motionAlpha < 1.0 / 255.0) {
            output.position = discardVec;
            return output;
        }
    #endif

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

    // the shape of an out-of-focus point is decided in the fragment shader
    output.vDefocus = camDofMix;

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
            output.vColor = vec4f(normalizedDepth, 0.0, 0.0, 1.0) * clr.a * motionAlpha;
        } else if (uniform.pickMode == 2) {
            // render passes - see the GLSL twin
            var passVelocity: vec2f = vec2f(0.0);
            #ifdef SPLAT_MOTION
                var passNext: SplatCenter;
                passNext.modelCenterOriginal = modelCenter;
                passNext.modelCenterModified = modelCenter;
                if (initCenter(modelCenter + motion.xyz * uniform.passMotionStep, &passNext)) {
                    passVelocity = passNext.proj.xy / passNext.proj.w - center.proj.xy / center.proj.w;
                }
            #endif
            let clr: vec4f = getColor();
            output.vColor = vec4f(-center.view.z, passVelocity, 1.0) * clr.a * motionAlpha;
        } else if (uniform.pickMode == 3) {
            // render passes: the selection matte
            let clr: vec4f = getColor();
            output.vColor = vec4f(select(0.0, 1.0, (vertexState & 1u) != 0u), 0.0, 0.0, 1.0) * clr.a * motionAlpha;
        } else {
            // pick id
            let bits: vec4<u32> = (vec4<u32>(splat.index) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(255u);
            output.vColor = vec4f(bits) / 255.0;
        }
    #else
        var color: vec4f = getColor();

        #ifdef SPLAT_DEBUG
            let debugOpacity: f32 = color.a;
        #endif

        // a defocused gaussian covers more screen, so it must be fainter
        color.a = color.a * camDofAlpha * motionAlpha * motionBlurAlpha;

        // the debug view takes the colour's place, and is graded and
        // exposed as a colour is - see the GLSL twin
        #ifdef SPLAT_DEBUG
            var debugValue: f32 = 0.0;
            #ifdef SPLAT_DEBUG_TEX
                debugValue = textureLoad(splatDebug, splat.uv, 0).r;
            #endif
            #ifdef SPLAT_MOTION
                let debugClr: vec3f = debugColor(uniform.debugMode, uniform.debugParams, debugValue, debugOpacity, motion, motionFalloff, motionAlpha);
            #else
                let debugClr: vec3f = debugColor(uniform.debugMode, uniform.debugParams, debugValue, debugOpacity, vec4f(0.0), 0.0, 1.0);
            #endif
            // then what comes after a colour: the grades, the exposure
            color = applyGrade(vec4f(debugClr, color.a));
            color = vec4f(color.xyz * uniform.camExposure, color.a);
        #else

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

        // relit light: after the grade, before exposure, the side facing
        // the camera - see the GLSL twin
        #ifdef SPLAT_LIGHTING
            let lightView = mat3x3f(center.modelView[0].xyz, center.modelView[1].xyz, center.modelView[2].xyz);
            let viewDir = center.view * lightView;
            var lit: vec3f;
            if (dot(splatLightAxis, viewDir) <= 0.0) {
                lit = textureLoad(splatLightPlus, splat.uv, 0).rgb;
            } else {
                lit = textureLoad(splatLightMinus, splat.uv, 0).rgb;
            }
            color = vec4f(color.xyz * lit, color.a);
        #endif

        // fog: on the lit colour, before exposure - see the GLSL twin
        if (uniform.fogParams.x > 0.5) {
            var fogAt: f32 = -center.view.z;
            if (uniform.fogParams.x > 1.5) {
                fogAt = dot(uniform.fogPlane.xyz, modelCenter) + uniform.fogPlane.w;
            }
            var fogMix: f32 = smoothstep(uniform.fogParams.y, uniform.fogParams.z, fogAt);
            if (uniform.fogParams.x > 1.5) {
                fogMix = 1.0 - fogMix;
            }
            color = vec4f(mix(color.xyz, uniform.fogColor, fogMix * uniform.fogParams.w), color.a);
        }

        // camera exposure: scene-referred, before the tonemap
        color = vec4f(color.xyz * uniform.camExposure, color.a);

        // (the debug view has had its grade and exposure already)
        #endif

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
varying vDefocus: f32;

uniform outlineMode: f32;
uniform ringSize: f32;

#ifdef PICK_PASS
    uniform pickMode: i32;          // 0: id, 1: depth estimation, 2-3: render passes
#endif

const EXP4: f32 = exp(-4.0);
const INV_EXP4: f32 = 1.0 / (1.0 - EXP4);

fn normExp(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

// a lens images an out-of-focus point as its aperture - a disc with an
// edge - so the falloff crossfades from gaussian to disc as the blur
// circle takes the splat over. See the GLSL twin for the reasoning.
fn dofFalloff(A: f32, mix01: f32) -> f32 {
    let g = normExp(A);
    if (mix01 <= 0.0) {
        return g;
    }
    let r = sqrt(A);
    let disc = 1.0 - smoothstep(0.82, 1.0, r);
    return mix(g, disc, mix01);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let A: f32 = dot(vTexCoordFlags.xy, vTexCoordFlags.xy);

    if (A > 1.0) {
        discard;
    }

    #ifdef PICK_PASS
        if (uniform.pickMode >= 1) {
            // depth estimation, and the render passes' data
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
        let norm: f32 = dofFalloff(A, vDefocus);
        var alpha: f32 = norm * vColor.a;

        #ifdef SPLAT_HOLDOUT_DEPTH
            // depth only, where the gaussian is solid enough to hide what is behind
            if (alpha < 0.3) {
                discard;
            }
            output.color = vec4f(0.0);
            output.color1 = vec4f(0.0);
            return output;
        #endif

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

    // hand the depth to the depth of field (declared in gsplatModifyVS,
    // which is included before this chunk but runs after it)
    camViewDepth = -centerView.z / max(centerView.w, 1e-6);
    camModelScale = pow(abs(determinant(mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz))), 1.0 / 3.0);

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

export {
    vertexShader, fragmentShader, gsplatCenter, gsplatModify,
    vertexShaderWGSL, fragmentShaderWGSL, gsplatCenterWGSL, gsplatModifyWGSL
};
