import { expect, test } from "@playwright/test";

import { rawJson, seedState, signIn, watchBrowserErrors } from "./helpers.mjs";

test("Android NFC intake requires and durably associates one private duck photo", async ({ browser }) => {
  const seeded = await seedState("round-one");
  const admin = seeded.accounts.find((account) => account.isSystemAdmin);
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  const errors = watchBrowserErrors(page);
  await page.addInitScript(() => {
    globalThis.__photoIntake = { cameraCalls: [], stopped: 0, writes: [], reader: null, photoUploads: 0 };
    globalThis.NDEFReader = class NDEFReader extends EventTarget {
      constructor() {
        super();
        globalThis.__photoIntake.reader = this;
      }
      async scan() {}
      async write(message) { globalThis.__photoIntake.writes.push(message); }
    };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(...args) {
      const value = originalGetContext.apply(this, args);
      if (value) value.drawImage = () => {};
      return value;
    };
    const stream = new MediaStream();
    stream.getTracks = () => [{ stop: () => { globalThis.__photoIntake.stopped += 1; } }];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (constraints) => {
          globalThis.__photoIntake.cameraCalls.push(constraints);
          return stream;
        },
      },
    });
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/photo")
        && globalThis.__photoIntake.photoUploads++ === 0) {
        return Promise.resolve(Response.json(
          { error: "Simulated private photo storage failure." },
          { status: 503 },
        ));
      }
      return nativeFetch(input, init);
    };
  });

  await signIn(page, admin.email, "/staff/inventory-intake");
  await page.locator("[data-start-intake-nfc]").click();
  await page.waitForFunction(() => globalThis.__photoIntake.reader !== null);
  await page.evaluate(() => {
    const reading = new Event("reading");
    Object.defineProperties(reading, {
      serialNumber: { value: "blank-sticker-1" },
      message: { value: { records: [] } },
    });
    globalThis.__photoIntake.reader.dispatchEvent(reading);
  });

  const photo = page.locator("[data-intake-photo]");
  await expect(photo).toBeVisible();
  await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
  await expect(page.locator("[data-intake-photo-prompt]")).toHaveText(/Photograph Duck #\d+/);
  await expect(page.locator("[data-session-count]")).toHaveText("0");
  await expect(page.locator("[data-end-intake-nfc]")).toBeEnabled();
  const prompt = await page.locator("[data-intake-photo-prompt]").textContent();
  const visibleNumber = Number(prompt.match(/#(\d+)/)[1]);

  await page.locator("[data-capture-intake-photo]").click();
  await expect(page.locator("[data-intake-photo-message]")).toContainText("not stored yet");
  await expect(page.locator("[data-session-count]")).toHaveText("0");
  await expect(page.locator("[data-retry-intake-photo]")).toBeVisible();
  await page.locator("[data-retry-intake-photo]").click();

  await expect(photo).toBeHidden();
  await expect(page.locator("[data-session-count]")).toHaveText("1");
  await expect(page.locator("[data-intake-state]")).toHaveText("Ready");
  await page.waitForFunction(() => globalThis.__photoIntake.cameraCalls.length === 1);
  expect(await page.evaluate(() => globalThis.__photoIntake.cameraCalls[0])).toEqual({
    audio: false,
    video: { facingMode: { ideal: "environment" } },
  });

  const stored = await page.evaluate(async (number) => {
    const response = await fetch("/api/v1/staff/inventory/ducks");
    const body = await response.json();
    return body.ducks.find((duck) => duck.visibleNumber === number);
  }, visibleNumber);
  expect(stored.photo).toEqual({
    status: "STORED",
    url: `/api/v1/staff/inventory/ducks/${stored.id}/photo`,
  });
  await page.getByRole("button", { name: new RegExp(`^Duck #${visibleNumber} ·`) }).click();
  await expect(page.locator("[data-inventory-photo-image]")).toBeVisible();
  await expect(page.locator("[data-inventory-photo-status]")).toContainText("stored privately");

  const anonymous = await rawJson(`/api/v1/staff/inventory/ducks/${stored.id}/photo`, { origin: null });
  expect(anonymous.status).toBe(401);
  expect(JSON.stringify(anonymous.body)).not.toContain("duck-photos/");

  await expect(page.locator("[data-end-intake-nfc]")).toBeEnabled();
  await page.locator("[data-end-intake-nfc]").click();
  await page.waitForFunction(() => globalThis.__photoIntake.stopped === 1);
  expect(errors).toEqual([]);
  await context.close();
});

test("camera denial and an ended station keep the required photo recoverable", async ({ browser }) => {
  const seeded = await seedState("round-one");
  const admin = seeded.accounts.find((account) => account.isSystemAdmin);
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  const errors = watchBrowserErrors(page);
  await page.addInitScript(() => {
    globalThis.__photoRecovery = { cameraCalls: 0, reader: null, stopped: 0 };
    globalThis.NDEFReader = class NDEFReader extends EventTarget {
      constructor() {
        super();
        globalThis.__photoRecovery.reader = this;
      }
      async scan() {}
      async write() {}
    };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(...args) {
      const value = originalGetContext.apply(this, args);
      if (value) value.drawImage = () => {};
      return value;
    };
    const stream = new MediaStream();
    stream.getTracks = () => [{ stop: () => { globalThis.__photoRecovery.stopped += 1; } }];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          globalThis.__photoRecovery.cameraCalls += 1;
          if (globalThis.__photoRecovery.cameraCalls === 1) {
            throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
          }
          return stream;
        },
      },
    });
  });

  await signIn(page, admin.email, "/staff/inventory-intake");
  await page.locator("[data-start-intake-nfc]").click();
  await page.waitForFunction(() => globalThis.__photoRecovery.reader !== null);
  await page.evaluate(() => {
    const reading = new Event("reading");
    Object.defineProperties(reading, {
      serialNumber: { value: "blank-sticker-camera-denied" },
      message: { value: { records: [] } },
    });
    globalThis.__photoRecovery.reader.dispatchEvent(reading);
  });

  await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
  await expect(page.locator("[data-intake-photo-message]")).toContainText(
    "Enable camera access for this site in Chrome settings",
  );
  await expect(page.locator("[data-retry-intake-camera]")).toBeVisible();
  await expect(page.locator("[data-session-count]")).toHaveText("0");

  await page.locator("[data-end-intake-nfc]").click();
  await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
  await expect(page.locator("[data-intake-message]")).toContainText("required photo is incomplete");
  await expect(page.locator("[data-start-intake-nfc]")).toBeDisabled();

  await page.locator("[data-retry-intake-camera]").click();
  await expect(page.locator("[data-capture-intake-photo]")).toBeEnabled();
  await page.locator("[data-capture-intake-photo]").click();
  await expect(page.locator("[data-intake-photo]")).toBeHidden();
  await expect(page.locator("[data-session-count]")).toHaveText("1");
  await expect(page.locator("[data-start-intake-nfc]")).toBeEnabled();
  expect(await page.evaluate(() => globalThis.__photoRecovery.cameraCalls)).toBe(2);
  await page.waitForFunction(() => globalThis.__photoRecovery.stopped === 1);
  expect(errors).toEqual([]);
  await context.close();
});
