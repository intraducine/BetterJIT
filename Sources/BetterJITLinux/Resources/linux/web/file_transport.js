// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded range I/O remains available when native OPFS channels are unavailable.
(function (G) {
  'use strict';
  const CHUNK = 1 << 20;
  function httpRange(request, origin, path, offset, length, into) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        !(into instanceof Uint8Array) || length > into.length) throw new Error('Invalid file range.');
    for (let got = 0; got < length;) {
      const count = Math.min(CHUNK, length - got);
      const bytes = request('GET', `${origin}/fs/file?p=${encodeURIComponent(path)}&off=${offset + got}&len=${count}`);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count) throw new Error(`${path}: short HTTP range read`);
      into.set(bytes, got); got += count;
    }
  }
  G.BetterJITFileTransport = { httpRange, maximumHTTPRangeBytes: CHUNK };
})(typeof self !== 'undefined' ? self : globalThis);
