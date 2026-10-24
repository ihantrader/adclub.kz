import type { CatalogLanguage, SearchSynonymList } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  LoadingContent,
  Select,
  SkeletonList,
  TextField,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState, type FormEvent } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { useLoad } from "../use-load";
import { catalogErrorText, SYNONYM_LANGUAGE_TEXT } from "./catalog-words";

export type SynonymOwner = { kind: "item"; id: string } | { kind: "category"; id: string };

function listOf(owner: SynonymOwner): Promise<SearchSynonymList> {
  return owner.kind === "item"
    ? apiClient.listItemSearchSynonyms({ itemId: owner.id })
    : apiClient.listCategorySearchSynonyms({ categoryId: owner.id });
}

function addTo(
  owner: SynonymOwner,
  term: string,
  lang: CatalogLanguage | null,
): Promise<SearchSynonymList> {
  return owner.kind === "item"
    ? apiClient.addItemSearchSynonym({ itemId: owner.id }, { term, lang })
    : apiClient.addCategorySearchSynonym({ categoryId: owner.id }, { term, lang });
}

/**
 * «Синонимы для поиска» (TASK-044; ARCHITECTURE 10.2 п. 4, 4.64): a plain
 * list of an item or a category — add, remove. A synonym of a category
 * finds every item of it in the users' search; it is searched in every
 * language, the language is only a note. Two synonyms reading the same
 * (case, «ё», Kazakh letters and signs aside) the server refuses.
 */
export function SearchSynonyms({ owner, intro }: { owner: SynonymOwner; intro: string }) {
  const toast = useToast();
  const online = useOnline();
  const list = useLoad<SearchSynonymList>(
    () => listOf(owner),
    `synonyms:${owner.kind}:${owner.id}`,
  );
  const [term, setTerm] = useState("");
  const [lang, setLang] = useState<CatalogLanguage | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (term.trim().length < 2) {
      setError("Синоним — от двух знаков");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      list.replace(await addTo(owner, term.trim(), lang === "" ? null : lang));
      setTerm("");
      toast.show("Синоним добавлен");
    } catch (thrown) {
      setError(catalogErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (synonymId: string) => {
    setError(null);
    try {
      list.replace(await apiClient.removeSearchSynonym({ synonymId }));
      toast.show("Синоним убран");
    } catch (thrown) {
      setError(catalogErrorText(thrown));
    }
  };

  return (
    <div className="detail-stack">
      <p className="section__note">{intro}</p>
      {list.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={list.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(list.error)}
        </Banner>
      )}
      {error && <Banner tone="warning">{error}</Banner>}
      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={2} label="Загрузка" />}
      >
        {list.data?.synonyms.length === 0 ? (
          <EmptyState
            compact
            icon="search"
            title="Синонимов пока нет"
            text="Добавьте слова, по которым клиенты ищут эту позицию другими словами"
          />
        ) : (
          <ul className="cat-synonyms">
            {list.data?.synonyms.map((synonym) => (
              <li key={synonym.id} className="cat-synonyms__row">
                <span className="cat-synonyms__term">{synonym.term}</span>
                {synonym.lang && (
                  <TypeMark icon="language">{SYNONYM_LANGUAGE_TEXT[synonym.lang]}</TypeMark>
                )}
                <Button
                  variant="secondary"
                  size="s"
                  destructive
                  disabled={!online}
                  aria-label={`Убрать синоним «${synonym.term}»`}
                  onClick={() => remove(synonym.id)}
                >
                  Убрать
                </Button>
              </li>
            ))}
          </ul>
        )}
      </LoadingContent>
      <form className="cat-synonym-form" onSubmit={add}>
        <TextField
          className="ac-field--compact cat-synonym-form__term"
          label="Новый синоним"
          placeholder="колодки, brake pads, тежегіш қалыптары"
          value={term}
          onChange={setTerm}
        />
        <Select<CatalogLanguage | "any">
          compact
          className="cat-synonym-form__lang"
          label="Язык (необязательно)"
          value={lang === "" ? "any" : lang}
          options={[
            { value: "any", label: "Не указан" },
            { value: "ru", label: SYNONYM_LANGUAGE_TEXT.ru },
            { value: "kk", label: SYNONYM_LANGUAGE_TEXT.kk },
            { value: "en", label: SYNONYM_LANGUAGE_TEXT.en },
          ]}
          onChange={(next) => setLang(next === "any" ? "" : next)}
        />
        <Button type="submit" variant="secondary" size="s" icon="plus" disabled={!online || busy}>
          Добавить
        </Button>
      </form>
    </div>
  );
}
