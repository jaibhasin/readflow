# Third-party audio software

Readflow includes unmodified SoundTouchJS 0.3.0 under LGPL-2.1.
Copyright Olli Parviainen, Ryan Berdeen, Jakub Fiala, and Steve Cutter Blades.
The license is included in SOUNDTOUCH-LICENSE.txt.

The corresponding library source is available in the [SoundTouchJS v0.3.0 source tree](https://github.com/cutterbl/SoundTouchJS/tree/v0.3.0) and in the [npm source package](https://registry.npmjs.org/soundtouchjs/-/soundtouchjs-0.3.0.tgz).
To replace the library, install your modified compatible package in the Readflow source checkout and run `npm run build`.
The dependency is bundled locally; playback does not load executable code from a remote server.
