// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Covers the fork updater path: with the fork env defines baked in the same way
// scripts/build.mjs bakes them, update checks must resolve to the fork's GitHub
// releases and must never reach the official update feed. On Windows the fork
// self-updates (setup download, silent reinstall); everywhere else it offers the
// fork's release assets as manual downloads.

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

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

const WINDOWS_SETUP_BYTES = Buffer.alloc(2048, 7);
const WINDOWS_SETUP_SHA256 = createHash('sha256').update(WINDOWS_SETUP_BYTES).digest('hex');
const WINDOWS_LATEST_RELEASE = {
	tag_name: 'v2026.926.1',
	published_at: '2026-09-26T10:00:00Z',
	assets: [
		{
			name: 'Fluxer-2026.926.1-Setup-win32-x64.exe',
			size: WINDOWS_SETUP_BYTES.length,
			browser_download_url: INSTALLER_URL,
		},
		{
			name: 'Fluxer-2026.926.1-Setup-win32-x64.exe.sha256',
			size: WINDOWS_SETUP_SHA256.length,
			browser_download_url: `${INSTALLER_URL}.sha256`,
		},
		{
			name: 'Fluxer-2026.926.1-win32-x64.zip',
			size: 2048,
			browser_download_url:
				'https://github.com/example/fluxer/releases/download/v2026.926.1/Fluxer-2026.926.1-win32-x64.zip',
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
	sidecarSha256 = null,
	applyAttempt = null,
}) {
	const isWindows = platform === 'win32';
	const userDataDirectory = mkdtempSync(join(tmpdir(), 'fluxer-fork-updater-'));
	const setupBytes = isWindows ? WINDOWS_SETUP_BYTES : null;
	const setupSidecar = isWindows ? (sidecarSha256 ?? WINDOWS_SETUP_SHA256) : null;
	const releasesApiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
	const defines = {
		'process.env.FLUXER_FORK_UPDATES': JSON.stringify(mode),
		'process.env.FLUXER_FORK_UPDATE_REPO': JSON.stringify(repo),
	};
	const events = [];
	const spawnCalls = [];
	const exitCodes = [];
	const handlers = new Map();
	const fetchUrls = [];
	let recordedApplyAttempt = applyAttempt;
	const module = {exports: {}};
	const stubs = {
		'@electron/main/UpdaterApplyState': {
			readVelopackApplyAttempt: () => recordedApplyAttempt,
			recordVelopackApplyAttempt: (recorded) => {
				recordedApplyAttempt = {version: recorded, attemptedAt: Date.now()};
			},
			clearVelopackApplyAttempt: () => {
				recordedApplyAttempt = null;
			},
		},
		'@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'},
		'@electron/common/UserDataPath': {isPortableMode: () => false},
		'@electron/main/DesktopTray': {destroyDesktopTray() {}},
		'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
		'@electron/main/Troubleshooting': {relaunchAndExit() {}},
		'@electron/main/Window': {setQuitting() {}},
		'node:child_process': {
			spawn: (...args) => {
				spawnCalls.push(args);
				return {unref() {}};
			},
		},
		'electron-log': {info() {}, warn() {}, error() {}, debug() {}},
		electron: {
			app: {
				isPackaged: true,
				getVersion: () => version,
				getPath: (name) => (name === 'userData' ? userDataDirectory : ''),
				on() {},
				relaunch() {},
				exit: (code) => {
					exitCodes.push(code);
				},
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
			if (url === releasesApiUrl && latestRelease != null) {
				return Promise.resolve({ok: true, status: 200, json: async () => latestRelease});
			}
			if (isWindows && url === INSTALLER_URL) {
				return Promise.resolve({
					ok: true,
					status: 200,
					headers: {get: (name) => (name === 'content-length' ? String(setupBytes.length) : null)},
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(setupBytes));
							controller.close();
						},
					}),
				});
			}
			if (isWindows && url === `${INSTALLER_URL}.sha256`) {
				return Promise.resolve({ok: true, status: 200, text: async () => setupSidecar});
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

	const forkWindowsUpdateSource = transform('ForkWindowsUpdate.ts', defines);
	const forkWindowsUpdateModule = {exports: {}};
	sandbox.module = forkWindowsUpdateModule;
	sandbox.exports = forkWindowsUpdateModule.exports;
	sandbox.__filename = forkWindowsUpdateSource.path;
	vm.runInContext(forkWindowsUpdateSource.code, context, {filename: forkWindowsUpdateSource.path});
	stubs['@electron/main/ForkWindowsUpdate'] = forkWindowsUpdateModule.exports;

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
		spawnCalls,
		exitCodes,
		userDataDirectory,
		getApplyAttempt: () => recordedApplyAttempt,
		cleanup: () => {
			rmSync(userDataDirectory, {recursive: true, force: true});
		},
		check: () => handlers.get('updater-check')({}, 'user'),
		install: () => handlers.get('updater-install')({}),
	};
}

describe('Fork updater', () => {
	test('github mode offers the fork release assets without touching the official feed', async () => {
		const fork = loadForkUpdater({mode: 'github'});
		try {
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
		} finally {
			fork.cleanup();
		}
	});

	test('github mode reports not-available when the fork release is not newer', async () => {
		const fork = loadForkUpdater({mode: 'github', version: '2026.926.1'});
		try {
			await fork.check();
			assert.ok(fork.events.some((event) => event.type === 'not-available'));
		} finally {
			fork.cleanup();
		}
	});

	test('github mode reports not-available when the fork repository has no releases', async () => {
		const fork = loadForkUpdater({mode: 'github', repo: 'example/empty', latestRelease: null});
		try {
			await fork.check();
			assert.ok(fork.events.some((event) => event.type === 'not-available'));
		} finally {
			fork.cleanup();
		}
	});

	test('disabled mode reports not-available without any network request', async () => {
		const fork = loadForkUpdater({mode: 'disabled', repo: ''});
		try {
			await fork.check();
			assert.equal(fork.fetchUrls.length, 0, 'disabled mode must not hit the network');
			assert.ok(fork.events.some((event) => event.type === 'not-available'));
		} finally {
			fork.cleanup();
		}
	});
});

describe('Fork updater (Windows)', () => {
	test('github mode downloads the setup asset in-app with progress', async (t) => {
		const fork = loadForkUpdater({mode: 'github', platform: 'win32', latestRelease: WINDOWS_LATEST_RELEASE});
		t.after(() => fork.cleanup());
		await fork.check();
		assert.ok(
			fork.fetchUrls.every((url) => url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/')),
			`fork mode must never reach the official feed: ${JSON.stringify(fork.fetchUrls)}`,
		);
		const available = fork.events.find((event) => event.type === 'available');
		assert.ok(available, `expected an available event, got ${JSON.stringify(fork.events)}`);
		assert.equal(available.version, '2026.926.1');
		assert.equal(available.downloadStarted, true, 'the setup download starts without waiting for a click');
		assert.equal(available.downloadSize, WINDOWS_SETUP_BYTES.length);
		const progress = fork.events.filter((event) => event.type === 'progress');
		assert.ok(progress.length > 0, 'expected download progress events');
		assert.equal(progress.at(-1).percent, 100);
		const downloaded = fork.events.find((event) => event.type === 'downloaded');
		assert.ok(downloaded, 'expected a downloaded event');
		assert.equal(downloaded.version, '2026.926.1');
		assert.ok(
			existsSync(join(fork.userDataDirectory, 'updates', 'Fluxer-2026.926.1-Setup-win32-x64.exe')),
			'the verified setup asset must be kept in the user data directory',
		);
	});

	test('the restart prompt reinstalls silently and lets the installer relaunch the app', async (t) => {
		const fork = loadForkUpdater({mode: 'github', platform: 'win32', latestRelease: WINDOWS_LATEST_RELEASE});
		t.after(() => fork.cleanup());
		await fork.check();
		await fork.install();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fork.spawnCalls.length, 1, 'the setup installer must be spawned exactly once');
		const [command, args, options] = fork.spawnCalls[0];
		assert.ok(String(command).endsWith('Fluxer-2026.926.1-Setup-win32-x64.exe'));
		assert.deepEqual(
			[...args],
			['/S', '--force-run'],
			'silent reinstall that relaunches the app, like electron-updater',
		);
		assert.equal(options.detached, true);
		assert.equal(options.stdio, 'ignore');
		assert.equal(options.windowsHide, true);
		assert.deepEqual(fork.exitCodes, [0], 'the app must quit so the installer can replace it');
		assert.equal(fork.getApplyAttempt()?.version, '2026.926.1', 'the install attempt is recorded before quitting');
	});

	test('a checksum mismatch fails the download and offers the manual installer', async (t) => {
		const fork = loadForkUpdater({
			mode: 'github',
			platform: 'win32',
			latestRelease: WINDOWS_LATEST_RELEASE,
			sidecarSha256: 'ab'.repeat(32),
		});
		t.after(() => fork.cleanup());
		await fork.check();
		const error = fork.events.find((event) => event.type === 'error');
		assert.ok(error, `expected an error event, got ${JSON.stringify(fork.events)}`);
		assert.equal(error.phase, 'download');
		const available = fork.events.filter((event) => event.type === 'available').at(-1);
		assert.ok(available, 'the manual installer offer must follow the failed download');
		assert.equal(available.downloadStarted, false);
		assert.equal(available.downloadUrl, INSTALLER_URL);
		assert.deepEqual(
			readdirSync(join(fork.userDataDirectory, 'updates')),
			[],
			'a failed download must leave no setup file behind',
		);
	});

	test('an already-downloaded setup is offered again without re-downloading', async (t) => {
		const fork = loadForkUpdater({mode: 'github', platform: 'win32', latestRelease: WINDOWS_LATEST_RELEASE});
		t.after(() => fork.cleanup());
		await fork.check();
		assert.equal(fork.fetchUrls.filter((url) => url === INSTALLER_URL).length, 1);
		await fork.check();
		assert.equal(
			fork.fetchUrls.filter((url) => url === INSTALLER_URL).length,
			1,
			'the verified setup file must be reused',
		);
		assert.ok(
			fork.events.filter((event) => event.type === 'downloaded').length >= 2,
			'the pending update must be reported as downloaded again',
		);
	});

	test('a failed install surfaces the error and offers the manual installer', async (t) => {
		const fork = loadForkUpdater({
			mode: 'github',
			platform: 'win32',
			latestRelease: WINDOWS_LATEST_RELEASE,
			version: '2026.925.0',
			applyAttempt: {version: '2026.926.1', attemptedAt: 1},
		});
		t.after(() => fork.cleanup());
		await fork.check();
		const error = fork.events.find((event) => event.type === 'error');
		assert.ok(error, `expected an error event, got ${JSON.stringify(fork.events)}`);
		assert.equal(error.phase, 'install');
		const available = fork.events.find((event) => event.type === 'available');
		assert.ok(available, 'the manual installer offer must follow the failed install');
		assert.equal(available.downloadUrl, INSTALLER_URL);
	});
});
