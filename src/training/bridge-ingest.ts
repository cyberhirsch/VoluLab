import { BridgeImage, estimatePoses } from './bridge-client';
import { packDataset } from './dataset';
import { DatasetOp } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/**
 * Drive a bridge pose job into an import node: images go out, the
 * COLMAP stages stream back onto the node's status line, and the posed
 * dataset lands as the node's source when the run succeeds. The node
 * exists the whole time, so the graph shows the work where its result
 * will live.
 */
const bridgePoseIntoOp = async (op: DatasetOp, images: BridgeImage[], matcher: 'sequential' | 'exhaustive', events: Events): Promise<boolean> => {
    const stage = (key: string, detail = '') => {
        op.status = `${i18n.t(`bridge.stage-${key}`)}${detail ? ` ${detail}` : ''}`;
        events.fire('dataset.statusChanged', op);
    };

    try {
        stage('upload', `0/${images.length}`);
        const sparse = await estimatePoses(images, matcher, stage);

        stage('packing');
        const files = [
            ...images.map(image => ({ filename: `images/${image.name}`, contents: new File([image.data], image.name) })),
            ...sparse.map(f => ({ filename: f.path, contents: new File([f.data as BlobPart], f.path.split('/').pop()) }))
        ];
        const { bytes } = await packDataset(files);

        op.setSource({ kind: 'bytes', bytes, name: 'dataset.zip' }, op.sourceName);
        op.status = undefined;
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
        return true;
    } catch (error) {
        op.status = `${i18n.t('bridge.failed')} — ${String((error as any)?.message ?? error).slice(0, 120)}`;
        events.fire('dataset.statusChanged', op);
        return false;
    }
};

export { bridgePoseIntoOp };
