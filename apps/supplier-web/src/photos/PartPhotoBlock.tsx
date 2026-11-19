import type { SupplierItemPhoto, SupplierOfferPhotos } from "@adclub/contracts";
import { Badge, Banner, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api";
import { useT } from "../i18n";
import { shrinkPhoto } from "../price/photo-shrink";
import { photoRefusal, photoStatusText, photoStatusTone } from "./photo-rules";
import { PhotoPicker } from "./PhotoPicker";

/**
 * S-OFF-03 «У позиции нет фото — сфотографируйте деталь» (TASK-068): in the
 * card of an offer on a product whose item has no approved photo. One photo
 * at a time; it goes to moderation, and its status is here and in
 * «Модерация → Фото». Once the item has a photo the block is gone (only the
 * company's own photos stay listed until then).
 */
export function PartPhotoBlock({ offerId }: { offerId: string }) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const [state, setState] = useState<SupplierOfferPhotos | null>(null);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(
    () =>
      apiClient.getSupplierOfferPhotos({ offerId }).then(
        (answer) => answer,
        // The block is secondary: without an answer it simply isn't shown.
        () => null,
      ),
    [offerId],
  );

  useEffect(() => {
    let live = true;
    void load().then((answer) => {
      if (live && answer) setState(answer);
    });
    return () => {
      live = false;
    };
  }, [load]);

  if (!state || (!state.needed && state.photos.length === 0)) return null;

  async function send(file: File) {
    setRefusal(null);
    setSending(true);
    try {
      const answer = await apiClient.uploadSupplierOfferPhoto({ offerId }, await shrinkPhoto(file));
      toast.show(answer.created ? t("photo.sent") : t("photo.same"));
      const next = await load();
      if (next) setState(next);
    } catch (error) {
      setRefusal(photoRefusal(error, t));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card part-photo" aria-labelledby="part-photo-title">
      <h2 id="part-photo-title" className="ac-text-heading">
        {state.needed ? t("photo.blockTitle") : t("photo.yours")}
      </h2>
      {state.needed && <p className="ac-text-body-s ac-muted">{t("photo.blockText")}</p>}
      {state.photos.length > 0 && (
        <ul className="part-photo__list" aria-label={t("photo.yours")}>
          {state.photos.map((photo) => (
            <PhotoEntry key={photo.id} photo={photo} />
          ))}
        </ul>
      )}
      {refusal && (
        <Banner tone="danger" icon="alertTriangle">
          {refusal}
        </Banner>
      )}
      {state.needed && (
        <PhotoPicker
          testId="part-photo"
          disabled={!online}
          busy={sending}
          onPhoto={(file) => void send(file)}
        />
      )}
      {!online && <span className="ac-text-caption ac-muted">{t("common.needNetwork")}</span>}
    </section>
  );
}

export function PhotoEntry({ photo }: { photo: SupplierItemPhoto }) {
  const t = useT();
  return (
    <li className="part-photo__entry">
      {photo.thumbUrl ? (
        <img className="part-photo__thumb" src={photo.thumbUrl} alt="" loading="lazy" />
      ) : (
        <span className="part-photo__thumb part-photo__thumb--empty" aria-hidden="true" />
      )}
      <Badge
        tone={photoStatusTone(photo.status)}
        icon={
          photo.status === "approved"
            ? "circleCheck"
            : photo.status === "proposed"
              ? "clock"
              : "circleX"
        }
      >
        {photoStatusText(photo.status, photo.rejectionReason, t)}
      </Badge>
    </li>
  );
}
