import type { CatalogText, CatalogTexts } from "@adclub/contracts";
import { AiBadge, Badge, Icon, TypeMark } from "@adclub/ui";

/**
 * Small parts of the «Справочник» screens (TASK-080): the order arrows of a
 * row, where a text came from (DESIGN 7.9: «ИИ» — the AI mark, «Вручную» —
 * a kind, not a state) and the Kazakh and English names under a Russian one.
 */

/**
 * «Выше» / «Ниже» of a row: two small buttons next to its name (X6 — no
 * column of their own), an icon 16 in a 32 square; a disabled one stays in
 * place so the arrows of the rows stand in one line.
 */
export function OrderArrows({
  name,
  first,
  last,
  disabled,
  onMove,
}: {
  name: string;
  first: boolean;
  last: boolean;
  disabled?: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  return (
    <span className="cat-order" role="group" aria-label={`Порядок: ${name}`}>
      <button
        type="button"
        className="cat-order__button"
        aria-label={`Выше: ${name}`}
        title="Выше"
        disabled={disabled || first}
        onClick={() => onMove(-1)}
      >
        <Icon name="arrowUp" size={16} />
      </button>
      <button
        type="button"
        className="cat-order__button"
        aria-label={`Ниже: ${name}`}
        title="Ниже"
        disabled={disabled || last}
        onClick={() => onMove(1)}
      >
        <Icon name="arrowDown" size={16} />
      </button>
    </span>
  );
}

/**
 * Where a text came from: «Исходный», «Вручную» (the automatic translation
 * never overwrites it), «ИИ» in the AI color; no text — «Нет перевода».
 */
export function OriginMark({ text, source }: { text: CatalogText | null; source?: boolean }) {
  if (source) return <TypeMark icon="language">Исходный</TypeMark>;
  if (!text) {
    return (
      <Badge tone="warning" icon="alertTriangle">
        Нет перевода
      </Badge>
    );
  }
  if (text.origin === "ai") return <AiBadge>ИИ</AiBadge>;
  if (text.origin === "manual") return <TypeMark icon="user">Вручную</TypeMark>;
  return <TypeMark icon="language">Исходный</TypeMark>;
}

/** The Kazakh and English names under a Russian one, each with where it came from. */
export function NamesLine({ texts }: { texts: CatalogTexts }) {
  const lang = (code: "kk" | "en", text: CatalogText | null) => (
    <span className="cat-names__lang" title={text?.text}>
      <span className="cat-names__code">{code}</span>
      {text ? (
        <>
          <span className="cat-names__text">{text.text}</span>
          <OriginMark text={text} />
        </>
      ) : (
        <OriginMark text={null} />
      )}
    </span>
  );
  return (
    <span className="cat-names">
      {lang("kk", texts.kk)}
      {lang("en", texts.en)}
    </span>
  );
}
