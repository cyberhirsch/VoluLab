/**
 * Client for the local COLMAP bridge (bridge/server.mjs).
 *
 * The bridge is a small native helper on 127.0.0.1 that runs COLMAP on
 * images the app posts to it. Loopback is exempt from mixed-content
 * blocking, so this works from the https deployment too; the bridge
 * answers Chrome's private-network preflight itself.
 */

const BRIDGE = 'http://127.0.0.1:39733';

type BridgeImage = { name: string, data: Blob };

/** stage keys the ui maps to text: upload, features, matching, mapping, convert */
type StageFn = (stage: string, detail?: string) => void;

/** Is the bridge running, with a working COLMAP behind it? */
const bridgeReady = async (): Promise<boolean> => {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`${BRIDGE}/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return false;
        const body = await res.json();
        return body?.bridge === 'volulab' && body?.colmap === 'ready';
    } catch (e) {
        return false;
    }
};

/**
 * Send images through a full COLMAP run and return the sparse model
 * files. Throws with the bridge's error text when reconstruction fails.
 */
const estimatePoses = async (images: BridgeImage[], matcher: 'sequential' | 'exhaustive', onStage: StageFn): Promise<{ path: string, data: Uint8Array }[]> => {
    const created = await (await fetch(`${BRIDGE}/jobs`, { method: 'POST' })).json();
    const id = created.id as string;

    let sent = 0;
    for (const image of images) {
        await fetch(`${BRIDGE}/jobs/${id}/images/${encodeURIComponent(image.name)}`, {
            method: 'PUT',
            body: image.data
        });
        onStage('upload', `${++sent}/${images.length}`);
    }

    await fetch(`${BRIDGE}/jobs/${id}/run?matcher=${matcher}`, { method: 'POST' });

    for (;;) {
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        const status = await (await fetch(`${BRIDGE}/jobs/${id}`)).json();
        if (status.stage === 'error') throw new Error(status.error ?? 'bridge job failed');
        if (status.stage === 'done') break;
        if (status.stage !== 'idle') onStage(status.stage, status.detail ?? '');
    }

    const listing = await (await fetch(`${BRIDGE}/jobs/${id}/files`)).json();
    const out: { path: string, data: Uint8Array }[] = [];
    for (const p of (listing.files as string[])) {
        const buf = await (await fetch(`${BRIDGE}/jobs/${id}/files/${p.split('/').map(encodeURIComponent).join('/')}`)).arrayBuffer();
        out.push({ path: p, data: new Uint8Array(buf) });
    }

    fetch(`${BRIDGE}/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
    return out;
};

export { bridgeReady, estimatePoses, type BridgeImage };
