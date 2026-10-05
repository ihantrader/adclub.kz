import { Button, EmptyState, Icon } from "@adclub/ui";
import { useT } from "../i18n";
import { promptInstall, useInstallWay } from "../pwa/install";

/**
 * S-INST-01 «Установить на экран»: once after the first sign-in, then from
 * «Ещё». Android/Chrome — the browser's own dialog; iPhone/Safari — the
 * Share steps drawn as they look; another browser — the words of its menu.
 * Installed already — nothing to offer.
 */
export function Install({ onDone, firstTime }: { onDone?: () => void; firstTime?: boolean }) {
  const t = useT();
  const way = useInstallWay();

  if (way === "installed") {
    return (
      <>
        <h1 className="ac-text-title page__title">{t("install.title")}</h1>
        <EmptyState icon="circleCheck" title={t("install.installed")} />
        {onDone && (
          <Button variant="secondary" onClick={onDone}>
            {t("common.done")}
          </Button>
        )}
      </>
    );
  }

  return (
    <>
      <h1 className="ac-text-title page__title">{t("install.title")}</h1>
      <section className="card install">
        <img className="install__icon" src="/icons/icon-192.png" alt="" width={64} height={64} />
        <p className="ac-text-body">{t("install.text")}</p>

        {way === "prompt" && (
          <Button
            size="l"
            block
            icon="download"
            onClick={async () => {
              if (await promptInstall()) onDone?.();
            }}
          >
            {t("install.button")}
          </Button>
        )}

        {way === "ios" && (
          <>
            <ol className="install__steps">
              <li>
                <span className="install__step-number">1</span>
                <span>{t("install.iosStep1")}</span>
              </li>
              <li>
                <span className="install__step-number">2</span>
                <span>{t("install.iosStep2")}</span>
              </li>
            </ol>
            <IosPicture />
            <p className="ac-text-body-s ac-muted">{t("install.iosNote")}</p>
          </>
        )}

        {way === "menu" && <p className="ac-text-body-s ac-muted">{t("install.otherBrowser")}</p>}
      </section>
      {firstTime && onDone && (
        <Button variant="text" onClick={onDone}>
          {t("common.notNow")}
        </Button>
      )}
    </>
  );
}

/**
 * The picture of the iPhone steps: Safari's bottom bar with «Поделиться»
 * marked, and the line of the Share sheet that adds the cabinet to the
 * Home Screen. Drawn with the interface's own icons so it follows the theme.
 */
function IosPicture() {
  const t = useT();
  return (
    <div className="ios-picture" aria-hidden="true">
      <div className="ios-picture__bar">
        <Icon name="arrowLeft" size={20} />
        <span className="ios-picture__share">
          <Icon name="share" size={24} />
        </span>
        <Icon name="dots" size={20} />
      </div>
      <div className="ios-picture__sheet">
        <span className="ios-picture__row">
          <img
            className="ios-picture__app"
            src="/icons/icon-192.png"
            alt=""
            width={36}
            height={36}
          />
          <span className="ac-text-body-s">AD Кабинет</span>
        </span>
        <span className="ios-picture__row ios-picture__row--on">
          <span>{t("install.iosAddToHome")}</span>
          <Icon name="plusSquare" size={24} />
        </span>
      </div>
    </div>
  );
}
