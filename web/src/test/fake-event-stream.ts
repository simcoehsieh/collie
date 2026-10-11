// FORK — a fake `/api/events` for the live feed's tests (lib/live-feed.ts reads the stream through
// `fetch`, so the fake is a fetch). Every other URL goes to the fetch that was installed before it,
// which is MSW's under the DOM project. The test drives each stream from outside: answer it, write
// frames into its body, end it, or see that the client aborted it.

import { __setLiveFeedSupported } from "@/lib/live-feed";

export class FakeEventStream {
  static all: FakeEventStream[] = [];
  static get last(): FakeEventStream | null {
    return FakeEventStream.all.at(-1) ?? null;
  }

  readonly url: string;
  readonly headers: Headers;
  aborted = false;
  readonly response: Promise<Response>;
  private answer!: (res: Response) => void;
  private refuseFetch!: (error: Error) => void;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly enc = new TextEncoder();

  constructor(url: string, init: RequestInit | undefined) {
    this.url = url;
    this.headers = new Headers(init?.headers);
    this.response = new Promise<Response>((resolve, reject) => {
      this.answer = resolve;
      this.refuseFetch = reject;
    });
    init?.signal?.addEventListener("abort", () => {
      this.aborted = true;
      const error = new DOMException("The operation was aborted.", "AbortError");
      this.refuseFetch(error);
      try {
        this.controller?.error(error);
      } catch {
        /* already closed */
      }
    });
    FakeEventStream.all.push(this);
  }

  /** Answer 200 with a body that stays open until {@link end}. */
  open(): void {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.answer(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
  }

  /** Answer with a refusal, e.g. the pairing gate's 403. */
  refuse(status: number, body = "device not paired"): void {
    this.answer(new Response(body, { status }));
  }

  /** Reject the fetch as a transport failure. */
  drop(): void {
    this.refuseFetch(new TypeError("Failed to fetch"));
  }

  /** Write raw bytes into the open body (one chunk). */
  write(text: string): void {
    this.controller?.enqueue(this.enc.encode(text));
  }

  /** One `poke` frame. */
  poke(data: string): void {
    this.write(`event: poke\ndata: ${data}\n\n`);
  }

  /** The bridge ends the stream. */
  end(): void {
    this.controller?.close();
  }
}

/**
 * Route `/api/events` to {@link FakeEventStream} and turn the feed on. Returns the undo, which puts
 * the previous fetch back and the feed's support back to the test default (off).
 */
export function installFakeEventStream(): () => void {
  const previous = globalThis.fetch;
  FakeEventStream.all = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/api/events")) return previous(input, init);
    return new FakeEventStream(url, init).response;
  };
  // SAFETY: `typeof fetch` adds only Bun's static `preconnect` to the call signature `fake` has; the
  // client under test calls it, never `preconnect`.
  globalThis.fetch = fake as typeof fetch;
  __setLiveFeedSupported(true);
  return () => {
    globalThis.fetch = previous;
    __setLiveFeedSupported(null);
    FakeEventStream.all = [];
  };
}

/** Let the client's promise chain (fetch → read → parse) run to rest. Works under fake timers. */
export async function flushStream(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
