import { expect, test } from "@playwright/test";

import { baseUrl, bootstrap, seedState, signIn, watchBrowserErrors } from "./helpers.mjs";

const installIntakeHardware = async (page, initiallyAllowed = true) => {
  await page.addInitScript(({ allowed }) => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    });
    globalThis.__allowIntakeCamera = allowed;
    class FakeTrack {
      constructor() { this.listeners = new Map(); this.stopped = false; }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      removeEventListener(name, listener) {
        if (this.listeners.get(name) === listener) this.listeners.delete(name);
      }
      stop() { this.stopped = true; }
      end() { this.listeners.get("ended")?.(); }
    }
    class FakeNdefReader {
      constructor() {
        this.listeners = new Map();
        this.writes = [];
        globalThis.__intakeNdef = this;
      }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      removeEventListener(name, listener) {
        if (this.listeners.get(name) === listener) this.listeners.delete(name);
      }
      async scan({ signal }) { this.signal = signal; }
      async write(message) { this.writes.push(message); }
      emit(serialNumber) {
        this.listeners.get("reading")?.({ serialNumber, message: { records: [] } });
      }
    }
    globalThis.NDEFReader = FakeNdefReader;
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() { return this.__fakeSrcObject ?? null; },
      set(value) { this.__fakeSrcObject = value; },
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
      configurable: true,
      get: () => 1600,
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      configurable: true,
      get: () => 1200,
    });
    HTMLMediaElement.prototype.play = async () => {};
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }));
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      globalThis.__lastCameraConstraints = constraints;
      if (!globalThis.__allowIntakeCamera) throw new DOMException("Camera denied", "NotAllowedError");
      const track = new FakeTrack();
      globalThis.__intakePhotoTrack = track;
      return { getTracks: () => [track] };
    };
  }, { allowed: initiallyAllowed });
};

const createDraft = async (client, name) => (await client.post("/api/v1/staff/events", {
  commandId: crypto.randomUUID(),
  name,
  eventDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  roundOneHeatCapacity: 3,
}, { label: `create ${name}` })).body.event;

test.describe("Android NFC intake photo", () => {
  test.beforeEach(async () => {
    await seedState("empty");
  });

  test("does not complete or admit another NFC duck until the private photo upload succeeds", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const { admin, client } = await bootstrap();
    const event = await createDraft(client, "Photo Intake Race");
    await installIntakeHardware(page);
    await signIn(page, admin.email, "/staff/inventory");

    expect((await page.request.get("/staff/inventory")).headers()["permissions-policy"])
      .toBe("camera=(self), geolocation=(), microphone=(), nfc=(self)");
    await page.getByRole("button", { name: "Start NFC provisioning" }).click();
    await expect(page.locator("[data-intake-state]")).toHaveText("Ready");
    await page.evaluate(() => globalThis.__intakeNdef.emit("first-blank-sticker"));

    const photoPanel = page.locator("[data-intake-photo-panel]");
    await expect(photoPanel).toBeVisible();
    await expect(page.locator("[data-intake-state]")).toHaveText("Photo required");
    await expect(page.getByRole("button", { name: "Take photo" })).toBeEnabled();
    expect(await page.evaluate(() => globalThis.__lastCameraConstraints)).toEqual({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });

    // A second physical reading is ignored while the first duck still needs its
    // photo. The server-side interlock independently keeps the database at one.
    await page.evaluate(() => globalThis.__intakeNdef.emit("second-blank-sticker"));
    await expect(page.locator("[data-session-count]")).toHaveText("0");
    await expect.poll(async () => (await client.get("/api/v1/staff/inventory/ducks")).body.ducks.length)
      .toBe(1);
    const blockedStart = await client.post("/api/v1/staff/inventory/provisioning", {
      commandId: crypto.randomUUID(), eventId: event.id,
    }, { expect: [200], label: "server blocks a second duck on the required photo" });
    expect(blockedStart.body.status).toBe("PHOTO_REQUIRED");

    await page.getByRole("button", { name: "Take photo" }).click();
    await expect(photoPanel).toBeHidden();
    await expect(page.locator("[data-session-count]")).toHaveText("1");
    await expect(page.locator("[data-intake-state]")).toHaveText("Ready", { timeout: 5_000 });
    expect(await page.evaluate(() => globalThis.__intakeNdef.writes.length)).toBe(1);
    expect(await page.evaluate(() => globalThis.__intakePhotoTrack.stopped)).toBe(true);

    const ducks = (await client.get("/api/v1/staff/inventory/ducks")).body.ducks;
    expect(ducks).toHaveLength(1);
    expect(ducks[0].photo.status).toBe("READY");
    await page.getByRole("button", { name: /^Duck #1/ }).click();
    const preview = page.locator("[data-inventory-photo] img");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute(
      "src",
      `/api/v1/staff/inventory/ducks/${ducks[0].id}/photo`,
    );
    const publicEvent = await (await page.request.get("/api/v1/events/current")).text();
    expect(publicEvent).not.toContain("photo");
    expect(publicEvent).not.toContain(ducks[0].id);
    expect(errors).toEqual([]);
  });

  test("recovers after reload, camera denial, and an ended camera track", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const { admin, client } = await bootstrap();
    const event = await createDraft(client, "Recovered Photo Race");
    const started = (await client.post("/api/v1/staff/inventory/provisioning", {
      commandId: crypto.randomUUID(), eventId: event.id,
    }, { label: "start the interrupted intake" })).body;
    const confirmed = await client.post("/api/v1/staff/inventory/provisioning/confirm", {
      commandId: crypto.randomUUID(),
      eventId: event.id,
      duckId: started.duckId,
      provisioningCommandId: started.provisioningCommandId,
      physicalWriteVerified: true,
    }, { label: "confirm before the interrupted photo" });
    expect(confirmed.body.photo.status).toBe("REQUIRED");

    await installIntakeHardware(page, false);
    await signIn(page, admin.email, "/staff/inventory");
    await expect(page.locator("[data-intake-message]")).toContainText("required duck photo is waiting");
    await page.getByRole("button", { name: "Start NFC provisioning" }).click();
    const retry = page.getByRole("button", { name: "Try camera again" });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(page.locator("[data-intake-photo-message]")).toContainText("Camera access is required");

    await page.evaluate(() => { globalThis.__allowIntakeCamera = true; });
    await retry.click();
    await expect(page.getByRole("button", { name: "Take photo" })).toBeVisible();
    await page.evaluate(() => globalThis.__intakePhotoTrack.end());
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(page.locator("[data-intake-photo-message]")).toContainText("camera stopped", { ignoreCase: true });

    await retry.click();
    const capture = page.getByRole("button", { name: "Take photo" });
    await expect(capture).toBeVisible();
    await expect(capture).toBeEnabled();
    await capture.click();
    await expect(page.locator("[data-intake-photo-panel]")).toBeHidden();
    await expect.poll(async () => {
      const ducks = (await client.get("/api/v1/staff/inventory/ducks")).body.ducks;
      return ducks.find((duck) => duck.id === started.duckId)?.photo?.status;
    }).toBe("READY");
    expect(errors).toEqual([]);
  });
});
