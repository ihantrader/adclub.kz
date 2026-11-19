import type { Choice } from "@adclub/ui";
import { CATALOG_REQUEST_PHOTOS_MAX } from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  IconButton,
  SearchSelect,
  TextAreaField,
  TextField,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { goBack, navigate, useRouteState } from "../router";
import { photoRefusal } from "../photos/photo-rules";
import { PhotoPicker } from "../photos/PhotoPicker";
import { shrinkPhoto } from "../price/photo-shrink";
import { PageHeader } from "../screens/PageHeader";
import { formFromQuery, requestBody, requestRefusal, type RequestForm } from "./moderation-rules";

/** The subcategories of the catalog, loaded once: the suggestions of «Категория». */
let subcategories: Promise<Choice[]> | null = null;

function loadSubcategories(): Promise<Choice[]> {
  subcategories ??= apiClient.getCatalogCategories().then(
    (tree) =>
      tree.categories.flatMap((node) =>
        node.children.map((child) => ({
          id: child.id,
          label: child.name.text,
          note: node.name.text,
        })),
      ),
    (error: unknown) => {
      subcategories = null;
      throw error;
    },
  );
  return subcategories;
}

/**
 * S-OFF-05 «Запрос на добавление позиции» (TASK-048), from «Нет в
 * справочнике?» of the search: the name (required), the brand with
 * suggestions by any spelling (or another one typed), the article or
 * characteristics, the subcategory with suggestions, a comment → «Запрос
 * отправлен администратору. Результат — в разделе „Модерация“». Up to three
 * photos by choice (TASK-068): sent after the request, one by one; the item
 * made of the request gets them as candidates. One waiting request per
 * article (or name) of the company.
 */
export function RequestFormScreen() {
  const { t } = useLanguage();
  const online = useOnline();
  const opened = useRouteState() as { query?: string } | null;
  const [form, setForm] = useState<RequestForm>(() => formFromQuery(opened?.query ?? ""));
  const [brand, setBrand] = useState<Choice | null>(null);
  const [category, setCategory] = useState<Choice | null>(null);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [photos, setPhotos] = useState<{ file: File; url: string }[]>([]);
  const [photosFailed, setPhotosFailed] = useState<string | null>(null);

  // The previews are the browser's own links: given back when a photo goes,
  // and all of them when the screen is left.
  const shown = useRef(photos);
  useEffect(() => {
    shown.current = photos;
  }, [photos]);
  useEffect(
    () => () => {
      for (const photo of shown.current) URL.revokeObjectURL(photo.url);
    },
    [],
  );

  const searchBrands = useCallback(async (query: string): Promise<Choice[]> => {
    if (query.trim() === "") return [];
    const answer = await apiClient.listSupplierBrandSuggestions({ query: { q: query } });
    return answer.brands.map((entry) => ({
      id: entry.id,
      label: entry.name,
      note: entry.matched !== entry.name ? entry.matched : null,
    }));
  }, []);

  const searchCategories = useCallback(async (query: string): Promise<Choice[]> => {
    const all = await loadSubcategories();
    const text = query.trim().toLowerCase().replace(/ё/g, "е");
    const found =
      text === ""
        ? all
        : all.filter((choice) =>
            `${choice.label} ${choice.note ?? ""}`.toLowerCase().replace(/ё/g, "е").includes(text),
          );
    return found.slice(0, 30);
  }, []);

  const body = requestBody({
    ...form,
    brand: brand?.label ?? "",
    categoryId: category?.id ?? null,
  });

  async function send() {
    setTouched(true);
    if (!body) return;
    setSending(true);
    setRefusal(null);
    try {
      const created = await apiClient.createSupplierCatalogRequest(body);
      let failure: string | null = null;
      for (const photo of photos) {
        try {
          await apiClient.uploadCatalogRequestPhoto(
            { requestId: created.request.id },
            await shrinkPhoto(photo.file),
          );
        } catch (error) {
          failure = photoRefusal(error, t);
        }
      }
      setPhotosFailed(failure);
      for (const photo of photos) URL.revokeObjectURL(photo.url);
      setPhotos([]);
      setSent(true);
    } catch (error) {
      setRefusal(requestRefusal(error, t).text);
    } finally {
      setSending(false);
    }
  }

  const head = <PageHeader title={t("request.title")} back={() => goBack("offers")} />;

  if (sent) {
    return (
      <>
        {head}
        <Banner icon="circleCheck">{t("request.sent")}</Banner>
        {photosFailed && (
          <Banner tone="warning" icon="alertTriangle">
            {t("request.photosFailed", { reason: photosFailed })}
          </Banner>
        )}
        <ActionBar
          main={<Button onClick={() => navigate("moderation")}>{t("result.toModeration")}</Button>}
          others={[
            <Button
              key="another"
              variant="secondary"
              onClick={() => {
                setSent(false);
                setPhotosFailed(null);
                setTouched(false);
                setForm(formFromQuery(""));
                setBrand(null);
                setCategory(null);
              }}
            >
              {t("request.another")}
            </Button>,
          ]}
        />
      </>
    );
  }

  return (
    <>
      {head}
      <p className="ac-text-body-s ac-muted">{t("request.lead")}</p>
      <form
        id="request-form"
        className="card request-form form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <TextField
          autoFocus
          className="form-grid__wide"
          label={t("request.name")}
          value={form.name}
          maxLength={300}
          onChange={(name) => setForm((current) => ({ ...current, name }))}
          hint={touched && !body ? undefined : t("request.nameRequired")}
          error={touched && !body ? t("request.nameNeeded") : undefined}
        />
        <SearchSelect
          label={t("request.brand")}
          value={brand}
          onChange={setBrand}
          search={searchBrands}
          empty={t("request.brandNone")}
          create={{
            label: t("request.brandOther"),
            onCreate: (typed) => {
              const text = typed.trim();
              if (text) setBrand({ id: `typed:${text}`, label: text });
            },
          }}
          texts={{
            failed: t("searchSelect.failed"),
            nothing: t("searchSelect.nothing"),
            searching: t("searchSelect.searching"),
          }}
        />
        <TextField
          label={t("request.article")}
          value={form.article}
          maxLength={100}
          onChange={(article) => setForm((current) => ({ ...current, article }))}
        />
        <SearchSelect
          label={t("request.category")}
          value={category}
          onChange={setCategory}
          search={searchCategories}
          empty={t("request.categoryNone")}
          texts={{
            failed: t("searchSelect.failed"),
            nothing: t("searchSelect.nothing"),
            searching: t("searchSelect.searching"),
          }}
        />
        <TextAreaField
          className="form-grid__wide"
          label={t("request.comment")}
          value={form.comment}
          maxLength={1000}
          onChange={(comment) => setForm((current) => ({ ...current, comment }))}
        />
        <div className="form-grid__wide part-photo">
          <span className="ac-text-label">{t("request.photos")}</span>
          {photos.length > 0 && (
            <ul className="part-photo__list" aria-label={t("request.photos")}>
              {photos.map((photo, index) => (
                <li key={photo.url} className="part-photo__entry">
                  <img className="part-photo__thumb" src={photo.url} alt="" />
                  <IconButton
                    icon="trash"
                    label={t("request.photoRemove")}
                    size={20}
                    onClick={() => {
                      URL.revokeObjectURL(photo.url);
                      setPhotos((current) => current.filter((_, at) => at !== index));
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          {photos.length < CATALOG_REQUEST_PHOTOS_MAX && (
            <PhotoPicker
              testId="request-photo"
              disabled={sending}
              onPhoto={(file) =>
                setPhotos((current) =>
                  current.length >= CATALOG_REQUEST_PHOTOS_MAX
                    ? current
                    : [...current, { file, url: URL.createObjectURL(file) }],
                )
              }
            />
          )}
        </div>
        {refusal && (
          <div className="form-grid__wide">
            <Banner
              tone="danger"
              icon="alertTriangle"
              action={
                <Button variant="text" size="s" onClick={() => navigate("moderation")}>
                  {t("nav.moderation")}
                </Button>
              }
            >
              {refusal}
            </Banner>
          </div>
        )}
      </form>
      <ActionBar
        pinned
        main={
          <Button
            type="submit"
            form="request-form"
            size="l"
            loading={sending}
            disabled={!online || sending}
          >
            {t("request.send")}
          </Button>
        }
        note={online ? undefined : t("common.needNetwork")}
      />
    </>
  );
}
