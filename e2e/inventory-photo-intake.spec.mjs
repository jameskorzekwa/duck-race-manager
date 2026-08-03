import { expect, test } from "@playwright/test";

import { seedState, signIn, watchBrowserErrors } from "./helpers.mjs";

const androidUserAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const installIntakeHardware = async (page, { denyFirstCamera = false } = {}) => {
  await page.addInitScript(({ denyFirstCamera }) => {
    const state = globalThis.__intakePhotoTest = {
      captures: 0,
      getUserMediaCalls: [],
      scans: 0,
      stops: Number(sessionStorage.getItem("quickducks-test-camera-stops") ?? 0),
      writes: 0,
      denyCamera: denyFirstCamera,
      reader: null,
      track: null,
    };
    class FakeTrack extends EventTarget {
      readyState = "live";
      stop() {
        if (this.readyState === "ended") return;
        this.readyState = "ended";
        state.stops += 1;
        sessionStorage.setItem("quickducks-test-camera-stops", String(state.stops));
      }
      fail() {
        this.readyState = "ended";
        this.dispatchEvent(new Event("ended"));
      }
    }
    class FakeNdefReader extends EventTarget {
      constructor() {
        super();
        state.reader = this;
      }
      async scan() { state.scans += 1; }
      async write() { state.writes += 1; }
    }
    globalThis.NDEFReader = FakeNdefReader;
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() { return this.__fakeSrcObject ?? null; },
      set(value) { this.__fakeSrcObject = value; },
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 960 });
    HTMLMediaElement.prototype.play = async () => {};
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
      state.captures += 1;
      callback(new Blob([new Uint8Array([0xff, 0xd8, state.captures, 0x22, 0xff, 0xd9])], { type }));
    };
    const mediaDevices = navigator.mediaDevices ?? {};
    mediaDevices.getUserMedia = async (constraints) => {
      state.getUserMediaCalls.push(constraints);
      if (state.denyCamera) {
        state.denyCamera = false;
        throw new DOMException("Camera permission denied", "NotAllowedError");
      }
      const track = new FakeTrack();
      state.track = track;
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    state.emitBlank = (serialNumber) => {
      const event = new Event("reading");
      Object.defineProperties(event, {
        serialNumber: { value: serialNumber },
        message: { value: { records: [] } },
      });
      state.reader.dispatchEvent(event);
    };
  }, { denyFirstCamera });
};

const newAndroidPage = async (browser, options) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 900 },
    userAgent: androidUserAgent,
  });
  const page = await context.newPage();
  await installIntakeHardware(page, options);
  return { context, page };
};

const presentBlankSticker = async (page, serial) => {
  await page.evaluate((value) => globalThis.__intakePhotoTest.emitBlank(value), serial);
};

test("Android NFC intake saves two correctly associated photos with one retained camera stream", async ({ browser }) => {
  const seeded = await seedState("draft");
  const admin = seeded.accounts.find((account) => account.isSystemAdmin);
  const { context, page } = await newAndroidPage(browser);
  const errors = watchBrowserErrors(page);

  await signIn(page, admin.email, "/staff/inventory-intake");
  await page.locator("[data-start-intake-nfc]").click();
  await expect(page.locator("[data-intake-state]")).toHaveText("Ready");

  for (const [index, serial] of ["first-blank", "second-blank"].entries()) {
    await presentBlankSticker(page, serial);
    await expect(page.locator("[data-intake-camera]")).toBeVisible();
    await expect(page.locator("[data-intake-camera-title]")).toContainText(`Duck #${index + 1}`);
    await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
    await expect(page.locator("[data-end-intake-nfc]")).toBeDisabled();
    const capture = page.locator("[data-capture-intake-photo]");
    await expect(capture).toBeEnabled();
    await capture.click();
    await expect(page.locator("[data-session-count]")).toHaveText(String(index + 1));
    await expect(page.locator("[data-intake-camera]")).toBeHidden();
    await expect(page.locator("[data-intake-state]")).toHaveText("Ready", { timeout: 5_000 });
  }

  const hardware = await page.evaluate(() => ({
    calls: globalThis.__intakePhotoTest.getUserMediaCalls,
    captures: globalThis.__intakePhotoTest.captures,
    stops: globalThis.__intakePhotoTest.stops,
  }));
  expect(hardware.calls).toEqual([{ audio: false, video: { facingMode: { ideal: "environment" } } }]);
  expect(hardware.captures).toBe(2);
  expect(hardware.stops).toBe(0);

  const ducks = await page.evaluate(async () => (await fetch("/api/v1/staff/inventory/ducks")).json());
  expect(ducks.ducks).toHaveLength(2);
  expect(ducks.ducks.map((duck) => duck.photo.status)).toEqual(["READY", "READY"]);
  expect(new Set(ducks.ducks.map((duck) => duck.id)).size).toBe(2);

  await expect(page.locator("[data-end-intake-nfc]")).toBeEnabled();
  await page.locator("[data-end-intake-nfc]").click();
  await expect.poll(() => page.evaluate(() => globalThis.__intakePhotoTest.stops)).toBe(1);
  expect(errors).toEqual([]);
  await context.close();
});

test("camera denial and an ended stream keep the required photo recoverable", async ({ browser }) => {
  const seeded = await seedState("draft");
  const admin = seeded.accounts.find((account) => account.isSystemAdmin);
  const { context, page } = await newAndroidPage(browser, { denyFirstCamera: true });

  await signIn(page, admin.email, "/staff/inventory-intake");
  await page.locator("[data-start-intake-nfc]").click();
  await presentBlankSticker(page, "denied-camera-duck");
  await expect(page.locator("[data-intake-camera-message]")).toContainText("Allow camera access for this site");
  await expect(page.locator("[data-retry-intake-photo]")).toHaveText("Retry camera");
  await expect(page.locator("[data-end-intake-nfc]")).toBeDisabled();
  await page.locator("[data-retry-intake-photo]").click();
  await expect(page.locator("[data-capture-intake-photo]")).toBeEnabled();
  let failedUpload = false;
  await page.route("**/api/v1/staff/inventory/ducks/*/photo", async (route) => {
    if (!failedUpload && route.request().method() === "POST") {
      failedUpload = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Private photo storage is temporarily unavailable." }),
      });
      return;
    }
    await route.continue();
  });
  await page.locator("[data-capture-intake-photo]").click();
  await expect(page.locator("[data-retry-intake-photo]")).toHaveText("Retry save");
  await expect(page.locator("[data-session-count]")).toHaveText("0");
  await page.locator("[data-retry-intake-photo]").click();
  await expect(page.locator("[data-session-count]")).toHaveText("1");
  expect(await page.evaluate(() => globalThis.__intakePhotoTest.captures)).toBe(1);
  await page.unroute("**/api/v1/staff/inventory/ducks/*/photo");
  await expect(page.locator("[data-intake-state]")).toHaveText("Ready", { timeout: 5_000 });

  await presentBlankSticker(page, "ended-camera-duck");
  await expect(page.locator("[data-capture-intake-photo]")).toBeEnabled();
  await page.locator("[data-cancel-intake-photo]").click();
  await expect(page.locator("[data-intake-camera-message]")).toContainText("Capture canceled");
  await expect(page.locator("[data-session-count]")).toHaveText("1");
  await expect(page.locator("[data-end-intake-nfc]")).toBeDisabled();
  await page.evaluate(() => globalThis.__intakePhotoTest.track.fail());
  await expect(page.locator("[data-intake-camera-message]")).toContainText("camera stopped");
  await expect(page.locator("[data-retry-intake-photo]")).toBeEnabled();
  await expect(page.locator("[data-end-intake-nfc]")).toBeDisabled();
  await page.locator("[data-retry-intake-photo]").click();
  await expect(page.locator("[data-capture-intake-photo]")).toBeEnabled();
  await page.locator("[data-capture-intake-photo]").click();
  await expect(page.locator("[data-session-count]")).toHaveText("2");
  await expect.poll(() => page.evaluate(() => globalThis.__intakePhotoTest.getUserMediaCalls.length)).toBe(3);

  const ducks = await page.evaluate(async () => (await fetch("/api/v1/staff/inventory/ducks")).json());
  expect(ducks.ducks.map((duck) => duck.photo.status)).toEqual(["READY", "READY"]);
  await expect(page.locator("[data-intake-state]")).toHaveText("Ready", { timeout: 5_000 });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => globalThis.__intakePhotoTest.stops)).toBe(1);
  await context.close();
});
