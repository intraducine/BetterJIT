// Sound for Wine's OSS driver (wineoss.so, built against build/oss4's
// sys/soundcard.h): /dev/dsp plays what's written to it as time passes, and
// /dev/mixer says what's there. What the driver counts on is the clock:
// written sound drains from a small buffer at its rate, and the driver's
// position (a game's audio clock: FMOD's, which Thumper's intro waits on)
// follows it. The sound itself goes to host.audio when the host plays it.
'use strict';

const { File, fail, POLLOUT } = require('./kernel.js');
const { E } = require('./abi.js');

const AFMT_U8 = 0x8, AFMT_S16_LE = 0x10, AFMT_S32_LE = 0x1000, AFMT_FLOAT = 0x4000, AFMT_S24_LE = 0x8000;
const FORMATS = AFMT_U8 | AFMT_S16_LE | AFMT_S32_LE | AFMT_FLOAT | AFMT_S24_LE;
const BYTES = { [AFMT_U8]: 1, [AFMT_S16_LE]: 2, [AFMT_S32_LE]: 4, [AFMT_FLOAT]: 4, [AFMT_S24_LE]: 4 };
const PCM_CAP_OUTPUT = 0x20000;

// ioctls (_IO* 'P' for the device, 'M' the mixer, 'X' OSS 4's information)
const SNDCTL_DSP_RESET = 0x5000 /* (and HALT) */, SNDCTL_DSP_SYNC = 0x5001, SNDCTL_DSP_SPEED = 0xc0045002, SNDCTL_DSP_SETFMT = 0xc0045005,
  SNDCTL_DSP_CHANNELS = 0xc0045006, SNDCTL_DSP_GETOSPACE = 0x8010500c, SNDCTL_DSP_GETISPACE = 0x8010500d,
  SNDCTL_SYSINFO = 0x84e05801, SNDCTL_AUDIOINFO = 0xc49c5807, SNDCTL_ENGINEINFO = 0xc49c580c;
const AUDIOINFO_SIZE = 1180, SYSINFO_SIZE = 1248;

const FRAG = 2048, FRAGS = 16; // (32 KB: about 170 ms of 48 kHz stereo 16-bit)

function putString(u8, at, s, max) {
  const b = new TextEncoder().encode(s);
  u8.set(b.subarray(0, max - 1), at);
  u8[at + Math.min(b.length, max - 1)] = 0;
}

// oss_audioinfo for the one device (offsets: build/oss4/include/sys/soundcard.h)
function audioInfo(t, p) {
  const u8 = t.proc.mm.u8, dv = t.proc.mm.dv;
  u8.fill(0, p, p + AUDIOINFO_SIZE);
  dv.setInt32(p, 0, true); // dev
  putString(u8, p + 4, 'Madeira', 64); // name
  dv.setInt32(p + 72, -1, true); // pid
  dv.setInt32(p + 76, PCM_CAP_OUTPUT, true); // caps
  dv.setInt32(p + 84, FORMATS, true); // oformats
  dv.setInt32(p + 172, 1, true); // enabled
  dv.setInt32(p + 180, 8000, true); // min_rate
  dv.setInt32(p + 184, 192000, true); // max_rate
  dv.setInt32(p + 188, 1, true); // min_channels
  dv.setInt32(p + 192, 8, true); // max_channels
  putString(u8, p + 404, '/dev/dsp', 32); // devnode
  return 0;
}

class DspFile extends File {
  constructor() {
    super('dsp');
    this.fmt = AFMT_S16_LE;
    this.channels = 2;
    this.rate = 48000;
    this.queued = 0; // bytes written that haven't played yet
    this.at = performance.now();
  }
  get bytesPerMs() { return (this.rate * this.channels * BYTES[this.fmt]) / 1000; }
  drain() {
    const now = performance.now();
    this.queued = Math.max(0, this.queued - (now - this.at) * this.bytesPerMs);
    this.at = now;
  }
  free() {
    this.drain();
    return Math.max(0, Math.floor(FRAG * FRAGS - this.queued));
  }
  write(k, t, buf) {
    const n = Math.min(buf.length, this.free());
    if (n === 0) fail(E.AGAIN);
    this.queued += n;
    if (k.host.audio) k.host.audio({ fmt: this.fmt, channels: this.channels, rate: this.rate }, buf.subarray(0, n));
    return n;
  }
  read() { fail(E.INVAL); }
  poll() { return this.free() > 0 ? POLLOUT : 0; }
  ioctl(k, t, req, arg) {
    const dv = t.proc.mm.dv;
    switch (req) {
      case SNDCTL_DSP_SETFMT: {
        const want = dv.getInt32(arg, true);
        if (BYTES[want]) this.fmt = want;
        dv.setInt32(arg, this.fmt, true);
        return 0;
      }
      case SNDCTL_DSP_CHANNELS:
        this.channels = Math.max(1, Math.min(8, dv.getInt32(arg, true)));
        dv.setInt32(arg, this.channels, true);
        return 0;
      case SNDCTL_DSP_SPEED:
        this.rate = Math.max(8000, Math.min(192000, dv.getInt32(arg, true)));
        dv.setInt32(arg, this.rate, true);
        return 0;
      case SNDCTL_DSP_GETOSPACE: { // audio_buf_info: fragments, fragstotal, fragsize, bytes
        const free = this.free();
        dv.setInt32(arg, Math.floor(free / FRAG), true);
        dv.setInt32(arg + 4, FRAGS, true);
        dv.setInt32(arg + 8, FRAG, true);
        dv.setInt32(arg + 12, free, true);
        return 0;
      }
      case SNDCTL_DSP_RESET:
        this.queued = 0;
        this.at = performance.now();
        return 0;
      case SNDCTL_DSP_SYNC:
        return 0;
      case SNDCTL_ENGINEINFO:
      case SNDCTL_AUDIOINFO:
        return audioInfo(t, arg);
      case SNDCTL_DSP_GETISPACE:
      default:
        fail(E.INVAL);
    }
  }
  stat() { return { mode: 0o20666, ino: this.ino, rdev: 0x0e03 }; } // (S_IFCHR; OSS's major 14)
}

class MixerFile extends File {
  constructor() { super('mixer'); }
  read() { fail(E.INVAL); }
  write() { fail(E.INVAL); }
  ioctl(k, t, req, arg) {
    const u8 = t.proc.mm.u8, dv = t.proc.mm.dv;
    if (req === SNDCTL_SYSINFO) {
      u8.fill(0, arg, arg + SYSINFO_SIZE);
      putString(u8, arg, 'Madeira', 32); // product
      putString(u8, arg + 32, '4.2', 32); // version
      dv.setInt32(arg + 64, 0x040200, true); // versionnum
      dv.setInt32(arg + 196, 1, true); // numaudios
      dv.setInt32(arg + 244, 1, true); // nummixers
      dv.setInt32(arg + 280, 1, true); // numcards
      dv.setInt32(arg + 284, 1, true); // numaudioengines
      return 0;
    }
    if (req === SNDCTL_AUDIOINFO || req === SNDCTL_ENGINEINFO) return audioInfo(t, arg);
    // SOUND_MIXER_READ_x (_IOR('M', x, int)): full volume; WRITE_x: taken
    if ((req & 0xffffff00) === 0x80044d00) { dv.setInt32(arg, 100 | (100 << 8), true); return 0; }
    if ((req & 0xffffff00) === 0xc0044d00) return 0;
    fail(E.INVAL);
  }
  stat() { return { mode: 0o20666, ino: this.ino, rdev: 0x0e00 }; }
}

module.exports = { DspFile, MixerFile };
