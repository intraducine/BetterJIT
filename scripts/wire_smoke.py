#!/usr/bin/env python3
"""Independent UDP wire test; passing does NOT prove native iOS behavior."""
import json
import queue
import socket
import struct
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def request(cookie=None):
    # A syntactically valid AES-CBC-256 / PRF-SHA256 / SHA256-128 / ECP-256 offer.
    sa = bytes.fromhex("0000002c01010004 0300000c0100000c800e0100 "
                       "0300000802000005 030000080300000c 0000000804000013")
    # P-256 generator point, without the SEC1 04 prefix. No DH negotiation occurs.
    point = bytes.fromhex("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
                          "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
    payloads = [(33, sa), (34, struct.pack("!HH", 19, 0) + point), (40, b"N" * 32)]
    if cookie is not None:
        payloads.insert(0, (41, struct.pack("!BBH", 0, 0, 16390) + cookie))
    body = b""
    for index, (_, payload) in enumerate(payloads):
        following = payloads[index + 1][0] if index + 1 < len(payloads) else 0
        body += struct.pack("!BBH", following, 0, len(payload) + 4) + payload
    return struct.pack("!QQBBBBII", 0x0102030405060708, 0, payloads[0][0], 0x20, 34, 8, 0, 28 + len(body)) + body


def notification(data, expected):
    spi_i, spi_r, next_type, version, exchange, flags, message_id, length = struct.unpack("!QQBBBBII", data[:28])
    assert (spi_i, spi_r, next_type, version, exchange, flags, message_id, length) == (
        0x0102030405060708, 0, 41, 0x20, 34, 0x20, 0, len(data))
    next_payload, critical, payload_length, protocol, spi_size, notify = struct.unpack("!BBHBBH", data[28:36])
    assert (next_payload, critical, payload_length, protocol, spi_size, notify) == (0, 0, len(data) - 28, 0, 0, expected)
    return data[36:]


def main():
    binary = ROOT / ".build/debug/betterjit-probe"
    process = subprocess.Popen([str(binary), "listen", "--ike-port", "0", "--nat-port", "0", "--duration", "20"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    records = queue.Queue()
    def collect():
        for line in process.stdout:
            records.put(json.loads(line))
    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    try:
        bindings = [records.get(timeout=10), records.get(timeout=10)]
        assert all(record["event"] == "bound" for record in bindings), bindings
        for binding, encapsulated in zip(bindings, (False, True)):
            marker = b"\x00" * 4 if encapsulated else b""
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.bind(("127.0.0.1", 0)); client.settimeout(2)
                endpoint = ("127.0.0.1", binding["port"])
                def exchange(payload):
                    client.sendto(marker + payload, endpoint)
                    reply, source = client.recvfrom(4096)
                    assert source == endpoint
                    assert reply.startswith(marker)
                    return reply[len(marker):]
                cookie = notification(exchange(request()), 16390)
                assert len(cookie) == 32
                # Wrong cookies must not be reported as a successful round trip.
                assert notification(exchange(request(b"x" * 32)), 16390) == cookie
                assert notification(exchange(request(cookie)), 14) == b""
                assert notification(exchange(request(cookie)), 14) == b""  # Retransmission.
                malformed = bytearray(request()); malformed[24:28] = b"\xff" * 4
                client.sendto(marker + malformed, endpoint); client.settimeout(0.15)
                try:
                    client.recvfrom(4096)
                    raise AssertionError("Malformed length received a reply")
                except socket.timeout:
                    pass
        confirmed = 0
        while confirmed < 2:
            record = records.get(timeout=2)
            confirmed += record["event"] == "cookieRoundTrip"
        print("PASS: real UDP cookie round trips on plain and encapsulated sockets; malformed packets dropped")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)
        reader.join(timeout=2)
        errors = process.stderr.read()
        if process.returncode != 0:
            raise RuntimeError(f"Probe exited {process.returncode}: {errors}")


if __name__ == "__main__":
    main()
