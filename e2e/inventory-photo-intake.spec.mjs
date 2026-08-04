import { expect, test } from "@playwright/test";

import { accountWith, baseUrl, rawJson, seedState, signIn, watchBrowserErrors } from "./helpers.mjs";

test("Android NFC intake requires two correctly associated photos while reusing one camera stream", async ({ page }) => {
  const seeded = await seedState("registration", { participants: 1, heatSize: 3 });
  const duckManager = accountWith(seeded.accounts, "DUCK_MANAGER");
  const browserErrors = watchBrowserErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    });
    class TestNdefReader {
      listeners = new Map();
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
      async scan() { globalThis.__quickducksNdef = this; }
      async write(message) { globalThis.__quickducksNdefWrites.push(message); }
      emit(serialNumber) {
        this.listeners.get("reading")?.({ serialNumber, message: { records: [] } });
      }
    }
    globalThis.__quickducksNdefWrites = [];
    globalThis.__quickducksCameraAcquisitions = 0;
    globalThis.__quickducksCameraStops = 0;
    globalThis.NDEFReader = TestNdefReader;
    const listeners = new Map();
    const track = {
      readyState: "live",
      addEventListener(name, listener) { listeners.set(name, listener); },
      stop() {
        if (this.readyState === "ended") return;
        this.readyState = "ended";
        globalThis.__quickducksCameraStops += 1;
      },
    };
    const stream = new MediaStream();
    stream.getTracks = () => [track];
    stream.getVideoTracks = () => [track];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia(constraints) {
          globalThis.__quickducksCameraAcquisitions += 1;
          globalThis.__quickducksCameraConstraints = constraints;
          return stream;
        },
      },
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 600 });
    HTMLVideoElement.prototype.play = async () => {};
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      globalThis.__quickducksJpegQuality = quality;
      callback(new Blob([Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])], { type }));
    };
  });

  await signIn(page, duckManager.email, "/staff/inventory");
  await page.getByRole("button", { name: "Start NFC provisioning" }).click();
  await expect(page.locator("[data-intake-state]")).toHaveText("Ready");

  let releaseFirstUpload;
  let delayFirstUpload = true;
  await page.route(/\/api\/v1\/staff\/inventory\/ducks\/[^/]+\/photo$/, async (route) => {
    if (delayFirstUpload) {
      delayFirstUpload = false;
      await new Promise((resolve) => { releaseFirstUpload = resolve; });
    }
    await route.continue();
  });

  const processDuck = async (serialNumber, delayUpload = false) => {
    await page.evaluate((serial) => globalThis.__quickducksNdef.emit(serial), serialNumber);
    await expect(page.locator("[data-intake-photo]")).toBeVisible();
    await expect(page.locator("[data-intake-photo-prompt]")).toContainText(/Photograph Duck #\d+ now/);
    await page.getByRole("button", { name: "Capture and save photo" }).click();
    if (delayUpload) {
      await expect(page.locator("[data-intake-state]")).toHaveText("Saving photo");
      await expect(page.locator("[data-intake-message]")).toContainText("Keep this duck here");
      await expect(page.getByRole("button", { name: "End NFC provisioning" })).toBeDisabled();
      releaseFirstUpload();
    }
    await expect(page.locator("[data-intake-photo]")).toBeHidden();
    await expect(page.locator("[data-intake-state]")).toHaveText("Ready", { timeout: 15_000 });
  };

  await processDuck("photo-duck-one", true);
  await processDuck("photo-duck-two");
  expect(await page.evaluate(() => globalThis.__quickducksCameraConstraints)).toEqual({
    audio: false,
    video: { facingMode: { exact: "environment" } },
  });
  expect(await page.evaluate(() => globalThis.__quickducksCameraAcquisitions)).toBe(1);
  expect(await page.evaluate(() => globalThis.__quickducksJpegQuality)).toBe(0.82);
  expect(await page.evaluate(() => globalThis.__quickducksCameraStops)).toBe(0);

  const photographed = await page.evaluate(async () => {
    const response = await fetch("/api/v1/staff/inventory/ducks");
    const body = await response.json();
    return body.ducks.filter((duck) => duck.photo?.state === "READY")
      .map((duck) => ({ id: duck.id, viewPath: duck.photo.viewPath }));
  });
  expect(photographed).toHaveLength(2);
  expect(new Set(photographed.map(({ id }) => id)).size).toBe(2);
  for (const photo of photographed) {
    const result = await page.evaluate(async (viewPath) => {
      const response = await fetch(viewPath);
      return { status: response.status, type: response.headers.get("content-type"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
    }, photo.viewPath);
    expect(result.status).toBe(200);
    expect(result.type).toBe("image/jpeg");
    expect(result.bytes).toEqual([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  }
  const anonymous = await rawJson(photographed[0].viewPath, { origin: baseUrl });
  expect(anonymous.status).toBe(401);

  await page.getByRole("button", { name: "End NFC provisioning" }).click();
  await expect(page.locator("[data-intake-state]")).toHaveText("Ended");
  expect(await page.evaluate(() => globalThis.__quickducksCameraStops)).toBe(1);
  expect(browserErrors).toEqual([]);
});

test("camera denial keeps the persisted duck photo visibly recoverable", async ({ page }) => {
  const seeded = await seedState("registration", { participants: 1, heatSize: 3 });
  const duckManager = accountWith(seeded.accounts, "DUCK_MANAGER");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    });
    class TestNdefReader {
      listeners = new Map();
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      removeEventListener() {}
      async scan() { globalThis.__quickducksNdef = this; }
      async write() {}
      emit() { this.listeners.get("reading")?.({ serialNumber: "denied-photo", message: { records: [] } }); }
    }
    globalThis.NDEFReader = TestNdefReader;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { async getUserMedia() { throw new DOMException("denied", "NotAllowedError"); } },
    });
  });
  await signIn(page, duckManager.email, "/staff/inventory");
  await page.getByRole("button", { name: "Start NFC provisioning" }).click();
  await page.evaluate(() => globalThis.__quickducksNdef.emit());
  await expect(page.locator("[data-intake-photo]")).toBeVisible();
  await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
  await expect(page.locator("[data-intake-message]")).toContainText("Enable camera permission for this site in Chrome settings");
  await expect(page.getByRole("button", { name: "Retry required photo" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "End NFC provisioning" })).toBeDisabled();
  const pending = await page.evaluate(async () => {
    const response = await fetch("/api/v1/staff/inventory/ducks");
    return (await response.json()).ducks.filter((duck) => duck.photo?.state === "PENDING");
  });
  expect(pending).toHaveLength(1);

  await page.reload();
  await expect(page.locator("[data-intake-photo]")).toBeVisible();
  await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
  await expect(page.getByRole("button", { name: "Start NFC provisioning" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry required photo" })).toBeEnabled();
  const afterRecovery = await page.evaluate(async () => {
    const response = await fetch("/api/v1/staff/inventory/ducks");
    return (await response.json()).ducks.filter((duck) => duck.photo?.state === "PENDING").length;
  });
  expect(afterRecovery).toBe(1);
});
