declare module "soundtouchjs" {
  interface SampleBuffer {
    readonly frameCount: number;
    putSamples(samples: Float32Array, position: number, frames: number): void;
    receiveSamples(samples: Float32Array, frames: number): void;
  }
  export class SoundTouch {
    tempo: number;
    pitch: number;
    rate: number;
    readonly inputBuffer: SampleBuffer;
    readonly outputBuffer: SampleBuffer;
    readonly stretch: {
      setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
    };
    process(): void;
  }
}
