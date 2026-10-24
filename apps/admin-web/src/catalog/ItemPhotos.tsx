import {
  PHOTO_CONTENT_TYPES,
  PHOTO_MAX_UPLOAD_BYTES,
  type AdminCatalogItemCard,
  type AdminItemPhoto,
  type AdminItemPhotosResponse,
  type ItemPhotoSourceType,
  type ItemPhotoStatus,
} from "@adclub/contracts";
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  FileDrop,
  Icon,
  LoadingContent,
  MenuButton,
  Select,
  SkeletonList,
  StatusBadge,
  TextField,
  TypeMark,
  useToast,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { AppLink, Thumb } from "../layout/layout";
import { routePaths } from "../router";
import { useLoad } from "../use-load";
import {
  PHOTO_SOURCES_WITH_URL,
  PHOTO_SOURCE_TEXT,
  PHOTO_STATUS_TEXT,
  catalogErrorText,
  conflictText,
  isConflict,
} from "./catalog-words";
import { moveInOrder } from "./order";
import { whoChanged } from "./shared";

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** The host of a source page, for its short link («geely-motors.com»). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const UPLOAD_SOURCES = (Object.keys(PHOTO_SOURCE_TEXT) as ItemPhotoSourceType[]).filter(
  (type) => type !== "supplier_photo",
);

/**
 * «Фото» of the card (A-CAT-05; TASK-013 on the server, TASK-080): a JPEG,
 * PNG or WebP file dropped on the zone or chosen — its source and, for a
 * picture found on the internet, the page it comes from; the photos as a
 * grid of thumbnails 160 with their status, «Подтвердить», «Отклонить…»
 * with a reason, «Убрать» in «⋯», the order of the approved ones by the
 * arrows on them (the first is the primary). The server checks the file by
 * its content and says why it refuses; the same file twice is «уже есть».
 */
export function ItemPhotos({
  card,
  onChanged,
}: {
  card: AdminCatalogItemCard;
  onChanged: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const itemId = card.item.id;
  const photos = useLoad<AdminItemPhotosResponse>(
    () => apiClient.listItemPhotos({ itemId }),
    `photos:${itemId}`,
  );
  const [file, setFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState<ItemPhotoSourceType>("admin_upload");
  const [sourceUrl, setSourceUrl] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [rejecting, setRejecting] = useState<AdminItemPhoto | null>(null);
  const [reason, setReason] = useState("");
  const list = photos.data?.photos ?? [];
  const approved = list.filter((photo) => photo.status === "approved");
  // The approved ones in their order first: the order the clients see.
  const shown = [...approved, ...list.filter((photo) => photo.status !== "approved")];
  const needsUrl = PHOTO_SOURCES_WITH_URL.includes(sourceType);

  const upload = async () => {
    if (!file) return;
    setUploadError(null);
    setUrlError(null);
    if (needsUrl && !sourceUrl.trim()) {
      setUrlError("Для фото из интернета укажите ссылку на страницу-источник");
      return;
    }
    setUploading(true);
    try {
      const before = new Set(list.map((photo) => photo.id));
      const answer = await apiClient.uploadItemPhoto({ itemId }, file, {
        query: { sourceType, ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}) },
      });
      photos.replace(answer);
      const isNew = answer.photos.some((photo) => !before.has(photo.id));
      toast.show(isNew ? "Фото загружено и ждёт подтверждения" : "Это фото у позиции уже есть");
      setFile(null);
      setSourceUrl("");
    } catch (thrown) {
      setUploadError(catalogErrorText(thrown));
    } finally {
      setUploading(false);
    }
  };

  const setStatus = async (photo: AdminItemPhoto, status: ItemPhotoStatus, why?: string) => {
    setError(null);
    try {
      await apiClient.setItemPhotoStatus(
        { itemId, photoId: photo.id },
        { expectedVersion: photo.version, status, ...(why ? { reason: why } : {}) },
      );
      toast.show(`Фото: ${PHOTO_STATUS_TEXT[status].toLowerCase()}`);
      photos.reload();
      onChanged();
    } catch (thrown) {
      setError(
        isConflict(thrown)
          ? { text: conflictText(await whoChanged("catalog_item_photo", photo.id)), conflict: true }
          : { text: catalogErrorText(thrown), conflict: false },
      );
      photos.reload();
    }
  };

  const move = async (index: number, by: -1 | 1) => {
    const order = moveInOrder(
      approved.map((photo) => photo.id),
      index,
      by,
    );
    if (!order) return;
    setError(null);
    try {
      photos.replace(await apiClient.reorderItemPhotos({ itemId }, { photoIds: order.ids }));
      onChanged();
    } catch (thrown) {
      setError({ text: catalogErrorText(thrown), conflict: false });
      photos.reload();
    }
  };

  return (
    <div className="detail-stack">
      <section className="card cat-block">
        <div className="section__head">
          <h3 className="section__title">Загрузить фото</h3>
        </div>
        <FileDrop
          title="Перетащите фото сюда или выберите файл"
          hint="JPEG, PNG или WebP. Проверяется по содержимому файла"
          icon="image"
          accept={PHOTO_CONTENT_TYPES}
          maxBytes={PHOTO_MAX_UPLOAD_BYTES}
          file={file}
          disabled={!online || uploading}
          onFile={(chosen) => {
            setFile(chosen);
            setUploadError(null);
          }}
          onReject={() => setFile(null)}
          error={uploadError}
          texts={{
            choose: "Выбрать файл",
            none: "Файл не выбран",
            wrongType: "Формат не поддерживается — нужен JPEG, PNG или WebP",
            tooLarge: "Файл слишком большой",
          }}
        />
        <div className="form-grid">
          <Select<ItemPhotoSourceType>
            label="Источник"
            value={sourceType}
            options={UPLOAD_SOURCES.map((type) => ({
              value: type,
              label: PHOTO_SOURCE_TEXT[type],
            }))}
            onChange={(next) => {
              setSourceType(next);
              setUrlError(null);
            }}
          />
          {needsUrl && (
            <TextField
              label="Ссылка на страницу-источник"
              value={sourceUrl}
              onChange={setSourceUrl}
              placeholder="https://…"
              error={urlError ?? undefined}
              autoComplete="off"
            />
          )}
        </div>
        <ActionBar
          label="Загрузка фото"
          main={
            <Button disabled={!online || !file} loading={uploading} onClick={upload}>
              Загрузить
            </Button>
          }
          note={!file ? "Сначала выберите файл" : undefined}
        />
      </section>

      {error && (
        <Banner
          tone="warning"
          action={
            error.conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setError(null);
                  photos.reload();
                }}
              >
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {error.text}
        </Banner>
      )}
      {photos.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={photos.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(photos.error)}
        </Banner>
      )}
      <LoadingContent
        ready={photos.data !== undefined}
        indicator={photos.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <section className="section">
          <div className="section__head">
            <h3 className="section__title">Фото позиции</h3>
          </div>
          {photos.data && (
            <p className="section__note">
              Клиенты видят подтверждённые фото в этом порядке, первое — основное. Показываются{" "}
              {photos.data.displayMode === "copy"
                ? "нашей копией"
                : "ссылкой на источник (своя копия — у фото без источника)"}
              ; меняется в <AppLink href={routePaths.settings}>«Настройках»</AppLink>, группа
              «Фото».
            </p>
          )}
          {shown.length === 0 ? (
            <EmptyState
              compact
              icon="image"
              title="Фото нет"
              text="Клиенты видят заглушку вместо фото."
            />
          ) : (
            <ul className="cat-photos" aria-label="Фото позиции">
              {shown.map((photo) => {
                const approvedIndex = approved.findIndex((entry) => entry.id === photo.id);
                const preview = photo.image?.thumbUrl ?? photo.originalUrl;
                const alive = !photo.filesDeletedAt;
                const menu: MenuAction[] = alive
                  ? [
                      ...(photo.status !== "rejected"
                        ? [
                            {
                              key: "reject",
                              label: "Отклонить…",
                              icon: "prohibit" as const,
                              disabled: !online,
                              onSelect: () => {
                                setReason("");
                                setRejecting(photo);
                              },
                            },
                          ]
                        : []),
                      ...(photo.status !== "deleted"
                        ? [
                            {
                              key: "delete",
                              label: "Убрать",
                              icon: "trash" as const,
                              destructive: true,
                              disabled: !online,
                              onSelect: () => void setStatus(photo, "deleted"),
                            },
                          ]
                        : []),
                    ]
                  : [];
                return (
                  <li
                    key={photo.id}
                    className={
                      photo.status === "approved" ? "cat-photo" : "cat-photo cat-photo--muted"
                    }
                  >
                    <div className="cat-photo__picture">
                      {preview ? (
                        <a
                          href={photo.originalUrl ?? preview}
                          target="_blank"
                          rel="noreferrer noopener"
                          aria-label="Открыть фото полностью"
                        >
                          <Thumb src={preview} size={160} alt="Фото позиции" />
                        </a>
                      ) : (
                        <Thumb size={160} />
                      )}
                      {approvedIndex >= 0 && approved.length > 1 && (
                        <span className="cat-photo__order" role="group" aria-label="Порядок фото">
                          <button
                            type="button"
                            className="cat-photo__move"
                            aria-label="Раньше"
                            title="Раньше"
                            disabled={!online || approvedIndex === 0}
                            onClick={() => void move(approvedIndex, -1)}
                          >
                            <Icon name="chevronLeft" size={16} />
                          </button>
                          <button
                            type="button"
                            className="cat-photo__move"
                            aria-label="Позже"
                            title="Позже"
                            disabled={!online || approvedIndex === approved.length - 1}
                            onClick={() => void move(approvedIndex, 1)}
                          >
                            <Icon name="chevronRight" size={16} />
                          </button>
                        </span>
                      )}
                    </div>
                    <div className="badges">
                      <StatusBadge kind="photo" status={photo.status}>
                        {PHOTO_STATUS_TEXT[photo.status]}
                      </StatusBadge>
                      {photo.isPrimary && (
                        <Badge tone="accent" icon="star">
                          Основное
                        </Badge>
                      )}
                    </div>
                    <div className="cat-photo__facts">
                      <TypeMark icon={photo.sourceUrl ? "externalLink" : "upload"}>
                        {PHOTO_SOURCE_TEXT[photo.sourceType]}
                      </TypeMark>
                      {photo.sourceUrl && (
                        <a
                          className="cat-photo__source"
                          href={photo.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={photo.sourceUrl}
                        >
                          {hostOf(photo.sourceUrl)}
                        </a>
                      )}
                      <span>
                        {photo.width}×{photo.height}, {sizeText(photo.byteSize)}
                      </span>
                      <span>{formatMoment(photo.uploadedAt)}</span>
                      {photo.rejectionReason && <span>Причина: {photo.rejectionReason}</span>}
                      {photo.filesDeletedAt && (
                        <Badge tone="warning" icon="alertTriangle">
                          Файлы удалены
                        </Badge>
                      )}
                    </div>
                    {(menu.length > 0 || (alive && photo.status !== "approved")) && (
                      <span className="row-actions cat-photo__actions">
                        {alive && photo.status !== "approved" && (
                          <Button
                            variant="secondary"
                            size="s"
                            disabled={!online}
                            onClick={() => void setStatus(photo, "approved")}
                          >
                            Подтвердить
                          </Button>
                        )}
                        {menu.length > 0 && (
                          <MenuButton size="s" label="Действия с фото" actions={menu} />
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </LoadingContent>

      <Dialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Отклонить фото?"
        actions={
          <>
            <Button
              disabled={!reason.trim()}
              onClick={async () => {
                if (rejecting) await setStatus(rejecting, "rejected", reason.trim());
                setRejecting(null);
              }}
            >
              Отклонить
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <TextField label="Причина" value={reason} onChange={setReason} hint="Обязательна" />
          {rejecting?.isPrimary && (
            <p className="ac-text-body-s">
              Это основное фото: роль перейдёт к следующему подтверждённому, а если его нет —
              клиенты увидят заглушку.
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
