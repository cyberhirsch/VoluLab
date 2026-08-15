const vertexShader = /* glsl*/ `
    uniform vec3 near_origin;
    uniform vec3 near_x;
    uniform vec3 near_y;

    uniform vec3 far_origin;
    uniform vec3 far_x;
    uniform vec3 far_y;

    attribute vec2 vertex_position;

    varying vec3 worldFar;
    varying vec3 worldNear;

    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);

        vec2 p = vertex_position * 0.5 + 0.5;
        worldNear = near_origin + near_x * p.x + near_y * p.y;
        worldFar = far_origin + far_x * p.x + far_y * p.y;
    }
`;

const fragmentShader = /* glsl*/ `
    uniform vec3 view_position;
    uniform mat4 matrix_viewProjection;
    uniform sampler2D blueNoiseTex32;

    uniform int plane;  // 0: x (yz), 1: y (xz), 2: z (xy)

    vec4 planes[3] = vec4[3](
        vec4(1.0, 0.0, 0.0, 0.0),
        vec4(0.0, 1.0, 0.0, 0.0),
        vec4(0.0, 0.0, 1.0, 0.0)
    );

    vec3 colors[3] = vec3[3](
        vec3(1.0, 0.2, 0.2),
        vec3(0.2, 1.0, 0.2),
        vec3(0.2, 0.2, 1.0)
    );

    int axis0[3] = int[3](1, 0, 0);
    int axis1[3] = int[3](2, 2, 1);

    varying vec3 worldNear;
    varying vec3 worldFar;

    bool intersectPlane(inout float t, vec3 pos, vec3 dir, vec4 plane) {
        float d = dot(dir, plane.xyz);
        if (abs(d) < 1e-06) {
            return false;
        }

        float n = -(dot(pos, plane.xyz) + plane.w) / d;
        if (n < 0.0) {
            return false;
        }

        t = n;

        return true;
    }

    // Line thickness, in screen pixels. Constant at every distance.
    const float lineWidthPx = 1.0;

    // The neutral grid lines sit at a fraction of the coloured axes' opacity,
    // so the axes read as the primary structure and the mesh stays quiet.
    const float neutralOpacity = 0.5;

    // UV units covered by one screen pixel, per axis.
    vec2 gridDeriv(in vec2 ddx, in vec2 ddy) {
        return vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
    }

    // Constant screen-space width grid.
    //
    // The usual "pristine grid" (bgolus) keeps a fixed WORLD line width and
    // clamps it up to a one-pixel floor, so lines fatten as the camera
    // approaches. Here the drawn width is pinned to lineWidthPx at every
    // distance and the size difference is paid back in opacity instead.
    //
    // worldWidth is the width the line would have had in world terms. Once
    // that falls below the pixel we actually draw, the line is being rendered
    // wider than it should be, so its alpha is scaled by the shortfall. That
    // coverage term is what produces both the fade into the distance and the
    // brightness hierarchy between the coarse and fine levels - without it
    // every level reads at full strength all the way to the horizon.
    //
    // gridUV runs 0 at a line to 1 at the cell centre, i.e. across half a
    // cell, so one pixel measures 2 * uvDeriv in those units and a total width
    // of lineWidthPx has a half-width of uvDeriv * lineWidthPx.
    float screenGrid(in vec2 uv, in vec2 ddx, in vec2 ddy, float widthPx, vec2 worldWidth) {
        vec2 uvDeriv = gridDeriv(ddx, ddy);

        vec2 drawWidth = uvDeriv * widthPx;

        // one full pixel of transition, half either side of the edge. There is
        // no MSAA on the context, so this smoothstep is the only antialiasing
        // the grid gets - too narrow a ramp and near-horizontal lines at the
        // horizon alias badly.
        vec2 lineAA = uvDeriv;

        vec2 gridUV = 1.0 - abs(fract(uv) * 2.0 - 1.0);
        vec2 grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);

        // pay back the difference between the drawn pixel and the true width
        grid2 *= clamp(worldWidth / drawWidth, 0.0, 1.0);

        return mix(grid2.x, 1.0, grid2.y);
    }

    float calcDepth(vec3 p) {
        vec4 v = matrix_viewProjection * vec4(p, 1.0);
        return (v.z / v.w) * 0.5 + 0.5;
    }

    bool writeDepth(float alpha) {
        vec2 uv = fract(gl_FragCoord.xy / 32.0);
        float noise = texture2DLod(blueNoiseTex32, uv, 0.0).y;
        return alpha > noise;
    }

    void main(void) {
        vec3 p = worldNear;
        vec3 v = normalize(worldFar - worldNear);

        // intersect ray with the world xz plane
        float t;
        if (!intersectPlane(t, p, v, planes[plane])) {
            discard;
        }

        // calculate grid intersection
        vec3 worldPos = p + v * t;
        vec2 pos = plane == 0 ? worldPos.yz : (plane == 1 ? worldPos.xz : worldPos.xy);
        vec2 ddx = dFdx(pos);
        vec2 ddy = dFdy(pos);

        float epsilon = 1.0 / 255.0;

        // calculate fade
        float fade = 1.0 - smoothstep(400.0, 1000.0, length(worldPos - view_position));
        if (fade < epsilon) {
            discard;
        }

        vec2 levelPos;
        float levelSize;
        float levelAlpha;

        // 10m grid with colored main axes
        levelPos = pos * 0.1;
        levelSize = 2.0 / 1000.0;
        levelAlpha = screenGrid(levelPos, ddx * 0.1, ddy * 0.1, lineWidthPx, vec2(levelSize)) * fade;
        if (levelAlpha > epsilon) {
            // the axis highlight has to track the same one-pixel band as the
            // line itself, so its threshold is a pixel measure too - a world
            // constant here would drift off the line with distance
            vec2 axisWidth = gridDeriv(ddx * 0.1, ddy * 0.1) * lineWidthPx;
            vec3 color;
            vec2 loc = abs(levelPos);
            if (loc.x < axisWidth.x) {
                if (loc.y < axisWidth.y) {
                    color = vec3(1.0);
                } else {
                    color = colors[axis1[plane]];
                }
            } else if (loc.y < axisWidth.y) {
                color = colors[axis0[plane]];
            } else {
                // ordinary grid line on this level, not an axis
                color = vec3(0.9);
                levelAlpha *= neutralOpacity;
            }
            gl_FragColor = vec4(color, levelAlpha);
            gl_FragDepth = writeDepth(levelAlpha) ? calcDepth(worldPos) : 1.0;
            return;
        }

        // 1m grid - all neutral, no axes on this level
        levelPos = pos;
        levelSize = 1.0 / 100.0;
        levelAlpha = screenGrid(levelPos, ddx, ddy, lineWidthPx, vec2(levelSize)) * fade * neutralOpacity;
        if (levelAlpha > epsilon) {
            gl_FragColor = vec4(vec3(0.7), levelAlpha);
            gl_FragDepth = writeDepth(levelAlpha) ? calcDepth(worldPos) : 1.0;
            return;
        }

        // 0.1m grid - all neutral, no axes on this level
        levelPos = pos * 10.0;
        levelSize = 1.0 / 100.0;
        levelAlpha = screenGrid(levelPos, ddx * 10.0, ddy * 10.0, lineWidthPx, vec2(levelSize)) * fade * neutralOpacity;
        if (levelAlpha > epsilon) {
            gl_FragColor = vec4(vec3(0.7), levelAlpha);
            gl_FragDepth = writeDepth(levelAlpha) ? calcDepth(worldPos) : 1.0;
            return;
        }

        discard;
    }
`;

export { vertexShader, fragmentShader };
