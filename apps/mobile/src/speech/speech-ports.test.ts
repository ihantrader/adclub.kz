import { encodeWav, SPEECH_SAMPLE_RATE } from "@adclub/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeSpeechPortWith,
  type NativeAudioChunk,
  type NativeAudioStream,
  type NativeSpeechDeps,
} from "./native-speech-core";
import type { RecordingHandlers } from "./speech-port";
import { createWebSpeechPort, type WebSpeechEnv } from "./web-speech-port";

/** A promise the test resolves when it wants. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function spyHandlers() {
  const handlers: RecordingHandlers = { onUpdate: vi.fn(), onAutoStop: vi.fn() };
  return handlers;
}

const loud = () => {
  const samples = new Int16Array(SPEECH_SAMPLE_RATE / 5).fill(12_000);
  return samples.buffer;
};

/** A fake `AudioStream` that remembers whether it is running and who listens. */
function fakeNativeStream(startGate: Promise<void>) {
  const listeners = new Set<(chunk: NativeAudioChunk) => void>();
  const stream = {
    running: false,
    released: false,
    started: false,
    listeners,
    addListener(_event: "audioStreamBuffer", listener: (chunk: NativeAudioChunk) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    async start() {
      await startGate;
      stream.started = true;
      stream.running = true;
    },
    stop() {
      stream.running = false;
    },
    release() {
      stream.released = true;
    },
    emit() {
      for (const listener of listeners) {
        listener({ data: loud(), sampleRate: SPEECH_SAMPLE_RATE, channels: 1 });
      }
    },
  };
  return stream;
}

function nativeDeps(modeGate: Promise<void>, startGate: Promise<void>) {
  const streams: ReturnType<typeof fakeNativeStream>[] = [];
  const modes: boolean[] = [];
  const deps: NativeSpeechDeps = {
    permission: () => Promise.resolve({ status: "granted", canAskAgain: true }),
    request: () => Promise.resolve({ status: "granted", canAskAgain: true }),
    async setRecordingMode(recording) {
      modes.push(recording);
      if (recording) await modeGate;
    },
    createStream() {
      const stream = fakeNativeStream(startGate);
      streams.push(stream);
      return stream as NativeAudioStream;
    },
    openSettings: () => Promise.resolve(),
  };
  return { deps, streams, modes };
}

describe("the phone's port when the recording is cancelled during its start (TASK-059.A)", () => {
  it("opens no stream when cancelled while the audio mode is set", async () => {
    const mode = deferred();
    const { deps, streams, modes } = nativeDeps(mode.promise, Promise.resolve());
    const port = createNativeSpeechPortWith(deps);
    const handlers = spyHandlers();
    const starting = port.start(handlers);
    port.cancel();
    mode.resolve();
    await starting;
    expect(streams).toHaveLength(0);
    // The recording mode is turned off again: the microphone is not held.
    expect(modes.at(-1)).toBe(false);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
    expect(handlers.onAutoStop).not.toHaveBeenCalled();
  });

  it("leaves the recording mode of a newer attempt alone when a cancelled one ends late (acceptance)", async () => {
    const begin = deferred();
    const { deps, streams, modes } = nativeDeps(Promise.resolve(), begin.promise);
    const port = createNativeSpeechPortWith(deps);
    const first = port.start(spyHandlers());
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    // The sheet closed and opened again at once: a second attempt starts.
    port.cancel();
    const second = port.start(spyHandlers());
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    begin.resolve();
    await Promise.all([first, second]);
    expect(streams[0]!.released).toBe(true);
    expect(streams[1]!.running).toBe(true);
    // The late end of the first attempt did not switch the mode off under the second.
    expect(modes.at(-1)).toBe(true);
    port.cancel();
    expect(modes.at(-1)).toBe(false);
  });

  it("closes the stream that started after the cancel, and calls no handler", async () => {
    const begin = deferred();
    const { deps, streams, modes } = nativeDeps(Promise.resolve(), begin.promise);
    const port = createNativeSpeechPortWith(deps);
    const handlers = spyHandlers();
    const starting = port.start(handlers);
    // Wait for the stream to be created and its start awaited.
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    port.cancel();
    begin.resolve();
    await starting;
    const stream = streams[0]!;
    expect(stream.started).toBe(true);
    expect(stream.running).toBe(false);
    expect(stream.released).toBe(true);
    expect(stream.listeners.size).toBe(0);
    expect(modes.at(-1)).toBe(false);
    stream.emit();
    expect(handlers.onUpdate).not.toHaveBeenCalled();
    expect(handlers.onAutoStop).not.toHaveBeenCalled();
    // Nothing left to give: the cancelled recording is gone.
    expect(await port.finish()).toBeNull();
  });

  it("records as before when nothing cancels it", async () => {
    const { deps, streams } = nativeDeps(Promise.resolve(), Promise.resolve());
    const port = createNativeSpeechPortWith(deps);
    const handlers = spyHandlers();
    await port.start(handlers);
    const stream = streams[0]!;
    expect(stream.running).toBe(true);
    stream.emit();
    expect(handlers.onUpdate).toHaveBeenCalled();
    const capture = await port.finish();
    expect(capture?.seconds).toBeGreaterThan(0);
    expect(stream.running).toBe(false);
    expect(stream.listeners.size).toBe(0);
  });
});

/** A fake browser: tracks, an audio context, a substituted file — each remembers what is open. */
function fakeBrowser(options: {
  media?: Promise<void>;
  file?: Promise<void>;
  substitute?: boolean;
}) {
  const tracks: { stopped: boolean; stop(): void }[] = [];
  const contexts: { closed: boolean }[] = [];
  const processors: { onaudioprocess: ((event: unknown) => void) | null }[] = [];
  const wav = encodeWav(new Int16Array(SPEECH_SAMPLE_RATE).fill(9_000), SPEECH_SAMPLE_RATE);
  const env: WebSpeechEnv = {
    substitution: () => (options.substitute ? { file: "http://sample/ru.wav", speed: 10 } : null),
    async getUserMedia() {
      await options.media;
      const track = {
        stopped: false,
        stop() {
          track.stopped = true;
        },
      };
      tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    queryPermission: () => Promise.resolve("granted"),
    createAudioContext() {
      const context = {
        closed: false,
        sampleRate: SPEECH_SAMPLE_RATE,
        destination: {},
        createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
        createScriptProcessor() {
          const processor = {
            onaudioprocess: null as ((event: unknown) => void) | null,
            connect: () => undefined,
            disconnect: () => undefined,
          };
          processors.push(processor);
          return processor;
        },
        close() {
          context.closed = true;
          return Promise.resolve();
        },
      };
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    async fetchBytes() {
      await options.file;
      return wav;
    },
  };
  return { env, tracks, contexts, processors };
}

describe("the browser's port when the recording is cancelled during its start (TASK-059.A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the microphone it was given after the cancel and creates no audio context", async () => {
    const media = deferred();
    const browser = fakeBrowser({ media: media.promise });
    const port = createWebSpeechPort(browser.env);
    const handlers = spyHandlers();
    const starting = port.start(handlers);
    port.cancel();
    media.resolve();
    await starting;
    expect(browser.tracks).toHaveLength(1);
    expect(browser.tracks.every((track) => track.stopped)).toBe(true);
    expect(browser.contexts).toHaveLength(0);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
    expect(handlers.onAutoStop).not.toHaveBeenCalled();
    expect(await port.finish()).toBeNull();
  });

  it("plays no substituted file when cancelled while it loads", async () => {
    vi.useFakeTimers();
    const file = deferred();
    const browser = fakeBrowser({ file: file.promise, substitute: true });
    const port = createWebSpeechPort(browser.env);
    const handlers = spyHandlers();
    const starting = port.start(handlers);
    port.cancel();
    file.resolve();
    await starting;
    vi.advanceTimersByTime(5_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
    expect(handlers.onAutoStop).not.toHaveBeenCalled();
    expect(await port.finish()).toBeNull();
  });

  it("closes the tracks and the audio context of a recording cancelled after its start", async () => {
    const browser = fakeBrowser({});
    const port = createWebSpeechPort(browser.env);
    const handlers = spyHandlers();
    await port.start(handlers);
    expect(browser.contexts).toHaveLength(1);
    port.cancel();
    expect(browser.tracks.every((track) => track.stopped)).toBe(true);
    expect(browser.contexts.every((context) => context.closed)).toBe(true);
    expect(browser.processors.every((processor) => processor.onaudioprocess === null)).toBe(true);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
  });
});
