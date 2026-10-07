import {
  PHOTO_CONTENT_TYPES,
  type AdminCatalogItemCard,
  type AdminItemPhoto,
  type AdminItemPhotosResponse,
  type ItemPhotoSourceType,
  type ItemPhotoStatus,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useRef, useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
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

/**
 * «Фото» of the card (A-CAT-05; TASK-013 on the server): a JPEG, PNG or
 * WebP file — its source and, for a picture found on the internet, the page
 * it comes from; the photos with their status, «Подтвердить», «Отклонить»
 * with a reason, «Убрать», the order of the approved ones (the first is
 * the primary). The server checks the file by its content and says why it
 * refuses; the same file twice is «уже есть», not a second photo.
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState<ItemPhotoSourceType>("admin_upload");
  const [sourceUrl, setSourceUrl] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<AdminItemPhoto | null>(null);
  const [reason, setReason] = useState("");
  const list = photos.data?.photos ?? [];
  const approved = list.filter((photo) => photo.status === "approved");
  const needsUrl = PHOTO_SOURCES_WITH_URL.includes(sourceType);

  const upload = async () => {
    if (!file) return;
    setUploadError(null);
    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setUploadError("Формат не поддерживается — нужен JPEG, PNG или WebP");
      return;
    }
    if (needsUrl && !sourceUrl.trim()) {
      setUploadError("Для фото из интернета укажите ссылку на страницу-источник");
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
      if (fileInput.current) fileInput.current.value = "";
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
          ? conflictText(await whoChanged("catalog_item_photo", photo.id))
          : catalogErrorText(thrown),
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
      setError(catalogErrorText(thrown));
      photos.reload();
    }
  };

  return (
    <div className="detail-stack">
      <div className="card-section upload-box">
        <h3 className="ac-text-heading">Загрузить фото</h3>
        <div className="filters">
          <label className="select">
            <span className="ac-text-caption ac-muted">Файл (JPEG, PNG или WebP)</span>
            <input
              ref={fileInput}
              type="file"
              accept={PHOTO_CONTENT_TYPES.join(",")}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label className="select">
            <span className="ac-text-caption ac-muted">Источник</span>
            <select
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value as ItemPhotoSourceType)}
            >
              {(Object.keys(PHOTO_SOURCE_TEXT) as ItemPhotoSourceType[])
                .filter((type) => type !== "supplier_photo")
                .map((type) => (
                  <option key={type} value={type}>
                    {PHOTO_SOURCE_TEXT[type]}
                  </option>
                ))}
            </select>
          </label>
          {needsUrl && (
            <TextField
              label="Ссылка на страницу-источник"
              value={sourceUrl}
              onChange={setSourceUrl}
              hint="https://…"
              autoComplete="off"
            />
          )}
          <Button disabled={!online || !file} loading={uploading} onClick={upload}>
            Загрузить
          </Button>
        </div>
        {uploadError && (
          <p className="dialog-error" role="alert">
            {uploadError}
          </p>
        )}
        {photos.data && (
          <p className="ac-text-caption ac-muted">
            Клиентам фото показывается{" "}
            {photos.data.displayMode === "copy"
              ? "нашей копией"
              : "ссылкой на источник (своя копия — у фото без источника)"}{" "}
            — настройка photo_display_mode.
          </p>
        )}
      </div>

      {error && <Banner tone="warning">{error}</Banner>}
      {photos.error !== undefined && <Banner tone="danger">{loadErrorText(photos.error)}</Banner>}
      <LoadingContent
        ready={photos.data !== undefined}
        indicator={photos.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {list.length === 0 ? (
          <EmptyState icon="package" title="Фото нет" text="Клиенты видят заглушку вместо фото." />
        ) : (
          <div className="table-wrap">
            <table className="admin-table photos-table">
              <thead>
                <tr>
                  <th scope="col">Фото</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Источник</th>
                  <th scope="col">Файл</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((photo) => {
                  const approvedIndex = approved.findIndex((entry) => entry.id === photo.id);
                  const preview = photo.image?.thumbUrl ?? photo.originalUrl;
                  return (
                    <tr
                      key={photo.id}
                      className={photo.status === "approved" ? undefined : "row--muted"}
                    >
                      <td className="thumb-cell">
                        {preview ? (
                          <a
                            href={photo.originalUrl ?? preview}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            <img className="thumb thumb--large" src={preview} alt="Фото позиции" />
                          </a>
                        ) : (
                          <span
                            className="thumb thumb--large thumb--empty"
                            aria-label="Файл удалён"
                          />
                        )}
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span
                            className={`status status--${photo.status === "approved" ? "open" : photo.status === "proposed" ? "acknowledged" : "closed"}`}
                          >
                            {PHOTO_STATUS_TEXT[photo.status]}
                          </span>
                          {photo.isPrimary && <span className="ac-text-caption">основное</span>}
                          {photo.rejectionReason && (
                            <span className="ac-text-caption ac-muted">
                              Причина: {photo.rejectionReason}
                            </span>
                          )}
                          {photo.filesDeletedAt && (
                            <span className="ac-text-caption warning-text">файлы удалены</span>
                          )}
                        </div>
                      </td>
                      <td className="ac-text-body-s">
                        <div className="cell-stack">
                          <span>{PHOTO_SOURCE_TEXT[photo.sourceType]}</span>
                          {photo.sourceUrl && (
                            <a
                              className="clamp ac-text-caption"
                              href={photo.sourceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={photo.sourceUrl}
                            >
                              {photo.sourceUrl}
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="ac-text-caption ac-muted">
                        {photo.width}×{photo.height}, {sizeText(photo.byteSize)}
                        <br />
                        {formatMoment(photo.uploadedAt)}
                      </td>
                      <td className="admin-table__actions">
                        <div className="button-row button-row--end">
                          {approvedIndex >= 0 && (
                            <>
                              <IconButton
                                icon="arrowLeft"
                                className="arrow-up"
                                label="Выше"
                                disabled={!online || approvedIndex === 0}
                                onClick={() => move(approvedIndex, -1)}
                              />
                              <IconButton
                                icon="arrowLeft"
                                className="arrow-down"
                                label="Ниже"
                                disabled={!online || approvedIndex === approved.length - 1}
                                onClick={() => move(approvedIndex, 1)}
                              />
                            </>
                          )}
                          {photo.status !== "approved" && !photo.filesDeletedAt && (
                            <Button
                              size="s"
                              disabled={!online}
                              onClick={() => setStatus(photo, "approved")}
                            >
                              Подтвердить
                            </Button>
                          )}
                          {photo.status !== "rejected" && !photo.filesDeletedAt && (
                            <Button
                              variant="secondary"
                              size="s"
                              disabled={!online}
                              onClick={() => {
                                setReason("");
                                setRejecting(photo);
                              }}
                            >
                              Отклонить
                            </Button>
                          )}
                          {photo.status !== "deleted" && !photo.filesDeletedAt && (
                            <Button
                              variant="text"
                              size="s"
                              disabled={!online}
                              onClick={() => setStatus(photo, "deleted")}
                            >
                              Убрать
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
