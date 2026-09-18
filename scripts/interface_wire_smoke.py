#!/usr/bin/env python3
"""Independent synthetic IKE clients over actual assigned IPv4/IPv6 sockets.
This checks implementation interoperability, not Apple's native VPN or offline iOS.
"""
from __future__ import annotations
import json
import queue
import socket
import struct
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = Path(subprocess.check_output(['swift', 'build', '--show-bin-path'], cwd=ROOT, text=True).strip()) / 'betterjit-probe'


def packet(cookie: bytes | None = None) -> bytes:
    sa = bytes.fromhex('0000002c010100040300000c0100000c800e01000300000802000005030000080300000c0000000804000013')
    payloads = [(33, sa), (34, bytes.fromhex('00130000') + b'\x01' * 64), (40, b'\xaa' * 32)]
    if cookie is not None:
        payloads.insert(0, (41, bytes.fromhex('00004006') + cookie))
    body = b''.join(struct.pack('!BBH', payloads[i + 1][0] if i + 1 < len(payloads) else 0, 0, len(data) + 4) + data
                    for i, (_, data) in enumerate(payloads))
    return bytes.fromhex('0102030405060708') + b'\0' * 8 + struct.pack('!BBBBII', payloads[0][0], 0x20, 34, 8, 0, 28 + len(body)) + body


def exercise(row: dict) -> None:
    events: queue.Queue[dict] = queue.Queue()
    proc = subprocess.Popen([str(BIN), 'listen', '--interface', row['name'], '--address', row['address'],
                             '--ike-port', '0', '--nat-port', '0', '--duration', '15'], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            events.put(json.loads(line))
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        ports = []
        while len(ports) < 2:
            event = events.get(timeout=5)
            if event['event'] == 'bound':
                ports.append(event['port'])
            if event['event'] == 'bindFailed':
                raise AssertionError(event)
        af = socket.AF_INET if row['family'] == 'ipv4' else socket.AF_INET6
        for index, port in enumerate(ports):
            marker = b'\0' * 4 if index == 1 else b''
            with socket.socket(af, socket.SOCK_DGRAM) as client:
                client.settimeout(3)
                client.bind((row['address'], 0))
                client.connect((row['address'], port))
                client.send(marker + packet())
                challenge = client.recv(1024)
                assert challenge[:len(marker)] == marker
                wire = challenge[len(marker):]
                assert len(wire) == 68 and wire[32:36] == bytes.fromhex('00004006')
                cookie = wire[36:]
                client.send(marker + packet(cookie=b'\0' * 32))
                assert client.recv(1024) == challenge, 'wrong cookie must not pass'
                client.send(marker + packet(cookie=cookie))
                end = client.recv(1024)
                assert len(end) == 36 + len(marker) and end[-4:] == bytes.fromhex('0000000e')
        print(f"PASS synthetic IKE COOKIE round trips: {row['name']} {row['family']}; plain + encapsulated")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(timeout=3)
        reader.join(timeout=2)
        if proc.stderr:
            error = proc.stderr.read()
            if error:
                print(error)


def main() -> None:
    rows = json.loads(subprocess.check_output([str(BIN), 'interfaces'], cwd=ROOT, text=True))
    chosen = []
    for family, loopback in [('ipv4', True), ('ipv6', True), ('ipv4', False)]:
        candidates = [r for r in rows if r['family'] == family and r['isUp'] and
                      (r['address'].startswith('127.') or r['address'] == '::1') == loopback and
                      not r['name'].startswith(('utun', 'ipsec', 'awdl', 'llw', 'ap', 'nan'))]
        if not candidates:
            print(f'SKIP no {family} loopback={loopback} address on this runner')
            continue
        chosen.append(candidates[0])
    assert chosen, 'no local interfaces tested'
    for row in chosen:
        exercise(row)


if __name__ == '__main__':
    main()
