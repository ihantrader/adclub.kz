import { Button, EmptyState, Icon } from "@adclub/ui";
import { useT } from "../i18n";
import { promptInstall, useInstallWay } from "../pwa/install";
import { goBackTo } from "../router";
import { PageHeader } from "./PageHeader";

/**
 * S-INST-01 «Установить на экран»: once after the first sign-in, then from
 * «Ещё». Chrome and Edge with their own dialog — the main «Установить»;
 * iPhone/Safari — «Поделиться → На экран „Домой“» drawn as it looks;
 * Android without the dialog yet — «⋮ → Установить приложение», drawn
 * too; another browser — the words of its menu. Installed already —
 * nothing to offer. «Не сейчас» is a text action inside the card
 * (TASK-079).
 */
export function Install({ onDone, firstTime }: { onDone?: () => void; firstTime?: boolean }) {
  const t = useT();
  const way = useInstallWay();
  const header = firstTime ? (
    <PageHeader title={t("install.title")} />
  ) : (
    <PageHeader title={t("install.title")} back={() => goBackTo("more")} deskRoot />
  );

  if (way === "installed") {
    return (
      <>
        {header}
        <EmptyState
          icon="circleCheck"
          title={t("install.installed")}
          action={
            onDone && (
              <Button variant="secondary" onClick={onDone}>
                {t("common.done")}
              </Button>
            )
          }
        />
      </>
    );
  }

  return (
    <>
      {header}
      <section className="card install">
        <div className="install__lead">
          <img className="install__icon" src="/icons/icon-192.png" alt="" width={64} height={64} />
          <p className="ac-text-body">{t("install.text")}</p>
        </div>

        {way === "ios" && (
          <>
            <Steps steps={[t("install.iosStep1"), t("install.iosStep2")]} />
            <IosPicture />
            <p className="ac-text-body-s ac-muted">{t("install.iosNote")}</p>
          </>
        )}

        {way === "android" && (
          <>
            <Steps steps={[t("install.androidStep1"), t("install.androidStep2")]} />
            <AndroidPicture />
          </>
        )}

        {way === "menu" && <p className="ac-text-body-s ac-muted">{t("install.otherBrowser")}</p>}

        {(way === "prompt" || (firstTime && onDone)) && (
          <div className="install__actions">
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
            {firstTime && onDone && (
              <Button variant="text" onClick={onDone}>
                {t("common.notNow")}
              </Button>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="install__steps">
      {steps.map((step, index) => (
        <li key={step}>
          <span className="install__step-number">{index + 1}</span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
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

/**
 * The Android steps the same way: the browser's address bar with «⋮»
 * marked, and the line of its menu «Установить приложение».
 */
function AndroidPicture() {
  const t = useT();
  return (
    <div className="ios-picture" aria-hidden="true">
      <div className="ios-picture__bar android-picture__bar">
        <span className="android-picture__address ac-text-body-s">adclub.kz</span>
        <span className="ios-picture__share android-picture__menu">
          <Icon name="dots" size={24} />
        </span>
      </div>
      <div className="ios-picture__sheet">
        <span className="ios-picture__row">
          <span className="ac-text-body-s ac-muted">{t("install.androidNewTab")}</span>
        </span>
        <span className="ios-picture__row ios-picture__row--on">
          <span>{t("install.androidInstallApp")}</span>
          <Icon name="download" size={24} />
        </span>
      </div>
    </div>
  );
}
