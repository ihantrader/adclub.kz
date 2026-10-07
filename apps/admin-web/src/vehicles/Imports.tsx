import type {
  AdminVehicleImport,
  VehicleImportTemplateResponse,
  VehicleOptionKind,
} from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useRef, useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { navigateTo, vehicleImportPath } from "../router";
import { useLoad } from "../use-load";
import { LoadError, MoreButton, usePaged, VehiclesTabs } from "./shared";
import {
  COLUMN_TEXT,
  IMPORT_STATUS_TEXT,
  importFileErrorText,
  importNumbers,
  OPTION_KIND_TEXT,
  personText,
  templateFileText,
  uploadContentType,
} from "./vehicle-words";

const statusClass: Record<AdminVehicleImport["status"], string> = {
  parsing: "acknowledged",
  ready: "open",
  applying: "acknowledged",
  applied: "closed",
  cancelled: "closed",
  failed: "closed",
};

/**
 * A-CAR-02 «Импорт» (SCREENS 7.2; TASK-035.B): «Скачать шаблон» with what
 * each column takes and the values of the reference lists next to it, the
 * upload (a file the server can't take is refused at once, in words), and
 * the history — who uploaded and applied, when, what came of it.
 */
export function Imports() {
  const online = useOnline();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const template = useLoad<VehicleImportTemplateResponse>(
    () => apiClient.getVehicleImportTemplate(),
    "template",
  );
  const history = usePaged<AdminVehicleImport>(async (cursor) => {
    const page = await apiClient.listVehicleImports({ query: { limit: 20, cursor } });
    return { items: page.imports, total: page.total, nextCursor: page.nextCursor };
  }, "imports");

  const download = () => {
    const data = template.data;
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([templateFileText(data.csv)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = data.fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const answer = await apiClient.uploadVehicleImport(file, {
        contentType: uploadContentType(file.type),
        query: { fileName: file.name.slice(0, 200) },
      });
      navigateTo(vehicleImportPath(answer.import.id));
    } catch (thrown) {
      setUploadError(importFileErrorText(thrown));
    } finally {
      setUploading(false);
    }
  };

  const optionsByKind = new Map<VehicleOptionKind, string[]>();
  for (const option of template.data?.options ?? []) {
    const names = [option.code, option.names.ru, option.names.kk, option.names.en].filter(
      (name, index, all): name is string => !!name && all.indexOf(name) === index,
    );
    optionsByKind.set(option.kind, [...(optionsByKind.get(option.kind) ?? []), names.join(" / ")]);
  }

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Автомобили</h1>
      </div>
      <VehiclesTabs active="imports" />

      <section className="panel-box" aria-labelledby="import-upload">
        <h2 id="import-upload" className="ac-text-heading">
          Загрузить файл
        </h2>
        <p className="ac-text-body-s ac-muted">
          Одна строка — одна модификация. Файл — таблица CSV в UTF-8 (в Excel: «Сохранить как → CSV
          UTF-8»), разделитель — запятая или точка с запятой. После загрузки сервер проверит строки
          и покажет отчёт; <strong>до «Применить» в справочнике ничего не меняется</strong>.
        </p>
        <div className="button-row">
          <Button variant="secondary" icon="download" onClick={download} disabled={!template.data}>
            Скачать шаблон
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            aria-label="Файл импорта"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setUploadError(null);
            }}
          />
          <Button onClick={upload} loading={uploading} disabled={!file || !online}>
            Загрузить и проверить
          </Button>
        </div>
        {uploadError && (
          <p className="dialog-error" role="alert">
            {uploadError}
          </p>
        )}
      </section>

      <section aria-labelledby="import-history" className="dialog-stack">
        <h2 id="import-history" className="ac-text-heading">
          История импортов
        </h2>
        <LoadError error={history.first.error} retry={history.first.reload} />
        <LoadingContent
          ready={history.first.data !== undefined}
          indicator={history.first.indicator}
          label="Загрузка"
          swapKey={history.first.answerKey}
          skeleton={<SkeletonList rows={3} label="Загрузка" />}
        >
          {history.items.length === 0 ? (
            <EmptyState icon="clock" title="Импортов ещё не было" text="Загрузите первый файл" />
          ) : (
            <div className="table-wrap">
              <table className="admin-table vehicles-table">
                <thead>
                  <tr>
                    <th scope="col">Файл</th>
                    <th scope="col">Загрузил</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">Итог</th>
                    <th scope="col">Применил</th>
                  </tr>
                </thead>
                <tbody>
                  {history.items.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <div className="cell-stack">
                          <AppLink href={vehicleImportPath(entry.id)}>
                            {entry.fileName ?? "Без имени"}
                          </AppLink>
                          <span className="ac-text-caption ac-muted">
                            строк: {entry.rowCount.toLocaleString("ru-RU")}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack ac-text-body-s">
                          <span>{personText(entry.uploadedBy)}</span>
                          <span className="ac-text-caption ac-muted">
                            {formatMoment(entry.createdAt)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`status status--${statusClass[entry.status]}`}>
                          {IMPORT_STATUS_TEXT[entry.status]}
                        </span>
                      </td>
                      <td className="ac-text-body-s">{importNumbers(entry)}</td>
                      <td>
                        {entry.appliedBy ? (
                          <div className="cell-stack ac-text-body-s">
                            <span>{personText(entry.appliedBy)}</span>
                            <span className="ac-text-caption ac-muted">
                              {formatMoment(entry.appliedAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="ac-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <MoreButton list={history} />
        </LoadingContent>
      </section>

      <section aria-labelledby="import-template" className="dialog-stack">
        <h2 id="import-template" className="ac-text-heading">
          Что в шаблоне
        </h2>
        <LoadError error={template.error} retry={template.reload} />
        {template.data && (
          <div className="import-columns">
            <div className="table-wrap">
              <table className="admin-table vehicles-table">
                <thead>
                  <tr>
                    <th scope="col">Колонка</th>
                    <th scope="col">Что в ней</th>
                    <th scope="col">Пример</th>
                  </tr>
                </thead>
                <tbody>
                  {template.data.columns.map((column) => (
                    <tr key={column.name}>
                      <td>
                        <div className="cell-stack">
                          <code>{column.name}</code>
                          <span className="ac-text-caption ac-muted">
                            {COLUMN_TEXT[column.name]}
                            {column.required ? " · обязательная" : ""}
                          </span>
                        </div>
                      </td>
                      <td className="ac-text-body-s">{column.description}</td>
                      <td className="ac-text-body-s">
                        <code>{column.example || "—"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-box">
              <h3 className="ac-text-body-strong">Допустимые значения списков</h3>
              <p className="ac-text-caption ac-muted">
                Код или любое название; новых значений файл не создаёт — их добавляют во вкладке
                «Справочные списки».
              </p>
              {(["body", "transmission", "drive", "fuel"] as const).map((kind) => (
                <div key={kind} className="cell-stack">
                  <span className="ac-text-caption-strong">{OPTION_KIND_TEXT[kind]}</span>
                  <span className="ac-text-body-s">
                    {(optionsByKind.get(kind) ?? []).join("; ") || "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      <Banner tone="neutral">
        Изменения справочника видны в приложении не позже чем через минуту после применения.
      </Banner>
    </>
  );
}
