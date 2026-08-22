const vertexShader = /* glsl */ `
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    uniform sampler2D splatState;
    uniform highp usampler2D splatPosition;
    uniform highp usampler2D splatTransform;        // per-splat index into transform palette
    uniform sampler2D transformPalette;             // palette of transform matrices
    uniform sampler2D splatColor;                   // Gaussian color texture (RGBA16F)

    // SH textures (for uncompressed format)
    #if SH_BANDS > 0
    uniform highp usampler2D splatSH_1to3;
    #if SH_BANDS > 1
    uniform highp usampler2D splatSH_4to7;
    uniform highp usampler2D splatSH_8to11;
    #if SH_BANDS > 2
    uniform highp usampler2D splatSH_12to15;
    #endif
    #endif
    #endif

    uniform vec3 view_position;                     // camera position in world space

    uniform uvec2 texParams;

    uniform float splatSize;
    uniform vec2 viewportSize;      // pixels, to size the quad in clip space
    uniform float useGaussianColor;                 // 0.0 = use selection colors, 1.0 = use gaussian color
    uniform vec4 selectedClr;
    uniform vec4 unselectedClr;

    varying vec4 varying_color;

    // calculate the current splat index and uv
    ivec2 calcSplatUV(uint index, uint width) {
        return ivec2(int(index % width), int(index / width));
    }

    #if SH_BANDS > 0

    // include SH evaluation from engine (provides SH_COEFFS, constants, and evalSH)
    #include "gsplatEvalSHVS"

    // unpack signed 11 10 11 bits
    vec3 unpack111011s(uint bits) {
        return vec3((uvec3(bits) >> uvec3(21u, 11u, 0u)) & uvec3(0x7ffu, 0x3ffu, 0x7ffu)) / vec3(2047.0, 1023.0, 2047.0) * 2.0 - 1.0;
    }

    // fetch quantized spherical harmonic coefficients with scale
    void fetchScale(in uvec4 t, out float scale, out vec3 a, out vec3 b, out vec3 c) {
        scale = uintBitsToFloat(t.x);
        a = unpack111011s(t.y);
        b = unpack111011s(t.z);
        c = unpack111011s(t.w);
    }

    // fetch quantized spherical harmonic coefficients
    void fetchSH(in uvec4 t, out vec3 a, out vec3 b, out vec3 c, out vec3 d) {
        a = unpack111011s(t.x);
        b = unpack111011s(t.y);
        c = unpack111011s(t.z);
        d = unpack111011s(t.w);
    }

    void fetchSH1(in uint t, out vec3 a) {
        a = unpack111011s(t);
    }

    #if SH_BANDS == 1
    void readSHData(in ivec2 uv, out vec3 sh[3], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
    }
    #elif SH_BANDS == 2
    void readSHData(in ivec2 uv, out vec3 sh[8], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
        fetchSH(texelFetch(splatSH_4to7, uv, 0), sh[3], sh[4], sh[5], sh[6]);
        fetchSH1(texelFetch(splatSH_8to11, uv, 0).x, sh[7]);
    }
    #elif SH_BANDS == 3
    void readSHData(in ivec2 uv, out vec3 sh[15], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
        fetchSH(texelFetch(splatSH_4to7, uv, 0), sh[3], sh[4], sh[5], sh[6]);
        fetchSH(texelFetch(splatSH_8to11, uv, 0), sh[7], sh[8], sh[9], sh[10]);
        fetchSH(texelFetch(splatSH_12to15, uv, 0), sh[11], sh[12], sh[13], sh[14]);
    }
    #endif

    #endif

    void main(void) {
        // Each centre is a two-triangle quad rather than a point.
        //
        // GL point size does not exist in WGSL - a point is one pixel there
        // and writing gl_PointSize invalidates the shader - so the size has
        // to be geometry. Six vertices per splat, expanded below in clip
        // space, which costs nothing on either backend and gives the same
        // square the old points drew.
        //
        // Splats are order-independent here, so the vertex id addresses them
        // directly: no sort-order lookup, which is also what keeps this
        // working on WebGPU where the order lives in a storage buffer.
        int vertexIndex = gl_VertexID;
        uint splatId = uint(vertexIndex / 6);
        int corner = vertexIndex % 6;

        ivec2 splatUV = calcSplatUV(splatId, texParams.x);
        uint splatState = uint(texelFetch(splatState, splatUV, 0).r * 255.0);

        // cull locked and deleted splats
        if ((splatState & 6u) != 0u) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        } else {
            mat4 model = matrix_model;

            // handle per-splat transform
            uint transformIndex = texelFetch(splatTransform, splatUV, 0).r;
            if (transformIndex > 0u) {
                // read transform matrix
                int u = int(transformIndex % 512u) * 3;
                int v = int(transformIndex / 512u);

                mat4 t;
                t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
                t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
                t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
                t[3] = vec4(0.0, 0.0, 0.0, 1.0);

                model = matrix_model * transpose(t);
            }

            vec3 center = uintBitsToFloat(texelFetch(splatPosition, splatUV, 0).xyz);

            vec3 gaussianClr;

            if (useGaussianColor > 0.0) {
                // get base gaussian color
                gaussianClr = texelFetch(splatColor, splatUV, 0).xyz;

                #if SH_BANDS > 0
                    // calculate world position and view direction
                    vec3 worldPos = (model * vec4(center, 1.0)).xyz;
                    vec3 viewDir = normalize(worldPos - view_position);
                    // transform view direction to model space
                    vec3 modelViewDir = normalize(viewDir * mat3(model));

                    // read and evaluate SH
                    vec3 sh[SH_COEFFS];
                    float scale;
                    readSHData(splatUV, sh, scale);
                    gaussianClr += evalSH(sh, modelViewDir) * scale;
                #endif
            } else {
                gaussianClr = unselectedClr.xyz;
            }

            // choose between selection colors and gaussian color
            varying_color = vec4(mix(gaussianClr, selectedClr.xyz, (splatState == 1u) ? selectedClr.w : 0.0), unselectedClr.w);

            gl_Position = matrix_viewProjection * model * vec4(center, 1.0);

            // disable depth clipping
            gl_Position.z = 0.0;

            // expand to a quad of splatSize pixels. The offset is scaled by
            // w so the perspective divide leaves a constant size on screen.
            vec2 quad = vec2(
                (corner == 0 || corner == 3 || corner == 5) ? -1.0 : 1.0,
                (corner == 0 || corner == 1 || corner == 3) ? -1.0 : 1.0
            );
            gl_Position.xy += quad * splatSize / viewportSize * gl_Position.w;
        }
    }
`;

const fragmentShader = /* glsl */ `
    varying vec4 varying_color;

    void main(void) {
        gl_FragColor = varying_color;
    }
`;

export { vertexShader, fragmentShader };
