import { fetchConfig, registerPushSubscription } from "@/lib/api";
import { disablePush, enablePush, getPushState, installResubscribeListener } from "./push";

vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(),
  registerPushSubscription: vi.fn(),
}));

const key = Uint8Array.from({ length: 65 }, (_, i) => i === 0 ? 4 : 1);
const vapidPublicKey = btoa(String.fromCharCode(...key)).replace(/=/g, "");
const subscription = {
  endpoint: "https://push.example.test/device",
  options: { applicationServerKey: key.buffer },
  toJSON: () => ({
    endpoint: "https://push.example.test/device",
    keys: { p256dh: "test-key", auth: "test-auth" },
  }),
  unsubscribe: vi.fn(async () => {
    current = null;
    return true;
  }),
};
let current: typeof subscription | null = null;
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async () => {
    current = subscription;
    return subscription;
  }),
};
const registration = { pushManager };
let serviceWorkerDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  current = null;
  vi.mocked(fetchConfig).mockReset().mockResolvedValue({ push: true, vapidPublicKey });
  vi.mocked(registerPushSubscription).mockReset().mockResolvedValue(undefined);
  pushManager.getSubscription.mockReset().mockImplementation(async () => current);
  pushManager.subscribe.mockReset().mockImplementation(async () => {
    current = subscription;
    return subscription;
  });
  subscription.unsubscribe.mockReset().mockImplementation(async () => {
    current = null;
    return true;
  });
  serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  vi.stubGlobal("PushManager", vi.fn());
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("isSecureContext", true);
  localStorage.setItem("collie:push-disabled", "1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (serviceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

describe("push self-healing (fork)", () => {
  const replacement = {
    ...subscription,
    endpoint: "https://push.example.test/device-2",
    toJSON: () => ({
      endpoint: "https://push.example.test/device-2",
      keys: { p256dh: "test-key-2", auth: "test-auth-2" },
    }),
    unsubscribe: vi.fn(async () => true),
  };

  it("mints a fresh subscription when the bridge no longer knows the endpoint this device holds", async () => {
    current = subscription; // the browser still hands back the old subscription
    localStorage.setItem("collie:push-endpoint", subscription.endpoint); // …which we believed registered
    // The real wire body, parsed the way the transport parses it: `registerPushSubscription` is
    // typed `void` for the upstream 204 contract, and JSON.parse's `any` feeds the mock without an
    // assertion the way a live response would.
    vi.mocked(registerPushSubscription)
      .mockResolvedValueOnce(JSON.parse('{"known":false}')) // the bridge had pruned it
      .mockResolvedValueOnce(JSON.parse('{"known":false}'));
    pushManager.subscribe.mockImplementationOnce(async () => {
      current = replacement;
      return replacement;
    });

    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(registerPushSubscription).toHaveBeenCalledTimes(2);
    // The second registration names the dead endpoint as the one it supersedes.
    expect(vi.mocked(registerPushSubscription).mock.calls[1]![0]).toEqual({
      endpoint: replacement.endpoint,
      keys: { p256dh: "test-key-2", auth: "test-auth-2" },
      replaces: subscription.endpoint,
    });
    expect(localStorage.getItem("collie:push-endpoint")).toBe(replacement.endpoint);
  });

  it("does not mint on a first-time registration, nor on one it just made, nor on an older bridge", async () => {
    // First time: nothing remembered, `known: false` is simply new.
    vi.mocked(registerPushSubscription).mockResolvedValueOnce(JSON.parse('{"known":false}'));
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    // Older bridge (204 → undefined) with a remembered endpoint: the pre-fork path, untouched.
    vi.mocked(registerPushSubscription).mockResolvedValueOnce(undefined);
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(registerPushSubscription).toHaveBeenCalledTimes(2);
  });

  it("hands the worker the VAPID key after a successful registration", async () => {
    const postMessage = vi.fn();
    Object.assign(registration, { active: { postMessage } });
    try {
      await enablePush();
      expect(postMessage).toHaveBeenCalledWith({ type: "VAPID_KEY", key: vapidPublicKey });
    } finally {
      Reflect.deleteProperty(registration, "active");
    }
  });

  it("a worker-side re-subscribe updates the endpoint this page remembers", () => {
    const listeners = new Map<string, (e: MessageEvent) => void>();
    Object.assign(navigator.serviceWorker, {
      addEventListener: (type: string, fn: (e: MessageEvent) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    localStorage.setItem("collie:push-endpoint", "https://push.example.test/old");
    const stop = installResubscribeListener();
    listeners.get("message")!(
      new MessageEvent("message", { data: { type: "PUSH_RESUBSCRIBED", endpoint: "https://push.example.test/new" } }),
    );
    expect(localStorage.getItem("collie:push-endpoint")).toBe("https://push.example.test/new");
    listeners.get("message")!(new MessageEvent("message", { data: { type: "SOMETHING_ELSE", endpoint: "x" } }));
    expect(localStorage.getItem("collie:push-endpoint")).toBe("https://push.example.test/new");
    stop();
    expect(listeners.size).toBe(0);
  });
});

describe("push subscription lifecycle", () => {
  it("can enable, disable, and enable again after both registrations succeed", async () => {
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect((await getPushState()).subscribed).toBe(true);
    await disablePush();
    expect(await getPushState()).toMatchObject({ subscribed: false, userDisabled: true });
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(await getPushState()).toMatchObject({ subscribed: true, userDisabled: false });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(registerPushSubscription).toHaveBeenCalledTimes(2);
  });

  it("keeps push off when the bridge rejects registration, and can retry the same subscription", async () => {
    vi.mocked(registerPushSubscription).mockRejectedValueOnce(new Error("sign in required"));
    await expect(enablePush()).rejects.toThrow("sign in required");
    expect(await getPushState()).toMatchObject({ subscribed: false, userDisabled: true });
    expect(localStorage.getItem("collie:push-endpoint")).toBeNull();

    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(await getPushState()).toMatchObject({ subscribed: true, userDisabled: false });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not show an unacknowledged subscription as on for a first-time user", async () => {
    localStorage.removeItem("collie:push-disabled");
    vi.mocked(registerPushSubscription).mockRejectedValueOnce(new Error("registration refused"));
    await expect(enablePush()).rejects.toThrow("registration refused");
    expect((await getPushState()).subscribed).toBe(false);
  });

  it("surfaces a browser registration failure and allows a later attempt", async () => {
    pushManager.subscribe.mockRejectedValueOnce(
      new DOMException("Registration failed - push service error", "AbortError"),
    );
    await expect(enablePush()).rejects.toThrow("push service error");
    expect(registerPushSubscription).not.toHaveBeenCalled();
    expect((await getPushState()).userDisabled).toBe(true);
    await expect(enablePush()).resolves.toEqual({ ok: true });
  });

  it("reports an unavailable config as retryable rather than claiming VAPID is disabled", async () => {
    vi.mocked(fetchConfig).mockRejectedValueOnce(new Error("offline"));
    expect(await getPushState()).toMatchObject({ availability: "unavailable", userDisabled: true });
    await expect(enablePush()).resolves.toEqual({ ok: true });
  });

  it("still distinguishes a bridge that actually has no push configuration", async () => {
    vi.mocked(fetchConfig).mockResolvedValue({ push: false, vapidPublicKey: "" });
    expect((await getPushState()).availability).toBe("server-off");
  });

  it("times out a stalled subscription without registering it after the timeout", async () => {
    vi.useFakeTimers();
    let finish: ((value: typeof subscription) => void) | undefined;
    pushManager.subscribe.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const rejected = expect(enablePush()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(registerPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem("collie:push-disabled")).toBe("1");

    current = subscription;
    finish?.(subscription);
    await vi.advanceTimersByTimeAsync(0);
    expect(registerPushSubscription).not.toHaveBeenCalled();
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(registerPushSubscription).toHaveBeenCalledTimes(1);
  });

  it("waits for an active service worker before subscribing", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator.serviceWorker, "ready", { value: new Promise(() => {}) });
    const rejected = expect(enablePush()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("remembers a successful registration for this page when storage writes are blocked", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    try {
      await expect(enablePush()).resolves.toEqual({ ok: true });
      expect((await getPushState()).subscribed).toBe(true);
    } finally {
      setItem.mockRestore();
      await disablePush();
    }
  });
});
