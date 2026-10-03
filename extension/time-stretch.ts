import { SoundTouch } from "soundtouchjs";

/** One continuous processor per playback run, never one per network chunk. */
export class StreamingTimeStretch {
  private readonly processor: SoundTouch | null;
  private inputFrames = 0;
  private outputFrames = 0;
  private finished = false;
  private readonly paddingFrames: number;
  readonly speed: number;

  constructor(speed: number, sampleRate: number) {
    if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("Invalid time-stretch settings");
    }
    this.speed = speed;
    this.paddingFrames = Math.ceil(sampleRate / 2);
    // At normal speed retain the original PCM exactly, without processing delay.
    this.processor = speed === 1 ? null : new SoundTouch();
    if (this.processor) {
      this.processor.stretch.setParameters(sampleRate, 0, 0, 8);
      this.processor.tempo = speed;
      this.processor.pitch = 1;
      this.processor.rate = 1;
    }
  }

  push(samples: Float32Array): Float32Array<ArrayBuffer> {
    if (this.finished) {
      throw new Error("Cannot append audio after finishing");
    }
    this.inputFrames += samples.length;
    if (!this.processor) {
      this.outputFrames += samples.length;
      return new Float32Array(samples);
    }
    this.putMono(samples);
    this.processor.process();
    return this.drain();
  }

  finish(): Float32Array<ArrayBuffer> {
    if (this.finished) {
      return new Float32Array();
    }
    this.finished = true;
    if (!this.processor || this.inputFrames === 0) {
      return new Float32Array();
    }
    // SoundTouch retains a lookahead and overlap tail. Silence releases it;
    // drain trims the padding to the exact requested source duration.
    const remaining = Math.round(this.inputFrames / this.speed) - this.outputFrames;
    this.putMono(new Float32Array(this.paddingFrames + Math.ceil(remaining * this.speed)));
    this.processor.process();
    return this.drain();
  }

  private putMono(samples: Float32Array): void {
    const stereo = new Float32Array(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
      stereo[index * 2] = samples[index];
      stereo[index * 2 + 1] = samples[index];
    }
    this.processor!.inputBuffer.putSamples(stereo, 0, samples.length);
  }

  private drain(): Float32Array<ArrayBuffer> {
    const count = Math.min(
      this.processor!.outputBuffer.frameCount,
      Math.max(0, Math.round(this.inputFrames / this.speed) - this.outputFrames),
    );
    const stereo = new Float32Array(count * 2);
    this.processor!.outputBuffer.receiveSamples(stereo, count);
    const mono = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      mono[index] = stereo[index * 2];
    }
    this.outputFrames += count;
    return mono;
  }
}
