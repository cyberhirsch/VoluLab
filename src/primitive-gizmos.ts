import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    PRIMITIVE_LINES,
    BlendState,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { ScenePrimitive } from './scene-primitive';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

/**
 * Draws every visible primitive as a wireframe, at its real size, so what a
 * select node catches or a light shines from is a shape you can see and
 * place. The selected one is drawn at full brightness, the rest dimmed.
 * Modelled on LightGizmos: one shared line mesh, rebuilt when anything
 * changes.
 *
 * A primitive is usually placed in among the gaussians, so it is drawn
 * twice, as the measure tool's lines are: once in the world, where the
 * gaussians in front cover it, and once faintly after them, so the covered
 * part still shows.
 */

const SEGMENTS = 32;

// how strongly the covered part shows through
const GHOST_OPACITY = 0.3;

const ghostFragmentShader = /* glsl */ `
    precision highp float;

    varying vec4 vColor;

    uniform float ghost;

    void main(void) {
        gl_FragColor = vec4(vColor.rgb, vColor.a * ghost);
    }
`;

const matrix = new Mat4();
const a = new Vec3();
const b = new Vec3();

class PrimitiveGizmos extends Element {
    entity: Entity;
    ghostEntity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    dirty = true;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;

        this.material = new ShaderMaterial({
            uniqueName: 'primitiveGizmoMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        this.material.depthWrite = true;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(scene.graphicsDevice);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.entity = new Entity('primitiveGizmos');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.worldLayer.id]
        });

        scene.app.root.addChild(this.entity);

        // the faint pass after the splats: no depth, blended
        const ghost = new ShaderMaterial({
            uniqueName: 'primitiveGizmoGhostMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: ghostFragmentShader
        });
        ghost.depthWrite = false;
        ghost.depthTest = false;
        ghost.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
        );
        ghost.setParameter('ghost', GHOST_OPACITY);
        ghost.update();

        const ghostInstance = new MeshInstance(this.mesh, ghost, null);
        ghostInstance.cull = false;

        this.ghostEntity = new Entity('primitiveGizmosGhost');
        this.ghostEntity.addComponent('render', {
            meshInstances: [ghostInstance],
            layers: [scene.overlayLayer.id]
        });

        scene.app.root.addChild(this.ghostEntity);

        const markDirty = () => {
            this.dirty = true;
            scene.forceRender = true;
        };
        const { events } = scene;
        events.on('scene.elementAdded', markDirty);
        events.on('scene.elementRemoved', markDirty);
        events.on('primitive.moved', markDirty);
        events.on('primitive.changed', markDirty);
        events.on('primitive.selectionChanged', markDirty);
        events.on('edit.changed', markDirty);
    }

    destroy() {
        this.entity?.destroy();
        this.ghostEntity?.destroy();
    }

    onPreRender() {
        if (this.dirty) {
            this.dirty = false;
            this.rebuildMesh();
        }

        // an empty line mesh is an invalid pipeline rather than an empty
        // draw - see SceneCameraGizmos
        this.entity.enabled = this.scene.camera.renderOverlays && this.mesh.primitive[0].count > 0;
        this.ghostEntity.enabled = this.entity.enabled;
    }

    private rebuildMesh() {
        const { scene } = this;
        const primitives = (scene.getElementsByType(ElementType.primitive) as unknown[])
        .filter(p => p instanceof ScenePrimitive && p.visible) as ScenePrimitive[];

        if (primitives.length === 0) {
            this.mesh.primitive[0].count = 0;
            return;
        }

        const selected = scene.events.invoke('primitive.selected') as ScenePrimitive;

        const positions: number[] = [];
        const colors: number[] = [];
        let grey = 255;

        // a line between two points of the unit shape, in world space
        const line = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
            matrix.transformPoint(a.set(x0, y0, z0), a);
            matrix.transformPoint(b.set(x1, y1, z1), b);
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            colors.push(grey, grey, grey, 255, grey, grey, grey, 255);
        };

        // a circle of the unit shape's radius, 0.5, round the axis given;
        // the offset moves it along that axis
        const circle = (axis: 'x' | 'y' | 'z', offset = 0) => {
            for (let i = 0; i < SEGMENTS; ++i) {
                const t0 = i / SEGMENTS * Math.PI * 2;
                const t1 = (i + 1) / SEGMENTS * Math.PI * 2;
                const [c0, s0, c1, s1] = [Math.cos(t0) * 0.5, Math.sin(t0) * 0.5, Math.cos(t1) * 0.5, Math.sin(t1) * 0.5];
                if (axis === 'x') line(offset, c0, s0, offset, c1, s1);
                else if (axis === 'y') line(c0, offset, s0, c1, offset, s1);
                else line(c0, s0, offset, c1, s1, offset);
            }
        };

        primitives.forEach((primitive) => {
            grey = primitive === selected ? 255 : 170;
            primitive.transform(matrix);

            switch (primitive.kind) {
                case 'sphere':
                    circle('x');
                    circle('y');
                    circle('z');
                    break;
                case 'cylinder':
                    circle('y', -0.5);
                    circle('y', 0.5);
                    for (let i = 0; i < 4; ++i) {
                        const t = i / 4 * Math.PI * 2;
                        const x = Math.cos(t) * 0.5;
                        const z = Math.sin(t) * 0.5;
                        line(x, -0.5, z, x, 0.5, z);
                    }
                    break;
                default:
                    // the twelve edges: four along each axis
                    for (const [u, v] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5]]) {
                        line(-0.5, u, v, 0.5, u, v);
                        line(u, -0.5, v, u, 0.5, v);
                        line(u, v, -0.5, u, v, 0.5);
                    }
                    break;
            }
        });

        this.mesh.setPositions(positions);
        this.mesh.setColors32(new Uint8Array(colors));
        this.mesh.update(PRIMITIVE_LINES);
        this.mesh.primitive[0].count = positions.length / 3;
    }
}

export { PrimitiveGizmos };
