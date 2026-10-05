import { describe, expect, it } from "vitest";
import {
  callOptions,
  callUrl,
  detectWhatsapp,
  openCallOption,
  whatsappNumber,
  type CallOption,
} from "./call-options";

const ids = (options: CallOption[]) => options.map((option) => option.id);

describe("«Позвонить через…» (TASK-029.B, SCREENS M-ORD-03 block 4)", () => {
  it("calls at once when there is no WhatsApp: the phone is the only way", () => {
    const options = callOptions("+7 705 555 01 01", { whatsapp: false, business: false });
    expect(options).toEqual([{ id: "phone", app: "tel:+77055550101", web: null }]);
  });

  it("offers only the WhatsApp apps that are installed, the phone always first", () => {
    expect(ids(callOptions("+77055550101", { whatsapp: true, business: false }))).toEqual([
      "phone",
      "whatsapp",
    ]);
    expect(ids(callOptions("+77055550101", { whatsapp: false, business: true }))).toEqual([
      "phone",
      "whatsappBusiness",
    ]);
    expect(ids(callOptions("+77055550101", { whatsapp: true, business: true }))).toEqual([
      "phone",
      "whatsapp",
      "whatsappBusiness",
    ]);
  });

  it("opens the chat with the supplier's number, with the web chat behind it", () => {
    const [, whatsapp, business] = callOptions("8 (705) 555-01-01", {
      whatsapp: true,
      business: true,
    });
    expect(whatsapp).toEqual({
      id: "whatsapp",
      app: "whatsapp://send?phone=77055550101",
      web: "https://wa.me/77055550101",
    });
    expect(business).toEqual({
      id: "whatsappBusiness",
      app: "whatsapp-smb://send?phone=77055550101",
      web: "https://wa.me/77055550101",
    });
  });

  it("shows one «WhatsApp» where nothing can be known (Expo Go) — it still leads somewhere", () => {
    expect(ids(callOptions("+77055550101", "unknown"))).toEqual(["phone", "whatsapp"]);
  });

  it("has nothing to offer without a phone, and no WhatsApp for a number it cannot read", () => {
    expect(callOptions(null, { whatsapp: true, business: true })).toEqual([]);
    expect(ids(callOptions("доб. 12", { whatsapp: true, business: true }))).toEqual(["phone"]);
    expect(callUrl("—")).toBeNull();
  });

  it("writes the number the way WhatsApp takes it", () => {
    expect(whatsappNumber("+7 705 555 01 01")).toBe("77055550101");
    expect(whatsappNumber("87055550101")).toBe("77055550101");
    expect(whatsappNumber("77055550101")).toBe("77055550101");
    expect(whatsappNumber("7055550101")).toBe("77055550101");
    expect(whatsappNumber("+7 (727) 250-00-00")).toBe("77272500000");
    expect(whatsappNumber("12-34")).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });

  it("asks the system only where it can answer", async () => {
    const asked: string[] = [];
    const installed = (urls: string[]) => async (url: string) => {
      asked.push(url);
      return urls.includes(url);
    };
    expect(await detectWhatsapp("expo-go", "ios", installed(["whatsapp://"]))).toBe("unknown");
    expect(await detectWhatsapp("web", "android", installed([]))).toEqual({
      whatsapp: false,
      business: false,
    });
    expect(asked).toEqual([]);

    expect(await detectWhatsapp("own-build", "ios", installed(["whatsapp://"]))).toEqual({
      whatsapp: true,
      business: false,
    });
    expect(
      await detectWhatsapp("own-build", "ios", installed(["whatsapp://", "whatsapp-smb://"])),
    ).toEqual({ whatsapp: true, business: true });
    // Android: both apps answer one link — one row, the system chooses.
    expect(
      await detectWhatsapp(
        "own-build",
        "android",
        installed(["whatsapp://send?phone=77000000000"]),
      ),
    ).toEqual({ whatsapp: true, business: false });
    // A scheme the build did not declare throws on iOS: «not there».
    expect(
      await detectWhatsapp("own-build", "ios", async () => {
        throw new Error("not allowed to query for scheme");
      }),
    ).toEqual({ whatsapp: false, business: false });
  });

  it("falls back to the web chat when the app refuses, and never for the dialer", async () => {
    const [phone, whatsapp] = callOptions("+77055550101", "unknown");
    const opened: string[] = [];
    const onlyWeb = async (url: string) => {
      if (!url.startsWith("https://")) throw new Error("no app");
      opened.push(url);
    };
    expect(await openCallOption(whatsapp!, onlyWeb)).toBe(true);
    expect(opened).toEqual(["https://wa.me/77055550101"]);
    expect(await openCallOption(phone!, onlyWeb)).toBe(false);
  });
});
