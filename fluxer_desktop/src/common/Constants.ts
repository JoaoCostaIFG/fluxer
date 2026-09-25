// SPDX-License-Identifier: AGPL-3.0-or-later

export const APP_PROTOCOL = 'fluxer';
// Fork: both release channels load the self-hosted instance instead of the hosted web client.
// Window.ts derives the trusted-origin allowlist (mic/camera `media` permission, privileged IPC)
// from these constants, so voice works on the instance without any launch flag.
export const STABLE_APP_URL = 'https://chat.joaocosta.dev';
export const CANARY_APP_URL = 'https://chat.joaocosta.dev';
export const STATIC_CDN_URL = 'https://fluxerstatic.com';
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
