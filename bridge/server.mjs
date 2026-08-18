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
let nextJob = 1;

const createJob = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'volulab-bridge-'));
    await mkdir(path.join(dir, 'images'), { recursive: true });
    const job = {
        id: String(nextJob++),
        dir,
        stage: 'idle',       // idle | features | matching | mapping | convert | done | error
        detail: '',
        error: null,
        tail: new Tail()
    };
    jobs.set(job.id, job);
    return job;
};

const runStage = (job, stage, command, args, cwd) => new Promise((resolve, reject) => {
    job.stage = stage;
    job.detail = '';
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd });
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

const runJob = async (job, matcher) => {
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
            '--ImageReader.camera_model', 'OPENCV', '--ImageReader.single_camera', '1'
        ], dir);
        await runStage(job, 'matching', command, [
            matcher === 'exhaustive' ? 'exhaustive_matcher' : 'sequential_matcher',
            '--database_path', 'colmap.db'
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

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // chrome's private-network-access preflight for https -> localhost
    'Access-Control-Allow-Private-Network': 'true'
};

const json = (res, code, body) => {
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});

/** keep a filename a filename - no separators, no traversal */
const safeName = name => path.basename(name).replace(/[^\w.\- ]/g, '_');

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS);
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

        if (req.method === 'PUT' && parts[0] === 'jobs' && parts[2] === 'images' && parts[3]) {
            const body = await readBody(req);
            await writeFile(path.join(job.dir, 'images', safeName(decodeURIComponent(parts[3]))), body);
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && parts[0] === 'jobs' && parts[2] === 'run') {
            const matcher = url.searchParams.get('matcher') === 'exhaustive' ? 'exhaustive' : 'sequential';
            runJob(job, matcher).catch(() => {});
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'jobs' && parts.length === 2) {
            json(res, 200, { stage: job.stage, detail: job.detail, error: job.error });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'files' && parts.length === 3) {
            json(res, 200, { files: await listResults(job) });
            return;
        }

        if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'files') {
            const rel = parts.slice(3).map(decodeURIComponent).join('/');
            if (rel.includes('..')) {
                json(res, 400, { error: 'bad path' });
                return;
            }
            const data = await readFile(path.join(job.dir, rel));
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream' });
            res.end(data);
            return;
        }

        if (req.method === 'DELETE' && parts[0] === 'jobs' && parts.length === 2) {
            jobs.delete(job.id);
            await rm(job.dir, { recursive: true, force: true });
            json(res, 200, { ok: true });
            return;
        }

        json(res, 404, { error: 'unknown route' });
    } catch (error) {
        json(res, 500, { error: String(error.message ?? error) });
    }
});

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
    });
};

start();
