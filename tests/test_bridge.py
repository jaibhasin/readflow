import base64
import json
import msgpack
import unittest

from bridge.main import fish_events, text_fragments


class FakeSocket:
    def __init__(self, frames: list[bytes]) -> None:
        self.frames = frames
        self.index = 0
        self.sent: list[bytes] = []
        self.closed = False

    def __aiter__(self):
        self.index = 0
        return self

    async def __anext__(self) -> bytes:
        if self.index >= len(self.frames):
            raise StopAsyncIteration
        frame = self.frames[self.index]
        self.index += 1
        return frame

    async def send(self, frame: bytes) -> None:
        self.sent.append(frame)

    async def close(self) -> None:
        self.closed = True


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def test_text_fragments_prefer_word_boundaries(self) -> None:
        text = "one two three four"

        self.assertEqual(list(text_fragments(text, 8)), ["one two ", "three ", "four"])

    async def test_fish_events_preserve_audio_alignment_and_offsets(self) -> None:
        alignment = {
            "segments": [{"text": "hello", "start": 0.0, "end": 0.4}],
            "audio_duration": 0.4,
        }
        socket = FakeSocket(
            [
                msgpack.packb(
                    {
                        "event": "audio",
                        "audio": b"\x00\x80",
                        "alignment": alignment,
                        "chunk_seq": 3,
                        "chunk_audio_offset_sec": 1.25,
                        "content": "hello",
                    },
                    use_bin_type=True,
                ),
                msgpack.packb({"event": "finish", "reason": "stop"}, use_bin_type=True),
            ]
        )

        events = [
            json.loads(record.decode().removeprefix("data: "))
            async for record in fish_events(socket, "hello", "session-1")
        ]

        self.assertEqual(events[0]["event"], "connected")
        self.assertEqual(events[0]["session_id"], "session-1")
        self.assertEqual(events[1]["audio_base64"], base64.b64encode(b"\x00\x80").decode())
        self.assertEqual(events[1]["alignment"], alignment)
        self.assertEqual(events[1]["chunk_seq"], 3)
        self.assertEqual(events[1]["chunk_audio_offset_sec"], 1.25)
        self.assertEqual(events[1]["audio_event_index"], 1)
        self.assertEqual(events[1]["audio_byte_count"], 2)
        self.assertEqual(events[1]["session_id"], "session-1")
        self.assertGreaterEqual(events[1]["bridge_elapsed_ms"], 0)
        self.assertEqual(events[2]["event"], "finish")
        self.assertEqual(events[2]["session_id"], "session-1")
        self.assertEqual(events[2]["text_fragments"][0]["text"], "hello")
        self.assertEqual(events[2]["text_fragments"][0]["char_count"], 5)
        self.assertTrue(socket.closed)


if __name__ == "__main__":
    unittest.main()
