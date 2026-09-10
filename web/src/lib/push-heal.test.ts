import { describe, expect, test } from "vitest";

import { XHR_HEADER, XHR_HEADER_VALUE as API_XHR_VALUE } from "./api";
import {
  XHR_HEADER_NAME,
  XHR_HEADER_VALUE,
  resubscribeBody,
  serverKeyFor,
  shouldMintFresh,
  urlB64ToUint8Array,
} from "./push-heal";

describe("push-heal", () => {
  test("the SW's copy of the XHR header is the API client's, byte for byte", () => {
    expect(XHR_HEADER_NAME).toBe(XHR_HEADER);
    expect(XHR_HEADER_VALUE).toBe(API_XHR_VALUE);
  });

  test("resubscribeBody names the superseded endpoint only when it differs", () => {
    const json = { endpoint: "https://push.example.test/new", keys: { p256dh: "k", auth: "a" } };
    expect(resubscribeBody(json, "https://push.example.test/old")).toEqual({
      endpoint: "https://push.example.test/new",
      keys: { p256dh: "k", auth: "a" },
      replaces: "https://push.example.test/old",
    });
    expect(resubscribeBody(json, "https://push.example.test/new")).toEqual({
      endpoint: "https://push.example.test/new",
      keys: { p256dh: "k", auth: "a" },
    });
    expect(resubscribeBody(json, null)).not.toHaveProperty("replaces");
    expect(resubscribeBody({}, undefined)).toEqual({ endpoint: "", keys: { p256dh: "", auth: "" } });
  });

  test("serverKeyFor prefers the old subscription's key, falls back to the stored one, else refuses", () => {
    const old = Uint8Array.from([4, 1, 2]).buffer;
    expect(serverKeyFor(old, "BAEC")).toBe(old);
    expect(serverKeyFor(null, "BAEC")).toEqual(Uint8Array.from([4, 1, 2]));
    expect(serverKeyFor(new ArrayBuffer(0), null)).toBeNull();
    expect(serverKeyFor(undefined, "")).toBeNull();
  });

  test("shouldMintFresh fires only on the prune signature", () => {
    // Believed registered, not just subscribed, bridge says unknown → pruned → mint.
    expect(shouldMintFresh({ known: false }, true, false)).toBe(true);
    // A first-time registration is unknown by definition.
    expect(shouldMintFresh({ known: false }, false, false)).toBe(false);
    // A subscription minted in this very attempt is unknown by definition too.
    expect(shouldMintFresh({ known: false }, true, true)).toBe(false);
    // The bridge knows it: nothing to heal.
    expect(shouldMintFresh({ known: true }, true, false)).toBe(false);
    // An older bridge answers 204 (no ack at all): the old behaviour, untouched.
    expect(shouldMintFresh(undefined, true, false)).toBe(false);
  });

  test("urlB64ToUint8Array decodes base64url without padding", () => {
    expect(Array.from(urlB64ToUint8Array("BAEC"))).toEqual([4, 1, 2]);
    expect(Array.from(urlB64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});
