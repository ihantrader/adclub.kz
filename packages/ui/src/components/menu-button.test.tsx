import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuButton, nextMenuIndex, type MenuAction } from "./MenuButton";

afterEach(cleanup);

function actions(onSelect = vi.fn()): MenuAction[] {
  return [
    { key: "contact", label: "Сделать контактным лицом", onSelect: () => onSelect("contact") },
    {
      key: "invite",
      label: "Приглашение повторно",
      disabled: true,
      onSelect: () => onSelect("invite"),
    },
    {
      key: "sessions",
      label: "Завершить все сессии (3)",
      destructive: true,
      onSelect: () => onSelect("sessions"),
    },
  ];
}

const button = () => screen.getByRole("button", { name: "Действия: Ерлан" });
const focused = () => document.activeElement?.textContent;

describe("nextMenuIndex", () => {
  it("goes round the ends and skips a disabled item", () => {
    const list = actions();
    expect(nextMenuIndex(list, 0, 1)).toBe(2);
    expect(nextMenuIndex(list, 2, 1)).toBe(0);
    expect(nextMenuIndex(list, 0, -1)).toBe(2);
    expect(nextMenuIndex(list, -1, 1)).toBe(0);
    expect(nextMenuIndex(list, list.length, -1)).toBe(2);
  });
});

describe("MenuButton", () => {
  it("opens with ↓ on the first item, moves with the arrows past a disabled one", () => {
    render(<MenuButton label="Действия: Ерлан" actions={actions()} />);
    fireEvent.keyDown(button(), { key: "ArrowDown" });
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(focused()).toBe("Сделать контактным лицом");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(focused()).toBe("Завершить все сессии (3)");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(focused()).toBe("Сделать контактным лицом");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(focused()).toBe("Завершить все сессии (3)");
  });

  it("Enter on an item runs it and gives the focus back to «⋯»", () => {
    const onSelect = vi.fn();
    render(<MenuButton label="Действия: Ерлан" actions={actions(onSelect)} />);
    fireEvent.click(button());
    fireEvent.click(screen.getByRole("menuitem", { name: "Завершить все сессии (3)" }));
    expect(onSelect).toHaveBeenCalledWith("sessions");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("Esc closes it without running anything, and does not reach a dialog around it", () => {
    const onSelect = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <MenuButton label="Действия: Ерлан" actions={actions(onSelect)} />
      </div>,
    );
    fireEvent.click(button());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(outer.mock.calls.some(([event]) => event.key === "Escape")).toBe(false);
    expect(document.activeElement).toBe(button());
  });

  it("a press outside closes it", () => {
    render(
      <>
        <MenuButton label="Действия: Ерлан" actions={actions()} />
        <p>Сотрудники</p>
      </>,
    );
    fireEvent.click(button());
    fireEvent.pointerDown(screen.getByText("Сотрудники"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks a destructive item and disables an unavailable one", () => {
    render(<MenuButton label="Действия: Ерлан" actions={actions()} />);
    fireEvent.click(button());
    expect(screen.getByRole("menuitem", { name: "Завершить все сессии (3)" }).className).toContain(
      "ac-menu__item--danger",
    );
    expect(
      (screen.getByRole("menuitem", { name: "Приглашение повторно" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("size s is the 36 button of a table row", () => {
    render(<MenuButton label="Действия: Ерлан" actions={actions()} size="s" />);
    expect(button().className).toContain("ac-icon-button--s");
  });
});
