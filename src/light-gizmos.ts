import {
    PRIMITIVE_LINES,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { SceneLight } from './scene-light';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

/**
 * Draws every visible light, so a light is a thing you can see and aim.
 *
 * A point light is a small star, a spot adds its cone out to the aim point,
 * a sun is an arrow along the way it shines, and an ambient light - light
 * from all around - is a dome. A light matched to the capture is framed by
 * a square, since it stands for light already there rather than adding
 * any. Each is drawn in its own colour, the selected one at full
 * brightness. Modelled on SceneCameraGizmos: one shared line mesh, rebuilt
 * when anything changes.
 */

const tmpForward = new Vec3();
const tmpRight = new Vec3();
const tmpUp = new Vec3();
const tmpA = new Vec3();
const tmpB = new Vec3();
const tmpBase = new Vec3();

const CONE_SEGMENTS = 12;

class LightGizmos extends Element {
    entity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    dirty = true;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'lightGizmoMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        this.material.depthWrite = true;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(device);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.entity = new Entity('lightGizmos');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.worldLayer.id]
        });

        scene.app.root.addChild(this.entity);

        const markDirty = () => {
            this.dirty = true;
            scene.forceRender = true;
        };
        const { events } = scene;
        events.on('scene.elementAdded', markDirty);
        events.on('scene.elementRemoved', markDirty);
        events.on('light.moved', markDirty);
        events.on('light.changed', markDirty);
        events.on('light.selectionChanged', markDirty);
        events.on('edit.changed', markDirty);
    }

    destroy() {
        this.entity?.destroy();
    }

    onPreRender() {
        const { scene } = this;

        if (this.dirty) {
            this.dirty = false;
            this.rebuildMesh();
        }

        // an empty line mesh is an invalid pipeline rather than an empty
        // draw - see SceneCameraGizmos
        this.entity.enabled = scene.camera.renderOverlays && this.mesh.primitive[0].count > 0;
    }

    private rebuildMesh() {
        const { scene } = this;
        const lights = (scene.getElementsByType(ElementType.light) as unknown[])
        .filter(light => light instanceof SceneLight && light.visible) as SceneLight[];

        if (lights.length === 0) {
            this.mesh.primitive[0].count = 0;
            return;
        }

        const selected = scene.events.invoke('light.selected') as SceneLight;

        // scale with the scene so the icon reads at any zoom
        const size = Math.max(0.25, scene.bound.halfExtents.length()) * 0.05;

        const positions: number[] = [];
        const colors: number[] = [];
        let rgb = [255, 255, 255];

        const pushLine = (a: Vec3, b: Vec3) => {
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            colors.push(rgb[0], rgb[1], rgb[2], 255, rgb[0], rgb[1], rgb[2], 255);
        };

        lights.forEach((light) => {
            const { position, target, settings } = light;

            // the light's own colour, normalised so a dim light still reads;
            // the selected light at full strength, the rest dimmed
            const c = settings.color;
            const peak = Math.max(c[0], c[1], c[2], 1e-3);
            const strength = light === selected ? 255 : 150;
            rgb = c.map(v => Math.round(Math.max(0.25, v / peak) * strength));

            tmpForward.sub2(target, position);
            const dist = Math.max(tmpForward.length(), 1e-4);
            tmpForward.mulScalar(1 / dist);
            if (Math.abs(tmpForward.y) > 0.999) {
                tmpRight.cross(tmpForward, Vec3.BACK).normalize();
            } else {
                tmpRight.cross(tmpForward, Vec3.UP).normalize();
            }
            tmpUp.cross(tmpRight, tmpForward);

            // a star at the light: three axes and the aim direction
            const star = (s: number) => {
                for (const axis of [Vec3.RIGHT, Vec3.UP, Vec3.FORWARD]) {
                    tmpA.copy(position).addScaled(axis, s);
                    tmpB.copy(position).addScaled(axis, -s);
                    pushLine(tmpA, tmpB);
                }
            };

            if (settings.kind === 'ambient') {
                // the horizon circle and two arcs over the top
                const r = size * 1.5;
                const arc = (a: Vec3, b: Vec3, from: number, to: number) => {
                    let prev: Vec3 = null;
                    for (let i = 0; i <= CONE_SEGMENTS; ++i) {
                        const angle = from + (to - from) * i / CONE_SEGMENTS;
                        const p = new Vec3().copy(position)
                        .addScaled(a, Math.cos(angle) * r)
                        .addScaled(b, Math.sin(angle) * r);
                        if (prev) pushLine(prev, p);
                        prev = p;
                    }
                };
                arc(Vec3.RIGHT, Vec3.BACK, 0, Math.PI * 2);
                arc(Vec3.RIGHT, Vec3.UP, 0, Math.PI);
                arc(Vec3.BACK, Vec3.UP, 0, Math.PI);
                return;
            }

            if (settings.role === 'match') {
                // a square across the aim, round whatever is drawn below
                const r = size * 1.4;
                const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => new Vec3().copy(position)
                .addScaled(tmpRight, a * r)
                .addScaled(tmpUp, b * r));
                for (let i = 0; i < 4; ++i) {
                    pushLine(corners[i], corners[(i + 1) % 4]);
                }
            }

            if (settings.kind === 'sun') {
                // an arrow along the way the sun shines, rays round its tail
                star(size * 0.6);
                const length = size * 4;
                tmpA.copy(position).addScaled(tmpForward, length);
                pushLine(position, tmpA);
                tmpB.copy(tmpA).addScaled(tmpForward, -size).addScaled(tmpRight, size * 0.5);
                pushLine(tmpA, tmpB);
                tmpB.copy(tmpA).addScaled(tmpForward, -size).addScaled(tmpRight, -size * 0.5);
                pushLine(tmpA, tmpB);
                tmpB.copy(tmpA).addScaled(tmpForward, -size).addScaled(tmpUp, size * 0.5);
                pushLine(tmpA, tmpB);
                tmpB.copy(tmpA).addScaled(tmpForward, -size).addScaled(tmpUp, -size * 0.5);
                pushLine(tmpA, tmpB);
                return;
            }

            star(size);

            if (settings.kind === 'spot') {
                // the cone out to the aim point, where its edge is a circle
                const half = Math.min(89, Math.max(0.5, settings.spotAngle * 0.5)) * Math.PI / 180;
                const radius = dist * Math.tan(half);
                tmpBase.copy(position).addScaled(tmpForward, dist);
                let prev: Vec3 = null;
                for (let i = 0; i <= CONE_SEGMENTS; ++i) {
                    const angle = i / CONE_SEGMENTS * Math.PI * 2;
                    const p = new Vec3().copy(tmpBase)
                    .addScaled(tmpRight, Math.cos(angle) * radius)
                    .addScaled(tmpUp, Math.sin(angle) * radius);
                    if (prev) pushLine(prev, p);
                    if (i % (CONE_SEGMENTS / 4) === 0 && i < CONE_SEGMENTS) pushLine(position, p);
                    prev = p;
                }
            } else {
                // a point light's aim point, which its intensity is measured at
                tmpA.copy(position).addScaled(tmpForward, Math.min(dist, size * 3));
                pushLine(position, tmpA);
            }
        });

        this.mesh.setPositions(positions);
        this.mesh.setColors32(new Uint8Array(colors));
        this.mesh.update(PRIMITIVE_LINES);
        this.mesh.primitive[0].count = positions.length / 3;
    }
}

export { LightGizmos };
