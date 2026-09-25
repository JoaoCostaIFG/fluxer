// SPDX-License-Identifier: AGPL-3.0-or-later

// Fork: Windows self-update support over the fork's GitHub release assets. The NSIS setup
// asset published by the fork workflow (plus its `<asset>.sha256` sidecar) is downloaded
// into the user data directory, verified against the published checksum, and reinstalled
// on request. The assisted per-user installer is spawned detached with `/S --force-run`,
// the exact combination electron-updater uses, so it reinstalls without any UI and
// relaunches the app when it finishes; if that reinstall never completes, the recorded
// apply attempt makes the next check fall back to the manual download offer.

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, readdirSync, rmSync} from 'node:fs';
import {mkdir, open, rename, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';

const FORK_SETUP_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PART_FILE_SUFFIX = '.part';
const SETUP_INSTALLER_ARGS = ['/S', '--force-run'] as const;

export class ForkSetupChecksumError extends Error {
	constructor(expected: string, actual: string) {
		super(`Fork setup checksum mismatch: expected ${expected}, downloaded ${actual}`);
		this.name = 'ForkSetupChecksumError';
	}
}

export type ForkSetupDownloadProgress = {
	transferred: number;
	total: number;
};

export function getForkUpdatesDirectory(userDataDirectory: string): string {
	return join(userDataDirectory, 'updates');
}

export function getForkSetupFileName(setupUrl: string): string {
	const lastSegment = setupUrl.split('?')[0].split('/').filter(Boolean).at(-1) ?? '';
	const fileName = decodeURIComponent(lastSegment);
	if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\')) {
		throw new Error(`Could not derive a safe setup file name from ${setupUrl}`);
	}
	return fileName;
}

export async function fetchForkSetupChecksum(
	sha256Url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const response = await fetchImpl(sha256Url, {cache: 'no-store', redirect: 'follow'});
	if (!response.ok) {
		return null;
	}
	const checksum = ((await response.text()) as string).trim().toLowerCase().split(/\s+/)[0] ?? '';
	return FORK_SETUP_SHA256_PATTERN.test(checksum) ? checksum : null;
}

async function digestForkSetupFile(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest('hex');
}

export async function findVerifiedForkSetupFile(
	updatesDirectory: string,
	fileName: string,
	expectedSha256: string,
): Promise<string | null> {
	const setupPath = join(updatesDirectory, fileName);
	try {
		if (!(await stat(setupPath)).isFile()) {
			return null;
		}
	} catch {
		return null;
	}
	return (await digestForkSetupFile(setupPath)) === expectedSha256 ? setupPath : null;
}

export async function downloadForkSetupFile(options: {
	updatesDirectory: string;
	fileName: string;
	setupUrl: string;
	expectedSha256: string;
	onProgress?: (progress: ForkSetupDownloadProgress) => void;
	fetchImpl?: typeof fetch;
}): Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(options.setupUrl, {cache: 'no-store', redirect: 'follow'});
	if (!response.ok || response.body == null) {
		throw new Error(`Fork setup download failed: ${response.status}`);
	}
	const declaredTotal = Number.parseInt(response.headers.get('content-length') ?? '', 10);
	const total = Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : 0;
	await mkdir(options.updatesDirectory, {recursive: true});
	const setupPath = join(options.updatesDirectory, options.fileName);
	const stagingPath = `${setupPath}${PART_FILE_SUFFIX}`;
	try {
		await rm(stagingPath, {force: true});
		const handle = await open(stagingPath, 'wx');
		let transferred = 0;
		try {
			const reader = response.body.getReader();
			try {
				for (;;) {
					const {done, value} = await reader.read();
					if (done) {
						break;
					}
					let written = 0;
					while (written < value.byteLength) {
						const result = await handle.write(value, written, value.byteLength - written);
						if (result.bytesWritten <= 0) {
							throw new Error(`Fork setup download stalled after ${transferred} bytes.`);
						}
						written += result.bytesWritten;
						transferred += result.bytesWritten;
					}
					options.onProgress?.({transferred, total});
				}
				if (total > 0 && transferred < total) {
					throw new Error(`Fork setup download ended after ${transferred} of ${total} bytes.`);
				}
				await handle.datasync();
			} finally {
				await reader.cancel().catch(() => {});
			}
		} finally {
			await handle.close();
		}
		const digest = await digestForkSetupFile(stagingPath);
		if (digest !== options.expectedSha256) {
			throw new ForkSetupChecksumError(options.expectedSha256, digest);
		}
		await rename(stagingPath, setupPath);
		return setupPath;
	} catch (error) {
		await rm(stagingPath, {force: true});
		throw error;
	}
}

export function removeOtherForkSetupFiles(updatesDirectory: string, keepFileName: string): Array<string> {
	let entries: Array<string>;
	try {
		entries = readdirSync(updatesDirectory);
	} catch {
		return [];
	}
	const removed: Array<string> = [];
	for (const entry of entries) {
		if (entry === keepFileName) {
			continue;
		}
		const removedPath = join(updatesDirectory, entry);
		try {
			rmSync(removedPath, {force: true});
			removed.push(removedPath);
		} catch {}
	}
	return removed;
}

export function launchForkSetupInstaller(setupPath: string): void {
	const child = spawn(setupPath, [...SETUP_INSTALLER_ARGS], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	});
	child.unref();
}
