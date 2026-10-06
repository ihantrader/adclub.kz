import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import { Button, IconButton } from "./Button";
import { Quantity } from "./controls";
import { CodeBlock } from "./data";
import { CodeCells, TextField } from "./fields";
import { CompatibilityMark, StatusBadge } from "./marks";
import { BottomTabs } from "./navigation";

afterEach(cleanup);

describe("Button", () => {
  it("ignores clicks and Enter while loading, keeping the label for the width", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Отправить заявку
      </Button>,
    );
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveProperty("disabled", false); // stays focusable
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toContain("Отправить заявку");
  });

  it("runs an async action once for a double click and shows loading until it settles", async () => {
    let finish: () => void = () => undefined;
    const onClick = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<Button onClick={onClick}>Принять</Button>);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    expect(button.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Удалить
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("gives icon-only buttons a screen reader name", () => {
    render(<IconButton icon="x" label="Закрыть" />);
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeTruthy();
  });
});

describe("fields", () => {
  it("keeps the typed value with an error and links the error text", () => {
    render(
      <TextField
        label="Телефон"
        value="+7 701"
        onChange={() => undefined}
        error="Неверный номер"
      />,
    );
    const input = screen.getByLabelText("Телефон");
    expect(input).toHaveProperty("value", "+7 701");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("Неверный номер");
  });

  it("rings a field focused from the keyboard, not one focused by a click (D-068)", () => {
    const { container } = render(<TextField label="Имя" value="" onChange={() => undefined} />);
    const control = container.querySelector(".ac-field__control") as HTMLElement;
    const input = screen.getByLabelText("Имя");
    fireEvent.focus(input);
    expect(control.classList.contains("ac-field__control--keyboard")).toBe(true);
    fireEvent.blur(input);
    expect(control.classList.contains("ac-field__control--keyboard")).toBe(false);
    fireEvent.pointerDown(input);
    fireEvent.focus(input);
    expect(control.classList.contains("ac-field__control--keyboard")).toBe(false);
  });

  it("marks AI data with text, not only color", () => {
    render(<TextField label="VIN" value="XWB" onChange={() => undefined} aiLabel="распознано" />);
    expect(screen.getByText("распознано")).toBeTruthy();
  });

  it("code cells accept digits only and show them in groups of three", () => {
    const onChange = vi.fn();
    const { container } = render(<CodeCells label="Код заявки" value="4829" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Код заявки/), { target: { value: "48-29 15x7" } });
    expect(onChange).toHaveBeenCalledWith("482915");
    const groups = container.querySelectorAll(".ac-code__group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toBe("482");
    expect(groups[1]?.textContent).toBe("9");
  });

  it("with the page's own keypad keeps the phone keyboard away, takes a grouped paste whole and finds on Enter (S-SCAN-02)", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <CodeCells
        label="Код клиента"
        value=""
        onChange={onChange}
        systemKeyboard={false}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByLabelText(/Код клиента/);
    expect(input.getAttribute("inputmode")).toBe("none");
    expect(input.getAttribute("autocomplete")).toBe("off");
    // No native limit cuts «482 915» before its separator is dropped.
    expect(input.hasAttribute("maxlength")).toBe(false);
    fireEvent.change(input, { target: { value: "482 915" } });
    expect(onChange).toHaveBeenLastCalledWith("482915");
    fireEvent.change(input, { target: { value: "482-915" } });
    expect(onChange).toHaveBeenLastCalledWith("482915");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("controls and marks", () => {
  it("disables minus at 1", () => {
    render(
      <Quantity
        value={1}
        onChange={() => undefined}
        label="Количество"
        decreaseLabel="Меньше"
        increaseLabel="Больше"
      />,
    );
    expect(screen.getByRole("button", { name: "Меньше" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Больше" })).toHaveProperty("disabled", false);
  });

  it("status and compatibility carry an icon and text", () => {
    const { container } = render(
      <>
        <StatusBadge group="finished">Отменена</StatusBadge>
        <CompatibilityMark value="doesNotFit">Не подходит</CompatibilityMark>
      </>,
    );
    expect(container.querySelector(".ac-badge--neutral svg")).toBeTruthy();
    expect(container.querySelector(".ac-compat--doesNotFit svg")).toBeTruthy();
    expect(screen.getByText("Отменена")).toBeTruthy();
  });
});

describe("navigation and code", () => {
  it("puts the raised center button in the middle of the tab bar", () => {
    render(
      <BottomTabs
        label="Разделы"
        active="orders"
        onSelect={() => undefined}
        items={[
          { key: "orders", label: "Заявки", icon: "receipt" },
          { key: "offers", label: "Предложения", icon: "tags" },
          { key: "price", label: "Прайс", icon: "fileSpreadsheet" },
          { key: "more", label: "Ещё", icon: "dots" },
        ]}
        center={{ key: "scan", label: "Сканер", icon: "scan" }}
      />,
    );
    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["Заявки", "Предложения", "Сканер", "Прайс", "Ещё"]);
    expect(screen.getByRole("button", { name: "Заявки" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("makes items with an address real links that the app routes on a plain click", () => {
    const selected: string[] = [];
    render(
      <BottomTabs
        label="Разделы"
        active="more"
        onSelect={(key) => selected.push(key)}
        items={[
          { key: "orders", label: "Заявки", icon: "receipt", href: "/orders" },
          { key: "more", label: "Ещё", icon: "dots", href: "/more" },
        ]}
        center={{ key: "scan", label: "Сканер", icon: "scan", href: "/scan" }}
      />,
    );
    const orders = screen.getByRole("link", { name: "Заявки" });
    expect(orders.getAttribute("href")).toBe("/orders");
    expect(screen.getByRole("link", { name: "Ещё" }).getAttribute("aria-current")).toBe("page");
    // A plain click is the app's; a click with a modifier is left to the browser.
    // (Seen after React's handler, then stopped: jsdom can't open another document.)
    const leftToBrowser: boolean[] = [];
    const record = (event: Event) => {
      leftToBrowser.push(!event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener("click", record);
    fireEvent.click(orders);
    fireEvent.click(screen.getByRole("link", { name: "Сканер" }), { ctrlKey: true });
    document.removeEventListener("click", record);
    expect(leftToBrowser).toEqual([false, true]);
    expect(selected).toEqual(["orders"]);
  });

  it("renders the code in groups and the QR black on white; hides the code before acceptance", () => {
    const { container, rerender } = render(
      <ThemeProvider storageKey="test" defaultMode="dark">
        <CodeBlock code="482915" qrValue="order-1" codeLabel="Код" qrLabel="QR" />
      </ThemeProvider>,
    );
    expect(screen.getByText("482 915")).toBeTruthy();
    const qr = screen.getByRole("img", { name: "QR" });
    expect(qr.querySelector("rect")?.getAttribute("fill")).toBe("#FFFFFF");
    expect(qr.querySelector("path")?.getAttribute("fill")).toBe("#000000");
    rerender(
      <ThemeProvider storageKey="test" defaultMode="dark">
        <CodeBlock
          code="482915"
          qrValue="order-1"
          codeLabel="Код"
          qrLabel="QR"
          pending={{ text: "Ждём" }}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText("482 915")).toBeNull();
    expect(screen.getByText("••• •••")).toBeTruthy();
    expect(container.querySelector(".ac-code-block--pending")).toBeTruthy();
  });
});
