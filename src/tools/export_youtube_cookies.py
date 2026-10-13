"""Exports the YouTube/Google cookies of the sign-in browser's Chromium profile as a Netscape cookies.txt.

Usage: python export_youtube_cookies.py <chromium user-data-dir> <output file>
Prints the number of exported cookies. Uses yt-dlp's own cookie reader, so changes to Chromium's cookie
encryption are handled by yt-dlp updates.
"""
import sys

from yt_dlp.cookies import YoutubeDLCookieJar, load_cookies


def wanted(domain):
    domain = domain.lstrip('.')
    return any(domain == base or domain.endswith(f'.{base}') for base in ('youtube.com', 'google.com'))


def main():
    profile_dir, output = sys.argv[1], sys.argv[2]
    # BASICTEXT: the sign-in browser runs with --password-store=basic (fixed encryption key, no keyring).
    try:
        jar = load_cookies(None, ('chromium', profile_dir, 'BASICTEXT', None), None)
    except Exception as err:  # report the underlying cause, not yt-dlp's generic wrapper message
        cause = err.__cause__ or err.__context__ or err
        print(f'{type(cause).__name__}: {cause}', file=sys.stderr)
        sys.exit(1)
    out = YoutubeDLCookieJar(output)
    for cookie in jar:
        if wanted(cookie.domain):
            out.set_cookie(cookie)
    out.save(ignore_discard=True, ignore_expires=True)
    print(len(out))


if __name__ == '__main__':
    main()
