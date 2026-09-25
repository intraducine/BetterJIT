#!/usr/bin/env python3
"""REAL browser OPFS/Wasm checks. This does not simulate a successful native bridge."""
import argparse
import functools
import http.server
import json
import pathlib
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.mjs'):
            return 'text/javascript'
        return super().guess_type(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium', 'webkit'], default='chromium')
    parser.add_argument('--executable')
    parser.add_argument('--large', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='betterjit-web-') as temp:
        directory = pathlib.Path(temp)
        for source in (ROOT / 'Web').iterdir():
            shutil.copy(source, directory / source.name)
        shutil.copy(ROOT / '.build/fixtures/fixtures.json', directory / 'fixtures.json')
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=temp))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                launch = {'headless': True}
                if args.executable:
                    launch['executable_path'] = args.executable
                if args.browser == 'chromium':
                    launch['args'] = ['--no-sandbox', '--disable-dev-shm-usage']
                browser = getattr(playwright, args.browser).launch(**launch)
                page = browser.new_page()
                page.set_default_timeout(120000)
                page.goto(f'http://127.0.0.1:{server.server_port}/')
                page.wait_for_function('window.betterjit !== undefined')
                report = page.evaluate('(large) => window.betterjit.run({large})', args.large)
                output = ROOT / f'.build/browser-report-{args.browser}.json'
                output.write_text(json.dumps(report, indent=2) + '\n')
                print(json.dumps(report, indent=2))
                assert report['passed'], 'Probe reported a failure'
                assert not report['nativeTransportVerified'], 'Browser must not falsely claim native success'
                for stage in ['native-translated-wasm', 'linear-memory', 'wasm-opfs-memory', 'cleanup']:
                    assert any(r['stage'] == stage and r['status'] == 'PASS' for r in report['records']), stage
                if args.large:
                    assert any(r['stage'] == 'high-offset-memory' and r['status'] == 'PASS' for r in report['records'])
                browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    main()
