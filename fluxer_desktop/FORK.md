# Fluxer desktop fork for chat.joaocosta.dev

This fork repoints the desktop app at the self-hosted instance and ships Windows and Linux
builds from this repository. It is maintained on top of upstream `fluxerapp/fluxer`.

## What the fork changes

| File | Change |
| --- | --- |
| `src/common/Constants.ts` | `STABLE_APP_URL`/`CANARY_APP_URL` point at `https://chat.joaocosta.dev`. `Window.ts` derives the trusted-origin allowlist (microphone/camera `media` permission, privileged IPC) from these constants, so **voice works on the instance without any launch flag**, on every launch path. `--fluxer-app-url` still works for one-off overrides. |
| `src/main/UpdaterDownloads.ts` + `src/main/Updater.ts` + `src/main/ForkWindowsUpdate.ts` | Update checks read this repository's GitHub releases instead of `pkgs.fluxer.com`. **Windows installs self-update**: the app downloads the release's NSIS setup in the background (verified against its published `.sha256`), shows a "restart to update" prompt, and on the click reinstalls silently — the installer relaunches the app (per-user, no UAC). Portable zip, unpackaged and non-Windows formats keep **manual download** updates. The official feed is never contacted, so an official release can never replace a fork install. |
| `scripts/build.mjs` | Bakes `FLUXER_FORK_UPDATE_REPO` into the bundle: set to `owner/name` it enables the GitHub-releases check; unset it disables update checks entirely. |
| `electron-builder.config.cjs` | Windows ships an assisted **NSIS setup + portable zip** (x64); Linux ships **AppImage + deb** (x64). RPM and tar.gz are dropped. An unqualified `--win`/`--linux` build defaults to x64. |
| `.gitignore` | Ignores `pnpm-store-*/`: the Windows CI step pins the pnpm store inside the checkout, and `pnpm version` refuses to run on a dirty tree. |
| `.github/workflows/build-desktop-fork.yaml` | CI: builds Windows x64 + Linux x64, attaches artifacts and SHA256 checksums to the GitHub release for a pushed `v*` tag. Steps run `tools/ci` with `cargo run --target-dir` into runner temp, keeping the workflow-level `fluxer-ci.exe` out of the in-tree `target/` that the nested per-addon `cargo run`s relink — Windows cannot replace a running executable (upstream gets the same separation from its separate `_ci` checkout). |

Everything else is upstream, so rebasing is usually just this diff.

## Releasing

1. Merge/rebase upstream into `main` as needed.
2. Push a tag:

   ```bash
   git tag v2026.925.1   # any dotted number greater than the last release
   git push origin v2026.925.1
   ```

   The workflow builds both platforms, then creates the GitHub release with:
   - `Fluxer-<version>-Setup-win32-x64.exe` (NSIS setup)
   - `Fluxer-<version>-win32-x64.zip` (portable zip)
   - `Fluxer-<version>-linux-x64.AppImage`
   - `Fluxer-<version>-linux-amd64.deb`
   - `<artifact>.sha256` checksums

3. Installed clients pick the release up on their next update check (on launch, on window
   focus, or every 30 minutes while visible). Windows installs download the setup in the
   background, show a "restart to update" prompt, and reinstall silently on the click — the
   app comes back updated. Other formats get a manual download link for the matching asset.

`workflow_dispatch` builds without publishing, for testing.

The updater repository is `${{ github.repository }}` of wherever the workflow runs, set
automatically from the job environment — no hardcoding to keep in sync.

## Rebuilding on a new upstream release

The fork touches a small set of files. In practice:

```bash
git fetch upstream
git rebase upstream/main        # or merge
# resolve conflicts in:
#   fluxer_desktop/src/common/Constants.ts
#   fluxer_desktop/src/main/UpdaterDownloads.ts
#   fluxer_desktop/src/main/Updater.ts
#   fluxer_desktop/src/main/Updater.test.mjs
#   fluxer_desktop/scripts/build.mjs
#   fluxer_desktop/electron-builder.config.cjs
#   .gitignore
git push origin main --force-with-lease
```

Upstream tests stay green because the fork update mode is baked in only through
`scripts/build.mjs`; running the test files directly keeps upstream behaviour.

## Local builds

Prerequisites: Rust 1.98.1 (`rustup`), Node.js 26, pnpm 12.4.2, Python 3, and on Linux the
apt/fpm/pipewire-header toolchain (CI runs it for you via `tools/ci`):

```bash
cd fluxer_desktop

# Linux system build dependencies (once):
cargo run --locked --manifest-path ../tools/ci/Cargo.toml -- \
  build-desktop --step install_linux_deps

# Bundle with the fork updater pointing at your repository:
FLUXER_FORK_UPDATE_REPO=<owner>/<repo> pnpm build

# Package (run on the target platform):
pnpm exec electron-builder --config electron-builder.config.cjs --linux --x64
pnpm exec electron-builder --config electron-builder.config.cjs --win --x64
```

Artifacts land in `fluxer_desktop/dist-electron/`. Without `FLUXER_FORK_UPDATE_REPO`, the
bundle has update checks fully disabled.

Windows packaging needs MSVC (the native addons build with it) and NSIS, which
electron-builder downloads on first use. CI handles all of this; local Windows builds are
only worth it for iterating.

## Instance checklist for voice

The desktop fix only covers the client side. On `chat.joaocosta.dev`, voice additionally
needs (see `fluxer_docs/src/content/docs/operator/configuration.mdx`):

- `FLUXER_LIVEKIT_ENABLED=true`, `FLUXER_LIVEKIT_API_KEY`/`FLUXER_LIVEKIT_API_SECRET`
  set (the Compose stack fills these from `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`).
- The seeded voice server must hand out an endpoint on the same origin the app loads
  (`wss://chat.joaocosta.dev/livekit` by default). If LiveKit runs on a different
  host/port, also set `FLUXER_CSP_EXTRA_CONNECT_SRC=wss://livekit.example.com` — the
  web client's CSP otherwise blocks the LiveKit socket while everything else works,
  which looks exactly like "voice is broken".
- The LiveKit UDP and TCP media ports published by Compose must be open/forwarded
  (signalling connects but no audio otherwise).

## Caveats

- The fork keeps the official app identity (name, `app.fluxer` id, `fluxer://` protocol,
  Linux package name `fluxer`, `~/.config/fluxer` data directory). It replaces an
  official install and shares its data — chosen deliberately; change
  `src/common/DesktopIdentity.ts` and `UserDataPath.ts` to coexist instead.
- Windows builds are unsigned: SmartScreen will warn on first run ("More info → Run
  anyway"). The NSIS setup installs per-user, so no UAC is needed.
- Windows auto-update applies to **Setup** installs: the app re-runs the NSIS setup
  silently (`/S --force-run`, per-user, no UAC) and the installer relaunches the app. The
  portable zip, AppImage and `deb` installs keep manual download links on each check.
  A download is only offered when the release also publishes its `.sha256` sidecar, which
  the workflow generates for every artifact.
- The updater compares `app.getVersion()` against the release tag with a plain dotted
  number comparison, so fork tags must always be greater than any version already
  installed (`2026.925.2` > `2026.925.1`).
