import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";

/** What a child page tells the top bar: its title and where «назад» leads. */
export interface ChildHeader {
  title: string;
  back: () => void;
  /** A section of «Ещё»: a child page on a phone, a page of the side menu from 1024 px. */
  deskRoot: boolean;
}

const HeaderContext = createContext<(header: ChildHeader | null) => void>(() => undefined);

export const PageHeaderProvider = HeaderContext.Provider;

export interface PageHeaderProps {
  title: string;
  /** «Назад» of a child page: the title goes to the top bar beside the arrow (C3). */
  back?: () => void;
  /** See `ChildHeader.deskRoot`. */
  deskRoot?: boolean;
  /** Beside the title of a root page («Добавить позицию» from 600 px). */
  actions?: ReactNode;
}

/**
 * The title of a page (TASK-079, C3, C20). A root page — «Заявки»,
 * «Предложения», «Прайс», «Ещё» — says it in the page, `titleL`; the top
 * bar of a phone shows the company. A child page says it in the top bar,
 * `title`, beside the one arrow «назад» — there is no second arrow in the
 * page. A section of «Ещё» is a child on a phone and a root page from
 * 1024 px, where the side menu lists it.
 */
export function PageHeader({ title, back, deskRoot = false, actions }: PageHeaderProps) {
  const setHeader = useContext(HeaderContext);
  const backRef = useRef(back);
  useLayoutEffect(() => {
    backRef.current = back;
  });
  const isChild = back !== undefined;
  useLayoutEffect(() => {
    if (!isChild) {
      setHeader(null);
      return undefined;
    }
    setHeader({ title, deskRoot, back: () => backRef.current?.() });
    return () => setHeader(null);
  }, [setHeader, title, deskRoot, isChild]);

  if (!isChild || deskRoot) {
    // On a phone a section of «Ещё» keeps only its actions here (the title is in the top bar).
    return (
      <div className={deskRoot && !actions ? "page__head page__head--desk" : "page__head"}>
        <h1
          className={
            deskRoot ? "ac-text-title-l page__title desk-only" : "ac-text-title-l page__title"
          }
        >
          {title}
        </h1>
        {actions}
      </div>
    );
  }
  return actions ? <div className="page__head page__head--actions">{actions}</div> : null;
}
