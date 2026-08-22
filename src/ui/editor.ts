import { Container } from '@playcanvas/pcui';
import { Mat4 } from 'playcanvas';

import { DataPanel } from './data-panel';
import { Events } from '../events';
import { BottomToolbar } from './bottom-toolbar';
import { CameraFace } from './camera-face';
import { CameraInfoOverlay } from './camera-info-overlay';
import { ColorPanel } from './color-panel';
import { ExportPopup } from './export-popup';
import { GraphPanel } from './graph-panel';
import { ImageSettingsDialog } from './image-settings-dialog';
import { ImportFace } from './import-face';
import { i18n } from './localization';
import { Menu } from './menu';
import { NodePanel } from './node-panel';
import { OutlinerPanel } from './outliner-panel';
import { Popup, ShowOptions } from './popup';
import { Progress } from './progress';
import { PublishSettingsDialog } from './publish-settings-dialog';
import { RightToolbar } from './right-toolbar';
import { SettingsPanel } from './settings-panel';
import { Spinner } from './spinner';
import { StatusBar } from './status-bar';
import { TimelinePanel } from './timeline-panel';
import { Tooltips } from './tooltips';
import { TrainingFace } from './training-face';
import { TransformPanel } from './transform-panel';
import { VideoSettingsDialog } from './video-settings-dialog';
import { ViewCube } from './view-cube';
import { ViewModeOverlay } from './view-mode-overlay';
import logo from './volulab-logo.png';
import { PaneKind } from '../workspace';
import { WorkspaceView } from './workspace-view';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

class EditorUI {
    appContainer: Container;
    topContainer: Container;
    canvasContainer: Container;
    toolsContainer: Container;
    canvas: HTMLCanvasElement;
    popup: Popup;
    tooltips: Tooltips;

    constructor(events: Events) {
        // favicon
        const link = document.createElement('link');
        link.rel = 'icon';
        link.href = logo;
        document.head.appendChild(link);

        // app
        const appContainer = new Container({
            id: 'app-container'
        });

        // editor
        const editorContainer = new Container({
            id: 'editor-container'
        });

        // tooltips container
        const tooltipsContainer = new Container({
            id: 'tooltips-container'
        });

        // top container
        const topContainer = new Container({
            id: 'top-container'
        });

        // canvas
        const canvas = document.createElement('canvas');
        canvas.id = 'canvas';

        // canvas container
        const canvasContainer = new Container({
            id: 'canvas-container'
        });

        // tools container
        const toolsContainer = new Container({
            id: 'tools-container'
        });

        // tooltips
        const tooltips = new Tooltips();
        tooltipsContainer.append(tooltips);

        // bottom toolbar
        const outlinerPanel = new OutlinerPanel(events, tooltips);
        const transformPanel = new TransformPanel(events);
        const settingsPanel = new SettingsPanel(events, tooltips);
        const colorPanel = new ColorPanel(events, tooltips);
        const bottomToolbar = new BottomToolbar(events, tooltips);
        const rightToolbar = new RightToolbar(events, tooltips);
        const menu = new Menu(events);
        const cameraInfoOverlay = new CameraInfoOverlay(events, tooltips);

        // The viewport pane owns the canvas and the chrome that is anchored to
        // it. The scene/settings/color panels are no longer floated here -
        // they are pane kinds now, registered with the workspace below.
        canvasContainer.dom.appendChild(canvas);
        canvasContainer.append(cameraInfoOverlay);
        canvasContainer.append(new ViewModeOverlay(events));
        canvasContainer.append(toolsContainer);
        canvasContainer.append(bottomToolbar);
        canvasContainer.append(rightToolbar);

        // view axes container
        const viewCube = new ViewCube(events);
        canvasContainer.append(viewCube);
        events.on('prerender', (cameraMatrix: Mat4) => {
            viewCube.update(cameraMatrix);
        });

        // main container
        const mainContainer = new Container({
            id: 'main-container'
        });

        const timelinePanel = new TimelinePanel(events, tooltips);
        const dataPanel = new DataPanel(events, tooltips);
        const graphPanel = new GraphPanel(events);
        const nodePanel = new NodePanel(events);
        // training is a node now: its controls are the train node's face,
        // mounted in the node pane the way the colour panel is. The dataset
        // import node carries the pickers on a face of its own.
        const trainingFace = new TrainingFace(events);
        nodePanel.mount('train', trainingFace.dom);
        const importFace = new ImportFace(events);
        nodePanel.mount('dataset', importFace.dom);
        // the camera node's exposure, depth of field and lens
        const cameraFace = new CameraFace(events);
        nodePanel.mount('camera', cameraFace.dom);
        // the colour controls are a node's parameters now, so they live inside
        // the node pane rather than in a pane of their own
        nodePanel.mount('colour', colorPanel.dom);
        const statusBar = new StatusBar(events, tooltips);

        // panels are pane content now, so they are always "shown" - the
        // workspace decides whether a pane is currently claiming them
        timelinePanel.hidden = false;
        dataPanel.hidden = false;
        settingsPanel.hidden = false;
        colorPanel.hidden = false;
        outlinerPanel.hidden = false;
        transformPanel.hidden = false;
        nodePanel.hidden = false;
        graphPanel.hidden = false;

        const workspace = new WorkspaceView({
            onChange: () => events.fire('workspace.changed')
        });

        workspace.register('viewport', canvasContainer.dom);
        workspace.register('outliner', outlinerPanel.dom);
        workspace.register('graph', graphPanel.dom);
        workspace.register('node', nodePanel.dom);
        workspace.register('transform', transformPanel.dom);
        workspace.register('timeline', timelinePanel.dom);
        workspace.register('data', dataPanel.dom);
        workspace.register('settings', settingsPanel.dom);
        workspace.rebuild();

        // flows that need a pane on screen (retrain, the graph's add-training
        // entry) route through here rather than touching the workspace directly
        events.on('workspace.reveal', (kind: PaneKind) => {
            workspace.reveal(kind);
        });

        // the workspace travels in the document, so a project opens in the
        // arrangement it was built in
        events.function('docSerialize.layout', () => workspace.serializeLayout());
        events.on('docDeserialize.layout', (state: any) => {
            if (state) {
                workspace.deserializeLayout(state);
            }
        });

        // the viewport header says which backend is drawing it. Fired from
        // main.ts once the device exists, which is after this UI is built.
        events.on('graphicsDevice.created', (deviceType: string) => {
            workspace.setViewportBadge(deviceType);
        });

        // the menu bar is global chrome, above the pane tree
        mainContainer.append(menu);
        mainContainer.append(workspace);
        mainContainer.append(statusBar);

        editorContainer.append(mainContainer);

        // message popup
        const popup = new Popup(tooltips);

        // export popup
        const exportPopup = new ExportPopup(events);

        // publish settings
        const publishSettingsDialog = new PublishSettingsDialog(events);

        // image settings
        const imageSettingsDialog = new ImageSettingsDialog(events);

        // video settings
        const videoSettingsDialog = new VideoSettingsDialog(events);

        topContainer.append(popup);
        topContainer.append(exportPopup);
        topContainer.append(publishSettingsDialog);
        topContainer.append(imageSettingsDialog);
        topContainer.append(videoSettingsDialog);

        appContainer.append(editorContainer);
        appContainer.append(topContainer);
        appContainer.append(tooltipsContainer);

        this.appContainer = appContainer;
        this.topContainer = topContainer;
        this.canvasContainer = canvasContainer;
        this.toolsContainer = toolsContainer;
        this.canvas = canvas;
        this.popup = popup;
        this.tooltips = tooltips;

        document.body.appendChild(appContainer.dom);
        document.body.setAttribute('tabIndex', '-1');

        // don't let pointer-clicked buttons keep focus (which would swallow
        // control keys like Space from the global shortcuts). keyboard
        // activation (e.detail === 0) keeps focus for tab navigation, and
        // modals keep focus inside so their shortcut blocking stays intact
        document.addEventListener('click', (e) => {
            if (e.detail === 0) return;
            const button = (e.target as Element)?.closest?.('button');
            if (button && button === document.activeElement && !button.closest('.blocks-shortcuts')) {
                button.blur();
            }
        });

        events.function('show.exportPopup', (exportType, splatNames: [string], showFilenameEdit: boolean) => {
            return exportPopup.show(exportType, splatNames, showFilenameEdit);
        });

        events.function('show.publishSettingsDialog', async () => {
            // show popup if user isn't logged in
            const userStatus = await events.invoke('publish.userStatus');
            if (!userStatus) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: i18n.t('popup.publish.please-log-in')
                });
                return false;
            }

            // get user publish settings
            const publishSettings = await publishSettingsDialog.show(userStatus);

            // do publish
            if (publishSettings) {
                await events.invoke('scene.publish', publishSettings);
            }
        });

        events.function('show.imageSettingsDialog', async () => {
            const imageSettings = await imageSettingsDialog.show();

            if (imageSettings) {
                try {
                    let writable;
                    let fileHandle: FileSystemFileHandle | undefined;

                    const imageFileTypes: Record<string, { description: string, accept: Record<`${string}/${string}`, `.${string}`[]>, extension: string }> = {
                        png: { description: 'PNG Image', accept: { 'image/png': ['.png'] }, extension: '.png' },
                        jpeg: { description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] }, extension: '.jpg' },
                        webp: { description: 'WebP Image', accept: { 'image/webp': ['.webp'] }, extension: '.webp' }
                    };
                    const imageFileType = imageFileTypes[imageSettings.format];

                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'VoluLabImageFileExport',
                            types: [{
                                description: imageFileType.description,
                                accept: imageFileType.accept
                            }],
                            suggestedName: `${events.invoke('render.baseFilename')}${imageFileType.extension}`
                        });

                        writable = await fileHandle.createWritable();
                    }

                    const result = await events.invoke('render.image', imageSettings, writable);

                    // if the render failed, remove the empty file left on disk
                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        // user cancelled save dialog
                        return;
                    }

                    await events.invoke('showPopup', {
                        type: 'error',
                        header: i18n.t('panel.render.failed'),
                        message: `'${error.message ?? error}'`
                    });
                }
            }
        });

        events.function('show.videoSettingsDialog', async () => {
            const videoSettings = await videoSettingsDialog.show();

            if (videoSettings) {

                try {
                    // Determine file extension and mime type based on format
                    let fileExtension: string;
                    let filePickerTypes: FilePickerAcceptType[];

                    // Codec name mapping for display
                    const codecNames: Record<string, string> = {
                        'h264': 'H.264',
                        'h265': 'H.265',
                        'vp9': 'VP9',
                        'av1': 'AV1'
                    };
                    const codecName = codecNames[videoSettings.codec] || videoSettings.codec.toUpperCase();

                    if (videoSettings.format === 'webm') {
                        fileExtension = '.webm';
                        filePickerTypes = [{
                            description: `WebM Video (${codecName})`,
                            accept: { 'video/webm': ['.webm'] }
                        }];
                    } else if (videoSettings.format === 'mov') {
                        fileExtension = '.mov';
                        filePickerTypes = [{
                            description: `MOV Video (${codecName})`,
                            accept: { 'video/quicktime': ['.mov'] }
                        }];
                    } else if (videoSettings.format === 'mkv') {
                        fileExtension = '.mkv';
                        filePickerTypes = [{
                            description: `MKV Video (${codecName})`,
                            accept: { 'video/x-matroska': ['.mkv'] }
                        }];
                    } else {
                        fileExtension = '.mp4';
                        filePickerTypes = [{
                            description: `MP4 Video (${codecName})`,
                            accept: { 'video/mp4': ['.mp4'] }
                        }];
                    }

                    const suggested = `${events.invoke('render.baseFilename')}${fileExtension}`;

                    let writable;
                    let fileHandle: FileSystemFileHandle | undefined;

                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'VoluLabVideoFileExport',
                            types: filePickerTypes,
                            suggestedName: suggested
                        });

                        writable = await fileHandle.createWritable();
                    }

                    const result = await events.invoke('render.video', videoSettings, writable);

                    // if the render was cancelled, remove the empty file left on disk
                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        // user cancelled save dialog
                        return;
                    }

                    await events.invoke('showPopup', {
                        type: 'error',
                        header: i18n.t('panel.render.failed'),
                        message: `'${error.message ?? error}'`
                    });
                }
            }
        });

        events.function('showPopup', (options: ShowOptions) => {
            return this.popup.show(options);
        });

        // spinner with reference counting to handle nested operations
        const spinner = new Spinner();
        topContainer.append(spinner);

        let spinnerCount = 0;

        events.on('startSpinner', () => {
            spinnerCount++;
            if (spinnerCount === 1) {
                spinner.hidden = false;
            }
        });

        events.on('stopSpinner', () => {
            spinnerCount = Math.max(0, spinnerCount - 1);
            if (spinnerCount === 0) {
                spinner.hidden = true;
            }
        });

        // progress

        const progress = new Progress();

        topContainer.append(progress);

        events.on('progressStart', (header: string, cancellable?: boolean) => {
            progress.hidden = false;
            progress.setHeader(header);
            progress.setText('');
            progress.setProgress(0);
            progress.showCancelButton(!!cancellable);
            progress.onCancel = cancellable ? () => events.fire('progressCancel') : null;
        });

        events.on('progressUpdate', (options: { text?: string, progress?: number }) => {
            if (options.text !== undefined) {
                progress.setText(options.text);
            }
            if (options.progress !== undefined) {
                progress.setProgress(options.progress);
            }
        });

        events.on('progressEnd', () => {
            progress.hidden = true;
            progress.showCancelButton(false);
            progress.onCancel = null;
        });

        // initialize canvas to correct size before creating graphics device etc
        const pixelRatio = window.devicePixelRatio;
        canvas.width = Math.ceil(canvasContainer.dom.offsetWidth * pixelRatio);
        canvas.height = Math.ceil(canvasContainer.dom.offsetHeight * pixelRatio);

        ['contextmenu', 'gesturestart', 'gesturechange', 'gestureend'].forEach((event) => {
            document.addEventListener(event, (e) => {
                e.preventDefault();
            }, true);
        });

        // whenever the canvas container is clicked, set keyboard focus on the body
        canvasContainer.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            // set focus on the body if user is busy pressing on the canvas or a child of the tools
            // element
            if (event.target === canvas || toolsContainer.dom.contains(event.target as Node)) {
                document.body.focus();
            }
        }, true);
    }
}

export { EditorUI };
