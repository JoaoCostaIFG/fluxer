// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL} from '@electron/common/BuildChannel';

// Fork: when FLUXER_FORK_UPDATE_REPO is baked in at build time (owner/name, e.g. "joaocosta/fluxer"),
// every update surface points at that GitHub repository's releases instead of pkgs.fluxer.com, and
// in-app self-update (Velopack, AppImage staging) is disabled in Updater.ts. An empty value disables
// update checks entirely. The value never resolves to the official feed, so a published official
// release can never replace a fork install. The undefined-env guard keeps vm-hosted tests working.
export const FORK_UPDATE_REPO = process.env === undefined ? '' : (process.env.FLUXER_FORK_UPDATE_REPO ?? '');
export const FORK_RELEASES_PAGE_URL =
	FORK_UPDATE_REPO.length > 0 ? `https://github.com/${FORK_UPDATE_REPO}/releases/latest` : '';
export const FORK_RELEASES_API_URL =
	FORK_UPDATE_REPO.length > 0 ? `https://api.github.com/repos/${FORK_UPDATE_REPO}/releases/latest` : '';

export type UpdaterDownloadOption = {
	format: ManualDesktopFormat;
	label: string;
	url: string;
	suggestedName?: string;
	sha256?: string | null;
};

type DesktopDownloadArch = 'x64' | 'arm64';

function getDesktopDownloadArch(arch: NodeJS.Architecture): DesktopDownloadArch {
	return arch === 'arm64' ? 'arm64' : 'x64';
}

const DESKTOP_DOWNLOAD_ARCH = getDesktopDownloadArch(process.arch);
const PKGS_BASE_URL = 'https://pkgs.fluxer.com';
export const UPDATE_BASE_URL = `${PKGS_BASE_URL}/desktop/${BUILD_CHANNEL}/${process.platform}/${DESKTOP_DOWNLOAD_ARCH}`;
export const DOWNLOAD_PAGE_URL =
	FORK_UPDATE_REPO.length > 0
		? FORK_RELEASES_PAGE_URL
		: BUILD_CHANNEL === 'canary'
			? 'https://canary.fluxer.app/download'
			: 'https://fluxer.app/download';

export const MANUAL_DESKTOP_FORMATS = ['setup', 'dmg', 'zip', 'appimage', 'deb', 'rpm', 'tar_gz'] as const;

export type ManualDesktopFormat = (typeof MANUAL_DESKTOP_FORMATS)[number];
export type ManualLatestFile = {url: string; sha256: string | null};
type LinuxManualDesktopFormat = Extract<ManualDesktopFormat, 'appimage' | 'deb' | 'rpm' | 'tar_gz'>;

export type ManualLatestInfo = {
	version: string;
	pubDate: string | null;
	files: Partial<Record<ManualDesktopFormat, ManualLatestFile>>;
};

function getManualDownloadFormatPreference(): Array<ManualDesktopFormat> {
	if (process.platform === 'linux') {
		return ['appimage', 'deb', 'rpm', 'tar_gz'];
	}
	if (process.platform === 'darwin') {
		return ['dmg', 'zip'];
	}
	if (process.platform === 'win32') {
		return ['setup'];
	}
	return [];
}

const LINUX_MANUAL_FORMAT_LABELS: Record<LinuxManualDesktopFormat, string> = {
	appimage: 'AppImage',
	deb: 'DEB package',
	rpm: 'RPM package',
	tar_gz: 'tar.gz archive',
};

const LINUX_MANUAL_FORMAT_EXTENSIONS: Record<LinuxManualDesktopFormat, string> = {
	appimage: '.AppImage',
	deb: '.deb',
	rpm: '.rpm',
	tar_gz: '.tar.gz',
};

const LINUX_MANUAL_ARCH_TOKENS: Record<LinuxManualDesktopFormat, Record<DesktopDownloadArch, string>> = {
	appimage: {x64: 'x86_64', arm64: 'arm64'},
	deb: {x64: 'amd64', arm64: 'arm64'},
	rpm: {x64: 'x86_64', arm64: 'aarch64'},
	tar_gz: {x64: 'x64', arm64: 'arm64'},
};

function isLinuxManualDesktopFormat(format: ManualDesktopFormat): format is LinuxManualDesktopFormat {
	return format === 'appimage' || format === 'deb' || format === 'rpm' || format === 'tar_gz';
}

export function buildManualVersionDownloadUrl(version: string, format: ManualDesktopFormat): string {
	return `${UPDATE_BASE_URL}/${version}/${format}`;
}

function getArtifactProductName(): string {
	return BUILD_CHANNEL === 'canary' ? 'Fluxer-Canary' : 'Fluxer';
}

function getManualUpdateSuggestedName(format: LinuxManualDesktopFormat, version: string): string {
	const archToken = LINUX_MANUAL_ARCH_TOKENS[format][DESKTOP_DOWNLOAD_ARCH];
	const extension = LINUX_MANUAL_FORMAT_EXTENSIONS[format];
	return `${getArtifactProductName()}-${version}-linux-${archToken}${extension}`;
}

export function getManualDownloadOptions(info: ManualLatestInfo): Array<UpdaterDownloadOption> {
	if (process.platform !== 'linux') {
		return [];
	}
	return (
		getManualDownloadFormatPreference()
			.filter(isLinuxManualDesktopFormat)
			// Fork builds publish artifacts as GitHub release assets, so only formats with a real
			// asset URL are offered; the official feed URL never leaks into a fork install.
			.filter((format) => FORK_UPDATE_REPO.length === 0 || info.files[format]?.url != null)
			.map((format) => {
				const file = info.files[format];
				return {
					format,
					label: LINUX_MANUAL_FORMAT_LABELS[format],
					url:
						FORK_UPDATE_REPO.length > 0 && file?.url ? file.url : buildManualVersionDownloadUrl(info.version, format),
					suggestedName: getManualUpdateSuggestedName(format, info.version),
					sha256: file?.sha256 ?? null,
				};
			})
	);
}

export function getManualDownloadUrl(info: ManualLatestInfo): string {
	const [preferredOption] = getManualDownloadOptions(info);
	if (preferredOption) {
		return preferredOption.url;
	}
	for (const format of getManualDownloadFormatPreference()) {
		const url = info.files[format]?.url;
		if (url) {
			return url;
		}
	}
	return DOWNLOAD_PAGE_URL;
}
