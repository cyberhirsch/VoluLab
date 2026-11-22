import { i18n } from './localization';
import { Events } from '../events';
import { CacheOp, PASS_NAMES, RenderPassesOp, StatsOp, ViewerOp } from '../inspect-ops';

/**
 * The node pane's faces for the output and inspection nodes: render passes,
 * viewer, cache and stats. None of their settings is an edit, so they are
 * changed in place and the pane redrawn, as an output node's are.
 */

const el = (tag: string, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};

const megabytes = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const pct = (a: number, b: number) => (b > 0 ? `${(100 * a / b).toFixed(1)} %` : '-');
const num = (n: number) => n.toLocaleString();
const fix = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3));

const buildInspectNode = (body: HTMLElement, op: RenderPassesOp | ViewerOp | CacheOp | StatsOp, index: number, events: Events, rebuild: () => void) => {
    const row = (label: string) => {
        const r = el('div', 'nd-row');
        r.appendChild(el('div', 'nd-row-label', label));
        body.appendChild(r);
        return r;
    };
    const stat = (label: string, value: string) => {
        row(label).appendChild(el('div', 'nd-value', value));
    };
    const note = (text: string) => body.appendChild(el('div', 'nd-note', text));
    const action = (text: string, onClick: () => void, disabled = false) => {
        const b = el('button', 'nd-action', text) as HTMLButtonElement;
        b.type = 'button';
        b.disabled = disabled;
        b.addEventListener('click', onClick);
        body.appendChild(b);
        return b;
    };
    const choice = (text: string, active: boolean, onClick: () => void) => {
        const b = el('button', 'nd-choice', text) as HTMLButtonElement;
        b.type = 'button';
        if (active) b.classList.add('nd-choice-active');
        b.addEventListener('click', onClick);
        return b;
    };
    const number = (label: string, value: number | null, placeholder: string, apply: (v: number | null) => void) => {
        const input = el('input', 'nd-num') as HTMLInputElement;
        input.type = 'number';
        input.step = '1';
        input.value = value === null ? '' : `${value}`;
        input.placeholder = placeholder;
        input.addEventListener('keydown', e => e.stopPropagation());
        input.addEventListener('change', () => {
            const v = parseInt(input.value, 10);
            apply(Number.isFinite(v) ? v : null);
        });
        row(label).appendChild(input);
    };

    if (op instanceof RenderPassesOp) {
        const { settings } = op;
        const passes = el('div', 'nd-choices');
        PASS_NAMES.forEach((p) => {
            passes.appendChild(choice(i18n.t(`node.passes.${p}`), settings.passes[p], () => {
                settings.passes[p] = !settings.passes[p];
                events.fire('edit.changed');
                rebuild();
            }));
        });
        row(i18n.t('node.passes.passes')).appendChild(passes);
        number(i18n.t('node.passes.width'), settings.width, '960', (v) => {
            settings.width = Math.max(16, Math.min(8192, v ?? 960));
        });
        number(i18n.t('node.passes.height'), settings.height, '540', (v) => {
            settings.height = Math.max(16, Math.min(8192, v ?? 540));
        });
        number(i18n.t('node.passes.start'), settings.startFrame, '0', (v) => {
            settings.startFrame = Math.max(0, v ?? 0);
        });
        const last = Math.max(0, (events.invoke('timeline.frames') ?? 1) - 1);
        number(i18n.t('node.passes.end'), settings.endFrame, `${last}`, (v) => {
            settings.endFrame = v === null ? null : Math.max(0, v);
        });
        const name = el('input', 'nd-text') as HTMLInputElement;
        name.type = 'text';
        name.value = settings.filename;
        name.addEventListener('keydown', e => e.stopPropagation());
        name.addEventListener('change', () => {
            settings.filename = name.value.trim().replace(/[\\/:*?"<>|]/g, '_') || settings.filename;
        });
        row(i18n.t('node.passes.file')).appendChild(name);
        action(i18n.t('node.passes.render'), () => events.invoke('renderPasses.write', index), !PASS_NAMES.some(p => settings.passes[p]));
        note(i18n.t('node.passes.note'));
        return;
    }

    if (op instanceof ViewerOp) {
        const active = events.invoke('viewer.active') === op;
        stat(i18n.t('node.viewer.state'), active ? i18n.t('node.viewer.showing') : i18n.t('node.viewer.idle'));
        const iso = el('div', 'nd-choices');
        iso.appendChild(choice(i18n.t('node.viewer.isolate'), op.isolate, () => {
            op.isolate = !op.isolate;
            rebuild();
        }));
        row(i18n.t('node.viewer.others')).appendChild(iso);
        if (active) {
            action(i18n.t('node.viewer.stop'), () => events.invoke('viewer.stop'));
        } else {
            action(i18n.t('node.viewer.view'), () => events.invoke('viewer.view', op), !!op.bypassed);
        }
        note(i18n.t('node.viewer.note'));
        return;
    }

    if (op instanceof CacheOp) {
        stat(i18n.t('node.cache.frames'), num(op.frames.size));
        stat(i18n.t('node.cache.memory'), megabytes(op.bytes));
        stat(i18n.t('node.cache.hits'), `${num(op.hits)} / ${num(op.hits + op.misses)}`);
        stat(i18n.t('node.cache.cleared'), num(op.clears));
        const disk = el('div', 'nd-choices');
        disk.appendChild(choice(i18n.t('node.cache.memory-only'), !op.settings.disk, () => {
            events.invoke('cache.setDisk', op, false).then(rebuild);
        }));
        disk.appendChild(choice(i18n.t('node.cache.disk'), op.settings.disk, () => {
            events.invoke('cache.setDisk', op, true).then(rebuild);
        }));
        row(i18n.t('node.cache.store')).appendChild(disk);
        if (op.dir) stat(i18n.t('node.cache.folder'), op.dir.name);
        const seq = events.invoke('sequence.source');
        const bakeable = !!seq && events.invoke('sequence.splat') === op.splat && !seq.showFrame;
        action(i18n.t('node.cache.bake'), () => events.invoke('cache.bake', op).then(rebuild), !bakeable);
        action(i18n.t('node.cache.clear'), () => events.invoke('cache.clear', op));
        note(i18n.t(op.splat?.motion ? 'node.cache.note-4d' : 'node.cache.note'));
        return;
    }

    if (op instanceof StatsOp) {
        const s = op.snapshot;
        if (!s) {
            note(i18n.t('node.stats.not-applied'));
            return;
        }
        stat(i18n.t('node.stats.count'), num(s.live));
        if (s.total !== s.live) stat(i18n.t('node.stats.deleted'), num(s.total - s.live));
        stat(i18n.t('node.stats.selected'), `${num(s.selected)} (${pct(s.selected, s.live)})`);
        if (s.hidden) stat(i18n.t('node.stats.hidden'), num(s.hidden));
        if (s.still !== null) {
            stat(i18n.t('node.stats.still'), `${num(s.still)} (${pct(s.still, s.live)})`);
            stat(i18n.t('node.stats.moving'), `${num(s.live - s.still)} (${pct(s.live - s.still, s.live)})`);
        }
        stat(i18n.t('node.stats.memory'), megabytes(s.bytes));
        if (s.min && s.max) {
            stat(i18n.t('node.stats.min'), s.min.map(fix).join(', '));
            stat(i18n.t('node.stats.max'), s.max.map(fix).join(', '));
            stat(i18n.t('node.stats.size'), s.max.map((v, k) => fix(v - s.min[k])).join(' x '));
        }

        if (op.splat?.motion) {
            if (op.perFrame) {
                const pf = op.perFrame;
                const drawn = pf.map(f => f.drawn);
                stat(i18n.t('node.stats.drawn'), `${num(Math.min(...drawn))} - ${num(Math.max(...drawn))}`);
                const changes = pf.slice(1).map(f => f.appeared + f.gone);
                const mean = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
                stat(i18n.t('node.stats.change'), `${num(Math.round(mean))} (${i18n.t('node.stats.max-change')} ${num(Math.max(0, ...changes))})`);
                const table = el('div', 'nd-note');
                table.style.whiteSpace = 'pre';
                table.style.fontFamily = 'monospace';
                table.style.maxHeight = '160px';
                table.style.overflowY = 'auto';
                table.textContent = pf.map(f => `${`${f.frame}`.padStart(4)} ${num(f.drawn).padStart(11)} +${num(f.appeared)} -${num(f.gone)}`).join('\n');
                body.appendChild(table);
            } else {
                action(i18n.t('node.stats.per-frame'), () => events.invoke('stats.perFrame', op));
            }
        } else if (op.seen.size > 1) {
            const counts = [...op.seen.values()];
            stat(i18n.t('node.stats.frames-seen'), num(counts.length));
            stat(i18n.t('node.stats.drawn'), `${num(Math.min(...counts))} - ${num(Math.max(...counts))}`);
        }
        note(i18n.t('node.stats.note'));
    }
};

export { buildInspectNode };

/**
 * While a viewer node is showing its point, a badge over the viewport says
 * so; clicking it goes back to the end of the chain.
 */
const registerViewerBadge = (events: Events) => {
    const badge = el('button', 'viewer-badge') as HTMLButtonElement;
    badge.type = 'button';
    Object.assign(badge.style, {
        position: 'absolute',
        top: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '10',
        padding: '4px 10px',
        border: '1px solid #f60',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.7)',
        color: '#fb7',
        font: '12px sans-serif',
        cursor: 'pointer',
        display: 'none'
    });
    badge.addEventListener('click', () => events.invoke('viewer.stop'));
    events.on('viewer.changed', (op: ViewerOp | null) => {
        const host = document.getElementById('canvas-container') ?? document.body;
        if (badge.parentElement !== host) host.appendChild(badge);
        badge.style.display = op ? '' : 'none';
        badge.textContent = op ? i18n.t('node.viewer.badge', { name: op.splat?.name ?? '' }) : '';
    });
};

export { registerViewerBadge };
