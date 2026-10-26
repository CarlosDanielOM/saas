/** Public metadata only. Updater-only artifacts are deliberately not exposed. */
export const DESKTOP_DOWNLOAD_BASE_URL = 'https://domdimabot.hel1.your-objectstorage.com/desktop';
export type ReleaseChannel = 'stable' | 'beta';
export type DownloadKind = 'installer' | 'zip' | 'appimage' | 'tar.gz';
export interface DesktopArtifact {
  readonly kind: DownloadKind;
  readonly file: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}
export interface DesktopRelease {
  readonly version: string;
  readonly prerelease: boolean;
  readonly publishedAt: string;
  readonly windows: readonly DesktopArtifact[];
  readonly linux: readonly DesktopArtifact[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error('Invalid desktop release metadata'); }

/** Fail closed: every displayed link must match its expected, versioned public file. */
export function parseDesktopRelease(value: unknown, channel: ReleaseChannel): DesktopRelease {
  if (!record(value) || value['schema'] !== 1) return invalid();
  const version = value['version'];
  if (typeof version !== 'string' || version.length > 80 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) return invalid();
  const prerelease = value['prerelease'];
  if (typeof prerelease !== 'boolean' || prerelease !== version.includes('-') ||
      (channel === 'stable' && prerelease)) return invalid();
  const publishedAt = value['publishedAt'];
  if (typeof publishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(publishedAt) ||
      !Number.isFinite(Date.parse(publishedAt))) return invalid();
  const platforms = value['platforms'];
  if (!record(platforms)) return invalid();
  const parsePlatform = (platform: string, kinds: readonly DownloadKind[]): readonly DesktopArtifact[] => {
    const entries = platforms[platform];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > kinds.length) return invalid();
    const seen = new Set<DownloadKind>();
    const artifacts = entries.map((entry: unknown): DesktopArtifact => {
      if (!record(entry) || !kinds.includes(entry['kind'] as DownloadKind)) return invalid();
      const kind = entry['kind'] as DownloadKind;
      if (seen.has(kind)) return invalid();
      seen.add(kind);
      const suffix = kind === 'installer' ? 'windows-x64-setup.exe' : kind === 'zip' ? 'windows-x64.zip' :
        kind === 'appimage' ? 'linux-x86_64.AppImage' : 'linux-x86_64.tar.gz';
      const file = `Dima-${version}-${suffix}`;
      const url = `${DESKTOP_DOWNLOAD_BASE_URL}/releases/${version}/${file}`;
      if (entry['file'] !== file || entry['url'] !== url ||
          typeof entry['size'] !== 'number' || !Number.isSafeInteger(entry['size']) ||
          entry['size'] <= 0 || entry['size'] > 10 * 1024 ** 3 ||
          typeof entry['sha256'] !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry['sha256'])) return invalid();
      return { kind, file, url, size: entry['size'], sha256: entry['sha256'] };
    });
    if (!seen.has(kinds[0])) return invalid();
    return [...artifacts].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  };
  return { version, prerelease, publishedAt,
    windows: parsePlatform('windows-x64', ['installer', 'zip']),
    linux: parsePlatform('linux-x86_64', ['appimage', 'tar.gz']) };
}
