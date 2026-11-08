import { isWinSCP, type FileProfile } from '@safestep/contracts';
export const products: Record<FileProfile, { name: string; page: string; publisher: string; package: string }> = {
  vlc_windows_x64: {
    name: 'VLC',
    page: 'https://www.videolan.org/vlc/download-windows.html',
    publisher: 'VideoLAN',
    package: 'Windows x64 EXE',
  },
  seven_zip_windows_x64_exe: {
    name: '7-Zip',
    page: 'https://www.7-zip.org/download.html',
    publisher: '7-Zip',
    package: 'Windows x64 EXE',
  },
  winscp_windows_setup: { name: 'WinSCP', page: 'https://winscp.net/eng/download.php', publisher: 'WinSCP', package: 'Windows Setup EXE' },
  winscp_portable: { name: 'WinSCP', page: 'https://winscp.net/eng/downloads.php', publisher: 'WinSCP', package: 'Windows portable ZIP' },
};
export function packageLabel(profile: FileProfile) {
  return products[profile].name + ' · ' + products[profile].package;
}
export function packageMatches(profile: FileProfile, url: URL, version: string) {
  if (
    !/^\d+(?:\.\d+){1,3}$/.test(version) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.protocol !== 'https:'
  )
    return false;
  if (isWinSCP(profile)) {
    const file = profile === 'winscp_windows_setup' ? 'Setup.exe' : 'Portable.zip';
    return url.origin === 'https://winscp.net' && url.pathname === '/download/WinSCP-' + version + '-' + file + '/download';
  }
  if (profile === 'vlc_windows_x64')
    return (
      url.origin === 'https://get.videolan.org' &&
      url.pathname === '/vlc/' + version + '/win64/vlc-' + version + '-win64.exe'
    );
  return (
    url.origin === 'https://github.com' &&
    url.pathname ===
      '/ip7z/7zip/releases/download/' + version + '/7z' + version.replaceAll('.', '') + '-x64.exe'
  );
}
export function fixturePage(u: URL, kind: 'website' | 'download') {
  return (
    ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
    u.pathname === (kind === 'website' ? '/trust-lab' : '/download-lab')
  );
}
