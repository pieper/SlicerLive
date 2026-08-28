"""Minimal RFC 6455 WebSocket server on Qt sockets (main thread, event driven, no threads), with text
AND binary frames. The framing helpers are the ones proven in LiveStoryLib/mrson_live.py; this adds
binary send + a small server/client abstraction so gui_stream (and later the mrson peer) share it.
ASCII only.
"""
import os
import re
import urllib.parse
import base64
import hashlib
import struct

import qt

_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _accept_key(key):
    return base64.b64encode(hashlib.sha1((key + _WS_MAGIC).encode()).digest()).decode()


def _encode(opcode, data):
    n = len(data)
    hdr = bytearray([0x80 | opcode])
    if n < 126:
        hdr.append(n)
    elif n < 65536:
        hdr.append(126); hdr += struct.pack(">H", n)
    else:
        hdr.append(127); hdr += struct.pack(">Q", n)
    return bytes(hdr) + data


def _decode_frames(buf):
    out = []
    while len(buf) >= 2:
        b1 = buf[1]
        opcode = buf[0] & 0x0F
        masked = b1 & 0x80
        ln = b1 & 0x7F
        idx = 2
        if ln == 126:
            if len(buf) < idx + 2:
                break
            ln = struct.unpack(">H", bytes(buf[idx:idx + 2]))[0]; idx += 2
        elif ln == 127:
            if len(buf) < idx + 8:
                break
            ln = struct.unpack(">Q", bytes(buf[idx:idx + 8]))[0]; idx += 8
        if masked:
            if len(buf) < idx + 4:
                break
            mask = buf[idx:idx + 4]; idx += 4
        if len(buf) < idx + ln:
            break
        payload = bytearray(buf[idx:idx + ln])
        if masked:
            for i in range(ln):
                payload[i] ^= mask[i % 4]
        del buf[:idx + ln]
        out.append((opcode, bytes(payload)))
    return out


class WsClient:
    def __init__(self, socket, server):
        self.socket = socket
        self.server = server
        self.buf = bytearray()
        self.handshook = False
        socket.connect("readyRead()", self._on_ready_read)
        socket.connect("disconnected()", self._on_disconnected)

    def _on_ready_read(self):
        self.buf += bytes(self.socket.readAll().data())
        if not self.handshook:
            if b"\r\n\r\n" not in self.buf:
                return
            header, _, rest = bytes(self.buf).partition(b"\r\n\r\n")
            self.buf = bytearray(rest)
            key = None
            lines = header.decode("latin1").split("\r\n")
            for line in lines:
                if line.lower().startswith("sec-websocket-key:"):
                    key = line.split(":", 1)[1].strip()
            if not key:
                self.socket.close(); return
            if self.server.token:                      # remote deployments: ws://host/?token=... (or wss behind a proxy)
                m = re.search(r"[?&]token=([^&\s]+)", lines[0])
                if not m or urllib.parse.unquote(m.group(1)) != self.server.token:
                    self.socket.write(qt.QByteArray(b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"))
                    self.socket.close(); return
            resp = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    "Sec-WebSocket-Accept: " + _accept_key(key) + "\r\n\r\n")
            self.socket.write(qt.QByteArray(resp.encode()))
            self.handshook = True
        for opcode, payload in _decode_frames(self.buf):
            if opcode == 0x8:
                self.socket.close(); return
            if opcode == 0x9:                         # ping -> pong
                self.socket.write(qt.QByteArray(_encode(0xA, payload)))
            elif opcode == 0x1:
                self.server.on_message(self, payload.decode("utf-8", "replace"))

    def send_text(self, text):
        try:
            self.socket.write(qt.QByteArray(_encode(0x1, text.encode("utf-8"))))
        except Exception:  # noqa: BLE001
            pass

    def send_binary(self, data):
        try:
            self.socket.write(qt.QByteArray(_encode(0x2, data)))
        except Exception:  # noqa: BLE001
            pass

    def _on_disconnected(self):
        self.server._drop(self)


class WsServer:
    def __init__(self, port, on_message, on_close=None, token=None):
        self.port = port
        # Shared secret every client must present as ?token= on the upgrade request. Default from the
        # launcher's MODULESERVER_TOKEN; empty = open (local use).
        self.token = token if token is not None else os.environ.get("MODULESERVER_TOKEN", "")
        self.on_message = on_message
        self.on_close = on_close
        self.clients = []
        self.server = qt.QTcpServer()
        self.server.connect("newConnection()", self._on_new_connection)
        if not self.server.listen(qt.QHostAddress(qt.QHostAddress.Any), port):
            raise RuntimeError("ws: could not listen on %d" % port)

    def _on_new_connection(self):
        while self.server.hasPendingConnections():
            self.clients.append(WsClient(self.server.nextPendingConnection(), self))

    def _drop(self, client):
        if client in self.clients:
            self.clients.remove(client)
        if self.on_close:
            self.on_close(client)

    def stop(self):
        for c in list(self.clients):
            try: c.socket.close()
            except Exception: pass  # noqa: BLE001
        self.clients = []
        self.server.close()
