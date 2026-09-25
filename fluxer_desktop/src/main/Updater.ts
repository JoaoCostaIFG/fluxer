// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRequire} from 'node:module';
import {isPortableMode} from '@electron/common/UserDataPath';
import {
	AppImageChecksumError,
	AppImageStagingError,
	type AppImageTarget,
	applyStagedAppImageUpdate,
	discardStagedAppImageUpdate,
	isRunningFromAppImage,
	resolveAppImageTarget,
	type StagedAppImageUpdate,
	stageAppImageUpdate,
	sweepAbandonedAppImageUpdates,
} from '@electron/main/AppImageUpdate';
import {destroyDesktopTray} from '@electron/main/DesktopTray';
import {
	downloadForkSetupFile,
	ForkSetupChecksumError,
	type ForkSetupDownloadProgress,
	fetchForkSetupChecksum,
	findVerifiedForkSetupFile,
	getForkSetupFileName,
	getForkUpdatesDirectory,
	launchForkSetupInstaller,
	removeOtherForkSetupFiles,
} from '@electron/main/ForkWindowsUpdate';
import {isFlatpakRuntime} from '@electron/main/LinuxSandbox';
import {relaunchAndExit} from '@electron/main/Troubleshooting';
import {
	clearVelopackApplyAttempt,
	readVelopackApplyAttempt,
	recordVelopackApplyAttempt,
	type VelopackApplyAttempt,
} from '@electron/main/UpdaterApplyState';
import {
	buildManualVersionDownloadUrl,
	DOWNLOAD_PAGE_URL,
	FORK_RELEASES_API_URL,
	FORK_UPDATE_REPO,
	getManualDownloadOptions,
	getManualDownloadUrl,
	MANUAL_DESKTOP_FORMATS,
	type ManualDesktopFormat,
	type ManualLatestFile,
	type ManualLatestInfo,
	UPDATE_BASE_URL,
	type UpdaterDownloadOption,
} from '@electron/main/UpdaterDownloads';
import {setQuitting} from '@electron/main/Window';
import {app, autoUpdater, type BrowserWindow, ipcMain} from 'electron';
import log from 'electron-log';
import type {UpdateInfo, VelopackAsset} from 'velopack';

type UpdaterContext = 'user' | 'background' | 'focus';
type UpdaterEvent =
	| {
			type: 'checking';
			context: UpdaterContext;
	  }
	| {
			type: 'available';
			context: UpdaterContext;
			version?: string | null;
			downloadSize?: number | null;
			downloadStarted: boolean;
			downloadUrl?: string;
			downloadOptions?: Array<UpdaterDownloadOption>;
	  }
	| {
			type: 'not-available';
			context: UpdaterContext;
	  }
	| {
			type: 'downloaded';
			context: UpdaterContext;
			version?: string | null;
	  }
	| {
			type: 'progress';
			context: UpdaterContext;
			percent: number;
			transferred: number;
			total: number;
			bytesPerSecond: number;
	  }
	| {
			type: 'error';
			context: UpdaterContext;
			message: string;
			phase?: 'check' | 'download' | 'install';
	  }
	| {
			type: 'unsupported';
			context: UpdaterContext;
			reason: 'platform' | 'unpackaged' | 'managed-package';
			downloadUrl?: string;
	  };

const requireModule = createRequire(import.meta.url);

// Fork update mode, baked in at build time by scripts/build.mjs from FLUXER_FORK_UPDATE_REPO:
// '' (unset) keeps the official upstream behaviour for development and tests, 'github' serves
// manual update checks from the fork's GitHub releases, 'disabled' never checks for updates.
// The undefined-env guard keeps vm-hosted tests working.
const FORK_UPDATES = process.env === undefined ? '' : (process.env.FLUXER_FORK_UPDATES ?? '');

let lastContext: UpdaterContext = 'background';
type VelopackUpdate = UpdateInfo | VelopackAsset;

let pendingVelopackUpdate: VelopackUpdate | null = null;
let velopackCheckPromise: Promise<void> | null = null;
let velopackDownloadPromise: Promise<void> | null = null;
let velopackInstallStarted = false;
let pendingAppImageUpdate: PendingAppImageUpdate | null = null;
let appImageUpdatePromise: Promise<void> | null = null;
let appImageInstallStarted = false;
// Fork: Windows self-update state. The NSIS setup asset for one version at a time is
// downloaded into the user data directory and kept across restarts, so a downloaded
// update that was never installed is offered again without re-downloading.
type PendingForkSetupUpdate = {version: string; setupPath: string; sha256: string};
let pendingForkSetup: PendingForkSetupUpdate | null = null;
let forkSetupCheckPromise: Promise<void> | null = null;
let forkSetupInstallStarted = false;

const UPDATE_DOWNLOAD_MAX_ATTEMPTS = 5;
const UPDATE_DOWNLOAD_RETRY_BASE_DELAY_MS = 3000;
const UPDATE_DOWNLOAD_RETRY_MAX_DELAY_MS = 60000;
const ELECTRON_DOWNLOAD_MAX_RETRIES = 4;
const UPDATE_PROGRESS_SAMPLE_INTERVAL_MS = 500;

type PendingAppImageUpdate = {version: string; target: AppImageTarget; staged: StagedAppImageUpdate};

function send(win: BrowserWindow | null, event: UpdaterEvent) {
	win?.webContents.send('updater-event', event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function backoffDelay(attempt: number): number {
	const exponential = UPDATE_DOWNLOAD_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
	const capped = Math.min(exponential, UPDATE_DOWNLOAD_RETRY_MAX_DELAY_MS);
	return Math.round(capped * (0.5 + Math.random() * 0.5));
}

function getVelopackAsset(update: VelopackUpdate): VelopackAsset {
	return 'TargetFullRelease' in update ? update.TargetFullRelease : update;
}

function getVelopackUpdateVersion(update: VelopackUpdate): string | null {
	return getVelopackAsset(update).Version ?? null;
}

function getVelopackUpdateSize(update: VelopackUpdate): number | null {
	const raw = getVelopackAsset(update).Size;
	if (raw == null) return null;
	if (typeof raw === 'bigint') {
		return Number(raw);
	}
	return Number(raw);
}

function createVelopackUpdateManager() {
	const {UpdateManager} = requireModule('velopack') as typeof import('velopack');
	return new UpdateManager(UPDATE_BASE_URL);
}

type VelopackUpdateManager = ReturnType<typeof createVelopackUpdateManager>;

function getInstalledVelopackVersion(updateManager: VelopackUpdateManager): string | null {
	try {
		const version = updateManager.getCurrentVersion();
		return typeof version === 'string' && version.length > 0 ? version : null;
	} catch (error) {
		log.warn('Failed to read the installed Velopack version', error);
		return null;
	}
}

function resolveFailedVelopackApply(updateManager: VelopackUpdateManager): VelopackApplyAttempt | null {
	const attempt = readVelopackApplyAttempt();
	if (!attempt) {
		return null;
	}
	const installedVersion = getInstalledVelopackVersion(updateManager) ?? app.getVersion();
	if (compareVersions(installedVersion, attempt.version) >= 0) {
		clearVelopackApplyAttempt();
		return null;
	}
	return attempt;
}

async function sendVelopackApplyFailure(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
	attempt: VelopackApplyAttempt,
): Promise<void> {
	log.error('A downloaded update was never applied, so the installer is offered instead.', attempt);
	send(getMainWindow(), {
		type: 'error',
		context,
		phase: 'install',
		message: `Fluxer could not finish installing version ${attempt.version}.`,
	});
	try {
		const latest = await fetchManualLatest({forceRefresh: true});
		sendManualUpdateAvailable(getMainWindow, context, latest);
		return;
	} catch (error) {
		log.warn('Failed to resolve the installer download after a failed update apply', error);
	}
	send(getMainWindow(), {
		type: 'available',
		context,
		version: attempt.version,
		downloadSize: null,
		downloadStarted: false,
		downloadUrl: buildManualVersionDownloadUrl(attempt.version, 'setup'),
	});
}

async function checkVelopackForUpdates(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
): Promise<void> {
	if (velopackCheckPromise) {
		return velopackCheckPromise;
	}
	velopackCheckPromise = (async () => {
		try {
			send(getMainWindow(), {type: 'checking', context});
			const updateManager = createVelopackUpdateManager();
			const failedApply = resolveFailedVelopackApply(updateManager);
			if (failedApply) {
				await sendVelopackApplyFailure(context, getMainWindow, failedApply);
				return;
			}
			const pendingUpdate = updateManager.getUpdatePendingRestart();
			const update = await updateManager.checkForUpdatesAsync();
			if (!update) {
				if (pendingUpdate) {
					pendingVelopackUpdate = pendingUpdate;
					send(getMainWindow(), {
						type: 'downloaded',
						context,
						version: getVelopackUpdateVersion(pendingUpdate),
					});
					return;
				}
				pendingVelopackUpdate = null;
				send(getMainWindow(), {type: 'not-available', context});
				return;
			}
			if (pendingUpdate) {
				const pendingVersion = getVelopackUpdateVersion(pendingUpdate);
				const updateVersion = getVelopackUpdateVersion(update);
				if (pendingVersion && updateVersion && compareVersions(updateVersion, pendingVersion) <= 0) {
					pendingVelopackUpdate = pendingUpdate;
					send(getMainWindow(), {
						type: 'downloaded',
						context,
						version: pendingVersion,
					});
					return;
				}
				log.info('Newer Velopack update found while another update is pending restart.', {
					pendingVersion,
					updateVersion,
				});
			}
			pendingVelopackUpdate = update;
			send(getMainWindow(), {
				type: 'available',
				context,
				version: getVelopackUpdateVersion(update),
				downloadSize: getVelopackUpdateSize(update),
				downloadStarted: false,
			});
		} catch (error) {
			send(getMainWindow(), {type: 'error', context, phase: 'check', message: getErrorMessage(error)});
		}
	})().finally(() => {
		velopackCheckPromise = null;
	});
	return velopackCheckPromise;
}

async function downloadVelopackUpdate(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
): Promise<void> {
	if (velopackDownloadPromise) {
		return velopackDownloadPromise;
	}
	const update = pendingVelopackUpdate;
	if (!update) {
		send(getMainWindow(), {
			type: 'error',
			context,
			phase: 'download',
			message: 'No update available to download. Please check for updates first.',
		});
		return;
	}
	if (!('TargetFullRelease' in update)) {
		send(getMainWindow(), {type: 'downloaded', context, version: getVelopackUpdateVersion(update)});
		return;
	}
	velopackDownloadPromise = (async () => {
		const total = getVelopackUpdateSize(update) ?? 0;
		let lastError: unknown;
		for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
			let lastSampleAt = Date.now();
			let lastSampleTransferred = 0;
			let smoothedBytesPerSecond = 0;
			try {
				const updateManager = createVelopackUpdateManager();
				await updateManager.downloadUpdateAsync(update, (percent) => {
					const transferred = total > 0 ? Math.round((total * percent) / 100) : 0;
					const now = Date.now();
					const dtMs = now - lastSampleAt;
					if (dtMs >= 500 || percent >= 100) {
						if (dtMs > 0 && transferred >= lastSampleTransferred) {
							const instant = ((transferred - lastSampleTransferred) * 1000) / dtMs;
							smoothedBytesPerSecond =
								smoothedBytesPerSecond === 0 ? instant : smoothedBytesPerSecond * 0.7 + instant * 0.3;
						}
						lastSampleAt = now;
						lastSampleTransferred = transferred;
						send(getMainWindow(), {
							type: 'progress',
							context,
							percent,
							transferred,
							total,
							bytesPerSecond: Math.round(smoothedBytesPerSecond),
						});
					}
				});
				send(getMainWindow(), {
					type: 'downloaded',
					context,
					version: getVelopackUpdateVersion(update),
				});
				return;
			} catch (error) {
				lastError = error;
				if (attempt >= UPDATE_DOWNLOAD_MAX_ATTEMPTS) {
					break;
				}
				const delay = backoffDelay(attempt);
				const reason = getErrorMessage(error);
				const waitSeconds = Math.round(delay / 1000);
				log.warn(
					`Velopack update download attempt ${attempt}/${UPDATE_DOWNLOAD_MAX_ATTEMPTS} failed (${reason}); retrying in ${waitSeconds}s`,
				);
				await sleep(delay);
			}
		}
		log.error('Velopack update download failed after retries', lastError);
		send(getMainWindow(), {type: 'error', context, phase: 'download', message: getErrorMessage(lastError)});
	})().finally(() => {
		velopackDownloadPromise = null;
	});
	return velopackDownloadPromise;
}

function installVelopackUpdate(): void {
	if (velopackInstallStarted) {
		log.warn('Velopack install already in progress; ignoring duplicate request.');
		return;
	}
	const updateManager = createVelopackUpdateManager();
	const update = pendingVelopackUpdate ?? updateManager.getUpdatePendingRestart();
	if (!update) {
		throw new Error('No Velopack update is ready to install.');
	}
	if (resolveFailedVelopackApply(updateManager)) {
		throw new Error('The last update could not be installed. Download the installer to update.');
	}
	const updateVersion = getVelopackUpdateVersion(update);
	if (updateVersion) {
		recordVelopackApplyAttempt(updateVersion);
	}
	velopackInstallStarted = true;
	setQuitting(true);
	destroyDesktopTray();
	updateManager.waitExitThenApplyUpdate(update);
	setImmediate(() => app.exit(0));
}

function registerVelopackUpdater(getMainWindow: () => BrowserWindow | null): void {
	ipcMain.handle('updater-check', async (_e, context: UpdaterContext) => {
		lastContext = context;
		await checkVelopackForUpdates(context, getMainWindow);
	});
	ipcMain.handle('updater-download', async (_e, context: UpdaterContext) => {
		lastContext = context;
		await downloadVelopackUpdate(context, getMainWindow);
	});
	ipcMain.handle('updater-install', async () => {
		installVelopackUpdate();
	});
}

function registerElectronUpdater(getMainWindow: () => BrowserWindow | null): void {
	let electronUpdateDownloading = false;
	let electronDownloadRetries = 0;
	let electronUpdateDownloaded = false;
	let electronDownloadedVersion: string | null = null;
	const {UpdateSourceType, updateElectronApp} = requireModule(
		'update-electron-app',
	) as typeof import('update-electron-app');
	updateElectronApp({
		updateSource: {
			type: UpdateSourceType.StaticStorage,
			baseUrl: UPDATE_BASE_URL,
		},
		updateInterval: '12 hours',
		logger: log,
		notifyUser: false,
	});
	autoUpdater.on('checking-for-update', () => {
		send(getMainWindow(), {type: 'checking', context: lastContext});
	});
	const sendPendingRestart = () => {
		send(getMainWindow(), {type: 'downloaded', context: lastContext, version: electronDownloadedVersion});
	};
	autoUpdater.on('update-available', () => {
		if (electronUpdateDownloaded) {
			sendPendingRestart();
			return;
		}
		electronUpdateDownloading = true;
		send(getMainWindow(), {
			type: 'available',
			context: lastContext,
			version: null,
			downloadSize: null,
			downloadStarted: true,
		});
	});
	autoUpdater.on('update-not-available', () => {
		if (electronUpdateDownloaded) {
			sendPendingRestart();
			return;
		}
		send(getMainWindow(), {type: 'not-available', context: lastContext});
	});
	autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
		electronUpdateDownloading = false;
		electronUpdateDownloaded = true;
		if (releaseName) {
			electronDownloadedVersion = releaseName;
		}
		sendPendingRestart();
	});
	autoUpdater.on('error', (err: Error) => {
		const message = err?.message ?? String(err);
		const phase: 'check' | 'download' = electronUpdateDownloading ? 'download' : 'check';
		if (electronUpdateDownloading && electronDownloadRetries < ELECTRON_DOWNLOAD_MAX_RETRIES) {
			electronDownloadRetries += 1;
			electronUpdateDownloading = false;
			const delay = backoffDelay(electronDownloadRetries);
			const waitSeconds = Math.round(delay / 1000);
			log.warn(
				`Update download failed (attempt ${electronDownloadRetries}/${ELECTRON_DOWNLOAD_MAX_RETRIES}); retrying in ${waitSeconds}s: ${message}`,
			);
			setTimeout(() => {
				try {
					autoUpdater.checkForUpdates();
				} catch (retryError) {
					log.warn('Update retry check failed', retryError);
				}
			}, delay);
			return;
		}
		electronUpdateDownloading = false;
		if (electronUpdateDownloaded) {
			sendPendingRestart();
			return;
		}
		send(getMainWindow(), {type: 'error', context: lastContext, phase, message});
	});
	ipcMain.handle('updater-check', async (_e, context: UpdaterContext) => {
		lastContext = context;
		try {
			autoUpdater.checkForUpdates();
		} catch (error) {
			send(getMainWindow(), {type: 'error', context, phase: 'check', message: getErrorMessage(error)});
		}
	});
	ipcMain.handle('updater-download', async () => {});
	ipcMain.handle('updater-install', async () => {
		setQuitting(true);
		autoUpdater.quitAndInstall();
	});
}

let manualLatestCache: {at: number; info: ManualLatestInfo} | null = null;

const MANUAL_CACHE_TTL_MS = 5 * 60 * 1000;

function parseSemverTuple(input: string): [number, number, number, string] {
	const trimmed = input.trim().replace(/^v/, '');
	const [core, ...preParts] = trimmed.split('-');
	const pre = preParts.join('-');
	const segments = core.split('.').map((part) => Number.parseInt(part, 10));
	const [major = 0, minor = 0, patch = 0] = segments;
	return [
		Number.isFinite(major) ? major : 0,
		Number.isFinite(minor) ? minor : 0,
		Number.isFinite(patch) ? patch : 0,
		pre,
	];
}

function compareVersions(a: string, b: string): number {
	const [aMaj, aMin, aPat, aPre] = parseSemverTuple(a);
	const [bMaj, bMin, bPat, bPre] = parseSemverTuple(b);
	if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
	if (aMin !== bMin) return aMin < bMin ? -1 : 1;
	if (aPat !== bPat) return aPat < bPat ? -1 : 1;
	if (aPre === bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	return aPre < bPre ? -1 : 1;
}

function parseManualLatestFiles(value: unknown): Partial<Record<ManualDesktopFormat, ManualLatestFile>> {
	if (!isRecord(value)) {
		return {};
	}
	const files: Partial<Record<ManualDesktopFormat, ManualLatestFile>> = {};
	for (const format of MANUAL_DESKTOP_FORMATS) {
		const entry = value[format];
		if (!isRecord(entry) || typeof entry.url !== 'string' || entry.url.trim().length === 0) {
			continue;
		}
		files[format] = {
			url: entry.url,
			sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
		};
	}
	return files;
}

async function fetchManualLatest(options: {forceRefresh?: boolean} = {}): Promise<ManualLatestInfo> {
	const now = Date.now();
	if (!options.forceRefresh && manualLatestCache && now - manualLatestCache.at < MANUAL_CACHE_TTL_MS) {
		return manualLatestCache.info;
	}
	const response = await fetch(`${UPDATE_BASE_URL}/latest`, {
		cache: 'no-store',
		headers: {
			Accept: 'application/json',
			'Cache-Control': 'no-cache',
			Pragma: 'no-cache',
		},
	});
	if (!response.ok) {
		throw new Error(`Latest version request failed: ${response.status}`);
	}
	const payload = (await response.json()) as {version?: unknown; pub_date?: unknown; files?: unknown};
	if (typeof payload.version !== 'string' || payload.version.length === 0) {
		throw new Error('Latest version response missing version string');
	}
	const info: ManualLatestInfo = {
		version: payload.version,
		pubDate: typeof payload.pub_date === 'string' ? payload.pub_date : null,
		files: parseManualLatestFiles(payload.files),
	};
	manualLatestCache = {at: now, info};
	return info;
}

function sendManualUpdateAvailable(
	getMainWindow: () => BrowserWindow | null,
	context: UpdaterContext,
	latest: ManualLatestInfo,
): void {
	const downloadOptions = getManualDownloadOptions(latest);
	send(getMainWindow(), {
		type: 'available',
		context,
		version: latest.version,
		downloadSize: null,
		downloadStarted: false,
		downloadUrl: getManualDownloadUrl(latest),
		...(downloadOptions.length > 0 ? {downloadOptions} : {}),
	});
}

async function checkManualUpdate(context: UpdaterContext, getMainWindow: () => BrowserWindow | null): Promise<void> {
	send(getMainWindow(), {type: 'checking', context});
	if (FORK_UPDATES === 'github') {
		await checkForkGithubRelease(context, getMainWindow);
		return;
	}
	try {
		const latest = await fetchManualLatest({forceRefresh: context === 'user'});
		const current = app.getVersion();
		if (compareVersions(latest.version, current) > 0) {
			sendManualUpdateAvailable(getMainWindow, context, latest);
		} else {
			send(getMainWindow(), {type: 'not-available', context});
		}
	} catch (error) {
		log.warn('Manual update check failed', error);
		send(getMainWindow(), {type: 'error', context, phase: 'check', message: getErrorMessage(error)});
	}
}

const FORK_RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
let forkReleaseCache: {at: number; info: ManualLatestInfo} | null = null;

function forkAssetMatchesPlatform(assetName: string): boolean {
	const lowered = assetName.toLowerCase();
	if (/(arm64|aarch64)/.test(lowered)) {
		return false;
	}
	if (process.platform === 'win32') {
		return lowered.endsWith('.exe') || lowered.endsWith('.zip');
	}
	if (process.platform === 'linux') {
		return lowered.endsWith('.appimage') || lowered.endsWith('.deb');
	}
	return false;
}

function forkAssetFormat(assetName: string): ManualDesktopFormat | null {
	const lowered = assetName.toLowerCase();
	if (lowered.endsWith('.exe')) return 'setup';
	if (lowered.endsWith('.zip')) return 'zip';
	if (lowered.endsWith('.appimage')) return 'appimage';
	if (lowered.endsWith('.deb')) return 'deb';
	return null;
}

function parseForkLatestRelease(payload: unknown): ManualLatestInfo | null {
	if (!isRecord(payload) || typeof payload.tag_name !== 'string' || !Array.isArray(payload.assets)) {
		return null;
	}
	const version = payload.tag_name.replace(/^v/, '');
	if (version.length === 0) {
		return null;
	}
	const files: Partial<Record<ManualDesktopFormat, ManualLatestFile>> = {};
	for (const asset of payload.assets) {
		if (
			!isRecord(asset) ||
			typeof asset.name !== 'string' ||
			typeof asset.browser_download_url !== 'string' ||
			!forkAssetMatchesPlatform(asset.name)
		) {
			continue;
		}
		const format = forkAssetFormat(asset.name);
		if (format == null || files[format] != null) {
			continue;
		}
		// Fork: the GitHub API reports each asset's byte size; the Windows self-update flow
		// uses it for the download progress total.
		files[format] = {
			url: asset.browser_download_url,
			sha256: null,
			size: typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : null,
		};
	}
	return {
		version,
		pubDate: typeof payload.published_at === 'string' ? payload.published_at : null,
		files,
	};
}

async function fetchForkLatestRelease(options: {forceRefresh?: boolean} = {}): Promise<ManualLatestInfo | null> {
	const now = Date.now();
	if (!options.forceRefresh && forkReleaseCache && now - forkReleaseCache.at < FORK_RELEASE_CACHE_TTL_MS) {
		return forkReleaseCache.info;
	}
	const response = await fetch(FORK_RELEASES_API_URL, {
		cache: 'no-store',
		headers: {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'fluxer-desktop-fork-updater',
		},
	});
	if (response.status === 404) {
		log.warn(`Fork update repository has no published release yet: ${FORK_UPDATE_REPO}`);
		return null;
	}
	if (!response.ok) {
		throw new Error(`Fork latest release request failed: ${response.status}`);
	}
	const info = parseForkLatestRelease(await response.json());
	if (info == null) {
		throw new Error('Fork latest release response is missing a tag or usable assets');
	}
	forkReleaseCache = {at: now, info};
	return info;
}

async function checkForkGithubRelease(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
): Promise<void> {
	try {
		const latest = await fetchForkLatestRelease({forceRefresh: context === 'user'});
		if (latest == null || compareVersions(latest.version, app.getVersion()) <= 0) {
			send(getMainWindow(), {type: 'not-available', context});
			return;
		}
		sendManualUpdateAvailable(getMainWindow, context, latest);
	} catch (error) {
		log.warn('Fork update check failed', error);
		send(getMainWindow(), {type: 'error', context, phase: 'check', message: getErrorMessage(error)});
	}
}

function resolveFailedForkSetupInstall(): VelopackApplyAttempt | null {
	const attempt = readVelopackApplyAttempt();
	if (!attempt) {
		return null;
	}
	if (compareVersions(app.getVersion(), attempt.version) >= 0) {
		clearVelopackApplyAttempt();
		return null;
	}
	return attempt;
}

function createForkSetupProgressReporter(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
	fallbackTotal: number,
): (progress: ForkSetupDownloadProgress) => void {
	let lastSampleAt = Date.now();
	let lastSampleTransferred = 0;
	let smoothedBytesPerSecond = 0;
	return ({transferred, total: reportedTotal}) => {
		const total = reportedTotal > 0 ? reportedTotal : fallbackTotal;
		const now = Date.now();
		const dtMs = now - lastSampleAt;
		const complete = total > 0 && transferred >= total;
		if (dtMs < UPDATE_PROGRESS_SAMPLE_INTERVAL_MS && !complete) {
			return;
		}
		if (dtMs > 0 && transferred >= lastSampleTransferred) {
			const instant = ((transferred - lastSampleTransferred) * 1000) / dtMs;
			smoothedBytesPerSecond = smoothedBytesPerSecond === 0 ? instant : smoothedBytesPerSecond * 0.7 + instant * 0.3;
		}
		lastSampleAt = now;
		lastSampleTransferred = transferred;
		send(getMainWindow(), {
			type: 'progress',
			context,
			percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
			transferred,
			total,
			bytesPerSecond: Math.round(smoothedBytesPerSecond),
		});
	};
}

async function checkForkWindowsUpdate(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
): Promise<void> {
	if (forkSetupCheckPromise) {
		return forkSetupCheckPromise;
	}
	forkSetupCheckPromise = (async () => {
		send(getMainWindow(), {type: 'checking', context});
		const failedInstall = resolveFailedForkSetupInstall();
		if (failedInstall) {
			log.error('A fork setup install was started but never applied; offering the installer instead.', failedInstall);
			send(getMainWindow(), {
				type: 'error',
				context,
				phase: 'install',
				message: `Fluxer could not finish installing version ${failedInstall.version}.`,
			});
			try {
				const latest = await fetchForkLatestRelease({forceRefresh: context === 'user'});
				if (latest) {
					sendManualUpdateAvailable(getMainWindow, context, latest);
				}
			} catch (error) {
				log.warn('Failed to resolve the fork installer download after a failed install', error);
			}
			return;
		}
		let latest: ManualLatestInfo | null;
		try {
			latest = await fetchForkLatestRelease({forceRefresh: context === 'user'});
		} catch (error) {
			log.warn('Fork update check failed', error);
			send(getMainWindow(), {type: 'error', context, phase: 'check', message: getErrorMessage(error)});
			return;
		}
		if (latest == null || compareVersions(latest.version, app.getVersion()) <= 0) {
			pendingForkSetup = null;
			removeOtherForkSetupFiles(getForkUpdatesDirectory(app.getPath('userData')), '');
			send(getMainWindow(), {type: 'not-available', context});
			return;
		}
		const setup = latest.files.setup;
		if (!setup?.url) {
			log.info('Fork release has no Windows setup asset, so the manual download is offered instead.', {
				version: latest.version,
			});
			sendManualUpdateAvailable(getMainWindow, context, latest);
			return;
		}
		if (pendingForkSetup && compareVersions(latest.version, pendingForkSetup.version) <= 0) {
			send(getMainWindow(), {type: 'downloaded', context, version: pendingForkSetup.version});
			return;
		}
		const updatesDirectory = getForkUpdatesDirectory(app.getPath('userData'));
		const fileName = getForkSetupFileName(setup.url);
		let expectedSha256: string | null = null;
		try {
			expectedSha256 = await fetchForkSetupChecksum(`${setup.url}.sha256`);
		} catch (error) {
			log.warn('Fork setup checksum request failed', error);
		}
		if (!expectedSha256) {
			log.warn(
				`Fork release does not publish a usable ${fileName}.sha256 checksum, so the manual download is offered instead.`,
			);
			sendManualUpdateAvailable(getMainWindow, context, latest);
			return;
		}
		send(getMainWindow(), {
			type: 'available',
			context,
			version: latest.version,
			downloadSize: setup.size ?? null,
			downloadStarted: true,
		});
		const existingSetupPath = await findVerifiedForkSetupFile(updatesDirectory, fileName, expectedSha256);
		if (existingSetupPath) {
			pendingForkSetup = {version: latest.version, setupPath: existingSetupPath, sha256: expectedSha256};
			removeOtherForkSetupFiles(updatesDirectory, fileName);
			send(getMainWindow(), {type: 'downloaded', context, version: latest.version});
			return;
		}
		await downloadForkSetupUpdate(context, getMainWindow, {
			updatesDirectory,
			fileName,
			setupUrl: setup.url,
			version: latest.version,
			expectedSha256,
			size: setup.size ?? null,
		});
	})().finally(() => {
		forkSetupCheckPromise = null;
	});
	return forkSetupCheckPromise;
}

async function downloadForkSetupUpdate(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
	plan: {
		updatesDirectory: string;
		fileName: string;
		setupUrl: string;
		version: string;
		expectedSha256: string;
		size: number | null;
	},
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
		const onProgress = createForkSetupProgressReporter(context, getMainWindow, plan.size ?? 0);
		try {
			const setupPath = await downloadForkSetupFile({
				updatesDirectory: plan.updatesDirectory,
				fileName: plan.fileName,
				setupUrl: plan.setupUrl,
				expectedSha256: plan.expectedSha256,
				onProgress,
			});
			pendingForkSetup = {version: plan.version, setupPath, sha256: plan.expectedSha256};
			removeOtherForkSetupFiles(plan.updatesDirectory, plan.fileName);
			send(getMainWindow(), {type: 'downloaded', context, version: plan.version});
			return;
		} catch (error) {
			lastError = error;
			if (error instanceof ForkSetupChecksumError || attempt >= UPDATE_DOWNLOAD_MAX_ATTEMPTS) {
				break;
			}
			const delay = backoffDelay(attempt);
			const reason = getErrorMessage(error);
			const waitSeconds = Math.round(delay / 1000);
			log.warn(
				`Fork setup download attempt ${attempt}/${UPDATE_DOWNLOAD_MAX_ATTEMPTS} failed (${reason}); retrying in ${waitSeconds}s`,
			);
			await sleep(delay);
		}
	}
	log.error('Fork setup download failed after retries', lastError);
	send(getMainWindow(), {type: 'error', context, phase: 'download', message: getErrorMessage(lastError)});
	try {
		const latest = await fetchForkLatestRelease();
		if (latest) {
			sendManualUpdateAvailable(getMainWindow, context, latest);
		}
	} catch (error) {
		log.warn('Failed to resolve the fork installer download after a failed download', error);
	}
}

function installForkSetupUpdate(getMainWindow: () => BrowserWindow | null): void {
	if (forkSetupInstallStarted) {
		log.warn('Fork setup install already in progress; ignoring duplicate request.');
		return;
	}
	const pending = pendingForkSetup;
	if (!pending) {
		throw new Error('No fork update is ready to install.');
	}
	if (resolveFailedForkSetupInstall()) {
		throw new Error('The last fork update could not be installed. Download the installer to update.');
	}
	recordVelopackApplyAttempt(pending.version);
	forkSetupInstallStarted = true;
	try {
		launchForkSetupInstaller(pending.setupPath);
	} catch (error) {
		clearVelopackApplyAttempt();
		forkSetupInstallStarted = false;
		log.error('Failed to launch the fork setup installer', error);
		send(getMainWindow(), {
			type: 'error',
			context: lastContext,
			phase: 'install',
			message: getErrorMessage(error),
		});
		return;
	}
	log.info(`Reinstalling ${pending.version} from ${pending.setupPath}; the installer relaunches the app.`);
	setQuitting(true);
	destroyDesktopTray();
	setImmediate(() => app.exit(0));
}

function registerForkWindowsUpdater(getMainWindow: () => BrowserWindow | null): void {
	ipcMain.handle('updater-check', async (_e, context: UpdaterContext) => {
		lastContext = context;
		await checkForkWindowsUpdate(context, getMainWindow);
	});
	ipcMain.handle('updater-download', async (_e, context: UpdaterContext) => {
		lastContext = context;
		await checkForkWindowsUpdate(context, getMainWindow);
	});
	ipcMain.handle('updater-install', () => {
		installForkSetupUpdate(getMainWindow);
	});
}

async function downloadAppImageUpdate(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
	latest: ManualLatestInfo,
	target: AppImageTarget,
	expectedSha256: string,
): Promise<void> {
	const version = latest.version;
	const url = buildManualVersionDownloadUrl(version, 'appimage');
	let lastError: unknown;
	for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
		let lastSampleAt = Date.now();
		let lastSampleTransferred = 0;
		let smoothedBytesPerSecond = 0;
		try {
			const staged = await stageAppImageUpdate({
				target,
				url,
				expectedSha256,
				onProgress: ({transferred, total}) => {
					const now = Date.now();
					const dtMs = now - lastSampleAt;
					const complete = total > 0 && transferred >= total;
					if (dtMs < UPDATE_PROGRESS_SAMPLE_INTERVAL_MS && !complete) {
						return;
					}
					if (dtMs > 0 && transferred >= lastSampleTransferred) {
						const instant = ((transferred - lastSampleTransferred) * 1000) / dtMs;
						smoothedBytesPerSecond =
							smoothedBytesPerSecond === 0 ? instant : smoothedBytesPerSecond * 0.7 + instant * 0.3;
					}
					lastSampleAt = now;
					lastSampleTransferred = transferred;
					send(getMainWindow(), {
						type: 'progress',
						context,
						percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
						transferred,
						total,
						bytesPerSecond: Math.round(smoothedBytesPerSecond),
					});
				},
			});
			if (pendingAppImageUpdate) {
				discardStagedAppImageUpdate(pendingAppImageUpdate.staged);
			}
			pendingAppImageUpdate = {version, target, staged};
			send(getMainWindow(), {type: 'downloaded', context, version});
			return;
		} catch (error) {
			lastError = error;
			if (
				error instanceof AppImageChecksumError ||
				error instanceof AppImageStagingError ||
				attempt >= UPDATE_DOWNLOAD_MAX_ATTEMPTS
			) {
				break;
			}
			const delay = backoffDelay(attempt);
			const reason = getErrorMessage(error);
			const waitSeconds = Math.round(delay / 1000);
			log.warn(
				`AppImage update download attempt ${attempt}/${UPDATE_DOWNLOAD_MAX_ATTEMPTS} failed (${reason}), retrying in ${waitSeconds}s`,
			);
			await sleep(delay);
		}
	}
	log.error('AppImage update download failed', lastError);
	send(getMainWindow(), {type: 'error', context, phase: 'download', message: getErrorMessage(lastError)});
	sendManualUpdateAvailable(getMainWindow, context, latest);
}

async function checkAppImageUpdate(
	context: UpdaterContext,
	getMainWindow: () => BrowserWindow | null,
	target: AppImageTarget,
): Promise<void> {
	if (appImageUpdatePromise) {
		return appImageUpdatePromise;
	}
	appImageUpdatePromise = (async () => {
		send(getMainWindow(), {type: 'checking', context});
		let latest: ManualLatestInfo;
		try {
			latest = await fetchManualLatest({forceRefresh: context === 'user'});
		} catch (error) {
			log.warn('AppImage update check failed', error);
			send(getMainWindow(), {type: 'error', context, phase: 'check', message: getErrorMessage(error)});
			return;
		}
		if (pendingAppImageUpdate && compareVersions(latest.version, pendingAppImageUpdate.version) <= 0) {
			send(getMainWindow(), {type: 'downloaded', context, version: pendingAppImageUpdate.version});
			return;
		}
		if (compareVersions(latest.version, app.getVersion()) <= 0) {
			send(getMainWindow(), {type: 'not-available', context});
			return;
		}
		const published = latest.files.appimage;
		const resolved = resolveAppImageTarget(target.installedPath);
		if (!resolved.ok || !published?.sha256) {
			log.info('AppImage cannot be replaced in place, so the manual download is offered instead.', {
				reason: resolved.ok ? 'published-checksum-missing' : resolved.reason,
			});
			sendManualUpdateAvailable(getMainWindow, context, latest);
			return;
		}
		send(getMainWindow(), {
			type: 'available',
			context,
			version: latest.version,
			downloadSize: null,
			downloadStarted: true,
		});
		await downloadAppImageUpdate(context, getMainWindow, latest, resolved.target, published.sha256);
	})().finally(() => {
		appImageUpdatePromise = null;
	});
	return appImageUpdatePromise;
}

function installAppImageUpdate(getMainWindow: () => BrowserWindow | null): void {
	if (appImageInstallStarted) {
		log.warn('AppImage install already in progress, ignoring the duplicate request.');
		return;
	}
	const pending = pendingAppImageUpdate;
	if (!pending) {
		throw new Error('No AppImage update is ready to install.');
	}
	try {
		applyStagedAppImageUpdate(pending.target, pending.staged);
	} catch (error) {
		log.error('AppImage update install failed', error);
		pendingAppImageUpdate = null;
		send(getMainWindow(), {type: 'error', context: lastContext, phase: 'install', message: getErrorMessage(error)});
		return;
	}
	appImageInstallStarted = true;
	pendingAppImageUpdate = null;
	log.info(`Replaced ${pending.target.installedPath} with ${pending.version}, relaunching now.`);
	relaunchAndExit();
}

function reclaimAbandonedAppImageUpdates(target: AppImageTarget): void {
	try {
		const reclaimed = sweepAbandonedAppImageUpdates(target);
		if (reclaimed.length > 0) {
			log.info(`Reclaimed ${reclaimed.length} abandoned AppImage staging directories in ${target.directory}.`);
		}
	} catch (error) {
		log.warn('Failed to reclaim abandoned AppImage staging directories', error);
	}
}

function registerAppImageUpdater(getMainWindow: () => BrowserWindow | null, target: AppImageTarget): void {
	reclaimAbandonedAppImageUpdates(target);
	app.on('will-quit', () => {
		if (!pendingAppImageUpdate || appImageInstallStarted) {
			return;
		}
		discardStagedAppImageUpdate(pendingAppImageUpdate.staged);
		pendingAppImageUpdate = null;
	});
	ipcMain.handle('updater-check', async (_e, context: UpdaterContext) => {
		lastContext = context;
		await checkAppImageUpdate(context, getMainWindow, target);
	});
	ipcMain.handle('updater-download', async (_e, context: UpdaterContext) => {
		lastContext = context;
		await checkAppImageUpdate(context, getMainWindow, target);
	});
	ipcMain.handle('updater-install', async () => {
		installAppImageUpdate(getMainWindow);
	});
}

function registerManualUpdater(
	getMainWindow: () => BrowserWindow | null,
	reason: 'platform' | 'unpackaged' | 'managed-package',
): void {
	ipcMain.handle('updater-check', async (_e, context: UpdaterContext) => {
		if (reason !== 'platform') {
			send(getMainWindow(), {
				type: 'unsupported',
				context,
				reason,
				...(reason === 'unpackaged' ? {downloadUrl: DOWNLOAD_PAGE_URL} : {}),
			});
			return;
		}
		await checkManualUpdate(context, getMainWindow);
	});
	ipcMain.handle('updater-download', async (_e, context: UpdaterContext) => {
		send(getMainWindow(), {
			type: 'unsupported',
			context,
			reason,
			...(reason === 'managed-package' ? {} : {downloadUrl: DOWNLOAD_PAGE_URL}),
		});
	});
	ipcMain.handle('updater-install', async () => {
		throw new Error('In-app updates are not supported on this platform.');
	});
}

function registerDisabledManualUpdater(getMainWindow: () => BrowserWindow | null): void {
	ipcMain.handle('updater-check', async (_e, context: UpdaterContext) => {
		lastContext = context;
		send(getMainWindow(), {type: 'not-available', context});
	});
	ipcMain.handle('updater-download', async (_e, context: UpdaterContext) => {
		lastContext = context;
		send(getMainWindow(), {type: 'unsupported', context, reason: 'platform'});
	});
	ipcMain.handle('updater-install', async () => {
		throw new Error('In-app updates are disabled in this build.');
	});
}

export function registerUpdater(getMainWindow: () => BrowserWindow | null) {
	if (FORK_UPDATES === 'disabled') {
		registerDisabledManualUpdater(getMainWindow);
		return;
	}
	if (FORK_UPDATES === 'github') {
		// Fork builds never reach the official feed. On Windows the fork self-updates from its
		// GitHub releases: the check downloads the NSIS setup asset in-app and the restart
		// prompt reinstalls it silently. Every other platform and package format (portable
		// zip, unpackaged, non-Windows) keeps the manual download flow.
		if (process.platform === 'win32' && app.isPackaged && !isPortableMode()) {
			registerForkWindowsUpdater(getMainWindow);
			return;
		}
		registerManualUpdater(getMainWindow, 'platform');
		return;
	}
	if (!app.isPackaged) {
		registerManualUpdater(getMainWindow, 'unpackaged');
		return;
	}
	if (isPortableMode()) {
		registerManualUpdater(getMainWindow, 'platform');
		return;
	}
	if (isFlatpakRuntime()) {
		registerManualUpdater(getMainWindow, 'managed-package');
		return;
	}
	if (process.platform === 'win32') {
		registerVelopackUpdater(getMainWindow);
		return;
	}
	if (process.platform === 'darwin') {
		registerElectronUpdater(getMainWindow);
		return;
	}
	if (process.platform === 'linux' && isRunningFromAppImage()) {
		const appImage = resolveAppImageTarget();
		if (appImage.ok) {
			registerAppImageUpdater(getMainWindow, appImage.target);
			return;
		}
	}
	registerManualUpdater(getMainWindow, 'platform');
}
