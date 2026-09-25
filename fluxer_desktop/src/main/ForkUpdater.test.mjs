// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Covers the fork updater path: with the fork env defines baked in the same way
// scripts/build.mjs bakes them, update checks must resolve to the fork's GitHub
// releases (manual downloads only) and must never reach the official update feed.

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const RELEASES_API_URL = 'https://api.github.com/repos/example/fluxer/releases/latest';
const INSTALLER_URL =
	'https://github.com/example/fluxer/releases/download/v2026.926.1/Fluxer-2026.926.1-Setup-win32-x64.exe';
const APPIMAGE_URL =
	'https://github.com/example/fluxer/releases/download/v2026.926.1/Fluxer-2026.926.1-linux-x64.AppImage';
const DEB_URL = 'https://github.com/example/fluxer/releases/download/v2026.926.1/Fluxer-2026.926.1-linux-amd64.deb';
const ARM_APPIMAGE_URL =
	'https://github.com/example/fluxer/releases/download/v2026.926.1/Fluxer-2026.926.1-linux-arm64.AppImage';

const LATEST_RELEASE = {
	tag_name: 'v2026.926.1',
	published_at: '2026-09-26T10:00:00Z',
	assets: [
		{
			name: 'Fluxer-2026.926.1-Setup-win32-x64.exe',
			browser_download_url: INSTALLER_URL,
		},
		{
			name: 'Fluxer-2026.926.1-win32-x64.zip',
			browser_download_url:
				'https://github.com/example/fluxer/releases/download/v2026.926.1/Fluxer-2026.926.1-win32-x64.zip',
		},
		{
			name: 'Fluxer-2026.926.1-linux-x64.AppImage',
			browser_download_url: APPIMAGE_URL,
		},
		{
			name: 'Fluxer-2026.926.1-linux-amd64.deb',
			browser_download_url: DEB_URL,
		},
		{
			name: 'Fluxer-2026.926.1-linux-arm64.AppImage',
			browser_download_url: ARM_APPIMAGE_URL,
		},
	],
};

function transform(name, defines) {
	const url = new URL(`./${name}`, import.meta.url);
	const path = fileURLToPath(url);
	return {
		path,
		code: esbuild.transformSync(readFileSync(path, 'utf8'), {
			loader: 'ts',
			format: 'cjs',
			platform: 'node',
			target: 'node20',
			define: {'import.meta.url': JSON.stringify(url.href), ...defines},
		}).code,
	};
}

function loadForkUpdater({
	mode,
	repo = 'example/fluxer',
	latestRelease = LATEST_RELEASE,
	platform = 'linux',
	version = '2026.925.0',
}) {
	const defines = {
		'process.env.FLUXER_FORK_UPDATES': JSON.stringify(mode),
		'process.env.FLUXER_FORK_UPDATE_REPO': JSON.stringify(repo),
	};
	const events = [];
	const handlers = new Map();
	const fetchUrls = [];
	const module = {exports: {}};
	const stubs = {
		'@electron/main/UpdaterApplyState': {
			readVelopackApplyAttempt: () => null,
			recordVelopackApplyAttempt() {},
			clearVelopackApplyAttempt() {},
		},
		'@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'},
		'@electron/common/UserDataPath': {isPortableMode: () => false},
		'@electron/main/DesktopTray': {destroyDesktopTray() {}},
		'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
		'@electron/main/Troubleshooting': {relaunchAndExit() {}},
		'@electron/main/Window': {setQuitting() {}},
		'electron-log': {info() {}, warn() {}, error() {}, debug() {}},
		electron: {
			app: {
				isPackaged: true,
				getVersion: () => version,
				on() {},
				relaunch() {},
				exit() {},
			},
			autoUpdater: {on() {}},
			ipcMain: {
				handle(channel, handler) {
					handlers.set(channel, handler);
				},
			},
		},
	};
	const sandbox = {
		console,
		Buffer,
		process: {platform, arch: 'x64', execPath: process.execPath, env: {}},
		setTimeout,
		clearTimeout,
		setImmediate,
		fetch: (input) => {
			const url = String(input);
			fetchUrls.push(url);
			if (url === RELEASES_API_URL && latestRelease != null) {
				return Promise.resolve({ok: true, status: 200, json: async () => latestRelease});
			}
			return Promise.resolve({ok: false, status: 404, json: async () => ({})});
		},
		require: (specifier) => stubs[specifier] ?? require(specifier),
	};
	const context = vm.createContext(sandbox);

	const appImageSource = transform('AppImageUpdate.ts', defines);
	const appImageModule = {exports: {}};
	sandbox.module = appImageModule;
	sandbox.exports = appImageModule.exports;
	sandbox.__filename = appImageSource.path;
	vm.runInContext(appImageSource.code, context, {filename: appImageSource.path});
	stubs['@electron/main/AppImageUpdate'] = appImageModule.exports;

	const updaterDownloadsSource = transform('UpdaterDownloads.ts', defines);
	const updaterDownloadsModule = {exports: {}};
	sandbox.module = updaterDownloadsModule;
	sandbox.exports = updaterDownloadsModule.exports;
	sandbox.__filename = updaterDownloadsSource.path;
	vm.runInContext(updaterDownloadsSource.code, context, {filename: updaterDownloadsSource.path});
	stubs['@electron/main/UpdaterDownloads'] = updaterDownloadsModule.exports;

	const updaterSource = transform('Updater.ts', defines);
	sandbox.module = module;
	sandbox.exports = module.exports;
	sandbox.__filename = updaterSource.path;
	vm.runInContext(updaterSource.code, context, {filename: updaterSource.path});

	module.exports.registerUpdater(() => ({
		webContents: {send: (_channel, event) => events.push(event)},
	}));
	return {
		events,
		fetchUrls,
		check: () => handlers.get('updater-check')({}, 'user'),
	};
}

describe('Fork updater', () => {
	test('github mode offers the fork release assets without touching the official feed', async () => {
		const fork = loadForkUpdater({mode: 'github'});
		await fork.check();
		assert.ok(
			fork.fetchUrls.every((url) => !url.includes('pkgs.fluxer.com')),
			`fork mode must never reach the official feed: ${JSON.stringify(fork.fetchUrls)}`,
		);
		const available = fork.events.find((event) => event.type === 'available');
		assert.ok(available, `expected an available event, got ${JSON.stringify(fork.events)}`);
		assert.equal(available.version, '2026.926.1');
		assert.equal(available.downloadUrl, APPIMAGE_URL);
		const downloadOptions = available.downloadOptions;
		assert.deepEqual(
			[...downloadOptions.map((option) => option.format)].sort(),
			['appimage', 'deb'],
			'only formats with a published fork asset are offered',
		);
		assert.ok(downloadOptions.every((option) => option.url.startsWith('https://github.com/example/fluxer/')));
		assert.ok(
			!downloadOptions.some((option) => option.url === ARM_APPIMAGE_URL),
			'arm64 assets must not be offered to an x64 client',
		);
	});

	test('github mode reports not-available when the fork release is not newer', async () => {
		const fork = loadForkUpdater({mode: 'github', version: '2026.926.1'});
		await fork.check();
		assert.ok(fork.events.some((event) => event.type === 'not-available'));
	});

	test('github mode reports not-available when the fork repository has no releases', async () => {
		const fork = loadForkUpdater({mode: 'github', repo: 'example/empty', latestRelease: null});
		await fork.check();
		assert.ok(fork.events.some((event) => event.type === 'not-available'));
	});

	test('disabled mode reports not-available without any network request', async () => {
		const fork = loadForkUpdater({mode: 'disabled', repo: ''});
		await fork.check();
		assert.equal(fork.fetchUrls.length, 0, 'disabled mode must not hit the network');
		assert.ok(fork.events.some((event) => event.type === 'not-available'));
	});
});
