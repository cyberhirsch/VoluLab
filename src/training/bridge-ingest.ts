import { BridgeImage, bridgeReady, estimatePoses } from './bridge-client';
import { browserPosesReady, estimatePosesInBrowser } from './browser-poses';
import { packDataset } from './dataset';
import { DatasetOp } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/** Can poses be estimated right now: in the browser, or by the bridge? */
const posesReady = async (): Promise<boolean> => await browserPosesReady() || await bridgeReady();

/**
 * Estimate poses in the browser when it can, else through the bridge.
 * The browser run needs equal-sized images (one shared camera); when it
 * fails and the bridge is running, the bridge gets a go.
 */
const estimateAny = async (images: BridgeImage[], matcher: 'sequential' | 'exhaustive', stage: (key: string, detail?: string) => void) => {
    if (await browserPosesReady()) {
        try {
            return await estimatePosesInBrowser(images, matcher, stage);
        } catch (error) {
            if (!await bridgeReady()) throw error;
        }
    }
    return estimatePoses(images, matcher, stage);
};

/**
 * Drive a pose job into an import node: the COLMAP stages stream onto
 * the node's status line, and the posed dataset lands as the node's
 * source when the run succeeds. The node exists the whole time, so the
 * graph shows the work where its result will live.
 */
const bridgePoseIntoOp = async (op: DatasetOp, images: BridgeImage[], matcher: 'sequential' | 'exhaustive', events: Events): Promise<boolean> => {
    const stage = (key: string, detail = '') => {
        op.status = `${i18n.t(`bridge.stage-${key}`)}${detail ? ` ${detail}` : ''}`;
        events.fire('dataset.statusChanged', op);
    };

    try {
        const sparse = await estimateAny(images, matcher, stage);

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

export { bridgePoseIntoOp, posesReady };
