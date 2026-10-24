import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDrop, fileProblem, fileSizeText } from "./FileDrop";

afterEach(cleanup);

const file = (name: string, type: string, size = 1000) => {
  const made = new File(["x"], name, { type });
  Object.defineProperty(made, "size", { value: size });
  return made;
};

const IMAGES = [".jpg", ".jpeg", ".png", ".webp", "image/jpeg", "image/png", "image/webp"];

describe("fileProblem", () => {
  it("takes a file by its extension or its media type", () => {
    expect(fileProblem(file("photo.JPG", ""), IMAGES)).toBeNull();
    expect(fileProblem(file("photo", "image/png"), IMAGES)).toBeNull();
    expect(fileProblem(file("models.csv", "text/csv"), [".csv"])).toBeNull();
    expect(fileProblem(file("any.bin", "image/heic"), ["image/*"])).toBeNull();
  });

  it("refuses another kind and a file over the limit", () => {
    expect(fileProblem(file("price.xlsx", "application/vnd.ms-excel"), [".csv"])).toBe("type");
    expect(fileProblem(file("photo.svg", "image/svg+xml"), IMAGES)).toBe("type");
    expect(
      fileProblem(file("big.png", "image/png", 11 * 1024 * 1024), IMAGES, 10 * 1024 * 1024),
    ).toBe("size");
    expect(fileProblem(file("any.txt", "text/plain"), [])).toBeNull();
  });

  it("says the size in kilobytes or megabytes", () => {
    expect(fileSizeText(640 * 1024)).toBe("640\u00a0КБ");
    expect(fileSizeText(1.25 * 1024 * 1024)).toBe("1,3\u00a0МБ");
  });
});

describe("FileDrop", () => {
  const drop = (target: HTMLElement, files: File[]) =>
    fireEvent.drop(target, { dataTransfer: { files } });

  it("has no browser «Choose File»: the input is hidden, «Выбрать файл» opens it", () => {
    render(<FileDrop title="Перетащите файл" accept={IMAGES} onFile={() => undefined} />);
    const input = screen.getByTestId("file-drop-input") as HTMLInputElement;
    expect(input.className).toContain("ac-visually-hidden");
    expect(input.getAttribute("aria-hidden")).toBe("true");
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файл" }));
    expect(click).toHaveBeenCalled();
    expect(screen.getByText("Файл не выбран")).toBeTruthy();
  });

  it("takes a dropped file and shows the drop target while a file is over it", () => {
    const onFile = vi.fn();
    render(<FileDrop title="Перетащите файл" accept={IMAGES} onFile={onFile} />);
    const zone = screen.getByRole("region");
    fireEvent.dragOver(zone);
    expect(zone.classList.contains("ac-file-drop--over")).toBe(true);
    const photo = file("photo.png", "image/png");
    drop(zone, [photo]);
    expect(zone.classList.contains("ac-file-drop--over")).toBe(false);
    expect(onFile).toHaveBeenCalledWith(photo);
  });

  it("refuses a file of another kind with its reason, and does not hand it over", () => {
    const onFile = vi.fn();
    const onReject = vi.fn();
    render(<FileDrop title="Файл CSV" accept={[".csv"]} onFile={onFile} onReject={onReject} />);
    const xlsx = file("models.xlsx", "application/vnd.openxmlformats");
    drop(screen.getByRole("region"), [xlsx]);
    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith("type", xlsx);
    expect(screen.getByRole("alert").textContent).toContain("не подходит");
  });

  it("refuses a file over the size limit", () => {
    const onFile = vi.fn();
    render(<FileDrop title="Фото" accept={IMAGES} maxBytes={1024} onFile={onFile} />);
    const input = screen.getByTestId("file-drop-input");
    fireEvent.change(input, { target: { files: [file("photo.png", "image/png", 4096)] } });
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("слишком большой");
  });

  it("shows the chosen file by its name and size, and the action next to the button", () => {
    render(
      <FileDrop
        title="Фото"
        accept={IMAGES}
        file={file("brake-pads.png", "image/png", 2048)}
        onFile={() => undefined}
        action={<button type="button">Загрузить</button>}
      />,
    );
    expect(screen.getByText("brake-pads.png")).toBeTruthy();
    expect(document.querySelector(".ac-file-drop__size")?.textContent).toBe("2\u00a0КБ");
    expect(screen.getByRole("button", { name: "Загрузить" })).toBeTruthy();
  });

  it("ignores a drop while disabled or while a file goes up", () => {
    const onFile = vi.fn();
    const { rerender } = render(<FileDrop title="Фото" accept={IMAGES} onFile={onFile} disabled />);
    drop(screen.getByRole("region"), [file("a.png", "image/png")]);
    rerender(<FileDrop title="Фото" accept={IMAGES} onFile={onFile} progress="Загружаем…" />);
    drop(screen.getByRole("region"), [file("a.png", "image/png")]);
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Выбрать файл" })).toBeNull();
  });
});
