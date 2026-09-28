import base64
from collections import deque
import json
import os
import threading

import httpx
from dotenv import load_dotenv

try:
    import sounddevice as sd
except ImportError as error:
    raise SystemExit("Install audio playback support: python -m pip install sounddevice") from error


SAMPLE_RATE = 44_100
BYTES_PER_FRAME = 2  # Fish Audio PCM is 16-bit mono.
BLOCK_FRAMES = 882  # 20 ms at 44.1 kHz.
VOICE_ID = "b347db033a6549378b48d00acb0d06cd"  # Selene
TEXT = "The starship emerged from Saturn's shadow, its rings blazing like a silver horizon. Ahead, a blue planet turned beneath a veil of auroras, and something on its dark side blinked in reply."


def sse_events(response):
    data_lines = []
    for line in response.iter_lines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line and data_lines:
            yield json.loads("\n".join(data_lines))
            data_lines.clear()
    if data_lines:
        yield json.loads("\n".join(data_lines))


def main():
    load_dotenv()
    api_key = os.environ.get("FISH_API_KEY")
    if not api_key:
        raise SystemExit("Set FISH_API_KEY in .env before running this script.")

    audio_chunks = deque()
    playback_segments = deque(maxlen=256)
    alignment_by_chunk = {}
    playback_lock = threading.Lock()
    alignment_lock = threading.Lock()
    playback_ready = threading.Event()
    request_done = threading.Event()
    playback_done = threading.Event()
    stop_display = threading.Event()

    current_chunk = memoryview(b"")
    current_position = 0
    frames_submitted = 0
    bytes_received = 0

    def audio_callback(outdata, frames, time_info, status):
        nonlocal current_chunk, current_position, frames_submitted
        output = memoryview(outdata)
        output[:] = bytes(len(output))

        if not playback_ready.is_set():
            return

        written = 0
        while written < len(output):
            if current_position == len(current_chunk):
                try:
                    current_chunk = memoryview(audio_chunks.popleft())
                except IndexError:
                    break
                current_position = 0

            count = min(len(output) - written, len(current_chunk) - current_position)
            output[written : written + count] = current_chunk[
                current_position : current_position + count
            ]
            written += count
            current_position += count

        if written:
            with playback_lock:
                playback_segments.append(
                    (time_info.outputBufferDacTime, frames_submitted, written // BYTES_PER_FRAME)
                )
            frames_submitted += written // BYTES_PER_FRAME

        if request_done.is_set() and not audio_chunks and current_position == len(current_chunk):
            raise sd.CallbackStop()

    def audible_seconds(stream):
        now = stream.time
        with playback_lock:
            segments = list(playback_segments)
        for dac_time, first_frame, count in reversed(segments):
            if now >= dac_time:
                played = min(count, max(0, (now - dac_time) * SAMPLE_RATE))
                return (first_frame + played) / SAMPLE_RATE
        return 0.0

    def display_words(stream):
        displayed = set()
        while True:
            playhead = audible_seconds(stream)
            with alignment_lock:
                snapshots = list(alignment_by_chunk.items())

            for chunk_seq, snapshot in sorted(snapshots):
                offset = snapshot["offset"]
                for index, segment in enumerate(snapshot["segments"]):
                    key = (chunk_seq, index)
                    start = offset + segment["start"]
                    if key not in displayed and start <= playhead:
                        end = offset + segment["end"]
                        print(f"{start:6.2f}s - {end:6.2f}s  {segment['text']}", flush=True)
                        displayed.add(key)

            if stop_display.wait(0.01):
                break

    with sd.RawOutputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        blocksize=BLOCK_FRAMES,
        latency="low",
        callback=audio_callback,
        finished_callback=playback_done.set,
    ) as stream:
        display_thread = threading.Thread(target=display_words, args=(stream,), daemon=True)
        display_thread.start()
        try:
            with httpx.stream(
                "POST",
                "https://api.fish.audio/v1/tts/stream/with-timestamp",
                headers={"Authorization": f"Bearer {api_key}", "model": "s2.1-pro-free"},
                json={
                    "text": TEXT,
                    "reference_id": VOICE_ID,
                    "format": "pcm",
                    "sample_rate": SAMPLE_RATE,
                    "latency": "balanced",
                },
                timeout=httpx.Timeout(connect=10, read=60, write=10, pool=10),
            ) as response:
                response.raise_for_status()
                remainder = b""
                for event in sse_events(response):
                    audio = remainder + base64.b64decode(event["audio_base64"])
                    complete_bytes = len(audio) // BYTES_PER_FRAME * BYTES_PER_FRAME
                    if complete_bytes:
                        audio_chunks.append(audio[:complete_bytes])
                        bytes_received += complete_bytes
                        if bytes_received >= SAMPLE_RATE * BYTES_PER_FRAME // 10:
                            playback_ready.set()
                    remainder = audio[complete_bytes:]

                    alignment = event.get("alignment")
                    if alignment is not None:
                        with alignment_lock:
                            # Snapshots are cumulative for each text chunk.
                            alignment_by_chunk[event["chunk_seq"]] = {
                                "offset": event["chunk_audio_offset_sec"],
                                "segments": alignment["segments"],
                            }

                if remainder:
                    raise ValueError("Fish Audio returned an incomplete PCM sample.")
        finally:
            request_done.set()
            playback_ready.set()
            completed = playback_done.wait(bytes_received / (SAMPLE_RATE * BYTES_PER_FRAME) + 5)
            stop_display.set()
            display_thread.join()

        if not completed:
            raise RuntimeError("Audio playback did not finish.")
        if not bytes_received:
            raise RuntimeError("Fish Audio returned no audio.")


if __name__ == "__main__":
    main()
