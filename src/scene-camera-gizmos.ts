import {
    PRIMITIVE_LINES,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { SceneCamera } from './scene-camera';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

/**
 * Draws every scene camera as a frustum, so a camera is a thing you can
 * see and aim rather than an invisible setting. The active one - the
 * camera the viewport looks through - is drawn brighter; a locked camera
 * is drawn amber, since "why won't this move" should be answerable by
 * looking at it.
 *
 * Modelled on CameraPoseGizmos, which does the same job for animation
 * keys; the geometry is one shared line mesh rebuilt when anything moves.
 */

const tmpForward = new Vec3();
const tmpRight = new Vec3();
const tmpUp = new Vec3();
const tmpBase = new Vec3();
const tmpTL = new Vec3();
const tmpTR = new Vec3();
const tmpBL = new Vec3();
const tmpBR = new Vec3();
const tmpUpTip = new Vec3();

// 4 pyramid + 4 base rect + 2 up indicator
const LINES_PER_CAMERA = 10;
const VERTS_PER_CAMERA = LINES_PER_CAMERA * 2;

class SceneCameraGizmos extends Element {
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
            uniqueName: 'sceneCameraGizmoMaterial',
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

        this.entity = new Entity('sceneCameraGizmos');
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
        events.on('camera.sceneCameraMoved', markDirty);
        events.on('camera.activeChanged', markDirty);
        events.on('camera.viewMode', markDirty);
        events.on('camera.sceneCameraChanged', markDirty);
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

        // An empty line mesh has no vertex buffer at all, and a shader that
        // asks for position and colour against no buffer is an invalid
        // pipeline rather than an empty draw - so with nothing to show, the
        // entity goes away instead of drawing nothing.
        this.entity.enabled = scene.camera.renderOverlays && this.mesh.primitive[0].count > 0;
    }

    private rebuildMesh() {
        const { scene } = this;
        // the viewport camera shares this element type, so filter by class
        const cameras = (scene.getElementsByType(ElementType.camera) as unknown[])
        .filter(camera => camera instanceof SceneCamera && camera.visible) as SceneCamera[];

        // the camera being looked through is the view itself, so drawing
        // its frustum would put a cage around every frame
        const active = scene.events.invoke('camera.active') as SceneCamera;
        const throughIt = scene.events.invoke('camera.viewMode') === 'camera';
        const drawn = cameras.filter(camera => !(throughIt && camera === active));

        if (drawn.length === 0) {
            this.mesh.primitive[0].count = 0;
            return;
        }

        // scale with the scene so the icon reads at any zoom
        const radius = Math.max(0.25, scene.bound.halfExtents.length());
        const depth = radius * 0.12;
        const halfW = depth * 0.75;
        const halfH = depth * 0.5;

        const positions: number[] = [];
        const colors = new Uint8Array(drawn.length * VERTS_PER_CAMERA * 4);

        const pushLine = (a: Vec3, b: Vec3) => {
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        };

        drawn.forEach((camera, index) => {
            const { position, target } = camera;

            tmpForward.sub2(target, position).normalize();
            if (Math.abs(tmpForward.y) > 0.999) {
                tmpRight.cross(tmpForward, Vec3.BACK).normalize();
            } else {
                tmpRight.cross(tmpForward, Vec3.UP).normalize();
            }
            tmpUp.cross(tmpRight, tmpForward);

            tmpBase.copy(position).addScaled(tmpForward, depth);
            tmpTL.copy(tmpBase).addScaled(tmpUp, halfH).addScaled(tmpRight, -halfW);
            tmpTR.copy(tmpBase).addScaled(tmpUp, halfH).addScaled(tmpRight, halfW);
            tmpBL.copy(tmpBase).addScaled(tmpUp, -halfH).addScaled(tmpRight, -halfW);
            tmpBR.copy(tmpBase).addScaled(tmpUp, -halfH).addScaled(tmpRight, halfW);

            pushLine(position, tmpTL);
            pushLine(position, tmpTR);
            pushLine(position, tmpBL);
            pushLine(position, tmpBR);

            pushLine(tmpTL, tmpTR);
            pushLine(tmpTR, tmpBR);
            pushLine(tmpBR, tmpBL);
            pushLine(tmpBL, tmpTL);

            tmpUpTip.copy(tmpBase).addScaled(tmpUp, halfH * 1.6);
            pushLine(tmpTL, tmpUpTip);
            pushLine(tmpTR, tmpUpTip);

            // amber when locked, bright cyan when active, dim otherwise
            const rgb = camera.locked ? [255, 176, 64] : (camera === active ? [0, 255, 255] : [0, 150, 160]);
            for (let v = 0; v < VERTS_PER_CAMERA; v++) {
                const off = (index * VERTS_PER_CAMERA + v) * 4;
                colors[off] = rgb[0];
                colors[off + 1] = rgb[1];
                colors[off + 2] = rgb[2];
                colors[off + 3] = 255;
            }
        });

        this.mesh.setPositions(positions);
        this.mesh.setColors32(colors);
        this.mesh.update(PRIMITIVE_LINES);
        this.mesh.primitive[0].count = drawn.length * VERTS_PER_CAMERA;
    }
}

export { SceneCameraGizmos };
