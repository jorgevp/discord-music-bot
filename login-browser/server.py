#!/usr/bin/env python3
"""Sign-in browser for the music bot.

Runs Chromium on a virtual display that the dashboard shows through noVNC, so the admin can sign in to
Google with their own email, password and 2-step verification. The bot then reads the session cookies from
the shared profile volume and asks this service to wipe the browser.

Ports (only reachable on the private network shared with the bot):
  6080  noVNC web client + websocket (the bot's dashboard proxies it behind its own sign-in)
  6081  control API for the bot, authenticated with a token written to /profile/control-token
"""
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PROFILE_ROOT = '/profile'
BROWSER_DIR = os.path.join(PROFILE_ROOT, 'chromium')
TOKEN_FILE = os.path.join(PROFILE_ROOT, 'control-token')
DISPLAY = ':99'
WIDTH, HEIGHT = 1280, 800
SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'
YOUTUBE_URL = 'https://www.youtube.com/'
MAX_SESSION_SECONDS = 30 * 60  # a forgotten sign-in window is wiped after this long

TOKEN = secrets.token_urlsafe(32)
lock = threading.RLock()
browser = None
browser_started_at = 0.0
services = {}


def log(message):
    print(f'[login-browser] {message}', flush=True)


def spawn(cmd):
    return subprocess.Popen(cmd, env={**os.environ, 'DISPLAY': DISPLAY}, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)


def start_display():
    services['xvfb'] = spawn(['Xvfb', DISPLAY, '-screen', '0', f'{WIDTH}x{HEIGHT}x24', '-nolisten', 'tcp'])
    for _ in range(50):
        if os.path.exists('/tmp/.X11-unix/X99'):
            break
        time.sleep(0.1)
    # VNC only listens on localhost; websockify is the single way in.
    services['x11vnc'] = spawn(['x11vnc', '-display', DISPLAY, '-rfbport', '5900', '-localhost', '-nopw',
                                '-forever', '-shared', '-quiet', '-noxdamage'])
    services['websockify'] = spawn(['websockify', '--web', '/usr/share/novnc', '6080', 'localhost:5900'])


def browser_running():
    return browser is not None and browser.poll() is None


def launch_browser(url):
    global browser, browser_started_at
    os.makedirs(BROWSER_DIR, exist_ok=True)
    browser = spawn([
        'chromium',
        f'--user-data-dir={BROWSER_DIR}',
        '--password-store=basic',  # fixed-key cookie encryption that yt-dlp can read (keyring "basictext")
        '--no-sandbox',             # Chromium's sandbox needs privileges Docker doesn't grant by default
        '--test-type',              # hides the "unsupported flag: --no-sandbox" banner
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter',
        '--lang=en-US',
        '--window-position=0,0',
        f'--window-size={WIDTH},{HEIGHT}',
        url,
    ])
    browser_started_at = time.time()
    log('browser started')


def stop_browser():
    """Closes Chromium gracefully so it writes its cookie database to disk."""
    global browser
    if browser is None:
        return
    if browser.poll() is None:
        try:
            browser.send_signal(signal.SIGTERM)
            browser.wait(timeout=15)
        except subprocess.TimeoutExpired:
            pass
    try:
        os.killpg(browser.pid, signal.SIGKILL)  # leftover renderer/zygote processes
    except ProcessLookupError:
        pass
    browser = None
    log('browser stopped')


def wipe_browser():
    stop_browser()
    shutil.rmtree(BROWSER_DIR, ignore_errors=True)
    log('browser profile wiped')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if secrets.compare_digest(self.headers.get('Authorization', ''), f'Bearer {TOKEN}'):
            return True
        self.reply(401, {'error': 'unauthorized'})
        return False

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            return self.reply(200, {'ok': True})
        if not self.authorized():
            return None
        if path == '/status':
            with lock:
                return self.reply(200, {'browser': browser_running()})
        return self.reply(404, {'error': 'not found'})

    def do_POST(self):
        url = urlparse(self.path)
        if not self.authorized():
            return None
        with lock:
            if url.path == '/start':
                fresh = parse_qs(url.query).get('fresh', ['0'])[0] == '1'
                if fresh:
                    wipe_browser()
                else:
                    stop_browser()
                launch_browser(SIGN_IN_URL if fresh else YOUTUBE_URL)
                return self.reply(200, {'browser': True})
            if url.path == '/stop':
                stop_browser()
                return self.reply(200, {'browser': False})
            if url.path == '/wipe':
                wipe_browser()
                return self.reply(200, {'browser': False})
        return self.reply(404, {'error': 'not found'})


def watchdog():
    while True:
        time.sleep(5)
        for name, process in services.items():
            if process.poll() is not None:
                log(f'{name} exited unexpectedly; restarting the container')
                os._exit(1)
        with lock:
            if browser_running() and time.time() - browser_started_at > MAX_SESSION_SECONDS:
                log('sign-in window was left open too long')
                wipe_browser()


def main():
    try:
        with open(TOKEN_FILE, 'w', encoding='utf-8') as handle:
            handle.write(TOKEN)
        os.chmod(TOKEN_FILE, 0o600)
    except OSError as err:
        log(f'cannot write to {PROFILE_ROOT}: {err}. The volume must be writable by uid {os.getuid()}.')
        sys.exit(1)
    shutil.rmtree(BROWSER_DIR, ignore_errors=True)  # never resume a stale session after a restart
    start_display()
    threading.Thread(target=watchdog, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: (wipe_browser(), os._exit(0)))
    log('ready: noVNC on :6080, control API on :6081')
    ThreadingHTTPServer(('0.0.0.0', 6081), Handler).serve_forever()


if __name__ == '__main__':
    main()
