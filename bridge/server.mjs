/**
 * The VoluLab COLMAP bridge.
 *
 * A small local helper the browser cannot be: it runs native COLMAP.
 * VoluLab posts images to it over localhost, the bridge runs feature
 * extraction, matching and mapping, and serves the sparse model back;
 * the app packs the dataset and trains. Strictly optional - without it
 * the app falls back to writing the run-me script kit.
 *
 * Zero dependencies. Start with:  npm run bridge   (or node bridge/server.mjs)
 *
 * On first run without COLMAP on the PATH (Windows), the bridge offers
 * to download the official portable build and unpack it next to itself -
 * no admin rights involved.
 */

import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 39733);
const HOST = '127.0.0.1';
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_COLMAP_DIR = path.join(BRIDGE_DIR, '.colmap');
const TEMP_PREFIX = 'volulab-bridge-';

// one image may be large (a raw-ish 100 MP jpeg), a job may not be endless
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_JOB_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_JOB_IMAGES = 5000;
// a job nobody has asked about for this long was abandoned by its tab
const JOB_IDLE_MS = 60 * 60 * 1000;

/**
 * Who may talk to the bridge: VoluLab served locally (dev server, any
 * port) and the deployed app. VOLULAB_ORIGINS adds more, comma-separated.
 * Every other website is refused - the bridge runs a native program on
 * this machine and holds the user's photos.
 */
const DEPLOYED_ORIGINS = ['https://cyberhirsch.github.io'];
const extraOrigins = (process.env.VOLULAB_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const originAllowed = origin => LOCAL_ORIGIN_RE.test(origin) || DEPLOYED_ORIGINS.includes(origin) || extraOrigins.includes(origin);

// the Host header must name this machine: a rebound DNS name pointing at
// 127.0.0.1 makes a hostile page same-origin with us, but not same-host
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

// ---------------------------------------------------------------- colmap

/**
 * COLMAP_CMD overrides discovery - a JSON array ["node","stub.mjs"] or a
 * plain executable path. Used by tests and by anyone with an odd install.
 */
const commandOverride = () => {
    const raw = process.env.COLMAP_CMD;
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(String);
    } catch (e) { /* not json - treat as a path */ }
    return [raw];
};

const runnable = (cmd, args = ['--help']) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, err => resolve(!err || err.code !== 'ENOENT'));
});

/** Find colmap.exe (or colmap) under a directory, two levels deep. */
const findColmapUnder = (dir) => {
    const names = process.platform === 'win32' ? ['colmap.exe', 'COLMAP.bat'] : ['colmap'];
    const walk = async (d, depth) => {
        let entries;
        try {
            entries = await readdir(d, { withFileTypes: true });
        } catch (e) {
            return null;
        }
        for (const entry of entries) {
            if (entry.isFile() && names.includes(entry.name)) return path.join(d, entry.name);
        }
        if (depth <= 0) return null;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const hit = await walk(path.join(d, entry.name), depth - 1);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(dir, 2);
};

/** [command, ...leading args] or null when colmap is nowhere to be found. */
const locateColmap = async () => {
    const override = commandOverride();
    if (override) return override;
    if (await runnable('colmap', ['help'])) return ['colmap'];
    const local = await findColmapUnder(LOCAL_COLMAP_DIR);
    if (local) return [local];
    return null;
};

// ------------------------------------------------------------- provision

const httpsGet = (url, redirects = 5) => new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'volulab-bridge' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            resolve(httpsGet(res.headers.location, redirects - 1));
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
        }
        resolve(res);
    });
    req.on('error', reject);
});

const readAll = async (res) => {
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    return Buffer.concat(chunks);
};

const hasNvidia = () => new Promise((resolve) => {
    execFile('nvidia-smi', ['-L'], { timeout: 10000 }, err => resolve(!err));
});

/**
 * Download the official portable COLMAP for Windows and unpack it under
 * bridge/.colmap. The release assets are named for platform and cuda
 * flavour, so the newest matching one is picked via the GitHub API.
 */
const provisionWindows = async (log) => {
    log('looking up the latest COLMAP release…');
    const api = await readAll(await httpsGet('https://api.github.com/repos/colmap/colmap/releases/latest'));
    const release = JSON.parse(api.toString());
    const assets = release.assets ?? [];
    const cuda = await hasNvidia();
    log(`release ${release.tag_name}, ${cuda ? 'nvidia gpu found - taking the cuda build' : 'no nvidia gpu - taking the nocuda build'}`);
    const wanted = assets.find(a => /windows/i.test(a.name) && (cuda ? /cuda/i.test(a.name) && !/nocuda/i.test(a.name) : /nocuda/i.test(a.name)));
    if (!wanted) throw new Error('no matching windows asset in the latest release');

    const zipPath = path.join(LOCAL_COLMAP_DIR, wanted.name);
    await mkdir(LOCAL_COLMAP_DIR, { recursive: true });
    log(`downloading ${wanted.name} (${(wanted.size / 1e6).toFixed(0)} MB)…`);
    const res = await httpsGet(wanted.browser_download_url);
    const out = createWriteStream(zipPath);
    let got = 0;
    let lastShown = 0;
    await new Promise((resolve, reject) => {
        res.on('data', (chunk) => {
            got += chunk.length;
            if (got - lastShown > 50e6) {
                lastShown = got;
                log(`  ${(got / 1e6).toFixed(0)} / ${(wanted.size / 1e6).toFixed(0)} MB`);
            }
        });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
    });

    log('unpacking…');
    await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command',
            `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${LOCAL_COLMAP_DIR}" -Force`],
        { timeout: 600000 }, err => (err ? reject(err) : resolve()));
    });
    await rm(zipPath, { force: true });

    const exe = await findColmapUnder(LOCAL_COLMAP_DIR);
    if (!exe) throw new Error('unpacked, but no colmap executable found');
    log(`ready: ${exe}`);
    return exe;
};

const offerProvisioning = async () => {
    if (process.platform !== 'win32') {
        console.log('COLMAP not found. Install it yourself:');
        console.log(process.platform === 'darwin' ? '  brew install colmap' : '  sudo apt install colmap');
        return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        rl.question('COLMAP not found. Download the portable build now? [Y/n] ', resolve);
    });
    rl.close();
    if (/^n/i.test(answer.trim())) {
        console.log('skipped - the bridge will report COLMAP as missing until it appears.');
        return;
    }
    try {
        await provisionWindows(line => console.log(line));
    } catch (error) {
        console.error(`provisioning failed: ${error.message}`);
    }
};

// ------------------------------------------------------------------ jobs

/** last N log lines, for progress display and post-mortems */
class Tail {
    lines = [];

    push(text) {
        for (const line of String(text).split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.lines.push(trimmed);
            if (this.lines.length > 60) this.lines.shift();
        }
    }

    get last() {
        return this.lines[this.lines.length - 1] ?? '';
    }
}

const jobs = new Map();

const createJob = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
    await mkdir(path.join(dir, 'images'), { recursive: true });
    const job = {
        // unguessable: the id is all that stands between a job's photos and
        // anything else that can reach this port
        id: randomUUID(),
        dir,
        stage: 'idle',       // idle | features | matching | mapping | convert | done | error
        detail: '',
        error: null,
        tail: new Tail(),
        child: null,         // the colmap process of the running stage
        cancelled: false,
        names: new Set(),    // stored image names, kept unique
        bytes: 0,
        touched: Date.now()
    };
    jobs.set(job.id, job);
    return job;
};

const removeDir = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

/** Forget a job: kill its colmap, then delete its folder. */
const deleteJob = async (job) => {
    jobs.delete(job.id);
    job.cancelled = true;
    const child = job.child;
    if (child && child.exitCode === null && child.signalCode === null) {
        // windows keeps the files open until the process is really gone
        const closed = new Promise((resolve) => {
            child.once('close', resolve);
        });
        child.kill();
        await Promise.race([closed, new Promise((resolve) => {
            setTimeout(resolve, 5000);
        })]);
    }
    await removeDir(job.dir);
};

const runStage = (job, stage, command, args, cwd) => new Promise((resolve, reject) => {
    if (job.cancelled) {
        reject(new Error('cancelled'));
        return;
    }
    job.stage = stage;
    job.detail = '';
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd });
    job.child = child;
    const onData = (chunk) => {
        job.tail.push(chunk);
        // colmap reports "Processed file [x/y]" and similar - surface it
        const match = job.tail.last.match(/\[(\d+)\/(\d+)\]/);
        job.detail = match ? `${match[1]}/${match[2]}` : job.tail.last.slice(0, 80);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${stage} exited with ${code}\n${job.tail.lines.slice(-8).join('\n')}`))));
});

/**
 * COLMAP's options for a job, from the run request: only known camera
 * models and numbers in range get through to the command line.
 */
const jobOptions = (params) => {
    const model = ['SIMPLE_RADIAL', 'PINHOLE', 'OPENCV'].includes(params.get('camera_model')) ? params.get('camera_model') : 'OPENCV';
    const int = (name, fallback, lo, hi) => {
        const n = Math.round(Number(params.get(name)));
        return params.has(name) && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    return {
        model,
        single: params.get('single_camera') === '0' ? '0' : '1',
        maxFeatures: int('max_features', 8192, 256, 65536),
        overlap: int('overlap', 10, 1, 200)
    };
};

const runJob = async (job, matcher, options = jobOptions(new URLSearchParams())) => {
    const command = await locateColmap();
    if (!command) {
        job.stage = 'error';
        job.error = 'colmap not found';
        return;
    }
    const dir = job.dir;
    try {
        await mkdir(path.join(dir, 'sparse'), { recursive: true });
        await runStage(job, 'features', command, [
            'feature_extractor', '--database_path', 'colmap.db', '--image_path', 'images',
            '--ImageReader.camera_model', options.model, '--ImageReader.single_camera', options.single,
            '--SiftExtraction.max_num_features', String(options.maxFeatures)
        ], dir);
        await runStage(job, 'matching', command, [
            matcher === 'exhaustive' ? 'exhaustive_matcher' : 'sequential_matcher',
            '--database_path', 'colmap.db',
            ...(matcher === 'exhaustive' ? [] : ['--SequentialMatching.overlap', String(options.overlap)])
        ], dir);
        await runStage(job, 'mapping', command, [
            'mapper', '--database_path', 'colmap.db', '--image_path', 'images', '--output_path', 'sparse'
        ], dir);
        await runStage(job, 'convert', command, [
            'model_converter', '--input_path', path.join('sparse', '0'), '--output_path', path.join('sparse', '0'), '--output_type', 'TXT'
        ], dir);
        // mapping without a model means colmap found no reconstruction
        await stat(path.join(dir, 'sparse', '0', 'images.txt'));
        job.stage = 'done';
    } catch (error) {
        job.stage = 'error';
        job.error = String(error.message ?? error);
        // a failed job's photos and database are of no further use; the
        // job itself stays so its error can still be read
        if (!job.cancelled) await removeDir(job.dir);
    } finally {
        job.child = null;
        job.touched = Date.now();
    }
};

/** every file under sparse/, as job-relative posix paths */
const listResults = async (job) => {
    const out = [];
    const walk = async (rel) => {
        let entries;
        try {
            entries = await readdir(path.join(job.dir, rel), { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const childRel = `${rel}/${entry.name}`;
            if (entry.isDirectory()) await walk(childRel);
            else out.push(childRel);
        }
    };
    await walk('sparse');
    return out;
};

// ---------------------------------------------------------------- server

/** CORS for an allowed origin: echoed back, never '*' */
const corsFor = origin => ({
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // chrome's private-network-access preflight for https -> localhost
    'Access-Control-Allow-Private-Network': 'true'
});

const json = (res, code, body) => {
    res.writeHead(code, { ...(res.cors ?? {}), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

class TooLarge extends Error {}

/** the request body, refused once it grows past `limit` bytes */
const readBody = (req, limit) => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
        reject(new TooLarge('image too large'));
        return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
            req.destroy();
            reject(new TooLarge('image too large'));
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});

/** keep a filename a filename - no separators, no traversal */
const safeName = name => path.basename(name).replace(/[^\w.\- ]/g, '_');

/**
 * The name an image is stored under: safe, and unique within the job -
 * two names that sanitize alike ("ä.jpg", "ö.jpg") must not overwrite
 * each other. The client is told, so its dataset uses the same names
 * COLMAP's images.txt will.
 */
const storedName = (job, name) => {
    const safe = safeName(name) || 'image';
    if (!job.names.has(safe)) return safe;
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let i = 1; ; i++) {
        const candidate = `${stem}_${i}${ext}`;
        if (!job.names.has(candidate)) return candidate;
    }
};

const server = http.createServer(async (req, res) => {
    try {
        // a rebound dns name reaches us with a foreign Host
        if (!LOCAL_HOST_RE.test(req.headers.host ?? '')) {
            res.writeHead(403);
            res.end();
            return;
        }
        // browsers always name the page a cross-origin request comes from;
        // requests from tools (no Origin) are as local as the bridge itself
        const origin = req.headers.origin;
        if (origin !== undefined && !originAllowed(origin)) {
            res.writeHead(403);
            res.end();
            return;
        }
        res.cors = corsFor(origin);

        if (req.method === 'OPTIONS') {
            res.writeHead(204, res.cors);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        const parts = url.pathname.split('/').filter(p => p);

        if (req.method === 'GET' && url.pathname === '/health') {
            const command = await locateColmap();
            json(res, 200, { ok: true, bridge: 'volulab', colmap: command ? 'ready' : 'missing' });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/jobs') {
            const job = await createJob();
            json(res, 200, { id: job.id });
            return;
        }

        const job = jobs.get(parts[1]);
        if (parts[0] === 'jobs' && !job) {
            json(res, 404, { error: 'no such job' });
            return;
        }
        if (job) job.touched = Date.now();

        if (req.method === 'PUT' && parts[0] === 'jobs' && parts[2] === 'images' && parts[3]) {
            if (job.stage !== 'idle') {
                json(res, 409, { error: 'job already running' });
                return;
            }
            if (job.names.size >= MAX_JOB_IMAGES) {
                json(res, 413, { error: `at most ${MAX_JOB_IMAGES} images per job` });
                return;
            }
            const body = await readBody(req, Math.min(MAX_IMAGE_BYTES, MAX_JOB_BYTES - job.bytes));
            const name = storedName(job, decodeURIComponent(parts[3]));
            job.names.add(name);
            job.bytes += body.length;
            await writeFile(path.join(job.dir, 'images', name), body);
            json(res, 200, { ok: true, name });
            return;
        }

        if (req.method === 'POST' && parts[0] === 'jobs' && parts[2] === 'run') {
            if (job.stage !== 'idle') {
                json(res, 409, { error: 'job already running' });
                return;
            }
            const matcher = url.searchParams.get('matcher') === 'exhaustive' ? 'exhaustive' : 'sequential';
            // taken synchronously, so a second run request is refused
            job.stage = 'features';
            runJob(job, matcher, jobOptions(url.searchParams)).catch(() => {});
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'jobs' && parts.length === 2) {
            json(res, 200, { stage: job.stage, detail: job.detail, error: job.error });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'files' && parts.length === 3) {
            json(res, 200, { files: job.stage === 'done' ? await listResults(job) : [] });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'files') {
            // only the reconstruction is served - never the photos or the database
            const rel = parts.slice(3).map(decodeURIComponent).join('/');
            const sparse = path.join(job.dir, 'sparse');
            const file = path.resolve(job.dir, rel);
            if (job.stage !== 'done' || !rel.startsWith('sparse/') || !file.startsWith(sparse + path.sep)) {
                json(res, 400, { error: 'bad path' });
                return;
            }
            const data = await readFile(file);
            res.writeHead(200, { ...res.cors, 'Content-Type': 'application/octet-stream' });
            res.end(data);
            return;
        }

        if (req.method === 'DELETE' && parts[0] === 'jobs' && parts.length === 2) {
            await deleteJob(job);
            json(res, 200, { ok: true });
            return;
        }

        json(res, 404, { error: 'unknown route' });
    } catch (error) {
        if (!res.headersSent) {
            json(res, error instanceof TooLarge ? 413 : 500, { error: String(error.message ?? error) });
        }
    }
});

/** Jobs whose tab went away without a DELETE: dropped after an idle hour. */
const sweepIdleJobs = () => {
    const now = Date.now();
    for (const job of jobs.values()) {
        if (!job.child && now - job.touched > JOB_IDLE_MS) {
            deleteJob(job).catch(() => {});
        }
    }
};

/** Folders left by an earlier bridge that was closed mid-job. */
const sweepStaleDirs = async () => {
    let entries;
    try {
        entries = await readdir(tmpdir(), { withFileTypes: true });
    } catch (e) {
        return;
    }
    const live = new Set([...jobs.values()].map(j => j.dir));
    for (const entry of entries) {
        const dir = path.join(tmpdir(), entry.name);
        if (entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX) && !live.has(dir)) {
            await removeDir(dir);
        }
    }
};

const start = async () => {
    console.log('VoluLab COLMAP bridge');
    const command = await locateColmap();
    if (command) {
        console.log(`colmap: ${command.join(' ')}`);
    } else {
        await offerProvisioning();
    }
    server.listen(PORT, HOST, () => {
        console.log(`listening on http://${HOST}:${PORT} - leave this window open and import photos or a video in VoluLab`);
        // only once the port is ours: a second bridge that fails to listen
        // must not delete the first one's jobs
        sweepStaleDirs().catch(() => {});
        setInterval(sweepIdleJobs, 5 * 60 * 1000).unref();
    });
};

start();
