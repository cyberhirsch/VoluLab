/// <reference types="@webgpu/types" />
/// <reference types="wicg-file-system-access" />

interface FileSystemFileHandle {
    remove(): Promise<void>;
}

// injected per build by rollup (see rollup.config.mjs) so the service worker
// gets a fresh cache name every deploy
declare const __BUILD_ID__: string;

declare module '*.png' {
    const value: any;
    export default value;
}

declare module '*.svg' {
    const value: any;
    export default value;
}

declare module '*.scss' {
    const value: any;
    export default value;
}
