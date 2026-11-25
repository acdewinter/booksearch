// Receiving one file over DCC: connect to the sender (or wait for the sender
// to connect to us), write what arrives to a ".part" file, acknowledge it.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const CONNECT_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 120_000;

export class DccReceive extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.partPath where the incoming bytes are written
   * @param {number} o.size     announced size in bytes (0 = unknown)
   * @param {number} o.offset   bytes already in partPath (resuming)
   * @param {string} [o.host]   sender address (when we connect to them)
   * @param {number} [o.port]
   * @param {boolean} [o.secure] TLS (DCC SSEND)
   */
  constructor(o) {
    super();
    this.partPath = o.partPath;
    this.size = o.size || 0;
    this.offset = o.offset || 0;
    this.received = this.offset; // position in the file, which is also what gets acknowledged
    this.host = o.host;
    this.port = o.port;
    this.secure = Boolean(o.secure);
    this.finished = false;
    this.socket = null;
    this.server = null;
    this.file = null;
    this.timer = null;
  }

  /** Connect to the sender. */
  start() {
    const options = { host: this.host, port: this.port };
    const socket = this.secure
      ? tls.connect({ ...options, rejectUnauthorized: false }) // senders use self-signed certificates
      : net.connect(options);
    this.socket = socket;
    this.timer = setTimeout(() => this.#fail('The sender did not answer. It may be behind a firewall.'), CONNECT_TIMEOUT_MS);
    socket.once('error', (err) => {
      if (!this.file) this.#fail(`Could not connect to the sender (${err.code || err.message}).`);
    });
    socket.once(this.secure ? 'secureConnect' : 'connect', () => this.#attach(socket));
  }

  /** Wait for the sender to connect to a port we opened (reverse DCC). */
  startListening(server, timeoutMs) {
    this.server = server;
    this.timer = setTimeout(
      () => this.#fail('The sender never connected. Check that the DCC port is forwarded to this machine.'),
      timeoutMs,
    );
    server.once('connection', (socket) => {
      server.close();
      this.server = null;
      this.socket = socket;
      this.#attach(socket);
    });
    server.once('error', (err) => this.#fail(`Could not listen for the sender: ${err.message}`));
  }

  #attach(socket) {
    clearTimeout(this.timer);
    if (this.finished) return socket.destroy();

    this.file = fs.createWriteStream(this.partPath, this.offset > 0 ? { flags: 'r+', start: this.offset } : { flags: 'w' });
    this.file.on('error', (err) => this.#fail(`Could not write the file: ${describeFsError(err)}`));

    socket.setTimeout(STALL_TIMEOUT_MS, () => this.#fail('The sender stopped sending data.'));
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => {}); // 'close' follows and decides what it means
    socket.on('close', () => {
      if (this.finished) return;
      if (this.size === 0 && this.received > 0) this.#complete();
      else if (this.size > 0) {
        const pct = Math.floor((this.received / this.size) * 100);
        this.#fail(`The sender closed the connection at ${pct}%.`);
      } else this.#fail('The sender closed the connection before sending anything.');
    });
    this.emit('start');
  }

  #onData(chunk) {
    if (this.finished) return;
    let data = chunk;
    if (this.size > 0 && this.received + data.length > this.size) {
      data = data.subarray(0, this.size - this.received);
    }
    this.received += data.length;
    if (data.length && !this.file.write(data)) {
      // The disk is slower than the network: stop reading until it catches up.
      this.socket.pause();
      this.file.once('drain', () => this.socket?.resume());
    }
    this.#acknowledge();
    if (this.size > 0 && this.received >= this.size) this.#complete();
  }

  /** DCC senders expect the running byte count back, as a 32-bit number. */
  #acknowledge() {
    if (!this.socket?.writable) return;
    const ack = Buffer.allocUnsafe(4);
    ack.writeUInt32BE(this.received % 0x1_0000_0000);
    this.socket.write(ack);
  }

  #complete() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    const socket = this.socket;
    socket.setTimeout(0);
    socket.end();
    setTimeout(() => socket.destroy(), 5000).unref();
    this.file.end(() => this.emit('done'));
  }

  #stop() {
    this.finished = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  #fail(message) {
    if (this.finished) return;
    this.#stop();
    const report = () => this.emit('failed', message);
    if (this.file && !this.file.destroyed) this.file.end(report);
    else report();
  }

  /** Stop on the user's request. Calls back once the file is closed. */
  cancel(done = () => {}) {
    if (this.finished) return done();
    this.#stop();
    if (this.file && !this.file.destroyed) {
      this.file.once('close', done);
      this.file.destroy();
    } else done();
  }
}

export function describeFsError(err) {
  switch (err.code) {
    case 'ENOSPC': return 'the disk is full.';
    case 'EACCES': case 'EPERM': return 'the download folder is not writable.';
    case 'EROFS': return 'the download folder is read-only.';
    case 'ENOENT': return 'the download folder is missing.';
    default: return err.message;
  }
}

/** Open a listening port from the range, for a sender that wants us to accept the connection. */
export function listenInRange(min, max) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > max) return reject(new Error('Every DCC port is in use.'));
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.listen(port, '0.0.0.0', () => {
        server.removeAllListeners('error');
        resolve({ server, port });
      });
    };
    tryPort(min);
  });
}
