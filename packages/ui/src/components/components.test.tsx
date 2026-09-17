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
