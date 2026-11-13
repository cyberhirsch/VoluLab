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

/** fetch that turns a bridge error answer into a thrown error */
const call = async (url: string, init: Parameters<typeof fetch>[1] = {}) => {
    const res = await fetch(url, init);
    if (!res.ok) {
        let text = `bridge answered ${res.status}`;
        try {
            text = (await res.json())?.error ?? text;
        } catch (e) { /* not json */ }
        throw new Error(text);
    }
    return res;
};

/**
 * Send images through a full COLMAP run and return the sparse model
 * files. Throws with the bridge's error text when reconstruction fails.
 *
 * The bridge may store an image under a different name than it was sent
 * with (it keeps names ASCII and unique); each image's `name` is updated
 * to the stored one, which is the name images.txt refers to. Aborting
 * `signal` deletes the job, which stops COLMAP on the bridge; the job is
 * deleted on failure too, so nothing is left in the bridge's temp folder.
 */
const estimatePoses = async (images: BridgeImage[], matcher: 'sequential' | 'exhaustive', onStage: StageFn, signal?: AbortSignal): Promise<{ path: string, data: Uint8Array }[]> => {
    const created = await (await call(`${BRIDGE}/jobs`, { method: 'POST', signal })).json();
    const id = created.id as string;

    try {
        let sent = 0;
        for (const image of images) {
            const stored = await (await call(`${BRIDGE}/jobs/${id}/images/${encodeURIComponent(image.name)}`, {
                method: 'PUT',
                body: image.data,
                signal
            })).json();
            if (typeof stored?.name === 'string') image.name = stored.name;
            onStage('upload', `${++sent}/${images.length}`);
        }

        await call(`${BRIDGE}/jobs/${id}/run?matcher=${matcher}`, { method: 'POST', signal });

        for (;;) {
            await new Promise((resolve) => {
                setTimeout(resolve, 1500);
            });
            signal?.throwIfAborted();
            const status = await (await call(`${BRIDGE}/jobs/${id}`, { signal })).json();
            if (status.stage === 'error') throw new Error(status.error ?? 'bridge job failed');
            if (status.stage === 'done') break;
            if (status.stage !== 'idle') onStage(status.stage, status.detail ?? '');
        }

        const listing = await (await call(`${BRIDGE}/jobs/${id}/files`, { signal })).json();
        const out: { path: string, data: Uint8Array }[] = [];
        for (const p of (listing.files as string[])) {
            const buf = await (await call(`${BRIDGE}/jobs/${id}/files/${p.split('/').map(encodeURIComponent).join('/')}`, { signal })).arrayBuffer();
            out.push({ path: p, data: new Uint8Array(buf) });
        }
        return out;
    } finally {
        // not tied to the signal: an aborted job is exactly the one to delete
        fetch(`${BRIDGE}/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
    }
};

export { bridgeReady, estimatePoses, type BridgeImage };
